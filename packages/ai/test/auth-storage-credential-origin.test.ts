import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

// Clear every env var the providers under test alias, so ambient shell / ~/.env
// state can't leak an env origin into precedence assertions.
const SUPPRESS_ENV = {
	OPENAI_API_KEY: undefined,
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
	COPILOT_GITHUB_TOKEN: undefined,
} as const;

describe("AuthStorage.getCredentialOrigin", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let auth: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-credential-origin-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		auth = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		auth = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("undefined when no auth is configured", async () => {
		await withEnv(SUPPRESS_ENV, () => {
			// Provider absent from the env map entirely — no env fallback can apply.
			expect(auth?.getCredentialOrigin("no-such-provider")).toBeUndefined();
		});
	});

	test("env origin carries the backing variable name for single-var providers", async () => {
		await withEnv({ ...SUPPRESS_ENV, COPILOT_GITHUB_TOKEN: "ghp_fake" }, () => {
			expect(auth?.getCredentialOrigin("github-copilot")).toEqual({
				kind: "env",
				envVar: "COPILOT_GITHUB_TOKEN",
			});
		});
	});

	test("env origin omits the variable name for computed resolvers", async () => {
		// anthropic resolves through $pickenv(...) — no single variable describes it.
		await withEnv({ ...SUPPRESS_ENV, ANTHROPIC_API_KEY: "sk-fake" }, () => {
			expect(auth?.getCredentialOrigin("anthropic")).toEqual({ kind: "env" });
		});
	});

	test("a stored OAuth credential outranks an env var", async () => {
		await withEnv({ ...SUPPRESS_ENV, COPILOT_GITHUB_TOKEN: "ghp_fake" }, async () => {
			await auth?.set("github-copilot", [
				{ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
			]);
			expect(auth?.getCredentialOrigin("github-copilot")).toEqual({ kind: "oauth" });
		});
	});

	test("a stored OAuth credential outranks a co-stored api key", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			// getApiKey() resolves stored OAuth before a stored api_key, so the origin must match.
			await auth?.set("openai", [
				{ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
				{ type: "api_key", key: "sk-stored" },
			]);
			expect(auth?.getCredentialOrigin("openai")).toEqual({ kind: "oauth" });
		});
	});

	test("an explicit env var outranks a stored api key", async () => {
		// Regression: a live env var is the user's current choice and must win over a stored
		// static api_key (e.g. a stale broker-migrated copy) so `GEMINI_API_KEY` etc. take effect.
		await withEnv({ ...SUPPRESS_ENV, OPENAI_API_KEY: "sk-env" }, async () => {
			await auth?.set("openai", [{ type: "api_key", key: "sk-stored" }]);
			expect(auth?.getCredentialOrigin("openai")).toEqual({ kind: "env", envVar: "OPENAI_API_KEY" });
			expect(await auth?.getApiKey("openai")).toBe("sk-env");
		});
	});

	test("config then runtime overrides take precedence over stored credentials", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!auth) throw new Error("test setup failed");
			await auth.set("openai", [{ type: "api_key", key: "sk-stored" }]);
			expect(auth.getCredentialOrigin("openai")).toEqual({ kind: "api_key" });

			auth.setConfigApiKey("openai", "gateway-bearer");
			expect(auth.getCredentialOrigin("openai")).toEqual({ kind: "config" });

			auth.setRuntimeApiKey("openai", "cli-flag-bearer");
			expect(auth.getCredentialOrigin("openai")).toEqual({ kind: "runtime" });
		});
	});
});
