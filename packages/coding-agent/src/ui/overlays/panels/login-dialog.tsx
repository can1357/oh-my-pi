/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The OAuth sign-in sheet (`omp.overlay.login`): a modal glass sheet over the
 * composer. Top to bottom: one sentence saying what to do, the device code
 * (click to copy), the sign-in link with Copy, the questions (answered ones as
 * label/value lines, the live one as a field), and the flow's status —
 * finished stages checked, the current one spinning. The footer holds Cancel
 * and one primary action: Continue while a field waits (Open sign-in page
 * then leads the footer), else Open sign-in page.
 *
 * {@link LoginDialogState} is what the OAuth flow drives (`showAuth`,
 * `showPrompt`, `showManualInput`, `showWaiting`, `showProgress`); the
 * terminal draws the flow's transcript in a box titled `Login to …`.
 */
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthPrompt } from "@oh-my-pi/pi-ai/oauth/types";
import { type JSXNode, nativeRendering, type Signal, signal, type TextEdit, untrack } from "@oh-my-pi/pi-tui";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import "../../styles/panels/login-dialog";
import { editLine } from "../settings/line-edit";
import { ActionButton, applyEdit, applyMaskedEdit } from "./common";
import { matchesSelectCancel } from "../../../config/keybindings/matchers";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import { actionKbd, actionKeyId, kbdOf } from "../../keys/hints";
import { bindingGlyph, keyTitle } from "../../styles/panels/common";

