import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { OAuthLoginCallbacks, OAuthProviderId } from "@oh-my-pi/pi-ai/oauth/types";
import { SignInScene } from "@oh-my-pi/pi-tui/setup/scenes/sign-in";
import type { SetupSceneHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import { loginUrlCopyCommand, loginUrlWritesSettled } from "@oh-my-pi/pi-tui/login-url";
import * as piUtils from "@oh-my-pi/pi-utils";

// Every login persists its URL under the agent dir; keep that off the real one.
let agentDir: string;
beforeEach(() => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp agent dir with a long spaced name "));
	vi.spyOn(piUtils, "getAgentDir").mockReturnValue(agentDir);
});

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	// A write still in flight would re-create the dir after the rm.
	await loginUrlWritesSettled();
	vi.restoreAllMocks();
	fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("SignInScene", () => {
	it("masks secret input and keeps the OSC8 login link and manual-code prompt above clipped rows", async () => {
		const url = `https://example.com/oauth/authorize?client_id=omp&redirect_uri=http%3A%2F%2Flocalhost%3A45454%2Fcallback&state=${"a".repeat(96)}`;
		const loginGate = Promise.withResolvers<void>();
		const secretReceived = Promise.withResolvers<string>();
		const secretValue = crypto.randomUUID();
		const copySpy = vi.fn(async (_text: string): Promise<void> => {});
		let focusTarget: Component | undefined;
		const openedUrls: string[] = [];

		const authStorage = {
			credentials: { has: (_providerId: string) => false },
			keys: { source: (_providerId: string) => undefined },
			oauth: {
				async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
					ctrl.onAuth({ url });
					secretReceived.resolve(
						await ctrl.onPrompt({ message: "Consumer key", placeholder: "secret value", secret: true }),
					);
					const prompt = ctrl.onManualCodeInput?.();
					await loginGate.promise;
					await prompt;
				},
			},
		} as unknown as AuthStorage;

		const host = {
			ctx: {
				authStorage,
				disabledProviders: [],
				copyToClipboard: copySpy,
				refreshProvider: async () => {},
				openInBrowser(openedUrl: string): boolean {
					openedUrls.push(openedUrl);
					return true;
				},
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(component: Component | null): void {
				focusTarget = component ?? undefined;
			},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const tab = new SignInScene(host);
		try {
			for (const char of "anthropic") {
				tab.handleInput(char);
			}
			tab.handleInput("\n");

			expect(focusTarget).toBeDefined();
			focusTarget?.handleInput?.(secretValue);
			const masked = tab.render(120).join("\n");
			expect(masked).not.toContain(secretValue);
			focusTarget?.handleInput?.("\n");
			await expect(secretReceived.promise).resolves.toBe(secretValue);

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
		const copySpy = vi.fn(async (_text: string): Promise<void> => {});
		const authStorage = {
			credentials: { has: (_providerId: string) => false },
			keys: { source: (_providerId: string) => undefined },
			oauth: {
				async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
					ctrl.onAuth({ url });
					const settled = new AbortController();
					const prompt = ctrl.onManualCodeInput?.(settled.signal);
					settled.abort(new Error("native callback received"));
					await prompt?.catch(() => {});
					loginCompleted.resolve();
				},
			},
		} as unknown as AuthStorage;
		const host = {
			ctx: {
				authStorage,
				disabledProviders: [],
				copyToClipboard: copySpy,
				refreshProvider: async () => {},
				openInBrowser: () => true,
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(): void {},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const tab = new SignInScene(host);
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
		const copySpy = vi.fn(async (_text: string): Promise<void> => {});

		const authStorage = {
			credentials: { has: (_providerId: string) => false },
			keys: { source: (_providerId: string) => undefined },
			oauth: {
				async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
					ctrl.onAuth({ url });
					await loginGate.promise;
				},
			},
		} as unknown as AuthStorage;

		const host = {
			ctx: {
				authStorage,
				disabledProviders: [],
				copyToClipboard: copySpy,
				refreshProvider: async () => {},
				openInBrowser: () => true,
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(): void {},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const tab = new SignInScene(host);
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

	it("shows the suppressed-launch notice and a byte-complete clean-copy command", async () => {
		const url = `https://auth.example.com/oauth/authorize?client_id=omp&state=${"n".repeat(120)}`;
		const loginGate = Promise.withResolvers<void>();
		const authStorage = {
			credentials: { has: (_providerId: string) => false },
			keys: { source: (_providerId: string) => undefined },
			oauth: {
				async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
					ctrl.onAuth({ url });
					const prompt = ctrl.onManualCodeInput?.();
					await loginGate.promise;
					await prompt;
				},
			},
		} as unknown as AuthStorage;
		const host = {
			ctx: {
				authStorage,
				disabledProviders: [],
				copyToClipboard: async () => {},
				refreshProvider: async () => {},
				// BROWSER=none: the launch was suppressed.
				openInBrowser: () => false,
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(): void {},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const tab = new SignInScene(host);
		try {
			for (const char of "anthropic") tab.handleInput(char);
			tab.handleInput("\n");
			// The persisted-URL write is fire-and-forget off the render path.
			await loginUrlWritesSettled();
			const urlFileName = fs.readdirSync(agentDir).find(name => name.startsWith("login-url-"));
			expect(urlFileName).toBeDefined();
			expect(fs.readFileSync(path.join(agentDir, urlFileName as string), "utf8")).toBe(`${url}\n`);
			const expected = `Clean copy: ${loginUrlCopyCommand(path.join(agentDir, urlFileName as string))}`;

			const width = 44;
			// Premise: the spaced agent dir must actually overflow the row.
			expect(expected.length).toBeGreaterThan(width);
			const plain = tab.render(width).map(line => Bun.stripANSI(line));
			// The notice sits above the multi-row URL, which a short terminal clips first.
			const noticeIndex = plain.findIndex(line => line.includes("Browser launch disabled by BROWSER=none"));
			const urlIndex = plain.findIndex(line => line.trim().startsWith("https://auth.example.com"));
			expect(noticeIndex).toBeGreaterThanOrEqual(0);
			expect(noticeIndex).toBeLessThan(urlIndex);
			// Column-wrapped: wrapTextWithAnsi would swallow the space at a break.
			const first = plain.findIndex(line => line.trimStart().startsWith("Clean copy: "));
			expect(first).toBeGreaterThanOrEqual(0);
			const indent = plain[first].length - plain[first].trimStart().length;
			const rows = plain.slice(first, first + Math.ceil(expected.length / (width - indent)));
			expect(
				rows
					.map(row => row.slice(indent))
					.join("")
					.trimEnd(),
			).toBe(expected);
		} finally {
			tab.dispose();
			loginGate.resolve();
			await loginGate.promise;
		}
	});
});
