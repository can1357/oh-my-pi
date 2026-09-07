import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";
import type { OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import {
	type Component,
	type Focusable,
	Input,
	matchesKey,
	type SgrMouseEvent,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { copyToClipboard } from "../../../utils/clipboard";
import { OAuthSelectorComponent } from "../../components/oauth-selector";
import { theme } from "../../theme/theme";
import type { SetupSceneHost, SetupTab } from "./types";

function loginUrlLink(url: string): string {
	return `\x1b]8;;${url}\x07Open login URL\x1b]8;;\x07`;
}

function loginCopyHint(): string {
	return theme.fg("dim", "(clipboard copy attempted; Alt+C retries)");
}

class CopyablePromptInput implements Component, Focusable {
	#input: Input;
	#onCopy: () => void;

	constructor(input: Input, onCopy: () => void) {
		this.#input = input;
		this.#onCopy = onCopy;
	}

	get focused(): boolean {
		return this.#input.focused;
	}

	set focused(value: boolean) {
		this.#input.focused = value;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#input.setUseTerminalCursor(useTerminalCursor);
	}

	render(width: number): readonly string[] {
		return this.#input.render(width);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "alt+c")) {
			this.#onCopy();
			return;
		}
		this.#input.handleInput(data);
	}

	invalidate(): void {
		this.#input.invalidate();
	}
}

interface PromptState {
	message: string;
	placeholder?: string;
	input: CopyablePromptInput;
}

/**
 * "Sign in" panel: lets the user authenticate one or more model providers via
 * OAuth. Unlike a standalone scene it never auto-advances the wizard — the user
 * may sign in to several providers and then continue with Esc.
 */
export class SignInTab implements SetupTab {
	readonly id = "sign-in";
	readonly label = "Sign in";

	#authStorage: AuthStorage;
	#selector: OAuthSelectorComponent;
	#statusLines: string[] = [];
	#authUrl: string | undefined;
	#authLaunchUrl: string | undefined;
	#prompt: PromptState | undefined;
	#promptResolve: ((value: string) => void) | undefined;
	#promptReject: ((error: Error) => void) | undefined;
	#promptAbortCleanup: (() => void) | undefined;
	#loginAbort: AbortController | undefined;
	#loggingInProvider: string | undefined;
	#disposed = false;
	/** Render line where the provider selector begins. */
	#selectorRowStart = 2;

	constructor(private readonly host: SetupSceneHost) {
		this.#authStorage = host.ctx.session.modelRegistry.authStorage;
		this.#selector = this.#createSelector();
	}

	/** Modal while an OAuth flow is running so the scene won't switch tabs or finish. */
	get modal(): boolean {
		return this.#loggingInProvider !== undefined;
	}

	dispose(): void {
		this.#disposed = true;
		this.#selector.stopValidation();
		this.#loginAbort?.abort();
		this.#resolvePrompt("");
	}

	invalidate(): void {
		this.#selector.invalidate();
		this.#prompt?.input.invalidate();
	}

	handleInput(data: string): void {
		if (this.#loggingInProvider) {
			if (this.#authUrl && (matchesKey(data, "alt+c") || (data === "c" && !this.#prompt))) {
				void this.#copyAuthUrl();
				return;
			}
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.#loginAbort?.abort();
			}
			return;
		}
		this.#selector.handleInput(data);
	}

	/** Forward mouse to the provider selector; pointer is inert during an active login or code prompt. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#loggingInProvider || this.#prompt) return;
		this.#selector.routeMouse(event, line - this.#selectorRowStart, col);
	}

	render(width: number, maxLines?: number): readonly string[] {
		const lines: string[] = [];
		if (this.#loggingInProvider) {
			lines.push(theme.bold(`Signing in to ${this.#loggingInProvider}`));
		} else {
			// Hint + blank cost two rows; the wizard subtitle already explains
			// this panel, so on short screens the rows go to the provider list
			// instead (17 = full selector: 4 chrome above, 10 rows, 3 below).
			if (maxLines === undefined || maxLines >= 17 + 2) {
				lines.push(theme.fg("muted", "Pick a provider to sign in — you can connect more than one."), "");
			}
			this.#selectorRowStart = lines.length;
			if (maxLines !== undefined) this.#selector.setMaxHeight(maxLines - lines.length);
			lines.push(...this.#selector.render(width));
		}

		const urlLines = this.#authUrl ? wrapTextWithAnsi(theme.fg("dim", this.#authUrl), width) : [];
		if (this.#authUrl) {
			lines.push(
				theme.fg("accent", `Browser login: ${loginUrlLink(this.#authUrl)} ${loginCopyHint()}`),
				...urlLines.slice(0, 2),
			);
			if (this.#authLaunchUrl) {
				lines.push(theme.fg("dim", `Local shortcut (this machine only): ${this.#authLaunchUrl}`));
			}
		}
		if (this.#prompt) {
			lines.push(theme.fg("warning", this.#prompt.message));
			if (this.#prompt.placeholder) {
				lines.push(theme.fg("dim", this.#prompt.placeholder));
			}
			lines.push(this.#prompt.input.render(width)[0] ?? "");
		}
		if (urlLines.length > 2) {
			lines.push(...urlLines);
		}
		if (this.#statusLines.length > 0) {
			lines.push(...this.#statusLines.flatMap(line => wrapTextWithAnsi(line, width)));
		}
		return lines;
	}

	#createSelector(): OAuthSelectorComponent {
		return new OAuthSelectorComponent(
			"login",
			this.#authStorage,
			providerId => {
				void this.#login(providerId);
			},
			() => this.host.finish("skipped"),
			{ requestRender: () => this.host.requestRender() },
		);
	}

	async #login(providerId: string): Promise<void> {
		if (this.#loggingInProvider || this.#disposed) return;
		const useManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		this.#selector.stopValidation();
		this.#loggingInProvider = providerId;
		this.#statusLines = [theme.fg("dim", "Starting OAuth flow…")];
		this.#authUrl = undefined;
		this.#authLaunchUrl = undefined;
		this.#loginAbort = new AbortController();
		this.host.restoreFocus();
		this.host.requestRender();
		try {
			await this.#authStorage.login(providerId as OAuthProvider, {
				signal: this.#loginAbort.signal,
				onAuth: info => {
					// Store the full authorization URL as the primary copy/display
					// target: it works from any machine, including SSH boxes where
					// the OMP-hosted `launchUrl` would resolve against the user's
					// local browser and fail. The wizard render uses
					// `wrapTextWithAnsi`, so long URLs wrap across lines rather
					// than getting truncated — the RFC 7636 §4.3 PKCE-downgrade
					// bug that motivated `launchUrl` is unreachable through this
					// surface. `launchUrl` is still surfaced as an optional local
					// shortcut for wide-terminal local users.
					this.#authUrl = info.url;
					this.#authLaunchUrl = info.launchUrl && info.launchUrl !== info.url ? info.launchUrl : undefined;
					this.#statusLines = [];
					if (info.instructions) {
						this.#statusLines.push(theme.fg("warning", info.instructions));
					}
					if (useManualInput) {
						this.#statusLines.push(theme.fg("dim", "Paste the returned code or redirect URL when prompted."));
					}
					void this.#copyAuthUrl();
					this.host.ctx.openInBrowser(info.url);
					this.host.requestRender();
				},
				onPrompt: prompt => this.#showPrompt(prompt),
				onProgress: message => {
					this.#statusLines.push(theme.fg("dim", message));
					this.host.requestRender();
				},
				onManualCodeInput: signal =>
					this.#showPrompt({ message: "Paste the authorization code (or full redirect URL):" }, signal),
			});
			// Provider-scoped online refresh so the just-persisted credential re-runs
			// discovery instead of reusing a fresh authoritative cache row (#5780).
			await this.host.ctx.session.modelRegistry.refreshProvider(providerId, "online");
			if (this.#disposed) return;
			this.#statusLines = [
				theme.fg("success", `${theme.status.success} Signed in to ${providerId}`),
				theme.fg("dim", `Credentials saved to ${getAgentDbPath()}`),
			];
			this.#authUrl = undefined;
			this.#authLaunchUrl = undefined;
			this.#loggingInProvider = undefined;
			this.#loginAbort = undefined;
			this.#selector.stopValidation();
			this.#selector = this.#createSelector();
			this.host.restoreFocus();
			this.host.requestRender();
		} catch (error) {
			if (this.#disposed) return;
			if (this.#loginAbort?.signal.aborted) {
				this.#statusLines = [theme.fg("dim", "Login cancelled.")];
				this.#authUrl = undefined;
				this.#authLaunchUrl = undefined;
			} else {
				const message = error instanceof Error ? error.message : String(error);
				this.#statusLines = [
					theme.fg("error", `Login failed: ${message}`),
					theme.fg("dim", "Choose another provider or press Esc to continue."),
				];
				this.#authUrl = undefined;
				this.#authLaunchUrl = undefined;
			}
			this.#loggingInProvider = undefined;
			this.#loginAbort = undefined;
			this.host.restoreFocus();
			this.host.requestRender();
		}
	}

	async #copyAuthUrl(): Promise<void> {
		const url = this.#authUrl;
		if (!url) return;
		try {
			await copyToClipboard(url);
		} catch {
			// Clipboard integration is best-effort; the full URL remains rendered below.
		}
		this.host.requestRender();
	}

	#showPrompt(prompt: { message: string; placeholder?: string }, signal?: AbortSignal): Promise<string> {
		this.#resolvePrompt("");
		if (signal?.aborted) {
			return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Login input cancelled"));
		}
		const input = new Input();
		const focusInput = new CopyablePromptInput(input, () => {
			void this.#copyAuthUrl();
		});
		const pending = Promise.withResolvers<string>();
		this.#promptResolve = pending.resolve;
		this.#promptReject = pending.reject;
		this.#prompt = { message: prompt.message, placeholder: prompt.placeholder, input: focusInput };
		if (signal) {
			const onAbort = () => {
				if (this.#promptReject !== pending.reject) return;
				this.#rejectPrompt(signal.reason instanceof Error ? signal.reason : new Error("Login input cancelled"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.#promptAbortCleanup = () => signal.removeEventListener("abort", onAbort);
		}
		input.onSubmit = value => {
			this.#resolvePrompt(value);
		};
		input.onEscape = () => {
			this.#loginAbort?.abort();
			this.#resolvePrompt("");
		};
		this.host.setFocus(focusInput);
		this.host.requestRender();
		return pending.promise;
	}

	#resolvePrompt(value: string): void {
		const resolve = this.#promptResolve;
		if (!resolve) return;
		this.#clearPrompt();
		resolve(value);
	}

	#rejectPrompt(error: Error): void {
		const reject = this.#promptReject;
		if (!reject) return;
		this.#clearPrompt();
		reject(error);
	}

	#clearPrompt(): void {
		this.#promptAbortCleanup?.();
		this.#promptAbortCleanup = undefined;
		this.#promptResolve = undefined;
		this.#promptReject = undefined;
		this.#prompt = undefined;
		this.host.restoreFocus();
		this.host.requestRender();
	}
}