/** `Enter code: ABCD-1234` device instructions: the lead-in and the code. */
const DEVICE_CODE_INSTRUCTIONS = /^(.*\bcode:?\s+)([A-Za-z0-9][A-Za-z0-9-]{3,})\s*$/s;
/** A prompt's trailing `, then press Enter:` (the Continue button says it). */
const PRESS_KEY_SUFFIX = /,?\s*then press\s+\S+\s*:?\s*$/i;
/** Progress reporting a problem rather than a finished stage. */
const PROGRESS_PROBLEM = /\b(?:fail(?:ed|ure)?|error|unavailable|in use|could ?n[o']t|unable)\b/i;
/** The field's error when the flow asks for the manual code again. */
const RETRY_MESSAGE = "Couldn't read a code from that. Paste the authorization code or the full redirect URL.";
/** Status while the browser half runs and the provider reports nothing. */
const BROWSER_WAIT = "Waiting for you to finish in the browser…";

/** A text field of the flow. */
export interface LoginField {
	readonly text: Signal<string>;
	readonly cursor: Signal<number>;
	readonly secret: boolean;
	readonly placeholder?: string;
	readonly error: Signal<string | undefined>;
}

/** What the terminal transcript shows, in order. */
export type LoginPiece =
	| { readonly kind: "spacer" }
	| { readonly kind: "url"; readonly url: string }
	| { readonly kind: "text"; readonly text: string; readonly style: string; readonly href?: string }
	| { readonly kind: "field"; readonly field: LoginField };

type LoginStep =
	| { kind: "input"; message: string; field: LoginField; answer?: string }
	| { kind: "progress"; message: string };

interface LoginAuth {
	readonly url: string;
	readonly launchUrl?: string;
	readonly instructions?: string;
	readonly device?: string;
}

/** Sheet copy: plain text, a trailing `...` as `…`. */
function sheetText(message: string): string {
	return stripEscapes(message)
		.trim()
		.replace(/\.\.\.$/, "…");
}

/** `github.com/login/device` for a tooltip; the input when it is not a URL. */
function urlPlace(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
	} catch {
		return url;
	}
}

function newField(secret = false, placeholder?: string): LoginField {
	return {
		text: signal(""),
		cursor: signal(0),
		secret,
		...(placeholder ? { placeholder } : {}),
		error: signal<string | undefined>(undefined),
	};
}

/** The sign-in flow's live state. */
export class LoginDialogState {
	readonly providerName: string;
	readonly auth = signal<LoginAuth | undefined>(undefined);
	readonly steps = signal<readonly LoginStep[]>([]);
	readonly pieces = signal<readonly LoginPiece[]>([]);
	/** The sheet holds keyboard focus (the live field draws its caret). */
	readonly focused = signal(true);
	/** The terminal draws its own cursor: no caret cell. */
	readonly terminalCursor = signal(false);
	/** The field keys go to (mounted or not). */
	readonly field = signal<LoginField>(newField());
	readonly #abort = new AbortController();
	#resolve: ((value: string) => void) | undefined;
	#reject: ((error: Error) => void) | undefined;

	constructor(
		providerId: string,
		readonly onComplete: (success: boolean, message?: string) => void,
		readonly openUrl: (url: string) => void,
	) {
		this.providerName = getOAuthProviders().find(p => p.id === providerId)?.name || providerId;
	}

	get signal(): AbortSignal {
		return this.#abort.signal;
	}

	#push(...pieces: LoginPiece[]): void {
		this.pieces.set([...untrack(this.pieces), ...pieces]);
	}

	/** The field still waiting for an answer, if any. */
	activeField(): LoginField | undefined {
		const steps = this.steps();
		const current = this.field();
		for (let i = steps.length - 1; i >= 0; i--) {
			const step = steps[i]!;
			if (step.kind === "input" && step.answer === undefined && step.field === current) return step.field;
		}
		return undefined;
	}

	showAuth(url: string, instructions?: string, launchUrl?: string): void {
		const pieces: LoginPiece[] = [
			{ kind: "spacer" },
			{ kind: "url", url },
			{
				kind: "text",
				text: `${process.platform === "darwin" ? "⌘" : "Ctrl"}+click to open`,
				style: "dim",
				href: url,
			},
		];
		if (launchUrl && launchUrl !== url) {
			pieces.push({ kind: "text", text: `Local shortcut (this machine only): ${launchUrl}`, style: "dim" });
		}
		if (instructions) pieces.push({ kind: "spacer" }, { kind: "text", text: instructions, style: "warning" });
		this.pieces.set(pieces);
		const plain = instructions ? stripEscapes(instructions) : undefined;
		const device = plain ? DEVICE_CODE_INSTRUCTIONS.exec(plain) : null;
		this.auth.set({
			url,
			...(launchUrl && launchUrl !== url ? { launchUrl } : {}),
			...(plain ? { instructions: plain } : {}),
			...(device ? { device: device[2]! } : {}),
		});
		this.steps.set([]);
		this.openUrl(url);
	}

	showManualInput(prompt: string, signal?: AbortSignal): Promise<string> {
		const previous = untrack(this.field);
		const pieces = untrack(this.pieces);
		const mounted = pieces.findIndex(piece => piece.kind === "field" && piece.field === previous);
		const field = newField();
		this.field.set(field);
		if (mounted !== -1) {
			// Asked again only when the last paste carried no usable code.
			field.error.set(RETRY_MESSAGE);
			this.pieces.set(pieces.map((piece, i) => (i === mounted ? { kind: "field", field } : piece)));
			this.steps.set(
				untrack(this.steps).map(step =>
					step.kind === "input" && step.field === previous ? { ...step, field } : step,
				),
			);
		} else {
			this.steps.set([...untrack(this.steps), { kind: "input", message: stripEscapes(prompt), field }]);
			this.#push(
				{ kind: "spacer" },
				{ kind: "text", text: prompt, style: "dim" },
				{ kind: "field", field },
				{ kind: "text", text: `(${bindingGlyph("tui.select.cancel", "escape")} to cancel)`, style: "dim" },
			);
		}
		if (signal?.aborted) {
			return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Login input cancelled"));
		}
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#resolve = resolve;
		this.#reject = reject;
		signal?.addEventListener(
			"abort",
			() => {
				if (this.#reject !== reject) return;
				this.#resolve = this.#reject = undefined;
				reject(signal.reason instanceof Error ? signal.reason : new Error("Login input cancelled"));
			},
			{ once: true },
		);
		return promise;
	}

	showPrompt(prompt: OAuthPrompt): Promise<string> {
		// Earlier answers stay listed, secrets masked.
		const previous = untrack(this.field);
		const pieces = [...untrack(this.pieces)];
		const mounted = pieces.findIndex(piece => piece.kind === "field" && piece.field === previous);
		if (mounted !== -1) {
			const value = previous.secret ? "********" : untrack(previous.text);
			pieces.splice(mounted, 1, { kind: "text", text: `> ${value}`, style: "dim" });
			this.steps.set(
				untrack(this.steps).map(step =>
					step.kind === "input" && step.field === previous ? { ...step, answer: value } : step,
				),
			);
		}
		const placeholder = prompt.placeholder ? stripEscapes(prompt.placeholder) : undefined;
		const field = newField(prompt.secret === true, placeholder);
		this.field.set(field);
		pieces.push({ kind: "spacer" }, { kind: "text", text: prompt.message, style: "text" });
		if (prompt.placeholder) pieces.push({ kind: "text", text: `e.g., ${prompt.placeholder}`, style: "dim" });
		pieces.push(
			{ kind: "field", field },
			{
				kind: "text",
				text: `(${bindingGlyph("tui.select.cancel", "escape")} to cancel, ${bindingGlyph("tui.input.submit", "enter")} to submit)`,
				style: "dim",
			},
		);
		this.pieces.set(pieces);
		this.steps.set([...untrack(this.steps), { kind: "input", message: stripEscapes(prompt.message), field }]);
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#resolve = resolve;
		this.#reject = reject;
		return promise;
	}

	showWaiting(message: string): void {
		this.#push(
			{ kind: "spacer" },
			{ kind: "text", text: message, style: "dim" },
			{ kind: "text", text: `(${bindingGlyph("tui.select.cancel", "escape")} to cancel)`, style: "dim" },
		);
		this.steps.set([...untrack(this.steps), { kind: "progress", message: stripEscapes(message) }]);
	}

	showProgress(message: string): void {
		this.#push({ kind: "text", text: message, style: "dim" });
		this.steps.set([...untrack(this.steps), { kind: "progress", message: stripEscapes(message) }]);
	}

	/** Submit the live field (Enter, Continue). */
	submit(): void {
		const resolve = this.#resolve;
		if (!resolve) return;
		this.#resolve = this.#reject = undefined;
		resolve(untrack(untrack(this.field).text));
	}

	cancel(): void {
		this.#abort.abort();
		const reject = this.#reject;
		this.#resolve = this.#reject = undefined;
		reject?.(new Error("Login cancelled"));
		this.onComplete(false, "Login cancelled");
	}

	/** An edit of the live field (masked edits address one bullet per character). */
	edit(edit: TextEdit): void {
		const field = untrack(this.field);
		const line = { text: untrack(field.text), cursor: untrack(field.cursor) };
		const next = field.secret ? applyMaskedEdit(line, edit) : applyEdit(line, edit);
		if (!next) return;
		field.text.set(next.text);
		field.cursor.set(next.cursor);
	}

	paste(text: string): void {
		const field = untrack(this.field);
		const value = untrack(field.text);
		const at = untrack(field.cursor);
		const clean = text.replace(/[\r\n]+/g, "");
		field.text.set(`${value.slice(0, at)}${clean}${value.slice(at)}`);
		field.cursor.set(at + clean.length);
	}
}

