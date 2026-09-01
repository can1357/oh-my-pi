import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { OAuthLoginCallbacks, OAuthProviderId } from "@oh-my-pi/pi-ai/oauth/types";
import { providersSetupScene } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/scenes/providers";
import type { SetupSceneHost } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/scenes/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";

beforeAll(async () => {
	await initTheme();
});

describe("providers setup scene", () => {
	// Reported 2026-08-31: "also the tab to cycle doesn't do anything". It is
	// deliberate — an in-flight OAuth login is modal and swallows every key —
	// but the strip kept advertising the shortcut, so the lock read as a bug.
	it("drops the tab hint while an in-flight login owns the keyboard", async () => {
		const loginGate = Promise.withResolvers<void>();
		vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);

		const authStorage = {
			has: (_providerId: string) => false,
			hasAuth: (_providerId: string) => false,
			getCredentialOrigin: (_providerId: string) => undefined,
			async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
				ctrl.onAuth({ url: "https://example.com/oauth/authorize?client_id=omp&state=tab" });
				await loginGate.promise;
			},
		} as unknown as AuthStorage;

		const host = {
			ctx: {
				openInBrowser(): void {},
				settings: { get: (_key: string) => undefined },
				session: { modelRegistry: { authStorage, async refresh(): Promise<void> {} } },
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(): void {},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const scene = providersSetupScene.mount(host);
		try {
			expect(scene.render(80).join("\n")).toContain("(tab to cycle)");

			for (const char of "anthropic") {
				scene.handleInput?.(char);
			}
			scene.handleInput?.("\n");
			await Promise.resolve();

			expect(scene.render(80).join("\n")).not.toContain("(tab to cycle)");
		} finally {
			scene.dispose?.();
			loginGate.resolve();
			await loginGate.promise;
		}
	});
});
