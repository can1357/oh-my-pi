import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthLoginCallbacks, OAuthProviderId } from "@oh-my-pi/pi-ai/oauth/types";
import { logger } from "@oh-my-pi/pi-utils";
import { SignInScene } from "@oh-my-pi/pi-tui/setup/scenes/sign-in";
import type { SetupSceneHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function removalScene(options: {
	credentials: readonly (readonly [string, number])[];
	externalSources?: readonly (readonly [string, string])[];
	removeGate?: Promise<void>;
	removeStarted?: () => void;
	failRemove?: boolean;
	failRefresh?: boolean;
	onRefresh?: (providerId: string) => void;
	onReload?: (credentials: Map<string, number>) => void;
}): {
	scene: SignInScene;
	credentials: Map<string, number>;
	refreshes: string[];
	renders: () => number;
	finishes: () => number;
	focusEvents: () => number;
} {
	const credentials = new Map(options.credentials);
	const externalSources = new Map(options.externalSources ?? []);
	const refreshes: string[] = [];
	let renders = 0;
	let finishes = 0;
	let focusEvents = 0;
	const authStorage = {
		credentials: {
			has: (providerId: string) => credentials.has(providerId),
			async reload(): Promise<void> {
				options.onReload?.(credentials);
			},
			async remove(providerId: string): Promise<void> {
				options.removeStarted?.();
				await options.removeGate;
				if (options.failRemove) throw new Error("private credential store detail");
				credentials.delete(providerId);
			},
		},
		keys: {
			source: (providerId: string) =>
				credentials.has(providerId)
					? { kind: "api_key", concrete: true }
					: externalSources.has(providerId)
						? { kind: "env", concrete: true, envVar: externalSources.get(providerId) }
						: undefined,
			describe: (providerId: string) => externalSources.get(providerId),
		},
	} as unknown as AuthStorage;
	const host = {
		ctx: {
			authStorage,
			disabledProviders: [],
			async refreshProvider(providerId: string): Promise<void> {
				refreshes.push(providerId);
				options.onRefresh?.(providerId);
				if (options.failRefresh) throw new Error("discovery endpoint unavailable");
			},
		},
		requestRender(): void {
			renders++;
		},
		finish(): void {
			finishes++;
		},
		setFocus(): void {
			focusEvents++;
		},
		restoreFocus(): void {
			focusEvents++;
		},
	} as unknown as SetupSceneHost;
	return {
		scene: new SignInScene(host),
		credentials,
		refreshes,
		renders: () => renders,
		finishes: () => finishes,
		focusEvents: () => focusEvents,
	};
}

function searchProvider(scene: SignInScene, providerId: string): void {
	for (const character of providerId) scene.handleInput(character);
}

describe("SignInScene", () => {
	it("keeps the removal warning and cancel action visible on a short screen", () => {
		const target = getOAuthProviders()[0];
		if (!target) throw new Error("OAuth provider fixture is empty");
		const fixture = removalScene({ credentials: [[target.id, 1]] });
		fixture.scene.handleInput("\x04");

		const output = fixture.scene
			.render(80, 12)
			.map(line => Bun.stripANSI(line))
			.join(" ")
			.replaceAll("│", " ")
			.replace(/\s+/g, " ");
		expect(output).toContain("Remove all saved credentials");
		expect(output).toContain("Environment variables and config files are unchanged");
		expect(output).toContain("cancel");
		fixture.scene.dispose();
	});

	it("removes every saved credential for the provider and refreshes only that provider", async () => {
		const refreshStarted = Promise.withResolvers<void>();
		const fixture = removalScene({
			credentials: [
				["opencode-go", 2],
				["opencode-zen", 1],
			],
			onRefresh: () => refreshStarted.resolve(),
		});
		searchProvider(fixture.scene, "opencode-go");
		fixture.scene.handleInput("\x04");
		fixture.scene.handleInput("\n");
		await refreshStarted.promise;
		await Bun.sleep(0);

		expect(fixture.credentials.has("opencode-go")).toBe(false);
		expect(fixture.credentials.get("opencode-zen")).toBe(1);
		expect(fixture.refreshes).toEqual(["opencode-go"]);
		expect(fixture.scene.render(100).join("\n")).toContain("Removed saved credentials for opencode-go");
		fixture.scene.dispose();
	});

	it("cancels removal without deleting credentials, refreshing models, or finishing setup", () => {
		const fixture = removalScene({ credentials: [["opencode-go", 1]] });
		searchProvider(fixture.scene, "opencode-go");
		fixture.scene.handleInput("\x04");
		fixture.scene.handleInput("\x1b");

		expect(fixture.credentials.get("opencode-go")).toBe(1);
		expect(fixture.refreshes).toEqual([]);
		expect(fixture.finishes()).toBe(0);
		fixture.scene.dispose();
	});

	it("shows an external auth source after removing the saved credential", async () => {
		const fixture = removalScene({
			credentials: [["opencode-go", 1]],
			externalSources: [["opencode-go", "OPENCODE_GO_API_KEY"]],
		});
		searchProvider(fixture.scene, "opencode-go");
		fixture.scene.handleInput("\x04");
		fixture.scene.handleInput("\n");
		await Bun.sleep(0);

		const output = fixture.scene.render(120).join("\n");
		expect(fixture.credentials.has("opencode-go")).toBe(false);
		expect(output).toContain("OPENCODE_GO_API_KEY");
		expect(output).toContain("Still authenticated");
		expect(output).not.toContain("Logged out");
		fixture.scene.dispose();
	});

	it("preserves saved credentials and skips refresh when storage removal fails", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const fixture = removalScene({ credentials: [["opencode-go", 1]], failRemove: true });
		searchProvider(fixture.scene, "opencode-go");
		fixture.scene.handleInput("\x04");
		fixture.scene.handleInput("\n");
		await Bun.sleep(0);

		expect(fixture.credentials.has("opencode-go")).toBe(true);
		expect(fixture.refreshes).toEqual([]);
		const output = fixture.scene.render(100).join("\n");
		expect(output).toContain("Some credentials may have been removed");
		expect(output).toContain("Check the credential store and try again");
		expect(output).not.toContain("private credential store detail");
		expect(warn).toHaveBeenCalledWith(
			"Provider credential removal failed",
			expect.objectContaining({ providerId: "opencode-go", error: expect.any(Error) }),
		);
		fixture.scene.dispose();
	});

	it("reports model refresh failure separately after credentials are removed", async () => {
		const fixture = removalScene({ credentials: [["opencode-go", 1]], failRefresh: true });
		searchProvider(fixture.scene, "opencode-go");
		fixture.scene.handleInput("\x04");
		fixture.scene.handleInput("\n");
		await Bun.sleep(0);

		const output = fixture.scene.render(120).join("\n");
		expect(fixture.credentials.has("opencode-go")).toBe(false);
		expect(fixture.refreshes).toEqual(["opencode-go"]);
		expect(output).toContain("Removed saved credentials for opencode-go");
		expect(output).toContain("refresh");
		fixture.scene.dispose();
	});

	it("does not update focus or render after disposal while removal awaits", async () => {
		const removeGate = Promise.withResolvers<void>();
		const removeStarted = Promise.withResolvers<void>();
		const fixture = removalScene({
			credentials: [["opencode-go", 1]],
			removeGate: removeGate.promise,
			removeStarted: () => removeStarted.resolve(),
		});
		searchProvider(fixture.scene, "opencode-go");
		fixture.scene.handleInput("\x04");
		fixture.scene.handleInput("\n");
		await removeStarted.promise;
		const inFlight = fixture.scene
			.render(120)
			.map(line => Bun.stripANSI(line))
			.join(" ");
		expect(inFlight.match(/Removing saved credentials/g) ?? []).toHaveLength(1);
		fixture.scene.handleInput("\x1b");
		expect(fixture.finishes()).toBe(1);
		const renderCount = fixture.renders();
		const focusCount = fixture.focusEvents();
		fixture.scene.dispose();
		removeGate.resolve();
		await removeGate.promise;
		await Bun.sleep(0);

		expect(fixture.credentials.has("opencode-go")).toBe(false);
		expect(fixture.renders()).toBe(renderCount);
		expect(fixture.focusEvents()).toBe(focusCount);
		expect(fixture.refreshes).toEqual(["opencode-go"]);
	});

	it("detects a credential removed by another process during storage reload", async () => {
		const fixture = removalScene({
			credentials: [["opencode-go", 1]],
			onReload(credentials) {
				credentials.delete("opencode-go");
			},
		});
		searchProvider(fixture.scene, "opencode-go");
		fixture.scene.handleInput("\x04");
		fixture.scene.handleInput("\n");
		await Bun.sleep(0);

		const output = fixture.scene.render(100).join("\n");
		expect(fixture.credentials.has("opencode-go")).toBe(false);
		expect(fixture.refreshes).toEqual([]);
		expect(output).toContain("No saved credentials");
		expect(output).not.toContain("Removed saved credentials for opencode-go");
		fixture.scene.dispose();
	});

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
				openInBrowser(openedUrl: string): void {
					openedUrls.push(openedUrl);
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
				openInBrowser(): void {},
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
				openInBrowser(): void {},
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
});
