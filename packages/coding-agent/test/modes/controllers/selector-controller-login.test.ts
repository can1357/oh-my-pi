import { afterEach, beforeAll, describe, expect, it, mock, vi } from "bun:test";
import { LoginDialogComponent } from "@oh-my-pi/pi-coding-agent/modes/components/login-dialog";
import {
	resetProviderAuthCatalogCache,
	SelectorController,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { installLegacyPiSpecifierShim } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { TUI } from "@oh-my-pi/pi-tui";

// A greyed-out provider row in the /model hub forwards to the OAuth login this
// controller runs, and a real omp process always has the legacy pi specifier
// shim installed (the plugin and extension loaders register it at import time).
// Without it this suite would exercise a resolution path production never takes.
installLegacyPiSpecifierShim();

interface RenderableBlock {
	render(width: number): string[];
}

function renderPresented(blocks: unknown[]): string {
	return blocks
		.flatMap(block => {
			const maybeRenderable = block as Partial<RenderableBlock>;
			return maybeRenderable.render ? maybeRenderable.render(120) : [String(block)];
		})
		.join("\n");
}

beforeAll(async () => {
	await initTheme();
});

describe("SelectorController login", () => {
	it("awaits a provider-scoped online refresh, then presents OAuth success", async () => {
		const loginSaved = Promise.withResolvers<void>();
		const presentedBlocks: unknown[] = [];
		const authStorage = {
			login: vi.fn(async () => {
				loginSaved.resolve();
			}),
		} as unknown as AuthStorage;
		const refresh = vi.fn(() => new Promise<void>(() => {}));
		const refreshProvider = vi.fn(async () => {});
		const ctx = {
			oauthManualInput: {
				waitForInput: vi.fn(),
				clear: vi.fn(),
			},
			session: {
				modelRegistry: {
					authStorage,
					refresh,
					refreshProvider,
				},
			},
			// The login flow swaps the editor slot for the cancellable dialog
			// and restores it when the flow settles.
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			present: vi.fn((block: unknown) => {
				presentedBlocks.push(block);
			}),
			openInBrowser: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		void controller.showOAuthSelector("login", "xai-oauth");
		await loginSaved.promise;
		// Let the awaited refreshProvider settle before the success block is presented.
		await Promise.resolve();
		await Promise.resolve();

		expect(renderPresented(presentedBlocks)).toContain("Successfully logged in to xai-oauth");
		// Post-login refresh is scoped to the just-authenticated provider with the
		// `online` strategy (#5780) — not the all-provider default refresh.
		expect(refreshProvider).toHaveBeenCalledTimes(1);
		expect(refreshProvider).toHaveBeenCalledWith("xai-oauth", "online");
		expect(refresh).not.toHaveBeenCalled();
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("Esc during a pending login aborts the flow and restores the editor", async () => {
		const login = vi.fn(
			(_provider: string, ctrl: { signal?: AbortSignal }) =>
				new Promise<void>((_resolve, reject) => {
					ctrl.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);
		const authStorage = { login } as unknown as AuthStorage;
		const editorSlot: unknown[] = [];
		const editor = {};
		const presentedBlocks: unknown[] = [];
		const ctx = {
			oauthManualInput: { waitForInput: vi.fn(), clear: vi.fn() },
			session: { modelRegistry: { authStorage, refreshProvider: vi.fn(async () => {}) } },
			editorContainer: {
				clear: vi.fn(() => editorSlot.splice(0)),
				addChild: vi.fn((child: unknown) => editorSlot.push(child)),
				children: editorSlot,
			},
			editor,
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			present: vi.fn((block: unknown) => {
				presentedBlocks.push(block);
			}),
			openInBrowser: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		const loginDone = controller.showOAuthSelector("login", "xai-oauth");
		const dialog = editorSlot[0] as { handleInput(data: string): void };
		expect(dialog).toBeDefined();
		expect(dialog).not.toBe(editor);

		dialog.handleInput("\x1b"); // Esc cancels the pairing wait
		await loginDone;

		// The abort is user-driven: no error surfaced, the cancellation is
		// announced, and the editor owns the slot again.
		expect(ctx.showError).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith("Login cancelled");
		expect(editorSlot).toEqual([editor]);
		expect(renderPresented(presentedBlocks)).not.toContain("Successfully logged in");
	});
	it("routes enhanced paste into a direct API-key prompt", async () => {
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const dialog = new LoginDialogComponent(tui, "openrouter", vi.fn());
		const prompt = dialog.showPrompt("Paste your OpenRouter API key");

		dialog.pasteText("OMP_PASTE_TEST_123");
		dialog.handleInput("\n");

		await expect(prompt).resolves.toBe("OMP_PASTE_TEST_123");
	});
});

/** The ctx shape `#handleOAuthLogin` touches, with the auth UI a real module load. */
function makeLoginContext(): {
	ctx: InteractiveModeContext;
	blocks: unknown[];
	showError: ReturnType<typeof vi.fn>;
} {
	const blocks: unknown[] = [];
	const showError = vi.fn();
	const ctx = {
		oauthManualInput: { waitForInput: vi.fn(), clear: vi.fn() },
		session: {
			modelRegistry: {
				authStorage: { login: vi.fn(async () => {}) },
				refresh: vi.fn(async () => {}),
				refreshProvider: vi.fn(async () => {}),
			},
		},
		editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
		editor: {},
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		showStatus: vi.fn(),
		showError,
		present: vi.fn((block: unknown) => {
			blocks.push(block);
		}),
		openInBrowser: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, blocks, showError };
}

describe("SelectorController login for a provider with no credentials configured", () => {
	afterEach(() => {
		mock.restore();
		resetProviderAuthCatalogCache();
	});

	it("loads the auth UI and runs the login the /model hub requested", async () => {
		const { ctx, blocks } = makeLoginContext();
		const controller = new SelectorController(ctx);

		await controller.showOAuthSelector("login", "anthropic");

		expect(ctx.session.modelRegistry.authStorage.login).toHaveBeenCalledTimes(1);
		expect(renderPresented(blocks)).toContain("Successfully logged in to anthropic");
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	// Regression: the hub fires this login from a click/Enter handler whose
	// promise nobody awaits. A failure to load the auth catalog has to surface as
	// a login error; it used to reject that promise, and the process died on the
	// fatal unhandled-rejection path instead of showing anything.
	it("surfaces an auth-catalog load failure as a login error instead of rejecting", async () => {
		resetProviderAuthCatalogCache();
		// A barrel whose catalog export cannot be read stands in for the
		// resolution failure the shim produced in the field.
		mock.module("@oh-my-pi/pi-ai", () => ({
			get PASTE_CODE_LOGIN_PROVIDERS(): never {
				throw new Error("simulated auth catalog failure");
			},
			getOAuthProviders: () => [],
		}));
		const { ctx } = makeLoginContext();
		const controller = new SelectorController(ctx);

		// Resolves: the failure is reported, not thrown at the caller.
		await controller.showOAuthSelector("login", "anthropic");

		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("Login failed:"));
		expect(ctx.session.modelRegistry.authStorage.login).not.toHaveBeenCalled();
		// The editor slot comes back, so the session stays usable.
		expect(ctx.editorContainer.addChild).toHaveBeenCalledWith(ctx.editor);
	});
});

describe("SelectorController OAuth entry points under a broken auth catalog", () => {
	afterEach(() => {
		mock.restore();
		resetProviderAuthCatalogCache();
	});

	// Regression: /login and /logout start these flows with `void` and nothing
	// attaches a handler, so each entry point has to report a catalog failure
	// itself — an escaping rejection is the fatal unhandled-rejection path.
	it("reports a catalog load failure from every entry point without an unhandled rejection", async () => {
		const { ctx, showError } = makeLoginContext();
		const controller = new SelectorController(ctx);
		const rejections: unknown[] = [];
		const record = (reason: unknown) => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", record);
		try {
			const entries: ReadonlyArray<readonly [string, () => Promise<void>]> = [
				["login with provider", () => controller.showOAuthSelector("login", "anthropic")],
				["login picker", () => controller.showOAuthSelector("login")],
				["logout with provider", () => controller.showOAuthSelector("logout", "anthropic")],
				["logout picker", () => controller.showOAuthSelector("logout")],
			];
			mock.module("@oh-my-pi/pi-ai", () => ({
				get PASTE_CODE_LOGIN_PROVIDERS(): never {
					throw new Error("simulated auth catalog failure");
				},
			}));
			for (const [label, entry] of entries) {
				// Each entry point takes its own load path (the failed load is not
				// cached), so one registration covers all four.
				resetProviderAuthCatalogCache();
				const reported = showError.mock.calls.length;

				// Resolving — not rejecting — is the contract.
				await entry();

				expect(showError.mock.calls.length, label).toBeGreaterThan(reported);
			}
			// Let a rejection that nobody awaited surface before asserting.
			await Promise.resolve();
			await Promise.resolve();
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", record);
		}
	});
});
