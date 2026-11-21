import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import type { TspText } from "@oh-my-pi/pi-wire";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { Container } from "../../tui";
import { Spacer } from "../../components/spacer";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { editorKey } from "../../chrome/keybinding-hints";
import { type SgrMouseEvent } from "../../mouse";
import { wrapTextWithAnsi } from "../../utils";
import { LoginDialogComponent } from "../../overlays/login-dialog";
import { type OAuthSelectorSheet, OAuthSelectorComponent } from "../../overlays/oauth-selector";
import { theme } from "../../theme/theme";
import { col, node, span } from "../../native/describe";
import type { DescribeContext, NativeChild, NativeNode } from "../../native/node";
import { Memo } from "../../native/memo";
import {
	SETUP_SHEET_ROLE,
	type SetupScene,
	type SetupSceneController,
	type SetupSceneHost,
	type StyledLine,
} from "./types";

const SCENE_TITLE = "Sign in to your providers";
/** Login dialog rows kept above a cut on short screens: top border, spacer, first sign-in link row. */
const DIALOG_HEAD_ROWS = 3;
const LIST_LEAD = "Pick a provider to sign in — you can connect more than one.";
/** The provider sheet's subtitle: its title and rows already say "pick a provider". */
const SHEET_LEAD = "You can connect more than one.";

/** The last finished sign-in (`provider` is the display name): shown on the provider sheet (natively) or under the list (ANSI). */
type SignInOutcome =
	| { readonly kind: "success"; readonly provider: string }
	| { readonly kind: "error"; readonly provider: string; readonly message: string };

/**
 * "Sign in" scene: lets the user authenticate one or more model providers via
 * OAuth. It never auto-advances the wizard — the user may sign in to several
 * providers and then leave the step with Esc.
 *
 * Picking is the provider selector (natively a setup sheet: Skip/Continue on
 * Esc, Sign in on Enter); signing in is the app's {@link LoginDialogComponent},
 * driven like `/login` drives it: natively its own sheet over the setup page,
 * in the cell grid drawn in the wizard body in place of the selector.
 */
export class SignInScene implements SetupSceneController {
	readonly title = SCENE_TITLE;
	get subtitle(): string {
		return `Sign in to one or more providers. Press ${editorKey("tui.select.cancel")} when you're done.`;
	}

	#authStorage: AuthStorage;
	#selector: OAuthSelectorComponent;
	/** The login flow on screen; undefined while picking. */
	#dialog: LoginDialogComponent | undefined;
	#outcome: SignInOutcome | undefined;
	/** A sign-in succeeded in this scene: leaving the step reads "Continue". */
	#signedIn = false;
	/** Aborts a running login when the scene goes away. */
	#lifetime = new AbortController();
	#step: WizardStep | undefined;
	#native = new Memo();