function FieldNode(props: { readonly state: LoginDialogState; readonly field: LoginField }): JSXNode {
	const { field, state } = props;
	return (
		<col role="omp.form.field" gap="sm">
			<input
				prompt="> "
				placeholder={field.placeholder}
				sendable={false}
				text={() => (field.secret ? "•".repeat([...field.text()].length) : field.text())}
				cursor={field.cursor}
				onEdit={edit => state.edit(edit)}
			/>
			{() => {
				const error = field.error();
				return error ? <text spans={[{ s: "error", t: error }]} /> : <text hidden text="" />;
			}}
		</col>
	);
}

function Live(props: { readonly message: string; readonly nodeKey: string }): JSXNode {
	return (
		<row key={props.nodeKey} role="omp.login.waiting" gap="sm" align="center">
			<spinner style="orbit" label={sheetText(props.message)} tone="muted" />
		</row>
	);
}

function Done(props: { readonly message: string; readonly nodeKey: string }): JSXNode {
	const problem = PROGRESS_PROBLEM.test(props.message);
	return (
		<row key={props.nodeKey} role="omp.login.done" gap="sm" align="baseline" tone={problem ? "warning" : undefined}>
			<icon key="icon" name={problem ? "warn" : "check"} />
			<text key="text" wrap="word" text={sheetText(props.message).replace(/…$/, "")} />
		</row>
	);
}

