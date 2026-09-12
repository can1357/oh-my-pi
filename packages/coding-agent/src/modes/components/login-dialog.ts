import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { Container, getKeybindings, Input, Spacer, Text, type TUI, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";
import { urlHyperlinkAlways, WidthAwareText } from "../../tui";
import { openPath } from "../../utils/open";
import { OverlayPanel } from "./overlay-box";

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends OverlayPanel {
	#contentContainer: Container;
	#input: Input;
	#tui: TUI;
	#abortController = new AbortController();
	#inputResolver?: (value: string) => void;
	#inputRejecter?: (error: Error) => void;
	#inputAbortCleanup?: () => void;

	constructor(
		tui: TUI,
		providerId: string,
		private onComplete: (success: boolean, message?: string) => void,
	) {
		const providerInfo = getOAuthProviders().find(p => p.id === providerId);
		const providerName = providerInfo?.name || providerId;
		super(`Login to ${providerName}`);
		this.#tui = tui;

		// Dynamic content area
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		// Input (always present, used when needed)
		this.#input = new Input();
		this.#input.onSubmit = () => {
			const resolve = this.#inputResolver;
			if (!resolve) return;
			this.#clearInputHandlers();
			resolve(this.#input.getValue());
		};
		this.#input.onEscape = () => {
			this.#cancel();
		};
	}

	get signal(): AbortSignal {
		return this.#abortController.signal;
	}

	#cancel(): void {
		this.#abortController.abort();
		const reject = this.#inputRejecter;
		this.#clearInputHandlers();
		reject?.(new Error("Login cancelled"));
		this.onComplete(false, "Login cancelled");
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

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
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

		// Open browser (best-effort)
		openPath(url);

		this.#tui.requestRender();
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string, signal?: AbortSignal): Promise<string> {
		// Invalid pastes re-prompt (the OAuth callback loop calls this again), so
		// reuse the already-mounted input instead of stacking duplicate prompt and
		// hint lines beneath the dialog. Reset the value so each retry starts clean.
		if (!this.#contentContainer.children.includes(this.#input)) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("dim", prompt), 0, 0));
			this.#contentContainer.addChild(this.#input);
			this.#contentContainer.addChild(new Text(theme.fg("dim", "(Escape to cancel)"), 0, 0));
		}
		this.#input.setValue("");
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
	showPrompt(message: string, placeholder?: string): Promise<string> {
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("text", message), 0, 0));
		if (placeholder) {
			this.#contentContainer.addChild(new Text(theme.fg("dim", `e.g., ${placeholder}`), 0, 0));
		}
		if (!this.#contentContainer.children.includes(this.#input)) {
			this.#contentContainer.addChild(this.#input);
		}
		this.#contentContainer.addChild(new Text(theme.fg("dim", "(Escape to cancel, Enter to submit)"), 0, 0));

		this.#input.setValue("");
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
		this.#contentContainer.addChild(new Text(theme.fg("dim", "(Escape to cancel)"), 0, 0));
		this.#tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		this.#contentContainer.addChild(new Text(theme.fg("dim", message), 0, 0));
		this.#tui.requestRender();
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
