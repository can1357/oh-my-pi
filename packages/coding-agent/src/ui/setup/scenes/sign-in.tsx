/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Sign in: connect one or more providers. Picking is the provider sheet
 * (`OAuthSelector` as a setup sheet); signing in is the login dialog, shown
 * in place of the sheet until the flow settles or Escape cancels it. The
 * scene never advances on its own: Escape on the sheet leaves it, reading
 * "Continue" once a sign-in succeeded.
 */
import { PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { batch, computed, type JSXNode, signal, type UiNode, untrack } from "@oh-my-pi/pi-tui";
import type { TspText } from "@oh-my-pi/pi-wire";
import { getAgentDbPath } from "@oh-my-pi/pi-utils/dirs";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { connectedProviderName } from "../../../modes/view-model/chrome/format";
import { LoginDialog, LoginDialogState } from "../../overlays/panels/login-dialog";
import { OAuthSelector, type OAuthSelectorSheet } from "../../overlays/pickers/oauth-selector";
import "../../styles/setup";
import type { SignInLine, SignInTerm } from "../../styles/setup/sign-in";
import type { SetupScene } from "../types";
import { keyLabel } from "./choice";
import { actionKeyId } from "../../keys/hints";
import { formatKey } from "@oh-my-pi/pi-tui/theme/keys";

const SCENE_TITLE = "Sign in to your providers";
const SHEET_ROLE = "omp.setup.sheet";

/**
 * The key that leaves the scene, glyph plus spelled-out name (`⎋ (Esc)`): sign-in
 * runs before the glyph picker, so a bare keycap glyph may be unreadable.
 */
function doneKeyLabel(): string {
	const key = actionKeyId("tui.select.cancel", "escape");
	const glyph = keyLabel(key);
	const name = formatKey(key, { preset: "ascii", platform: process.platform });
	return glyph === name ? name : `${glyph} (${name})`;
}

/** How the last sign-in ended (`provider` is the display name). */
type Outcome =
	| { readonly kind: "success"; readonly provider: string }
	| { readonly kind: "error"; readonly provider: string; readonly message: string };

/** The last outcome as lines under the list (terminal). */
function outcomeLines(outcome: Outcome | undefined): SignInLine[] {
	if (!outcome) return [];
	if (outcome.kind === "success") {
		return [
			{
				text: `${currentTheme().symbols.symbol("status.success")} Signed in to ${outcome.provider}`,
				color: "success",
			},
			{ text: `Credentials saved to ${getAgentDbPath()}`, color: "dim" },
		];
	}
	return [
		{ text: `Login failed: ${outcome.message}`, color: "error" },
		{
			text: `Choose another provider or press ${doneKeyLabel()} to continue.`,
			color: "dim",
		},
	];
}

export const signInScene: SetupScene = {
	id: "providers",
	title: SCENE_TITLE,
	get subtitle() {
		return `Sign in to one or more providers. Press ${doneKeyLabel()} when you're done.`;
	},
	step: "Sign in",
	minVersion: 1,
	mount(context) {
		const host = context.host;
		const dialog = signal<LoginDialogState | undefined>(undefined);
		const outcome = signal<Outcome | undefined>(undefined);
		const signedIn = signal(false);
		const authRevision = signal(0);
		const lifetime = new AbortController();

		const sheet = computed((): OAuthSelectorSheet => {
			const last = outcome();
			let status: TspText | undefined;
			if (last?.kind === "success")
				status = [
					{ s: "success", t: `Signed in to ${last.provider}.` },
					{ s: "muted", t: " Add another provider or continue." },
				];
			else if (last?.kind === "error")
				status = [{ s: "error", t: `Couldn't sign in to ${last.provider}: ${last.message}` }];
			return {
				title: SCENE_TITLE,
				subtitle: "You can connect more than one.",
				role: SHEET_ROLE,
				size: "lg",
				...(status ? { status } : {}),
				leave: { id: "skip", label: signedIn() ? "Continue" : "Skip" },
			};
		});

		/** The intro under the wizard's subtitle: only when the full sheet still fits beside it. */
		const showIntro = (): boolean => {
			const budget = context.maxLines();
			return budget === undefined || budget >= FULL_SHEET_ROWS + 2;
		};
		const lines = computed(() => outcomeLines(outcome()));
		/** Rows the sheet may take: the budget less the intro and the outcome lines. */
		const sheetRows = computed(() => {
			const budget = context.maxLines();
			if (budget === undefined) return undefined;
			return Math.max(1, budget - (showIntro() ? 2 : 0) - lines().length);
		});

		const close = (state: LoginDialogState): void => {
			if (untrack(dialog) === state) dialog.set(undefined);
		};
		const login = async (providerId: string): Promise<void> => {
			if (untrack(dialog) || lifetime.signal.aborted) return;
			const name = getOAuthProviders().find(provider => provider.id === providerId)?.name ?? providerId;
			// Escape in the dialog goes straight back to the list; the aborted flow settles quietly below.
			const state: LoginDialogState = new LoginDialogState(
				providerId,
				() => close(state),
				url => host.openInBrowser?.(url),
			);
			batch(() => {
				outcome.set(undefined);
				dialog.set(state);
			});
			try {
				await host.authStorage.oauth.login(providerId, {
					signal: AbortSignal.any([state.signal, lifetime.signal]),
					onAuth: info => state.showAuth(info.url, info.instructions, info.launchUrl),
					onPrompt: prompt => state.showPrompt(prompt),
					onProgress: message => state.showProgress(message),
					onManualCodeInput: PASTE_CODE_LOGIN_PROVIDERS.has(providerId)
						? signal =>
								state.showManualInput(
									`Paste the address from your browser (or the code it shows), then press ${keyLabel(actionKeyId("tui.input.submit", "enter"))}:`,
									signal,
								)
						: undefined,
				});
				await host.refreshProvider?.(providerId);
				if (lifetime.signal.aborted) return;
				batch(() => {
					authRevision.set(untrack(authRevision) + 1);
					signedIn.set(true);
					outcome.set({ kind: "success", provider: connectedProviderName(providerId, name) });
				});
			} catch (error) {
				if (lifetime.signal.aborted || state.signal.aborted) return;
				outcome.set({
					kind: "error",
					provider: name,
					message: error instanceof Error ? error.message : String(error),
				});
			} finally {
				if (!lifetime.signal.aborted) close(state);
			}
		};

		// Built once: the sheet keeps its query and highlight while a login dialog covers it.
		const selector = (
			<OAuthSelector
				mode="login"
				auth={host.authStorage}
				disabledProviders={host.disabledProviders}
				authRevision={authRevision}
				sheet={sheet}
				maxHeight={sheetRows}
				onSelect={id => void login(id)}
				onCancel={() => context.finish(untrack(signedIn) ? "done" : "skipped")}
			/>
		) as JSXNode;

		const term = (): SignInTerm => ({
			role: "omp.setup.sign-in",
			maxLines: context.maxLines(),
			intro: dialog() === undefined && showIntro(),
			lines: dialog() === undefined ? lines() : [],
		});
		return {
			body: (
				<col term={term}>
					{() => {
						const state = dialog();
						return state ? <LoginDialog state={state} /> : selector;
					}}
				</col>
			),
			// The provider sheet, or the login dialog (its sheet in Tern, its box in a terminal).
			focusTarget: body =>
				findNode(body, node => {
					if (node.kind === "picker") return true;
					const role = (node.props() as { role?: string }).role;
					return role === "omp.login" || role === "omp.overlay.login";
				}),
			dispose: () => lifetime.abort(),
		};
	},
};

/** Rows of the full provider sheet: four of chrome above the list, ten rows, three below. */
const FULL_SHEET_ROWS = 17;

function findNode(node: UiNode, test: (node: UiNode) => boolean): UiNode | undefined {
	if (test(node)) return node;
	for (const child of node.children()) {
		const hit = findNode(child, test);
		if (hit) return hit;
	}
	return undefined;
}
