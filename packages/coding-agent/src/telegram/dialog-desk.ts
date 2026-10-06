/**
 * Telegram dialogs.
 *
 * One desk serves both dialog surfaces of the bridge:
 * - `uiContextFor(threadId)` — the full `ExtensionUIContext` handed to a topic
 *   session this process owns, where Telegram is the only UI.
 * - `remoteDialogHostFor(threadId)` — a `RemoteDialogHost` racing the local TUI
 *   for the attached session; losing the race aborts the request signal and the
 *   keyboard is struck from the message.
 *
 * Pending dialogs are keyed by a short per-dialog token, so callback data stays
 * inside Telegram's 64-byte budget and a press that arrives after its dialog was
 * answered, timed out or dropped is refused as stale. Every desk instance mints
 * its tokens under its own random prefix, so a button left over from an earlier
 * desk (a previous `/telegram start` or process run) names no route here and is
 * refused as stale too. Free text answers the topic's most recent pending text
 * dialog; commands never reach this desk.
 */
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import { logger } from "@oh-my-pi/pi-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "../extensibility/extensions/types";
import { getExtensionUISelectOptionLabel } from "../extensibility/extensions/types";
import type { RemoteDialogHost, RemoteDialogResult } from "../modes/remote-dialogs";
import { createAskFlow, type AskOutcome } from "./ask-desk";
import { BUTTON_LIMIT, CANCEL_INDEX, NO_KEYBOARD, parseUiCallback, uiCallbackData } from "./dialog-keys";
import {
	askQuestionKeyboard,
	askQuestionText,
	askReplyText,
	dialogHead,
	selectLabels,
	uiPrompt,
	type UiPrompt,
} from "./dialogs";
import { mdText } from "./rich";
import { clip, errorText } from "./text";
import type { DialogDesk, DialogDeskDeps } from "./types";

const ACCEPTED_TEXT = "Accepted";
const STALE_TEXT = "This question is already closed";

type DialogOutcome = { kind: "index"; index: number } | { kind: "text"; text: string } | { kind: "gone" };

interface Route {
	readonly token: string;
	readonly threadId: number;
	readonly head: string;
	/** Free text answers this dialog (mutated when an ask question starts awaiting one). */
	expectsReply: boolean;
	messageId: number | null;
	readonly expiresAt: number | null;
	press(index: number): void;
	text(text: string): void;
	/** Timeout, abort, topic drop or host shutdown: the request must resolve unavailable/cancelled. */
	gone(): void;
	disarm(): void;
}

interface PlaceParams {
	threadId: number;
	build(token: string): UiPrompt;
	dialogOptions?: ExtensionUIDialogOptions;
	onPress(route: Route, index: number): void;
	onText(route: Route, text: string): void;
	onGone(route: Route): void;
}

function answerNote(outcome: DialogOutcome, labels: readonly string[]): string | null {
	if (outcome.kind === "gone") return null;
	if (outcome.kind === "text") return outcome.text;
	return outcome.index === CANCEL_INDEX ? "Cancelled" : (labels[outcome.index] ?? "");
}

/** One-line summary of an ask answer, used for the answered-message note. */
function summarize(results: readonly ExtensionAskDialogResultItem[]): string {
	return results
		.map(item => {
			if (item.customInput !== undefined) return `Other: ${item.customInput}`;
			return item.selectedOptions.length === 0 ? "Selected: (none)" : `Selected: ${item.selectedOptions.join(", ")}`;
		})
		.join("; ");
}

