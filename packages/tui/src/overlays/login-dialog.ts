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

/** One native step after the sign-in link: a text answer (live or given) or a progress message. */
type LoginStep =
	| { kind: "input"; message: string; placeholder?: string; paste: boolean; field: TextFormField; answer?: string }
	| { kind: "progress"; message: string };

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends OverlayPanel {
	#contentContainer: Container;
	#input: TextFormField;
	#tui: TUI;
	#onComplete: (success: boolean, message?: string) => void;
	#openUrl: (url: string) => void;
	#abortController = new AbortController();
	#inputResolver?: (value: string) => void;
	#inputRejecter?: (error: Error) => void;
	#inputAbortCleanup?: () => void;
	readonly #providerName: string;
	/** The sign-in link from `showAuth` (native step 1 and the device code). */
	#nativeAuth: { url: string; launchUrl?: string; instructions?: string } | undefined;
	/** Native steps after the link, in arrival order; the live input field is embedded by identity. */
	#nativeSteps: LoginStep[] = [];
	#nativeRoot: NativeNode | undefined;

	constructor(
		tui: TUI,
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

	#createInput(secret = false): TextFormField {
		return new TextFormField({
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

		this.#nativeAuth = {
			url,
			launchUrl: launchUrl && launchUrl !== url ? launchUrl : undefined,
			instructions: instructions ? plainText(instructions) : undefined,
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
		this.#input = this.#createInput();
		const nativeMounted = this.#nativeSteps.find(step => step.kind === "input" && step.field === previousInput);
		if (mounted !== -1) {
			this.#contentContainer.children.splice(mounted, 1, this.#input);
			if (nativeMounted?.kind === "input") nativeMounted.field = this.#input;
		} else {
			this.#nativeSteps.push({ kind: "input", message: plainText(prompt), paste: true, field: this.#input });
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
			if (answered?.kind === "input") answered.answer = `${plainText(this.#input.input.prompt)}${value}`;
		}
		// A new prompt must not recover a previous secret through undo or yank.
		this.#input = this.#createInput(prompt.secret === true);
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
		this.#nativeSteps.push({
			kind: "input",
			message: plainText(prompt.message),
			placeholder: prompt.placeholder ? plainText(prompt.placeholder) : undefined,
			paste: false,
			field: this.#input,
		});
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
	 * dock; the `overlay` hoists into the terminal's layer): numbered steps —
	 * open or copy the sign-in link, the device code, the live wait, the paste
	 * field — and Cancel.
	 */
	override describe(): NativeNode {
		if (this.#nativeRoot) return this.#nativeRoot;
		const steps: NativeChild[] = [];
		const auth = this.#nativeAuth;
		if (auth) {
			steps.push(this.#describeLinkStep(auth.url, auth.launchUrl));
			if (auth.instructions) steps.push(this.#describeInstructionsStep(auth.instructions));
		}
		const live = this.#nativeSteps.findLastIndex(step => step.kind === "progress");
		// Progress messages share one step: settled ones dim, the latest one the live spinner.
		let progress: NativeChild[] | undefined;
		for (const [index, step] of this.#nativeSteps.entries()) {
			if (step.kind === "progress") {
				const line =
					index === live
						? node("row", { role: "omp.login.waiting", gap: "sm", align: "center" }, [
								node("spinner", { label: step.message, tone: "muted" }),
							])
						: text([span(step.message, "dim")], { wrap: "word" });
				if (progress) {
					progress.push(line);
				} else {
					progress = [line];
					steps.push(node("col", { role: "omp.login.step", gap: "xs" }, progress, `p${index}`));
				}
				continue;
			}
			if (step.answer !== undefined) {
				steps.push(keyed(text([span(step.answer, "dim")]), `a${index}`));
				continue;
			}
			const children: NativeChild[] = [text(step.message, { wrap: "word" })];
			if (step.placeholder) children.push(text([span(`e.g., ${step.placeholder}`, "dim")]));
			children.push(node("col", { role: "omp.login.paste" }, [step.field], "field"));
			steps.push(node("col", { role: "omp.login.step", gap: "xs" }, children, `i${index}`));
		}
		const cancelKey = getKeybindings().getKeys("tui.select.cancel")[0];
		const buttons: (NativeNode | null)[] = [
			null,
			actionButton("Cancel", "cancel", cancelKey ? { keys: cancelKey } : {}),
		];
		if (this.#activeField()) {
			const submitKey = getKeybindings().getKeys("tui.input.submit")[0];
			buttons.push(
				actionButton("Continue", "submit", { tone: "accent", ...(submitKey ? { keys: submitKey } : {}) }),
			);
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
			[
				col([node("col", { role: "omp.login.steps", gap: "md" }, steps, "steps"), actionBar(buttons)], {
					gap: "lg",
				}),
			],
			"sheet",
		);
		this.#nativeRoot = col([sheet]);
		return this.#nativeRoot;
	}

	/** Step 1: open the sign-in page (Tern opens the link) or copy it; the full URL beneath on one mono line. */
	#describeLinkStep(url: string, launchUrl: string | undefined): NativeNode {
		const children: NativeChild[] = [
			actionBar(
				[
					actionButton("Open sign-in page ↗", "open", { href: url, key: "openLink", title: url }),
					actionButton("Copy link", "copy", { href: url, key: "copyLink", title: "Copy the sign-in link" }),
				],
				"links",
			),
			text([span(url, "dim mono", { href: url })], {
				role: "omp.login.url",
				truncate: "middle",
				lines: 1,
				title: url,
			}),
		];
		if (launchUrl) {
			children.push(
				text(
					[span("Local shortcut (this machine only): ", "dim"), span(launchUrl, "dim link", { href: launchUrl })],
					{
						truncate: "middle",
						lines: 1,
					},
				),
			);
		}
		return node("col", { role: "omp.login.step", gap: "sm" }, children, "link");
	}

	/** Step 2: a device code large and click-to-copy, or the provider's instructions as they came. */
	#describeInstructionsStep(instructions: string): NativeNode {
		const device = DEVICE_CODE_INSTRUCTIONS.exec(instructions);
		const children: NativeChild[] = device
			? [
					text(device[1]!.trimEnd()),
					text([span(device[2]!, "mono")], {
						role: "omp.login.code",
						actions: { click: "copy" },
						title: "Copy code",
					}),
				]
			: [text([span(instructions, "warning")], { wrap: "word" })];
		return node("col", { role: "omp.login.step", gap: "sm" }, children, "code");
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
