import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { SignInScene } from "@oh-my-pi/pi-tui/setup/scenes/sign-in";
import type { SetupSceneHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeWithRetries } from "@oh-my-pi/pi-utils/temp";

let tempDir = "";
let store: SqliteAuthCredentialStore | undefined;
let reopenedStore: SqliteAuthCredentialStore | undefined;
let scene: SignInScene | undefined;

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	scene?.dispose();
	scene = undefined;
	vi.restoreAllMocks();
	reopenedStore?.close();
	reopenedStore = undefined;
	store?.close();
	store = undefined;
	if (tempDir) {
		await removeWithRetries(tempDir);
		tempDir = "";
	}
});

function searchProvider(target: SignInScene, providerId: string): void {
	for (const character of providerId) target.handleInput(character);
}

describe("provider credential removal persistence", () => {
	it("removes credentials through setup, persists after reopening, and preserves another provider", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-provider-removal-"));
		const dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		await store.upsertAuthCredential("opencode-go", {
			type: "api_key",
			key: "opencode-go-key-one",
			source: "login",
		});
		await store.upsertAuthCredential("opencode-go", {
			type: "api_key",
			key: "opencode-go-key-two",
			source: "login",
		});
		await store.upsertAuthCredential("opencode-zen", {
			type: "api_key",
			key: "opencode-zen-key",
			source: "login",
		});
		const authStorage = new AuthStorage(store);
		await authStorage.credentials.reload();
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);

		const refreshRequested = Promise.withResolvers<void>();
		const refreshedProviders: string[] = [];
		const host = {
			ctx: {
				authStorage,
				disabledProviders: [],
				async refreshProvider(providerId: string): Promise<void> {
					refreshedProviders.push(providerId);
					refreshRequested.resolve();
				},
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(): void {},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;
		scene = new SignInScene(host);

		searchProvider(scene, "opencode-go");
		scene.handleInput("\x04");
		expect(scene.render(120).join("\n")).toContain("Remove all saved credentials");
		const keyBeforeConfirmation = await authStorage.keys.get("opencode-go");
		if (keyBeforeConfirmation === undefined) throw new Error("expected a stored OpenCode Go API key before removal");
		expect(["opencode-go-key-one", "opencode-go-key-two"]).toContain(keyBeforeConfirmation);

		scene.handleInput("\n");
		await refreshRequested.promise;
		await Bun.sleep(0);
		expect(refreshedProviders).toEqual(["opencode-go"]);
		expect(authStorage.credentials.has("opencode-go")).toBe(false);
		expect(await authStorage.keys.get("opencode-zen")).toBe("opencode-zen-key");

		scene.dispose();
		scene = undefined;
		store.close();
		store = undefined;

		reopenedStore = await SqliteAuthCredentialStore.open(dbPath);
		const reopened = new AuthStorage(reopenedStore);
		await reopened.credentials.reload();
		expect(reopened.credentials.has("opencode-go")).toBe(false);
		expect(await reopened.keys.get("opencode-go")).toBeUndefined();
		expect(reopened.credentials.has("opencode-zen")).toBe(true);
		expect(await reopened.keys.get("opencode-zen")).toBe("opencode-zen-key");
	});
});