export function createDialogDesk(deps: DialogDeskDeps): DialogDesk {
	const { api, delivery, chatId } = deps;
	const clock = deps.clock ?? { now: Date.now };
	const routes = new Map<string, Route>();
	let counter = 0;
	/**
	 * Per-desk random prefix. A callback minted by another desk instance — an
	 * earlier `/telegram start` or an earlier process run whose keyboards were
	 * never struck — can never name a route here: its token is unknown and the
	 * press is refused as stale instead of resolving this desk's first dialog.
	 */
	const tokenPrefix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);

	async function call<T>(event: string, run: () => Promise<T>, detail: object = {}): Promise<T | null> {
		try {
			return await run();
		} catch (error) {
			logger.warn(`telegram: ${event}`, { ...detail, error: errorText(error) });
			return null;
		}
	}

	function retire(route: Route): boolean {
		if (routes.get(route.token) !== route) return false;
		routes.delete(route.token);
		return true;
	}

	function settleRoute(route: Route, note: string | null): boolean {
		if (!retire(route)) return false;
		route.disarm();
		const { messageId } = route;
		if (messageId !== null) {
			// No answer here: another surface answered, the request was withdrawn,
			// or it timed out. Say so instead of leaving a dead question.
			const markdown = `${route.head}\n\n${note === null ? "_Closed._" : `**✅ Answer:** ${mdText(note)}`}`;
			void call(
				"dialog.settle",
				() => delivery.edit({ chatId, messageId, threadId: route.threadId, markdown, replyMarkup: NO_KEYBOARD }),
				{
					threadId: route.threadId,
				},
			);
		}
		return true;
	}

	async function place(params: PlaceParams): Promise<Route> {
		const token = `${tokenPrefix}${++counter}`;
		const prompt = params.build(token);
		const timeout =
			typeof params.dialogOptions?.timeout === "number" && params.dialogOptions.timeout > 0
				? params.dialogOptions.timeout
				: null;
		let armed = true;
		let cancelTimer: (() => void) | null = null;
		const signal = params.dialogOptions?.signal;
		const onAbort = (): void => route.gone();
		const route: Route = {
			token,
			threadId: params.threadId,
			head: prompt.text,
			expectsReply: prompt.expectsReply,
			messageId: null,
			expiresAt: timeout === null ? null : clock.now() + timeout,
			press: index => {
				if (armed) params.onPress(route, index);
			},
			text: text => {
				if (armed) params.onText(route, text);
			},
			gone: () => {
				if (armed) params.onGone(route);
			},
			disarm: () => {
				if (!armed) return;
				armed = false;
				cancelTimer?.();
				cancelTimer = null;
				signal?.removeEventListener("abort", onAbort);
			},
		};
		routes.set(token, route);
		if (timeout !== null) {
			const handle = setTimeout(() => {
				params.dialogOptions?.onTimeout?.();
				route.gone();
			}, timeout);
			cancelTimer = () => clearTimeout(handle);
		}
		if (signal !== undefined) {
			if (signal.aborted) {
				route.gone();
				return route;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
		const ids = await call(
			"dialog.send",
			() =>
				delivery.send({
					chatId,
					threadId: params.threadId,
					markdown: prompt.text,
					replyMarkup: prompt.replyMarkup,
				}),
			{ threadId: params.threadId },
		);
		route.messageId = ids?.[0] ?? null;
		if (route.messageId === null && armed)
			logger.debug("telegram: dialog not placed", { threadId: params.threadId, token });
		return route;
	}

	function startUiDialog<T>(params: {
		threadId: number;
		build(token: string): UiPrompt;
		dialogOptions?: ExtensionUIDialogOptions;
		result(outcome: DialogOutcome): T;
		note(outcome: DialogOutcome): string | null;
		resolve(value: T): void;
	}): void {
		const settle = (route: Route, outcome: DialogOutcome): void => {
			if (!settleRoute(route, params.note(outcome))) return;
			params.resolve(params.result(outcome));
		};
		void place({
			threadId: params.threadId,
			build: params.build,
			dialogOptions: params.dialogOptions,
			onPress: (route, index) => settle(route, { kind: "index", index }),
			onText: (route, text) => settle(route, { kind: "text", text }),
			onGone: route => settle(route, { kind: "gone" }),
		});
	}

	function askDialog(
		threadId: number,
		questions: readonly ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		const { promise, resolve } = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
		const flow = createAskFlow(questions);
		let settled = false;
		const finish = (result: ExtensionAskDialogResult | undefined): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		const refresh = (route: Route): void => {
			const question = flow.question();
			const { messageId } = route;
			if (question === null || messageId === null) return;
			route.expectsReply = flow.awaitingText();
			const markdown = flow.awaitingText()
				? askReplyText(question, flow.at(), flow.total())
				: askQuestionText(question, flow.at(), flow.total(), flow.multi());
			void call(
				"dialog.refresh",
				() =>
					delivery.edit({
						chatId,
						messageId,
						threadId: route.threadId,
						markdown,
						replyMarkup: askQuestionKeyboard(question, route.token, flow.selected(), flow.multi()),
					}),
				{ threadId: route.threadId },
			);
		};

		const apply = (route: Route, before: number, outcome: AskOutcome): void => {
			if (outcome.kind === "stale") return;
			if (outcome.kind === "cancel") {
				settleRoute(route, "Cancelled");
				finish(undefined);
				return;
			}
			if (outcome.kind === "submit") {
				settleRoute(route, summarize(outcome.results));
				finish({ kind: "submit", results: outcome.results });
				return;
			}
			if (flow.at() !== before) {
				const answered = flow.results().at(-1);
				settleRoute(route, answered === undefined ? null : summarize([answered]));
				void render();
				return;
			}
			refresh(route);
		};

		const render = async (): Promise<void> => {
			const question = flow.question();
			if (question === null || settled) return;
			await place({
				threadId,
				dialogOptions,
				build: token => ({
					text: flow.awaitingText()
						? askReplyText(question, flow.at(), flow.total())
						: askQuestionText(question, flow.at(), flow.total(), flow.multi()),
					replyMarkup: askQuestionKeyboard(question, token, flow.selected(), flow.multi()),
					expectsReply: flow.awaitingText(),
				}),
				onPress: (route, index) => {
					const before = flow.at();
					apply(route, before, flow.press(index));
				},
				onText: (route, text) => apply(route, flow.at(), flow.reply(text)),
				onGone: route => {
					settleRoute(route, null);
					finish(undefined);
				},
			});
		};

		void render();
		return promise;
	}

	function remoteHost(threadId: () => number | null): RemoteDialogHost {
		function guestResult(outcome: DialogOutcome, labels: readonly string[]): RemoteDialogResult {
			if (outcome.kind === "gone") return { kind: "unavailable" };
			if (outcome.kind === "text") return { kind: "answered", value: outcome.text };
			if (outcome.index === CANCEL_INDEX) return { kind: "answered", value: undefined };
			return { kind: "answered", value: labels[outcome.index] ?? "" };
		}
		function selectPrompt(request: Extract<CollabUiRequestDraft, { kind: "select" }>, token: string): UiPrompt {
			const markableCount = request.markableCount ?? request.options.length;
			const checked = request.checkedIndices ?? [];
			const rows = request.options.map((option, index) => {
				const label = getExtensionUISelectOptionLabel(option);
				const description = typeof option === "string" ? "" : (option.description ?? "");
				let mark = "";
				if (index < markableCount && request.selectionMarker === "checkbox")
					mark = checked.includes(index) ? "☑ " : "☐ ";
				else if (index < markableCount && request.selectionMarker === "radio") {
					mark = index === (checked[0] ?? request.initialIndex) ? "◉ " : "○ ";
				}
				const text = description === "" ? label : `${label} — ${description}`;
				return [{ text: clip(`${mark}${text}`, BUTTON_LIMIT), callbackData: uiCallbackData(token, index) }];
			});
			rows.push([{ text: "Cancel", callbackData: uiCallbackData(token, CANCEL_INDEX) }]);
			return {
				// `helpText` carries the TUI's key hints (↑/↓, ⏎, ⎋); they mean nothing here.
				text: dialogHead({ method: "select", title: request.title }),
				replyMarkup: { inlineKeyboard: rows },
				expectsReply: false,
			};
		}

		return {
			requestGuestUi(request, signal) {
				const thread = threadId();
				if (thread === null) return null;
				const { promise, resolve } = Promise.withResolvers<RemoteDialogResult>();
				if (request.kind === "editor") {
					startUiDialog({
						threadId: thread,
						dialogOptions: { signal },
						build: token => uiPrompt({ method: "editor", title: request.title, prefill: request.prefill }, token),
						result: outcome => guestResult(outcome, []),
						note: outcome => answerNote(outcome, []),
						resolve,
					});
					return promise;
				}
				const labels = request.options.map(getExtensionUISelectOptionLabel);
				startUiDialog({
					threadId: thread,
					dialogOptions: { signal },
					build: token => selectPrompt(request, token),
					result: outcome => guestResult(outcome, labels),
					note: outcome => answerNote(outcome, labels),
					resolve,
				});
				return promise;
			},
		};
	}

	function uiContextFor(threadId: number): ExtensionUIContext {
		return {
			timeoutStartsOnPresentation: true,
			select: (title, options, dialogOptions) => {
				const labels = selectLabels(options);
				const { promise, resolve } = Promise.withResolvers<string | undefined>();
				startUiDialog({
					threadId,
					dialogOptions,
					build: token => uiPrompt({ method: "select", title, options }, token),
					result: outcome => (outcome.kind === "index" && outcome.index >= 0 ? labels[outcome.index] : undefined),
					note: outcome => answerNote(outcome, labels),
					resolve,
				});
				return promise;
			},
			confirm: (title, message, dialogOptions) => {
				const labels = ["No", "Yes"];
				const { promise, resolve } = Promise.withResolvers<boolean>();
				startUiDialog({
					threadId,
					dialogOptions,
					build: token => uiPrompt({ method: "confirm", title, message }, token),
					result: outcome => outcome.kind === "index" && outcome.index === 1,
					note: outcome => answerNote(outcome, labels),
					resolve,
				});
				return promise;
			},
			input: (title, placeholder, dialogOptions) => {
				const { promise, resolve } = Promise.withResolvers<string | undefined>();
				startUiDialog({
					threadId,
					dialogOptions,
					build: token => uiPrompt({ method: "input", title, placeholder }, token),
					result: outcome => (outcome.kind === "text" ? outcome.text : undefined),
					note: outcome => answerNote(outcome, []),
					resolve,
				});
				return promise;
			},
			editor: (title, prefill, dialogOptions) => {
				const { promise, resolve } = Promise.withResolvers<string | undefined>();
				startUiDialog({
					threadId,
					dialogOptions,
					build: token => uiPrompt({ method: "editor", title, prefill }, token),
					result: outcome => (outcome.kind === "text" ? outcome.text : undefined),
					note: outcome => answerNote(outcome, []),
					resolve,
				});
				return promise;
			},
			askDialog: (questions, dialogOptions) => askDialog(threadId, questions, dialogOptions),
			notify: (message, type) => {
				const mark = type === "error" ? "❌ " : type === "warning" ? "⚠️ " : "";
				void call("ui.notify", () => delivery.send({ chatId, threadId, markdown: `${mark}${mdText(message)}` }), {
					threadId,
				});
			},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			setEditorText: () => {},
			pasteToEditor: () => {},
			getEditorText: () => "",
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			get theme() {
				return theme;
			},
			getAllThemes: async () => [],
			getTheme: async () => undefined,
			setTheme: async () => ({ success: false, error: "Theme changes are not available over Telegram" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	function lastExpectingText(threadId: number): Route | undefined {
		let found: Route | undefined;
		for (const route of routes.values()) if (route.threadId === threadId && route.expectsReply) found = route;
		return found;
	}

	return {
		uiContextFor,
		remoteDialogHostFor: remoteHost,
		async handleCallback(query) {
			const parsed = parseUiCallback(query.data);
			if (parsed === null) return false;
			const route = routes.get(parsed.token);
			if (route === undefined) {
				await call("ui.stale", () => api.answerCallbackQuery({ id: query.id, text: STALE_TEXT }));
				return true;
			}
			if (route.expiresAt !== null && clock.now() > route.expiresAt) {
				route.gone();
				await call("ui.stale", () => api.answerCallbackQuery({ id: query.id, text: STALE_TEXT }));
				return true;
			}
			await call("ui.accepted", () => api.answerCallbackQuery({ id: query.id, text: ACCEPTED_TEXT }));
			route.press(parsed.index);
			return true;
		},
		async answerText(threadId, text) {
			const route = lastExpectingText(threadId);
			if (route === undefined) return false;
			if (route.expiresAt !== null && clock.now() > route.expiresAt) {
				route.gone();
				return false;
			}
			route.text(text);
			return true;
		},
		dropTopic(threadId) {
			for (const route of Array.from(routes.values())) if (route.threadId === threadId) route.gone();
		},
		shutdown() {
			for (const route of Array.from(routes.values())) route.gone();
		},
	};
}
