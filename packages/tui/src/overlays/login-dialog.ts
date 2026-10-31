import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthPrompt } from "@oh-my-pi/pi-ai/oauth/types";
import { Container, getKeybindings, Spacer, Text, type TUI, wrapTextWithAnsi } from "../index";
import { theme } from "../theme/theme";
import { urlHyperlinkAlways, WidthAwareText } from "../render/index";
import { formTheme } from "../chrome/form-theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { TextFormField } from "../components/form";
import { formatKeyHint, keyHintPlatform } from "../app-keybindings";
import { editorKey } from "../chrome/keybinding-hints";
import { col, keyed, node, span, text } from "../native/describe";
import type { NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import { plainText } from "../native/spans";

/** `Enter code: ABCD-1234` style device-flow instructions: the lead-in and the code. */
const DEVICE_CODE_INSTRUCTIONS = /^(.*\bcode:?\s+)([A-Za-z0-9][A-Za-z0-9-]{3,})\s*$/s;

/** A prompt's trailing `, then press Enter:` — the sheet's Continue button says it. */
const PRESS_KEY_SUFFIX = /,?\s*then press\s+\S+\s*:?\s*$/i;

/** Progress that reports a problem rather than a finished stage. */
const PROGRESS_PROBLEM = /\b(?:fail(?:ed|ure)?|error|unavailable|in use|could ?n[o']t|unable)\b/i;

/** Shown on the field when the flow asks for the manual code again: the last paste had no usable code. */
const RETRY_MESSAGE = "Couldn't read a code from that. Paste the authorization code or the full redirect URL.";

/** Shown while the browser half of the flow runs and the provider reports nothing. */
const BROWSER_WAIT = "Waiting for you to finish in the browser…";

/** The sign-in link from `showAuth`: the provider's instructions, or the device code split out of them. */
interface LoginAuth {
	url: string;
	launchUrl?: string;
	instructions?: string;
	device?: { code: string };
}

/** One native step after the sign-in link: a text answer (live or given) or a progress message. */
type LoginStep =
	| { kind: "input"; message: string; field: TextFormField; answer?: string }
	| { kind: "progress"; message: string };

/** Sheet copy: plain text, a trailing ASCII ellipsis as `…`. */
function sheetText(message: string): string {
	return plainText(message)
		.trim()
		.replace(/\.\.\.$/, "…");
}

/** `github.com/login/device` for a tooltip; the input when it isn't a URL. */
function urlPlace(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
	} catch {
		return url;
	}
}

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends OverlayPanel {
	#contentContainer: Container;
	#input: TextFormField;
	#tui: Pick<TUI, "requestRender">;
	#focused = false;
	#useTerminalCursor = false;
	#onComplete: (success: boolean, message?: string) => void;
	#openUrl: (url: string) => void;
	#abortController = new AbortController();
	#inputResolver?: (value: string) => void;
	#inputRejecter?: (error: Error) => void;
	#inputAbortCleanup?: () => void;
	readonly #providerName: string;
	#nativeAuth: LoginAuth | undefined;
	/** Native steps after the link, in arrival order; the live input field is embedded by identity. */
	#nativeSteps: LoginStep[] = [];
	#nativeRoot: NativeNode | undefined;

	constructor(
		tui: Pick<TUI, "requestRender">,
		providerId: string,
		onComplete: (success: boolean, message?: string) => void,
		openUrl: (url: string) => void,
	) {
		const providerInfo = getOAuthProviders().find(p => p.id === providerId);
		const providerName = providerInfo?.name || providerId;
		super(`Login to ${providerName}`, "omp.overlay.login");
		this.#providerName = providerName;
		this.#tui = tui;
		this.#onComplete = onComplete;
		this.#openUrl = openUrl;

		// Dynamic content area
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		this.#input = this.#createInput();
	}

	/** Focus reaches the live field: it draws the caret (the hardware cursor when the terminal's is on). */
	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
		this.#input.focused = value;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
		this.#input.input.setUseTerminalCursor(useTerminalCursor);
	}

	/** A fresh field for the next answer; the previous one stops drawing a caret. */
	#replaceInput(secret = false): void {
		this.#input.focused = false;
		this.#input = this.#createInput(secret);
	}

	#createInput(secret = false): TextFormField {
		const field = new TextFormField({
			theme: formTheme,
			secret,
			empty: "submit",
			spaceBeforeControl: false,
			spaceAfterControl: false,
			onSubmit: value => {
				const resolve = this.#inputResolver;
				if (!resolve) return;
				this.#clearInputHandlers();
				resolve(value);
			},
			onCancel: () => {
				this.#cancel();
			},
			requestRender: () => this.#tui.requestRender(),
		});
		field.focused = this.#focused;
		field.input.setUseTerminalCursor(this.#useTerminalCursor);
		return field;
	}

	get signal(): AbortSignal {
		return this.#abortController.signal;
	}

	#cancel(): void {
		this.#abortController.abort();
		const reject = this.#inputRejecter;
		this.#clearInputHandlers();
		reject?.(new Error("Login cancelled"));
		this.#onComplete(false, "Login cancelled");
	}

	/**
	 * Called by the OAuth `onAuth` callback. Renders the full authorization URL
	 * as the primary copy target — that works from any machine, including
	 * SSH/WSL/headless sessions where the OMP-hosted `launchUrl` would resolve
	 * against the user's local browser and fail. When `launchUrl` is present it
	 * is offered as an additional local shortcut so narrow local terminals still
	 * have a truncation-safe copy target (viewport clipping on a long authorize
	 * URL silently drops trailing OAuth query parameters — e.g.
	 * `code_challenge_method=S256`). Every physical URL row carries its own OSC 8
	 * link to the full URL, so clicking any wrapped fragment opens the same target.
	 */
	showAuth(url: string, instructions?: string, launchUrl?: string): void {
		this.#contentContainer.clear();
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new WidthAwareText(
				contentWidth =>
					wrapTextWithAnsi(url, contentWidth)
						.map(row => theme.fg("accent", urlHyperlinkAlways(url, row)))
						.join("\n"),
				0,
				0,
			),
		);

		const clickHint = `${formatKeyHint(keyHintPlatform() === "darwin" ? "super" : "ctrl")}+click to open`;
		const hyperlink = `\x1b]8;;${url}\x07${clickHint}\x1b]8;;\x07`;
		this.#contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 0, 0));

		if (launchUrl && launchUrl !== url) {
			this.#contentContainer.addChild(
				new Text(theme.fg("dim", `Local shortcut (this machine only): ${launchUrl}`), 0, 0),
			);
		}

		if (instructions) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("warning", instructions), 0, 0));
		}

		const plain = instructions ? plainText(instructions) : undefined;
		const device = plain ? DEVICE_CODE_INSTRUCTIONS.exec(plain) : null;
		this.#nativeAuth = {
			url,
			launchUrl: launchUrl && launchUrl !== url ? launchUrl : undefined,
			instructions: plain,
			device: device ? { code: device[2]! } : undefined,
		};
		this.#nativeSteps = [];
		this.#nativeRoot = undefined;

		// Open browser (best-effort)
		this.#openUrl(url);

		this.#tui.requestRender();
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string, signal?: AbortSignal): Promise<string> {
		// Keep retry chrome in place, but discard prior prompt undo/kill history.
		const mounted = this.#contentContainer.children.indexOf(this.#input);
		const previousInput = this.#input;
		this.#replaceInput();
		const nativeMounted = this.#nativeSteps.find(step => step.kind === "input" && step.field === previousInput);
		if (mounted !== -1) {
			// The flow asks again only when the last paste carried no usable code.
			this.#input.setError(RETRY_MESSAGE);
			this.#contentContainer.children.splice(mounted, 1, this.#input);
			if (nativeMounted?.kind === "input") nativeMounted.field = this.#input;
		} else {
			this.#nativeSteps.push({ kind: "input", message: plainText(prompt), field: this.#input });
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("dim", prompt), 0, 0));
			this.#contentContainer.addChild(this.#input);
			this.#contentContainer.addChild(
				new Text(theme.fg("dim", `(${editorKey("tui.select.cancel")} to cancel)`), 0, 0),
			);
		}
		this.#nativeRoot = undefined;
		this.#tui.requestRender();

		if (signal?.aborted) {
			return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Login input cancelled"));
		}
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#inputResolver = resolve;
		this.#inputRejecter = reject;
		if (signal) {
			const onAbort = () => {
				if (this.#inputRejecter !== reject) return;
				this.#clearInputHandlers();
				reject(signal.reason instanceof Error ? signal.reason : new Error("Login input cancelled"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.#inputAbortCleanup = () => signal.removeEventListener("abort", onAbort);
		}
		return promise;
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
	 */
	showPrompt(prompt: OAuthPrompt): Promise<string> {
		// Multi-step flows keep prior answers visible, except secrets.
		const mounted = this.#contentContainer.children.indexOf(this.#input);
		if (mounted !== -1) {
			const value = this.#input.input.mask ? "********" : this.#input.getValue();
			const answer = new Text(theme.fg("dim", `${this.#input.input.prompt}${value}`), 0, 0);
			this.#contentContainer.removeChild(this.#input);
			this.#contentContainer.children.splice(mounted, 0, answer);
			const answered = this.#nativeSteps.find(step => step.kind === "input" && step.field === this.#input);
			if (answered?.kind === "input") answered.answer = value;
		}
		// A new prompt must not recover a previous secret through undo or yank.
		this.#replaceInput(prompt.secret === true);
		if (prompt.placeholder) this.#input.input.placeholder = plainText(prompt.placeholder);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("text", prompt.message), 0, 0));
		if (prompt.placeholder) {
			this.#contentContainer.addChild(new Text(theme.fg("dim", `e.g., ${prompt.placeholder}`), 0, 0));
		}
		this.#contentContainer.addChild(this.#input);
		this.#contentContainer.addChild(
			new Text(
				theme.fg(
					"dim",
					`(${editorKey("tui.select.cancel")} to cancel, ${editorKey("tui.input.submit")} to submit)`,
				),
				0,
				0,
			),
		);
		this.#nativeSteps.push({ kind: "input", message: plainText(prompt.message), field: this.#input });
		this.#nativeRoot = undefined;

		this.#tui.requestRender();

		this.#inputAbortCleanup?.();
		this.#inputAbortCleanup = undefined;
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#inputResolver = resolve;
		this.#inputRejecter = reject;
		return promise;
	}

	#clearInputHandlers(): void {
		this.#inputAbortCleanup?.();
		this.#inputAbortCleanup = undefined;
		this.#inputResolver = undefined;
		this.#inputRejecter = undefined;
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("dim", message), 0, 0));
		this.#contentContainer.addChild(new Text(theme.fg("dim", `(${editorKey("tui.select.cancel")} to cancel)`), 0, 0));
		this.#nativeSteps.push({ kind: "progress", message: plainText(message) });
		this.#nativeRoot = undefined;
		this.#tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		this.#contentContainer.addChild(new Text(theme.fg("dim", message), 0, 0));
		this.#nativeSteps.push({ kind: "progress", message: plainText(message) });
		this.#nativeRoot = undefined;
		this.#tui.requestRender();
	}

	/**
	 * A glass sheet over the composer (the dialog replaces the editor in the
	 * dock; the `overlay` hoists into the terminal's layer). Top to bottom: one
	 * sentence saying what to do, the device code as a large click-to-copy
	 * well, the sign-in link as a read-only field with Copy, the questions
	 * (answered ones as label/value lines, the live one as a field), and the
	 * flow's status — finished stages checked, the current one spinning. The
	 * footer holds Cancel and one primary action: Continue while a field waits
	 * for an answer (Open sign-in page then leads the footer as a plain
	 * button), else Open sign-in page.
	 */
	override describe(): NativeNode {
		if (this.#nativeRoot) return this.#nativeRoot;
		const auth = this.#nativeAuth;
		const field = this.#activeField();
		const body: NativeChild[] = [];
		if (auth) {
			body.push(keyed(text(this.#lead(auth), { role: "omp.login.lead", wrap: "word" }), "lead"));
			if (auth.device) body.push(this.#describeCode(auth.device.code));
			body.push(this.#describeLink(auth.url));
			if (auth.launchUrl) {
				body.push(
					keyed(
						text([span("On this machine  ", "dim"), span(auth.launchUrl, "mono", { href: auth.launchUrl })], {
							role: "omp.login.shortcut",
							truncate: "middle",
							lines: 1,
							title: auth.launchUrl,
						}),
						"shortcut",
					),
				);
			}
		}
		const status: NativeNode[] = [];
		const live = this.#nativeSteps.findLastIndex(step => step.kind === "progress");
		for (const [index, step] of this.#nativeSteps.entries()) {
			if (step.kind === "progress") {
				status.push(
					index === live
						? this.#describeLive(step.message, `p${index}`)
						: this.#describeDone(step.message, `p${index}`),
				);
				continue;
			}
			// A field label: the footer's Continue says the prompt's `then press Enter`.
			const label = step.message.trim().replace(PRESS_KEY_SUFFIX, "").replace(/:$/, "");
			if (step.answer !== undefined) {
				body.push(
					node(
						"row",
						{ role: "omp.login.answer", gap: "sm", align: "baseline" },
						[
							keyed(text(label, { truncate: "end", lines: 1 }), "label"),
							keyed(text(step.answer || "—", { truncate: "end", lines: 1 }), "value"),
						],
						`a${index}`,
					),
				);
			} else {
				body.push(
					node(
						"col",
						{ role: "omp.login.prompt", gap: "sm" },
						[keyed(text(label, { role: "omp.login.label", wrap: "word" }), "label"), step.field],
						`i${index}`,
					),
				);
			}
		}
		// The provider reports nothing while the browser half runs (GitHub's device poll): say so.
		if (auth && live === -1 && !field) status.push(this.#describeLive(BROWSER_WAIT, "browser"));
		if (status.length > 0) body.push(node("col", { role: "omp.login.status", gap: "xs" }, status, "status"));

		const cancelKey = getKeybindings().getKeys("tui.select.cancel")[0];
		const cancel = actionButton("Cancel", "cancel", cancelKey ? { keys: cancelKey } : {});
		const open = auth ? this.#describeOpen(auth.url, !field) : null;
		let buttons: (NativeNode | null)[];
		if (field) {
			const submitKey = getKeybindings().getKeys("tui.input.submit")[0];
			const submit = actionButton("Continue", "submit", {
				tone: "accent",
				...(submitKey ? { keys: submitKey } : {}),
			});
			buttons = open ? [open, null, cancel, submit] : [null, cancel, submit];
		} else {
			buttons = open ? [null, cancel, open] : [null, cancel];
		}
		const sheet = node(
			"overlay",
			{
				role: this.nativeRole,
				head: `Sign in to ${this.#providerName}`,
				anchor: "center",
				size: "md",
				modal: true,
			},
			[col([node("col", { role: "omp.login.body", gap: "md" }, body, "body"), actionBar(buttons)], { gap: "lg" })],
			"sheet",
		);
		this.#nativeRoot = col([sheet]);
		return this.#nativeRoot;
	}

	/** What to do, in one sentence: enter the code, follow the provider's instructions, or finish in the browser. */
	#lead(auth: LoginAuth): string {
		if (auth.device) return "Enter this code on the sign-in page to connect your account.";
		if (auth.instructions) return sheetText(auth.instructions);
		return "Continue in your browser. If it didn't open, open or copy the link below.";
	}

	/** The device code, large in a well; a click copies it. */
	#describeCode(code: string): NativeNode {
		return node(
			"row",
			{ role: "omp.login.code", align: "center", actions: { click: "copy" }, href: code, title: "Copy code" },
			[keyed(text([span(code, "mono")]), "value"), node("icon", { name: "copy" }, undefined, "icon")],
			"code",
		);
	}

	/** The sign-in link as a read-only field: the full URL (middle-truncated; a click opens it) and Copy. */
	#describeLink(url: string): NativeNode {
		const shown = text([span(url, "mono", { href: url })], {
			role: "omp.login.url",
			truncate: "middle",
			lines: 1,
			title: url,
		});
		return node(
			"row",
			{ role: "omp.login.link", gap: "sm", align: "center" },
			[
				node("icon", { name: "link" }, undefined, "icon"),
				keyed(shown, "url"),
				node(
					"row",
					{
						role: "omp.btn",
						align: "center",
						actions: { click: "copy" },
						href: url,
						title: "Copy the sign-in link",
					},
					[text("Copy")],
					"copyLink",
				),
			],
			"link",
		);
	}

	/** Open sign-in page (Tern opens the link itself): the primary action while nothing waits for an answer. */
	#describeOpen(url: string, primary: boolean): NativeNode {
		return node(
			"row",
			{
				role: "omp.btn",
				gap: "xs",
				align: "center",
				actions: { click: "open" },
				href: url,
				title: `Open ${urlPlace(url)} in your browser`,
				...(primary ? { tone: "accent" as const } : {}),
			},
			[text("Open sign-in page"), node("icon", { name: "open" }, undefined, "icon")],
			"openLink",
		);
	}

	/** The stage running now: a spinner and what it waits for. */
	#describeLive(message: string, key: string): NativeNode {
		return node(
			"row",
			{ role: "omp.login.waiting", gap: "sm", align: "center" },
			[node("spinner", { style: "orbit", label: sheetText(message), tone: "muted" })],
			key,
		);
	}

	/** A finished stage, checked; one that reported a problem keeps a warning mark. */
	#describeDone(message: string, key: string): NativeNode {
		const problem = PROGRESS_PROBLEM.test(message);
		return node(
			"row",
			{ role: "omp.login.done", gap: "sm", align: "baseline", ...(problem ? { tone: "warning" as const } : {}) },
			[
				node("icon", { name: problem ? "warn" : "check" }, undefined, "icon"),
				keyed(text(sheetText(message).replace(/…$/, ""), { wrap: "word" }), "text"),
			],
			key,
		);
	}

	/** The input field still waiting for an answer, if any. */
	#activeField(): TextFormField | undefined {
		for (let i = this.#nativeSteps.length - 1; i >= 0; i--) {
			const step = this.#nativeSteps[i]!;
			if (step.kind === "input" && step.answer === undefined && step.field === this.#input) return step.field;
		}
		return undefined;
	}

	/** Cancel and Continue run what Esc and Enter run. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (event.act === "cancel") this.#cancel();
		else if (event.act === "submit") this.#activeField()?.submit();
	}

	/** Route non-bracketed paste transports into the active login input. */
	pasteText(text: string): void {
		this.#input.pasteText(text);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.#cancel();
			return;
		}

		// Pass to input
		this.#input.handleInput(data);
	}
}
