import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/** A `ListAvailableModels` entry as a Free login returns it: no request schema. */
function listed(modelId: string, image: boolean, maxInputTokens: number, rateMultiplier: number) {
	return {
		modelId,
		modelName: modelId,
		rateMultiplier,
		rateUnit: "Credit",
		supportedInputTypes: image ? ["TEXT", "IMAGE"] : ["TEXT"],
		tokenLimits: { maxInputTokens, maxOutputTokens: 64_000 },
	};
}

const FREE_ROSTER = [
	listed("auto", true, 1_000_000, 1),
	listed("claude-sonnet-4.5", true, 200_000, 1.3),
	listed("claude-haiku-4.5", true, 200_000, 0.4),
	listed("deepseek-3.2", false, 164_000, 0.25),
	listed("minimax-m2.5", false, 196_000, 0.25),
	listed("minimax-m2.1", false, 196_000, 0.15),
	listed("glm-5", false, 200_000, 0.5),
	listed("qwen3-coder-next", false, 256_000, 0.05),
];

const OPUS = {
	additionalModelRequestFieldsSchema: {
		type: "object",
		properties: {
			thinking: {
				type: "object",
				properties: {
					type: { type: "string", enum: ["adaptive"] },
					display: { type: "string", enum: ["summarized", "omitted"] },
				},
				required: ["type"],
			},
			output_config: {
				type: "object",
				properties: {
					effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
				},
			},
			max_tokens: { type: "integer", minimum: 1024, maximum: 64_000 },
		},
		additionalProperties: false,
	},
	description: "Claude Opus 5.5 model with 1M context window",
	modelId: "claude-opus-5.5",
	modelName: "claude-opus-5.5",
	promptCaching: { supportsPromptCaching: true },
	rateMultiplier: 2,
	rateUnit: "Credit",
	refusalFallbackModels: [{ modelId: "claude-opus-4.8" }],
	supportedInputTypes: ["TEXT", "IMAGE"],
	tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
};

const ROSTERS: Record<string, object> = {
	"Bearer token-free": { defaultModel: { modelId: "auto" }, models: FREE_ROSTER },
	"Bearer token-pro": { defaultModel: { modelId: "auto" }, models: [...FREE_ROSTER, OPUS] },
};

const LOGINS = {
	free: { access: "token-free", refresh: "refresh-free", accountId: "11111111-1111-4111-8111-111111111111" },
	pro: { access: "token-pro", refresh: "refresh-pro", accountId: "22222222-2222-4222-8222-222222222222" },
};

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

test.each([
	["Free login first", [LOGINS.free, LOGINS.pro]],
	["Pro login first", [LOGINS.pro, LOGINS.free]],
])("Kiro discovery lists every login's models and routes each to a login serving it (%s)", async (_, logins) => {
	await authStorage.credentials.set(
		"kiro",
		logins.map(login => ({
			type: "oauth" as const,
			...login,
			expires: Date.now() + 3_600_000,
			region: "us-east-1",
			kiroProfileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/EXAMPLE",
		})),
	);
	const fetchMock: FetchImpl = async (_input, init) => {
		const roster = ROSTERS[new Headers(init?.headers).get("authorization") ?? ""];
		return roster ? Response.json(roster) : new Response("Unauthorized", { status: 401 });
	};
	const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"), { fetch: fetchMock });

	await registry.refreshProvider("kiro", "online");

	const ids = registry
		.getAll()
		.filter(model => model.provider === "kiro")
		.map(model => model.id);
	expect(ids.toSorted()).toEqual([...FREE_ROSTER.map(model => model.modelId), OPUS.modelId].toSorted());
	const opus = registry.find("kiro", "claude-opus-5.5");
	expect(opus?.accountAccess).toEqual({ [LOGINS.pro.accountId]: {} });
	expect(registry.find("kiro", "glm-5")?.accountAccess).toEqual({
		[LOGINS.free.accountId]: {},
		[LOGINS.pro.accountId]: {},
	});

	// A session pinned to the Free login moves to the Pro login for a model only Pro serves.
	const sessionId = "kiro-opus-session";
	const free = authStorage.oauth.accounts("kiro").find(account => account.accountId === LOGINS.free.accountId);
	if (!free || !opus) throw new Error("expected the Free login and Claude Opus 5.5");
	expect(authStorage.sessions.pin("kiro", sessionId, free.credentialId)).toBe(true);
	expect(await registry.getApiKey(opus, sessionId)).toContain(`"token":"${LOGINS.pro.access}"`);
});
