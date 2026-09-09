import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { OAuthLoginCallbacks, OAuthProviderId } from "@oh-my-pi/pi-ai/oauth/types";
import { SignInTab } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/scenes/sign-in";
import type { SetupSceneHost } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/scenes/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import type { Component } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("SignInTab", () => {
	it("keeps the OSC8 login link and manual-code prompt above clipped wizard rows", async () => {
		const url = `https://example.com/oauth/authorize?client_id=omp&redirect_uri=http%3A%2F%2Flocalhost%3A45454%2Fcallback&state=${"a".repeat(96)}`;
		const loginGate = Promise.withResolvers<void>();
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		let focusTarget: Component | undefined;
		const openedUrls: string[] = [];

		const authStorage = {
			has: (_providerId: string) => false,
			hasAuth: (_providerId: string) => false,
			getCredentialOrigin: (_providerId: string) => undefined,
			async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
				ctrl.onAuth({ url });
				const prompt = ctrl.onManualCodeInput?.();
				await loginGate.promise;
				await prompt;
			},
		} as unknown as AuthStorage;

		const host = {
			ctx: {
				openInBrowser(openedUrl: string): void {
					openedUrls.push(openedUrl);
				},
				session: {
					modelRegistry: {
						authStorage,
						async refresh(): Promise<void> {},
					},
				},
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(component: Component | null): void {
				focusTarget = component ?? undefined;
			},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const tab = new SignInTab(host);
		try {
			for (const char of "anthropic") {
				tab.handleInput(char);
			}
			tab.handleInput("\n");

			const rendered = tab.render(36);
			const compact = rendered.map(line => Bun.stripANSI(line).trim()).join("");
			expect(compact).toContain(url);
			expect(compact).not.toContain("…");
			expect(rendered.join("\n")).toContain(`\x1b]8;;${url}\x07Open login URL\x1b]8;;\x07`);
			expect(openedUrls).toEqual([url]);
			expect(focusTarget).toBeDefined();
			focusTarget?.handleInput?.("\x1bc");
			expect(copySpy).toHaveBeenCalledTimes(2);
			expect(copySpy).toHaveBeenLastCalledWith(url);

			// On a ~24-row terminal the wizard body ends up ~8 rows; the OSC8
			// link, a plain URL row, and the focused input must survive that clip.
			const clippedBody = rendered.slice(0, 8).map(line => Bun.stripANSI(line).trim());
			const plainUrlIndex = clippedBody.findIndex(line => line.startsWith("https://example.com/oauth/authorize?"));
			const inputIndex = clippedBody.findIndex(line => line.startsWith(">"));
			expect(clippedBody.some(line => line.startsWith("Browser login: Open login URL"))).toBe(true);
			expect(plainUrlIndex).toBeGreaterThanOrEqual(0);
			expect(clippedBody).toContain("Paste the authorization code (or full redirect URL):");
			expect(inputIndex).toBeGreaterThanOrEqual(0);
			expect(plainUrlIndex).toBeLessThan(inputIndex);
		} finally {
			tab.dispose();
			loginGate.resolve();
			await loginGate.promise;
		}
	});

	it("clears manual input after a native callback path settles", async () => {
		const url = "https://example.com/oauth/authorize?client_id=omp&state=native";
		const loginCompleted = Promise.withResolvers<void>();
		const authStorage = {
			has: (_providerId: string) => false,
			hasAuth: (_providerId: string) => false,
			getCredentialOrigin: (_providerId: string) => undefined,
			async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
				ctrl.onAuth({ url });
				const settled = new AbortController();
				const prompt = ctrl.onManualCodeInput?.(settled.signal);
				settled.abort(new Error("native callback received"));
				await prompt?.catch(() => {});
				loginCompleted.resolve();
			},
		} as unknown as AuthStorage;
		const host = {
			ctx: {
				openInBrowser(): void {},
				session: {
					modelRegistry: {
						authStorage,
						async refresh(): Promise<void> {},
					},
				},
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(): void {},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const tab = new SignInTab(host);
		try {
			for (const char of "anthropic") tab.handleInput(char);
			tab.handleInput("\n");
			await loginCompleted.promise;
			await Promise.resolve();

			expect(tab.render(80).join("\n")).not.toContain("Paste the authorization code");
		} finally {
			tab.dispose();
		}
	});

	it("copies the active login URL from the keyboard while the setup TUI owns selection", async () => {
		const url = "https://example.com/oauth/authorize?client_id=omp&state=copy";
		const loginGate = Promise.withResolvers<void>();
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);

		const authStorage = {
			has: (_providerId: string) => false,
			hasAuth: (_providerId: string) => false,
			getCredentialOrigin: (_providerId: string) => undefined,
			async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
				ctrl.onAuth({ url });
				await loginGate.promise;
			},
		} as unknown as AuthStorage;

		const host = {
			ctx: {
				openInBrowser(): void {},
				session: {
					modelRegistry: {
						authStorage,
						async refresh(): Promise<void> {},
					},
				},
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(): void {},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const tab = new SignInTab(host);
		try {
			for (const char of "anthropic") {
				tab.handleInput(char);
			}
			tab.handleInput("\n");
			await Promise.resolve();
			expect(copySpy).toHaveBeenCalledTimes(1);

			tab.handleInput("\x1bc");
			await Promise.resolve();
			expect(copySpy).toHaveBeenCalledTimes(2);
			expect(copySpy).toHaveBeenLastCalledWith(url);
		} finally {
			tab.dispose();
			loginGate.resolve();
			await loginGate.promise;
		}
	});
});
