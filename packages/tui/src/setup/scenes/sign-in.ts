import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";
import type { OAuthPrompt, OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import { type Component, type Focusable, Container } from "../../tui";
import { Spacer } from "../../components/spacer";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { Input } from "../../components/input";
import { formatKeyHint } from "../../app-keybindings";
import { editorKey } from "../../chrome/keybinding-hints";
import { matchesKey } from "../../keys";
import { type SgrMouseEvent } from "../../mouse";
import { wrapTextWithAnsi } from "../../utils";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { OAuthSelectorComponent } from "../../overlays/oauth-selector";
import { theme } from "../../theme/theme";
import { col, node, span, text } from "../../native/describe";
import type { NativeChild, NativeNode } from "../../native/node";
import { Memo } from "../../native/memo";
import type { SetupScene, SetupSceneController, SetupSceneHost, StyledLine } from "./types";

function loginUrlLink(url: string): string {
	return `\x1b]8;;${url}\x07Open login URL\x1b]8;;\x07`;
}

function loginCopyHint(): string {
	return theme.fg("dim", `(clipboard copy attempted; ${formatKeyHint("alt+c")} retries)`);
}

class CopyablePromptInput implements Component, Focusable {
	#input: Input;
	#onCopy: () => void;
	readonly #native: NativeNode;

	constructor(input: Input, onCopy: () => void) {
		this.#input = input;
		this.#onCopy = onCopy;
		this.#native = col([input]);
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

	/** The wrapped field describes itself (`input`, caret while focused); alt+c stays a key here. */
	describe(): NativeNode {
		return this.#native;
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
 * "Sign in" scene: lets the user authenticate one or more model providers via
 * OAuth. It never auto-advances the wizard — the user may sign in to several
 * providers and then continue with Esc.
 */
export class SignInScene implements SetupSceneController {
	readonly title = "Sign in to your providers";
	get subtitle(): string {
		return `Sign in to one or more providers. Press ${editorKey("tui.select.cancel")} when you're done.`;
	}

	#authStorage: AuthStorage;
	#selector: OAuthSelectorComponent;
	/** Status copy under the selector or login flow; replaced (never mutated) on change. */
	#statusLines: readonly StyledLine[] = [];
	#authUrl: string | undefined;
	#authLaunchUrl: string | undefined;
	#prompt: PromptState | undefined;
	#promptResolve: ((value: string) => void) | undefined;
	#promptReject: ((error: Error) => void) | undefined;
	#promptAbortCleanup: (() => void) | undefined;
	#loginAbort: AbortController | undefined;
	#loggingInProvider: string | undefined;
	#removingProvider: string | undefined;
	#disposed = false;
	#step: WizardStep | undefined;
	#native = new Memo();

	readonly #host: SetupSceneHost;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		this.#authStorage = host.ctx.authStorage;
		this.#selector = this.#createSelector();
	}

	dispose(): void {
		this.#disposed = true;
		this.#selector.stopValidation();
		this.#loginAbort?.abort();
		this.#resolvePrompt("");
	}

	invalidate(): void {
		this.#native.clear();
		this.#step?.invalidate();
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
		if (this.#removingProvider) {
			this.#selector.handleInput(data);
			return;
		}
		this.#selector.handleInput(data);
	}

	/** Forward mouse to the provider selector; pointer is inert during an active login or code prompt. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#loggingInProvider || this.#prompt) return;
		this.#step?.routeMouse(event, line, col);
	}

	render(width: number, maxLines?: number): readonly string[] {
		// Hint + blank cost two rows; the wizard subtitle already explains
		// this panel, so on short screens the rows go to the provider list
		// instead (17 = full selector: 4 chrome above, 10 rows, 3 below).
		let intro: Container | undefined;
		if (this.#loggingInProvider === undefined && (maxLines === undefined || maxLines >= 17 + 2)) {
			intro = new Container();
			intro.addChild(
				new Text(theme.fg("muted", "Pick a provider to sign in — you can connect more than one."), 0, 0),
			);
			intro.addChild(new Spacer(1));
		}
		const tail = new Container();
		const urlLines = this.#authUrl ? wrapTextWithAnsi(theme.fg("dim", this.#authUrl), width) : [];
		if (this.#authUrl) {
			tail.addChild(
				new Text(theme.fg("accent", `Browser login: ${loginUrlLink(this.#authUrl)} ${loginCopyHint()}`), 0, 0),
			);
			// Keep one URL row above the prompt; repeat the complete wrapped URL
			// below so the input remains visible in the wizard's short viewport.
			if (urlLines[0]) tail.addChild(new Text(urlLines[0], 0, 0));
			if (this.#authLaunchUrl) {
				tail.addChild(
					new Text(theme.fg("dim", `Local shortcut (this machine only): ${this.#authLaunchUrl}`), 0, 0),
				);
			}
		}
		if (this.#prompt) {
			tail.addChild(new Text(theme.fg("warning", this.#prompt.message), 0, 0));
			if (this.#prompt.placeholder) {
				tail.addChild(new Text(theme.fg("dim", this.#prompt.placeholder), 0, 0));
			}
			tail.addChild(this.#prompt.input);
		}
		if (urlLines.length > 1) {
			for (const line of urlLines) {
				tail.addChild(new Text(line, 0, 0));
			}
		}
		for (const line of this.#statusLines) {
			for (const wrapped of wrapTextWithAnsi(theme.fg(line.color, line.text), width)) {
				tail.addChild(new Text(wrapped, 0, 0));
			}
		}
		if (!this.#step) {
			this.#step = new WizardStep({
				kind: "choice",
				content: this.#selector,
				gap: 0,
				fitContent: budget => {
					if (budget !== undefined) this.#selector.setMaxHeight(budget);
				},
			});
		}
		if (this.#loggingInProvider) {
			this.#step.setKind("async");
			this.#step.setHeading(new Text(theme.bold(`Signing in to ${this.#loggingInProvider}`), 0, 0));
			this.#step.setIntro(undefined);
			this.#step.setContent(tail);
			this.#step.setStatus(undefined);
		} else {
			this.#step.setKind("choice");
			this.#step.setHeading(undefined);
			this.#step.setIntro(intro);
			this.#step.setContent(this.#selector);
			this.#step.setStatus(tail);
		}
		this.#step.setMaxHeight(maxLines);
		return this.#step.render(width);
	}

	/**
	 * Picking: intro, the provider selector (describes itself) and the last
	 * outcome. Signing in: a spinner heading, the login link (with the full
	 * URL once, char-wrapped), any code prompt and the flow's progress lines.
	 */
	describe(): NativeNode {
		const provider = this.#loggingInProvider;
		const authUrl = this.#authUrl;
		const launchUrl = this.#authLaunchUrl;
		const prompt = this.#prompt;
		const statusLines = this.#statusLines;
		const copyKey = formatKeyHint("alt+c");
		return this.#native.get([provider, authUrl, launchUrl, prompt, statusLines, this.#selector, copyKey], () => {
			const tail: NativeChild[] = [];
			if (authUrl) {
				tail.push(
					node(
						"text",
						{
							spans: [
								span("Browser login: ", "accent"),
								span("Open login URL", "accent link", { href: authUrl }),
								span(` (clipboard copy attempted; ${copyKey} retries)`, "dim"),
							],
						},
						undefined,
						"login",
					),
					node(
						"text",
						{ spans: [span(authUrl, "dim link", { href: authUrl })], wrap: "char", actions: { menu: ["copy"] } },
						undefined,
						"url",
					),
				);
				if (launchUrl) {
					tail.push(
						node(
							"text",
							{
								spans: [
									span("Local shortcut (this machine only): ", "dim"),
									span(launchUrl, "dim link", { href: launchUrl }),
								],
								wrap: "char",
							},
							undefined,
							"launch",
						),
					);
				}
			}
			if (prompt) {
				const promptChildren: NativeChild[] = [text([span(prompt.message, "warning")])];
				if (prompt.placeholder) promptChildren.push(text([span(prompt.placeholder, "dim")]));
				promptChildren.push(prompt.input);
				tail.push(node("col", {}, promptChildren, "prompt"));
			}
			statusLines.forEach((line, index) => {
				tail.push(node("text", { spans: [span(line.text, line.color)] }, undefined, `status:${index}`));
			});

			if (provider) {
				return col(
					[
						node(
							"row",
							{ gap: "sm", align: "center" },
							[node("spinner", {}), text([span(`Signing in to ${provider}`, "strong")])],
							"heading",
						),
						...tail,
					],
					{ gap: "sm", role: "omp.setup.sign-in", tone: "pending" },
				);
			}
			return col(
				[
					node(
						"text",
						{ spans: [span("Pick a provider to sign in — you can connect more than one.", "muted")] },
						undefined,
						"intro",
					),
					this.#selector,
					...tail,
				],
				{ gap: "sm", role: "omp.setup.sign-in" },
			);
		});
	}

	#createSelector(): OAuthSelectorComponent {
		return new OAuthSelectorComponent(
			"login",
			this.#authStorage,
			providerId => {
				void this.#login(providerId);
			},
			() => this.#host.finish("skipped"),
			{
				requestRender: () => this.#host.requestRender(),
				disabledProviders: this.#host.ctx.disabledProviders,
				onRemove: providerId => this.#removeSavedCredentials(providerId),
			},
		);
	}

	async #removeSavedCredentials(providerId: string): Promise<void> {
		if (this.#loggingInProvider || this.#removingProvider || this.#disposed) return;
		this.#removingProvider = providerId;
		this.#statusLines = [{ text: `Removing saved credentials for ${providerId}…`, color: "dim" }];
		this.#host.requestRender();
		try {
			await this.#authStorage.credentials.reload();
			if (this.#disposed) return;
			if (!this.#authStorage.credentials.has(providerId)) {
				this.#statusLines = [
					{ text: `No saved credentials for ${providerId}; nothing was removed.`, color: "warning" },
				];
				this.#host.requestRender();
				return;
			}

			await this.#authStorage.credentials.remove(providerId);

			let refreshFailed = false;
			try {
				await this.#host.ctx.refreshProvider(providerId);
			} catch {
				refreshFailed = true;
			}
			if (this.#disposed) return;

			const statusLines: StyledLine[] = [{ text: `Removed saved credentials for ${providerId}.`, color: "success" }];
			const remainingSource = this.#authStorage.keys.describe(providerId);
			if (remainingSource) {
				statusLines.push({
					text: `Still authenticated via ${remainingSource}; external credentials were not removed.`,
					color: "warning",
				});
			}
			if (refreshFailed) {
				statusLines.push({
					text: "Provider model refresh failed; refresh the provider again if its model list is stale.",
					color: "warning",
				});
			}
			this.#statusLines = statusLines;
			this.#host.requestRender();
		} catch {
			if (this.#disposed) return;
			this.#statusLines = [{ text: `Could not remove saved credentials for ${providerId}.`, color: "error" }];
			this.#host.requestRender();
			throw new Error("Could not remove saved credentials");
		} finally {
			this.#removingProvider = undefined;
		}
	}

	async #login(providerId: string): Promise<void> {
		if (this.#loggingInProvider || this.#removingProvider || this.#disposed) return;
		const useManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		this.#selector.stopValidation();
		this.#loggingInProvider = providerId;
		this.#statusLines = [{ text: "Starting OAuth flow…", color: "dim" }];
		this.#authUrl = undefined;
		this.#authLaunchUrl = undefined;
		this.#loginAbort = new AbortController();
		this.#host.restoreFocus();
		this.#host.requestRender();
		try {
			await this.#authStorage.oauth.login(providerId as OAuthProvider, {
				signal: this.#loginAbort.signal,
				onBrowserSession: (request, signal) => this.#host.ctx.captureBrowserSession(request, signal),
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
					const statusLines: StyledLine[] = [];
					if (info.instructions) {
						statusLines.push({ text: info.instructions, color: "warning" });
					}
					if (useManualInput) {
						statusLines.push({ text: "Paste the returned code or redirect URL when prompted.", color: "dim" });
					}
					this.#statusLines = statusLines;
					void this.#copyAuthUrl();
					this.#host.ctx.openInBrowser(info.url);
					this.#host.requestRender();
				},
				onPrompt: prompt => this.#showPrompt(prompt),
				onProgress: message => {
					this.#statusLines = [...this.#statusLines, { text: message, color: "dim" }];
					this.#host.requestRender();
				},
				onManualCodeInput: signal =>
					this.#showPrompt({ message: "Paste the authorization code (or full redirect URL):" }, signal),
			});
			// Provider-scoped online refresh so the just-persisted credential re-runs
			// discovery instead of reusing a fresh authoritative cache row (#5780).
			await this.#host.ctx.refreshProvider(providerId);
			if (this.#disposed) return;
			this.#statusLines = [
				{ text: `${theme.status.success} Signed in to ${providerId}`, color: "success" },
				{ text: `Credentials saved to ${getAgentDbPath()}`, color: "dim" },
			];
			this.#authUrl = undefined;
			this.#authLaunchUrl = undefined;
			this.#loggingInProvider = undefined;
			this.#loginAbort = undefined;
			this.#selector.stopValidation();
			this.#selector = this.#createSelector();
			this.#host.restoreFocus();
			this.#host.requestRender();
		} catch (error) {
			if (this.#disposed) return;
			if (this.#loginAbort?.signal.aborted) {
				this.#statusLines = [{ text: "Login cancelled.", color: "dim" }];
				this.#authUrl = undefined;
				this.#authLaunchUrl = undefined;
			} else {
				const message = error instanceof Error ? error.message : String(error);
				this.#statusLines = [
					{ text: `Login failed: ${message}`, color: "error" },
					{
						text: `Choose another provider or press ${editorKey("tui.select.cancel")} to continue.`,
						color: "dim",
					},
				];
				this.#authUrl = undefined;
				this.#authLaunchUrl = undefined;
			}
			this.#loggingInProvider = undefined;
			this.#loginAbort = undefined;
			this.#host.restoreFocus();
			this.#host.requestRender();
		}
	}

	async #copyAuthUrl(): Promise<void> {
		const url = this.#authUrl;
		if (!url) return;
		try {
			await this.#host.ctx.copyToClipboard(url);
		} catch {
			// Clipboard integration is best-effort; the full URL remains rendered below.
		}
		this.#host.requestRender();
	}

	#showPrompt(prompt: OAuthPrompt, signal?: AbortSignal): Promise<string> {
		this.#resolvePrompt("");
		if (signal?.aborted) {
			return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Login input cancelled"));
		}
		const input = new Input();
		input.mask = prompt.secret === true;
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
		this.#host.setFocus(focusInput);
		this.#host.requestRender();
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
		this.#host.restoreFocus();
		this.#host.requestRender();
	}
}

/** Onboarding scene for provider sign-in. */
export const providersSetupScene: SetupScene = {
	id: "providers",
	title: "Sign in to your providers",
	minVersion: 1,
	mount: host => new SignInScene(host),
};
