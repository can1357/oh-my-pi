import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

describe("stored subscription credentials", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let auth: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-subscription-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		auth = new AuthStorage(store);
	});

	afterEach(async () => {
		store.close();
		await removeWithRetries(tempDir);
	});

	test("Mistral Vibe login keys count as subscription, but pasted and env keys remain metered", async () => {
		await auth.credentials.set("mistral", { type: "api_key", key: "pasted-key" });
		expect(auth.credentials.hasSubscription("mistral")).toBe(false);
		expect(auth.credentials.hasOAuth("mistral")).toBe(false);

		await withEnv({ MISTRAL_API_KEY: "env-key" }, () => {
			expect(auth.credentials.hasSubscription("mistral")).toBe(false);
		});

		await auth.credentials.set("mistral", { type: "api_key", key: "vibe-key", source: "login" });
		expect(store.listAuthCredentials("mistral")[0]?.credential).toEqual({
			type: "api_key",
			key: "vibe-key",
			source: "login",
		});
		expect(auth.credentials.hasSubscription("mistral")).toBe(true);
		expect(auth.credentials.hasOAuth("mistral")).toBe(false);
	});

	test("login keys without a subscription policy remain metered; OAuth remains a subscription", async () => {
		await auth.credentials.set("kagi", { type: "api_key", key: "login-key", source: "login" });
		expect(auth.credentials.hasSubscription("kagi")).toBe(false);
		expect(auth.credentials.hasOAuth("kagi")).toBe(false);

		await auth.credentials.set("mistral", {
			type: "oauth",
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 60_000,
		});
		expect(auth.credentials.hasSubscription("mistral")).toBe(true);
		expect(auth.credentials.hasOAuth("mistral")).toBe(true);
	});
});
