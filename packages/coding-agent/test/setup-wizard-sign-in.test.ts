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

			// On a ~24-row terminal the wizard body ends up ~8 rows. The OSC8
			// link, the focused input, and the start of the plain URL must all
			// survive that clip. The input now sits above the URL: a clipped
			// input is unusable, while a clipped URL tail is still reachable
			// through Alt+C or the OSC8 link.
			const clippedBody = rendered.slice(0, 8).map(line => Bun.stripANSI(line).trim());
			const plainUrlIndex = clippedBody.findIndex(line => line.startsWith("https://example.com/oauth/authorize?"));
			const inputIndex = clippedBody.findIndex(line => line.startsWith(">"));
			expect(clippedBody.some(line => line.startsWith("Browser login: Open login URL"))).toBe(true);
			expect(plainUrlIndex).toBeGreaterThanOrEqual(0);
			expect(clippedBody).toContain("Paste the authorization code (or full redirect URL):");
			expect(inputIndex).toBeGreaterThanOrEqual(0);
			expect(inputIndex).toBeLessThan(plainUrlIndex);
		} finally {
			tab.dispose();
			loginGate.resolve();
			await loginGate.promise;
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

	// Reported 2026-08-31: "when logging in I can't copy these links which is
	// weird". The panel printed the first two wrapped rows of the URL under the
	// header and then the whole URL again lower down, so the copy a user
	// actually reaches for ends mid-query-string.
	//
	// This asserts the rows, not the bytes a terminal selection produces: a
	// full-screen frame paints every wrapped fragment as its own row, so a
	// drag-copy carries the breaks no matter how the panel is laid out. The
	// byte-exact paths are Alt+C (covered above) and the OSC 8 link, and
	// `parseCallbackInput` strips the whitespace a selection adds.
	it("renders the authorization URL once, in consecutive rows, never twice", async () => {
		const url = `https://auth.example.com/oauth/authorize?response_type=code&client_id=omp&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&code_challenge=${"B".repeat(43)}&state=${"s".repeat(32)}`;
		const loginGate = Promise.withResolvers<void>();
		vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);

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
				openInBrowser(): void {},
				session: { modelRegistry: { authStorage, async refresh(): Promise<void> {} } },
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

			const width = 60;
			const plain = tab.render(width).map(line => Bun.stripANSI(line));
			expect(plain.join("").split(url).length - 1).toBe(1);

			// Consecutive: no prompt row, status line, or second copy interrupts
			// the block.
			const first = plain.findIndex(line => line.startsWith("https://auth.example.com"));
			expect(first).toBeGreaterThanOrEqual(0);
			const rowCount = Math.ceil(url.length / width);
			expect(plain.slice(first, first + rowCount).join("")).toBe(url);
		} finally {
			tab.dispose();
			loginGate.resolve();
			await loginGate.promise;
		}
	});

	// The notice is only useful if it survives the same clip the layout above is
	// built around: printed after a multi-row URL it is the first row the wizard
	// drops, leaving BROWSER=none users with no browser and no explanation.
	it("puts the suppressed-launch notice above the URL block", async () => {
		const previousBrowser = process.env.BROWSER;
		process.env.BROWSER = "none";
		const url = `https://auth.example.com/oauth/authorize?client_id=omp&state=${"n".repeat(120)}`;
		const loginGate = Promise.withResolvers<void>();
		vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const openedUrls: string[] = [];

		const authStorage = {
			has: (_providerId: string) => false,
			hasAuth: (_providerId: string) => false,
			getCredentialOrigin: (_providerId: string) => undefined,
			async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
				ctrl.onAuth({ url, instructions: "A browser window should open. Complete login to finish." });
				await loginGate.promise;
			},
		} as unknown as AuthStorage;

		const host = {
			ctx: {
				openInBrowser(openedUrl: string): void {
					openedUrls.push(openedUrl);
				},
				session: { modelRegistry: { authStorage, async refresh(): Promise<void> {} } },
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

			expect(openedUrls).toEqual([]);
			const plain = tab.render(60).map(line => Bun.stripANSI(line));
			const noticeIndex = plain.findIndex(line => line.includes("Browser launch disabled by BROWSER=none"));
			const urlIndex = plain.findIndex(line => line.startsWith("https://auth.example.com"));
			expect(noticeIndex).toBeGreaterThanOrEqual(0);
			expect(noticeIndex).toBeLessThan(urlIndex);
		} finally {
			tab.dispose();
			loginGate.resolve();
			await loginGate.promise;
			if (previousBrowser === undefined) delete process.env.BROWSER;
			else process.env.BROWSER = previousBrowser;
		}
	});
});
