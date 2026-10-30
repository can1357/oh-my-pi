import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { OAuthLoginCallbacks, OAuthProviderId } from "@oh-my-pi/pi-ai/oauth/types";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { providersSetupScene, SignInScene } from "@oh-my-pi/pi-tui/setup/scenes/sign-in";
import type { SetupHost, SetupSceneHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { SetupWizardComponent } from "@oh-my-pi/pi-tui/setup/wizard-overlay";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const pickerCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

type Login = (provider: OAuthProviderId, callbacks: OAuthLoginCallbacks) => Promise<void>;

/** A scene host over a credential store where a finished `login` signs the provider in. */
function sceneHost(login: Login) {
	const signedIn = new Set<string>();
	const state = {
		focus: undefined as (Component & { pasteText?(text: string): void }) | undefined,
		finished: [] as string[],
		refreshed: [] as string[],
		/** Settles when the scene hands focus back (the login dialog closed). */
		restored: Promise.withResolvers<void>(),
	};
	const authStorage = {
		credentials: { has: (id: string) => signedIn.has(id) },
		keys: { source: (id: string) => (signedIn.has(id) ? { kind: "oauth" } : undefined) },
		oauth: {
			async login(provider: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
				await login(provider, callbacks);
				signedIn.add(provider);
			},
		},
	} as unknown as AuthStorage;
	const host = {
		ctx: {
			authStorage,
			disabledProviders: [],
			refreshProvider: async (provider: string) => {
				state.refreshed.push(provider);
			},
			captureBrowserSession: async () => "",
			openInBrowser(): void {},
		},
		requestRender(): void {},
		finish(result: string): void {
			state.finished.push(result);
		},
		setFocus(component: Component | null): void {
			state.focus = component ?? undefined;
		},
		restoreFocus(): void {
			state.focus = undefined;
			state.restored.resolve();
		},
	} as unknown as SetupSceneHost;
	return { host, state };
}

/** The provider sheet the scene presents, or undefined while the login dialog is up. */
function providerSheet(scene: SignInScene): { props: TspPickerProps; owner: Component } | undefined {
	const owner = scene.describe(pickerCx).c?.[0];
	if (!owner || !("render" in owner) || !owner.describe) return undefined;
	const picker = (owner.describe(pickerCx)?.c?.[0] as NativeNode | undefined) ?? undefined;
	if (picker?.k !== "picker") return undefined;
	return { props: picker.p as TspPickerProps, owner };
}

function signInTo(scene: SignInScene, provider: string): void {
	for (const char of provider) scene.handleInput(char);
	scene.handleInput("\r");
}

describe("SignInScene", () => {
	it("Enter on a provider starts its login in the focused dialog; paste reaches the masked field", async () => {
		const secret = `sk-${crypto.randomUUID()}`;
		const answered = Promise.withResolvers<string>();
		const providers: string[] = [];
		const { host, state } = sceneHost(async (provider, callbacks) => {
			providers.push(provider);
			callbacks.onAuth({ url: "https://example.com/oauth/authorize?state=paste" });
			answered.resolve(await callbacks.onPrompt({ message: "Consumer key", secret: true }));
		});
		const scene = new SignInScene(host);
		try {
			signInTo(scene, "anthropic");
			expect(providers).toEqual(["anthropic"]);
			expect(providerSheet(scene)).toBeUndefined();
			// Enhanced paste targets the focused component's `pasteText`.
			state.focus?.pasteText?.(secret);
			expect(scene.render(120).join("\n")).not.toContain(secret);
			state.focus?.handleInput?.("\r");
			await expect(answered.promise).resolves.toBe(secret);
		} finally {
			scene.dispose();
		}
	});

	it("a successful login refreshes the provider and returns to its now signed-in row", async () => {
		const { host, state } = sceneHost(async (_provider, callbacks) => {
			callbacks.onAuth({ url: "https://example.com/oauth/authorize?state=ok" });
		});
		const scene = new SignInScene(host);
		try {
			expect(providerSheet(scene)?.props.items?.find(item => item.id === "anthropic")?.dot).toBe("muted");
			signInTo(scene, "anthropic");
			await state.restored.promise;
			expect(state.refreshed).toEqual(["anthropic"]);
			expect(state.focus).toBeUndefined();
			const sheet = providerSheet(scene)!;
			expect(sheet.props.selected).toBe("anthropic");
			expect(sheet.props.items?.find(item => item.id === "anthropic")?.dot).toBe("success");
		} finally {
			scene.dispose();
		}
	});

	it("Esc in the login dialog aborts the flow and returns to the list without an error", async () => {
		const aborted = Promise.withResolvers<void>();
		const { host, state } = sceneHost(async (_provider, callbacks) => {
			callbacks.onAuth({ url: "https://example.com/oauth/authorize?state=cancel" });
			const pending = Promise.withResolvers<void>();
			callbacks.signal?.addEventListener("abort", () => pending.reject(new Error("Login cancelled")));
			try {
				await pending.promise;
			} finally {
				aborted.resolve();
			}
		});
		const scene = new SignInScene(host);
		try {
			signInTo(scene, "anthropic");
			state.focus?.handleInput?.("\x1b");
			expect(state.focus).toBeUndefined();
			// The aborted flow settles after the list is back; drain its rejection before reading the sheet.
			await aborted.promise;
			for (let tick = 0; tick < 5; tick++) await Promise.resolve();
			expect(providerSheet(scene)?.props.strip).toBeUndefined();
			expect(state.refreshed).toEqual([]);
		} finally {
			scene.dispose();
		}
	});

	it("a failed login returns to the list with the error on the sheet", async () => {
		const { host, state } = sceneHost(async () => {
			throw new Error("token exchange failed");
		});
		const scene = new SignInScene(host);
		try {
			signInTo(scene, "anthropic");
			await state.restored.promise;
			expect(JSON.stringify(providerSheet(scene)?.props.strip?.label)).toContain("token exchange failed");
		} finally {
			scene.dispose();
		}
	});

	it("the sheet's skip action and Esc on the list leave the step", () => {
		const { host, state } = sceneHost(async () => {});
		const pointer = new SignInScene(host);
		const sheet = providerSheet(pointer)!;
		const skip = sheet.props.actions?.find(action => action.keys?.includes("esc"));
		expect(skip?.id).toBe("skip");
		sheet.owner.handleNativeEvent?.({ type: "action", key: "^picker", act: skip!.id, mods: [] });
		const keyboard = new SignInScene(host);
		keyboard.handleInput("\x1b");
		expect(state.finished).toEqual(["skipped", "skipped"]);
	});
});

class SignInTerminal extends VirtualTerminal {
	cursorVisible = false;
	#writes: string[] = [];

	override write(data: string): void {
		this.#writes.push(data);
		for (const match of data.matchAll(/\x1b\[\?25([hl])/g)) {
			this.cursorVisible = match[1] === "h";
		}
		super.write(data);
	}

	takeWrites(): string {
		const result = this.#writes.join("");
		this.#writes.length = 0;
		return result;
	}
}

describe("fullscreen setup sign-in cursor", () => {
	for (const hardware of [true, false]) {
		it(`keeps the real prompt glyph and restores focus with hardware cursor ${hardware ? "on" : "off"}`, async () => {
			const terminal = new SignInTerminal(100, 32);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(terminal, hardware, { renderScheduler: scheduler });
			const base = new Input();
			base.setValue("restored");
			tui.addChild(base);
			tui.setFocus(base);
			const cancelled = Promise.withResolvers<void>();
			const authStorage = {
				credentials: { has: (_providerId: string) => false },
				keys: { source: (_providerId: string) => undefined },
				oauth: {
					async login(_provider: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
						try {
							callbacks.onAuth({ url: "https://example.com/offline-login" });
							await callbacks.onPrompt({ message: "Authorization code" });
							callbacks.signal?.throwIfAborted();
						} finally {
							cancelled.resolve();
						}
					},
				},
			} as unknown as AuthStorage;
			const host = {
				ui: tui,
				authStorage,
				disabledProviders: [],
				refreshProvider: async () => {},
				openInBrowser(): void {},
			} as unknown as SetupHost;
			const wizard = new SetupWizardComponent(host, [providersSetupScene]);
			tui.start();
			await scheduler.settle(terminal);
			const normalCursor = terminal.getCursor();
			const overlay = tui.showOverlay(wizard, {
				fullscreen: true,
				width: "100%",
				maxHeight: "100%",
				anchor: "top-left",
				margin: 0,
			});
			try {
				void wizard.run();
				terminal.sendInput("\r");
				// Reuse the wizard tests' clock-based dissolve skip, not a wall-clock sleep.
				const afterDissolve = performance.now() + 1000;
				vi.spyOn(performance, "now").mockReturnValue(afterDissolve);
				await scheduler.settle(terminal);
				for (const char of "anthropic") terminal.sendInput(char);
				terminal.sendInput("\r");
				await scheduler.settle(terminal);
				const prompt = tui.getFocused();
				expect(prompt).not.toBe(wizard);
				expect(wizard.ownsOverlayFocusTarget(prompt!)).toBe(true);

				terminal.sendInput("abcd");
				await scheduler.settle(terminal);
				const atEnd = terminal.getCursor();
				terminal.sendInput("\x1b[D");
				await scheduler.settle(terminal);
				const beforeMove = tui.getDebugPaint()?.lines;
				terminal.takeWrites();
				terminal.sendInput("\x1b[D");
				await scheduler.settle(terminal);
				const movement = terminal.takeWrites();
				const caret = { row: atEnd.row, col: atEnd.col - 2 };
				expect(terminal.getCursor()).toEqual(caret);
				const row = terminal.getViewport()[caret.row]!;
				expect(row).toContain("abcd");
				expect(row[caret.col]).toBe("c");
				expect(tui.getDebugPaint()).toMatchObject({
					altScreen: true,
					cursor: { x: caret.col, y: caret.row, visible: hardware },
				});
				expect(terminal.cursorVisible).toBe(hardware);
				const paintedRow = tui.getDebugPaint()!.lines[caret.row]!;
				if (hardware) {
					expect(paintedRow).not.toContain("\x1b[7m");
					expect(tui.getDebugPaint()?.lines).toEqual(beforeMove);
					expect([...movement.matchAll(/\x1b\[(\d+);1H/g)]).toEqual([]);
				} else {
					expect(paintedRow).toContain("\x1b[7mc\x1b[27m");
					expect(movement).not.toContain("\x1b[?25h");
				}

				terminal.sendInput("\x1b");
				await cancelled.promise;
				await Promise.resolve();
				await scheduler.settle(terminal);
				expect(tui.getFocused()).toBe(wizard);
				expect(terminal.cursorVisible).toBe(false);
				expect(tui.getDebugPaint()?.cursor).toBeUndefined();
				expect(terminal.getViewport().join("\n")).not.toContain("Authorization code");
				overlay.hide();
				await scheduler.settle(terminal);
				expect(tui.getFocused()).toBe(base);
				expect(base.focused).toBe(true);
				expect(terminal.cursorVisible).toBe(hardware);
				expect(terminal.getCursor()).toEqual(normalCursor);
				terminal.sendInput("!");
				await scheduler.settle(terminal);
				expect(base.getValue()).toBe("restored!");
			} finally {
				wizard.dispose();
				overlay.hide();
				tui.stop();
			}
		});
	}
});