	readonly #host: SetupSceneHost;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		this.#authStorage = host.ctx.authStorage;
		this.#selector = new OAuthSelectorComponent(
			"login",
			this.#authStorage,
			providerId => {
				void this.#login(providerId);
			},
			() => this.#host.finish(this.#signedIn ? "done" : "skipped"),
			{
				requestRender: () => this.#host.requestRender(),
				disabledProviders: this.#host.ctx.disabledProviders,
				sheet: this.#sheet(),
			},
		);
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#selector.stopValidation();
		this.#dialog = undefined;
	}

	invalidate(): void {
		this.#native.clear();
		this.#step?.invalidate();
		this.#selector.invalidate();
		this.#dialog?.invalidate();
	}

	handleInput(data: string): void {
		if (this.#dialog) {
			this.#dialog.handleInput(data);
			return;
		}
		this.#selector.handleInput(data);
	}

	/** Forward mouse to the provider selector; the login dialog takes keys only. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#dialog) return;
		this.#step?.routeMouse(event, line, col);
	}

	render(width: number, maxLines?: number): readonly string[] {
		const dialog = this.#dialog;
		if (dialog) {
			// Short screens cut the middle: the head keeps the title and the first link row (every
			// wrapped URL row links the full URL), the tail the live step (code field, newest progress).
			const lines = dialog.render(width);
			if (maxLines === undefined || lines.length <= maxLines) return lines;
			const head = maxLines >= DIALOG_HEAD_ROWS * 2 ? DIALOG_HEAD_ROWS : 0;
			return [...lines.slice(0, head), ...lines.slice(lines.length - (maxLines - head))];
		}
		// Hint + blank cost two rows; the wizard subtitle already explains
		// this panel, so on short screens the rows go to the provider list
		// instead (17 = full selector: 4 chrome above, 10 rows, 3 below).
		let intro: Container | undefined;
		if (maxLines === undefined || maxLines >= 17 + 2) {
			intro = new Container();
			intro.addChild(new Text(theme.fg("muted", LIST_LEAD), 0, 0));
			intro.addChild(new Spacer(1));
		}
		const status = new Container();
		for (const line of this.#statusLines()) {
			for (const wrapped of wrapTextWithAnsi(theme.fg(line.color, line.text), width)) {
				status.addChild(new Text(wrapped, 0, 0));
			}
		}
		this.#step ??= new WizardStep({
			kind: "choice",
			content: this.#selector,
			gap: 0,
			fitContent: budget => {
				if (budget !== undefined) this.#selector.setMaxHeight(budget);
			},
		});
		this.#step.setIntro(intro);
		this.#step.setStatus(status);
		this.#step.setMaxHeight(maxLines);
		return this.#step.render(width);
	}

	/**
	 * Signing in: the login dialog (its own sheet). Picking: the provider
	 * selector, which presents the setup sheet where the terminal draws
	 * pickers; elsewhere it is an inline card under the lead and the outcome.
	 */
	describe(cx: DescribeContext): NativeNode {
		const dialog = this.#dialog;
		const sheet = cx.supports("picker");
		const outcome = this.#outcome;
		return this.#native.get([dialog, sheet, outcome, this.#selector], () => {
			if (dialog) return col([dialog]);
			if (sheet) return col([this.#selector]);
			const children: NativeChild[] = [
				node("text", { spans: [span(LIST_LEAD, "muted")] }, undefined, "intro"),
				this.#selector,
			];
			this.#statusLines().forEach((line, index) => {
				children.push(node("text", { spans: [span(line.text, line.color)] }, undefined, `status:${index}`));
			});
			return col(children, { gap: "sm", role: "omp.setup.sign-in" });
		});
	}

	/** The provider sheet: the step's copy, the last outcome above the action bar, and Skip until a sign-in succeeded. */
	#sheet(): OAuthSelectorSheet {
		const outcome = this.#outcome;
		let status: TspText | undefined;
		if (outcome?.kind === "success") {
			status = [
				span(`Signed in to ${outcome.provider}.`, "success"),
				span(" Add another provider or continue.", "muted"),
			];
		} else if (outcome?.kind === "error") {
			status = [span(`Couldn't sign in to ${outcome.provider}: ${outcome.message}`, "error")];
		}
		return {
			title: SCENE_TITLE,
			subtitle: SHEET_LEAD,
			role: SETUP_SHEET_ROLE,
			size: "lg",
			...(status ? { status } : {}),
			leave: { id: "skip", label: this.#signedIn ? "Continue" : "Skip" },
		};
	}

	/** The last outcome as status copy under the cell-grid list (and the inline native fallback). */
	#statusLines(): readonly StyledLine[] {
		const outcome = this.#outcome;
		if (!outcome) return [];
		if (outcome.kind === "success") {
			return [
				{ text: `${theme.status.success} Signed in to ${outcome.provider}`, color: "success" },
				{ text: `Credentials saved to ${getAgentDbPath()}`, color: "dim" },
			];
		}
		return [
			{ text: `Login failed: ${outcome.message}`, color: "error" },
			{
				text: `Choose another provider or press ${editorKey("tui.select.cancel")} to continue.`,
				color: "dim",
			},
		];
	}

	#setOutcome(outcome: SignInOutcome | undefined): void {
		this.#outcome = outcome;
		if (outcome?.kind === "success") this.#signedIn = true;
		this.#selector.setSheet(this.#sheet());
	}

	/** Back to the provider list (Esc in the dialog, or the flow settled). */
	#closeDialog(dialog: LoginDialogComponent): void {
		if (this.#dialog !== dialog) return;
		this.#dialog = undefined;
		this.#host.restoreFocus();
		this.#host.requestRender();
	}

	/** One provider's login, driven like `/login` drives the dialog; the outcome lands on the provider sheet. */
	async #login(providerId: string): Promise<void> {
		if (this.#dialog || this.#lifetime.signal.aborted) return;
		const ctx = this.#host.ctx;
		const useManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		const name = getOAuthProviders().find(provider => provider.id === providerId)?.name ?? providerId;
		const dialog = new LoginDialogComponent(
			this.#host,
			providerId,
			// Fires on Esc: back to the list now; the aborted flow's rejection settles below.
			() => this.#closeDialog(dialog),
			url => ctx.openInBrowser(url),
		);
		this.#dialog = dialog;
		this.#setOutcome(undefined);
		this.#host.setFocus(dialog);
		this.#host.requestRender();
		try {
			await this.#authStorage.oauth.login(providerId as OAuthProvider, {
				signal: AbortSignal.any([dialog.signal, this.#lifetime.signal]),
				onBrowserSession: (request, signal) => ctx.captureBrowserSession(request, signal),
				onAuth: info => dialog.showAuth(info.url, info.instructions, info.launchUrl),
				onPrompt: prompt => dialog.showPrompt(prompt),
				onProgress: message => dialog.showProgress(message),
				onManualCodeInput: useManualInput
					? signal =>
							dialog.showManualInput(
								`Paste the authorization code (or full redirect URL), then press ${editorKey("tui.input.submit")}:`,
								signal,
							)
					: undefined,
			});
			// Provider-scoped online refresh so the just-persisted credential re-runs
			// discovery instead of reusing a fresh authoritative cache row (#5780).
			await ctx.refreshProvider(providerId);
			if (this.#lifetime.signal.aborted) return;
			this.#selector.refreshAuth();
			this.#setOutcome({ kind: "success", provider: name });
		} catch (error) {
			// A cancel (Esc in the dialog) is quiet: the list is already back.
			if (this.#lifetime.signal.aborted || dialog.signal.aborted) return;
			this.#setOutcome({
				kind: "error",
				provider: name,
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			if (!this.#lifetime.signal.aborted) this.#closeDialog(dialog);
		}
	}
}

/** Onboarding scene for provider sign-in. */
export const providersSetupScene: SetupScene = {
	id: "providers",
	title: SCENE_TITLE,
	step: "Sign in",
	minVersion: 1,
	mount: host => new SignInScene(host),
};