export function LoginDialog(props: { readonly state: LoginDialogState }): JSXNode {
	const { state } = props;
	return (
		<col
			term={() => ({
				title: `Login to ${state.providerName}`,
				pieces: state.pieces(),
				caret: state.focused() && !state.terminalCursor(),
			})}
			// The terminal's dialog box; Tern draws the sheet alone and gets a bare column where it is mounted.
			role={() => (nativeRendering() ? undefined : "omp.login")}
			onKey={key => {
				if (matchesSelectCancel(key)) state.cancel();
				else if (getKeybindings().matches(key, "tui.input.submit")) state.submit();
				else {
					const field = untrack(state.field);
					const next = editLine({ text: untrack(field.text), cursor: untrack(field.cursor) }, key);
					if (!next) return false;
					field.text.set(next.text);
					field.cursor.set(next.cursor);
				}
				return true;
			}}
			onPaste={paste => {
				state.paste(paste.text);
				return true;
			}}
			onAction={act => {
				if (act === "cancel") state.cancel();
				else if (act === "submit" && untrack(() => state.activeField())) state.submit();
			}}
		>
			<overlay
				key="sheet"
				role="omp.overlay.login"
				head={`Sign in to ${state.providerName}`}
				anchor="center"
				size="md"
				modal
			>
				<col gap="lg">
					<col key="body" role="omp.login.body" gap="md">
						{() => {
							const auth = state.auth();
							const steps = state.steps();
							const field = state.activeField();
							const body: JSXNode[] = [];
							if (auth) {
								const lead = auth.device
									? "Enter this code on the sign-in page to connect your account."
									: auth.instructions
										? sheetText(auth.instructions)
										: "Continue in your browser. If it didn't open, open or copy the link below.";
								body.push(<text key="lead" role="omp.login.lead" wrap="word" text={lead} />);
								if (auth.device) {
									body.push(
										<row
											key="code"
											role="omp.login.code"
											align="center"
											actions={{ click: "copy" }}
											href={auth.device}
											title="Copy code"
										>
											<text key="value" spans={[{ s: "mono", t: auth.device }]} />
											<icon key="icon" name="copy" />
										</row>,
									);
								}
								body.push(
									<row key="link" role="omp.login.link" gap="sm" align="center">
										<icon key="icon" name="link" />
										<text
											key="url"
											role="omp.login.url"
											truncate="middle"
											lines={1}
											title={auth.url}
											spans={[{ s: "mono", t: auth.url, href: auth.url } as TspSpan]}
										/>
										<ActionButton
											id="copy"
											nodeKey="copyLink"
											label="Copy"
											href={auth.url}
											title="Copy the sign-in link"
										/>
									</row>,
								);
								if (auth.launchUrl) {
									body.push(
										<text
											key="shortcut"
											role="omp.login.shortcut"
											truncate="middle"
											lines={1}
											title={auth.launchUrl}
											spans={[
												{ s: "dim", t: "On this machine  " },
												{ s: "mono", t: auth.launchUrl, href: auth.launchUrl } as TspSpan,
											]}
										/>,
									);
								}
							}
							const status: JSXNode[] = [];
							const live = steps.findLastIndex(step => step.kind === "progress");
							steps.forEach((step, index) => {
								if (step.kind === "progress") {
									status.push(
										index === live ? (
											<Live message={step.message} nodeKey={`p${index}`} />
										) : (
											<Done message={step.message} nodeKey={`p${index}`} />
										),
									);
									return;
								}
								const label = step.message.trim().replace(PRESS_KEY_SUFFIX, "").replace(/:$/, "");
								body.push(
									step.answer !== undefined ? (
										<row key={`a${index}`} role="omp.login.answer" gap="sm" align="baseline">
											<text key="label" truncate="end" lines={1} text={label} />
											<text key="value" truncate="end" lines={1} text={step.answer || "—"} />
										</row>
									) : (
										<col key={`i${index}`} role="omp.login.prompt" gap="sm">
											<text key="label" role="omp.login.label" wrap="word" text={label} />
											<FieldNode state={state} field={step.field} />
										</col>
									),
								);
							});
							if (auth && live === -1 && !field) status.push(<Live message={BROWSER_WAIT} nodeKey="browser" />);
							if (status.length > 0) {
								body.push(
									<col key="status" role="omp.login.status" gap="xs">
										{status}
									</col>,
								);
							}
							return body;
						}}
					</col>
					{() => {
						const auth = state.auth();
						const field = state.activeField();
						const open = auth && (
							<ActionButton
								id="open"
								nodeKey="openLink"
								label="Open sign-in page"
								href={auth.url}
								title={`Open ${urlPlace(auth.url)} in your browser`}
								icon="open"
								tone={field ? undefined : "accent"}
							/>
						);
						const cancelKey = actionKeyId("tui.select.cancel", "escape");
						const cancel = (
							<ActionButton
								id="cancel"
								label="Cancel"
								title={`Cancel  ${keyTitle(cancelKey)}`}
								keys={kbdOf(cancelKey)}
							/>
						);
						return (
							<row key="actions" role="omp.actions" align="center" gap="sm">
								{field && open}
								<spacer grow={1} />
								{cancel}
								{field ? (
									<ActionButton
										id="submit"
										label="Continue"
										title={`Continue  ${keyTitle(actionKeyId("tui.input.submit", "enter"))}`}
										tone="accent"
										keys={actionKbd("tui.input.submit", "enter")}
									/>
								) : (
									open
								)}
							</row>
						);
					}}
				</col>
			</overlay>
		</col>
	);
}
