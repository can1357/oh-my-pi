import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { OAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const AUTO = { modelId: "auto", tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 } };
const OPUS = { modelId: "claude-opus-5.5", tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 } };
const ROSTERS: Record<string, unknown[]> = { "Bearer token-free": [AUTO], "Bearer token-pro": [AUTO, OPUS] };

let tempDir: string;
let authStorage: AuthStorage;

beforeEach(async () => {
	tempDir = path.join(os.tmpdir(), `pi-test-kiro-accounts-${Snowflake.next()}`);
	await fs.promises.mkdir(tempDir, { recursive: true });
	authStorage = await AuthStorage.create(":memory:");
});

afterEach(() => {
	authStorage.close();
	if (fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
});

test("Kiro discovery lists every login's models and routes each to a login serving it", async () => {
	await authStorage.credentials.set(
		"kiro",
		["free", "pro"].map((plan): OAuthCredential => ({
			type: "oauth",
			access: `token-${plan}`,
			refresh: `refresh-${plan}`,
			expires: Date.now() + 3_600_000,
			accountId: `login-${plan}`,
			region: "us-east-1",
		})),
	);
	const fetchMock: FetchImpl = async (_input, init) => {
		const models = ROSTERS[new Headers(init?.headers).get("authorization") ?? ""];
		return models ? Response.json({ models }) : new Response("Unauthorized", { status: 401 });
	};
	const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"), { fetch: fetchMock });

	await registry.refreshProvider("kiro", "online");

	const opus = registry.find("kiro", "claude-opus-5.5");
	expect(opus?.accountAccess).toEqual({ "login-pro": {} });
	const free = authStorage.oauth.accounts("kiro").find(account => account.accountId === "login-free");
	if (!free || !opus) throw new Error("expected the Free login and Claude Opus 5.5");
	expect(authStorage.sessions.pin("kiro", "kiro-opus-session", free.credentialId)).toBe(true);
	expect(await registry.getApiKey(opus, "kiro-opus-session")).toContain('"token":"token-pro"');
});
