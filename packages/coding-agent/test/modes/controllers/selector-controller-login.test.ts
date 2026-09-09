import { beforeAll, describe, expect, it, vi } from "bun:test";
import { LoginDialogComponent } from "@oh-my-pi/pi-coding-agent/modes/components/login-dialog";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { TUI } from "@oh-my-pi/pi-tui";

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
