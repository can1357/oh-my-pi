import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "../src/config/model-registry";
import { normalizeModelPatternList, resolveModelOverrideWithAuthFallback } from "../src/config/model-resolver";
import { Settings } from "../src/config/settings";
import type { AuthStorage } from "../src/session/auth-storage";
import * as discovery from "../src/task/discovery";
import { resolveEffectiveSubagentPolicy } from "../src/task/structured-subagent";
import type { ToolSession } from "../src/tools";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let tempDir: string;
let authStorage: AuthStorage;
let registry: ModelRegistry;
let settings: Settings;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-enabled-models-"));
	authStorage = createInMemoryAuthStorage();
	registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	registry.registerProvider("scope-test", {
		baseUrl: "https://example.test/v1",
		api: "openai-completions",
		apiKey: "scope-test-key",
		models: ["forbidden", "allowed"].map(id => ({
			id,
			name: id,
			reasoning: false,
			input: ["text" as const],
			contextWindow: 8192,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	});
	settings = Settings.isolated({ enabledModels: ["scope-test/allowed"] });
});

afterEach(async () => {
	vi.restoreAllMocks();
	registry.unregisterProvider("scope-test");
	authStorage.close();
	await fs.rm(tempDir, { recursive: true, force: true });
});

function session(agentModel: string[] = ["scope-test/allowed"]): ToolSession {
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [
			{
				name: "worker",
				description: "Test worker",
				systemPrompt: "Inspect the target.",
				source: "bundled",
				model: agentModel,
			},
		],
		projectAgentsDir: null,
	});
	return {
		cwd: tempDir,
		hasUI: false,
		settings,
		modelRegistry: registry,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "scope-test/allowed",
	} as unknown as ToolSession;
}

test.each(["request", "settings override", "frontmatter"] as const)(
	"rejects a forbidden %s selection before spawning",
	async source => {
		const toolSession = session(source === "frontmatter" ? ["scope-test/forbidden"] : undefined);
		if (source === "settings override") {
			settings.override("task.agentModelOverrides", { worker: "scope-test/forbidden" });
		}
		await expect(
			resolveEffectiveSubagentPolicy({
				session: toolSession,
				invocationKind: "task",
				assignment: "Inspect the target.",
				agent: "worker",
				model: source === "request" ? "scope-test/forbidden" : undefined,
			}),
		).rejects.toMatchObject({ kind: "preflight" });
	},
);

test("skips a forbidden ordered candidate at execution after shared preflight", async () => {
	const policy = await resolveEffectiveSubagentPolicy({
		session: session(),
		invocationKind: "eval",
		assignment: "Inspect the target.",
		agent: "worker",
		model: ["scope-test/forbidden", "scope-test/allowed"],
	});
	const result = await resolveModelOverrideWithAuthFallback(
		normalizeModelPatternList(policy.modelOverride),
		policy.parentActiveModelPattern,
		registry,
		settings,
	);
	expect(result.model?.id).toBe("allowed");
});

test("inherits the allowed live parent rather than the forbidden configured default", async () => {
	settings.setModelRole("default", "scope-test/forbidden");
	const policy = await resolveEffectiveSubagentPolicy({
		session: session(["*"]),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
	});
	const result = await resolveModelOverrideWithAuthFallback(
		normalizeModelPatternList(policy.modelOverride),
		policy.parentActiveModelPattern,
		registry,
		settings,
	);
	expect(result.model?.id).toBe("allowed");
});

test("an empty internal selector still uses allowed agent frontmatter", async () => {
	const policy = await resolveEffectiveSubagentPolicy({
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		model: "",
	});
	const result = await resolveModelOverrideWithAuthFallback(
		normalizeModelPatternList(policy.modelOverride),
		policy.parentActiveModelPattern,
		registry,
		settings,
	);
	expect(result.model?.id).toBe("allowed");
});

test("does not use an authenticated parent outside the scope as auth fallback", async () => {
	vi.spyOn(registry, "getApiKey").mockImplementation(async model =>
		model.id === "allowed" ? undefined : "parent-key",
	);
	const result = await resolveModelOverrideWithAuthFallback(
		["scope-test/allowed"],
		"scope-test/forbidden",
		registry,
		settings,
	);
	expect(result.model?.id).toBe("allowed");
	expect(result.authFallbackUsed).toBe(false);
});

test("an unmatched enabledModels scope cannot recover through the global catalog", async () => {
	settings.override("enabledModels", ["scope-test/missing"]);
	const result = await resolveModelOverrideWithAuthFallback(
		["scope-test/forbidden"],
		"scope-test/allowed",
		registry,
		settings,
	);
	expect(result.model).toBeUndefined();
});

test("an empty enabledModels list keeps unrestricted selection", async () => {
	settings.override("enabledModels", []);
	const policy = await resolveEffectiveSubagentPolicy({
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		model: "scope-test/forbidden",
	});
	const result = await resolveModelOverrideWithAuthFallback(
		normalizeModelPatternList(policy.modelOverride),
		undefined,
		registry,
		settings,
	);
	expect(result.model?.id).toBe("forbidden");
});
