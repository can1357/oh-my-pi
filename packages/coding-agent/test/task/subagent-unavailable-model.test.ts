import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ServingModel } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createSessionDefaults } from "../helpers/session-defaults";

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

const agent: AgentDefinition = { name: "astra-api", description: "test", systemPrompt: "test", source: "bundled" };

/**
 * Fake session that yields once. `servingModel` follows the real contract:
 * `runtimeFallback` emits the session's `retry_fallback_applied` event and
 * moves attribution onto the fallback, as a served fallback turn does.
 */
function createYieldingSession(
	servingModel: ServingModel,
	runtimeFallback?: { to: ServingModel; reason: string },
): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const emit = (event: { type: string; [key: string]: unknown }): void => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		...createSessionDefaults(),
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		model: model("primary", "declared-model"),
		servingModel,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			if (runtimeFallback) {
				emit({
					type: "retry_fallback_applied",
					from: servingModel.selector,
					to: runtimeFallback.to.selector,
					role: "subagent:unavailable",
					reason: runtimeFallback.reason,
				});
				session.servingModel = runtimeFallback.to;
				emit({
					type: "retry_fallback_succeeded",
					model: runtimeFallback.to.selector,
					role: "subagent:unavailable",
				});
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield",
				toolName: "yield",
				result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
				isError: false,
			});
		},
	};
	return session as unknown as AgentSession;
}

describe("subagent whose declared model cannot serve", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	});

	it("defers a declared model without working credentials to session creation instead of taking the parent model", async () => {
		const declared = model("primary", "declared-model");
		const parent = model("parent", "session-model");
		let childModel: Model | undefined;
		let childModelPattern: unknown;
		let childModelPatternAuthFallback: unknown;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childModel = options.model;
			childModelPattern = options.modelPattern;
			childModelPatternAuthFallback = options.modelPatternAuthFallback;
			return {
				session: createYieldingSession({ selector: "parent/session-model", isFallback: true }),
				extensionsResult: {},
				setToolUIContext: () => {},
			} as never;
		});

		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "no-credentials",
			modelOverride: ["primary/declared-model"],
			parentActiveModelPattern: "parent/session-model",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				refreshIfStale: async () => false,
				getAvailable: () => [declared, parent],
				getApiKey: async (requested: Model) => (requested.provider === "primary" ? undefined : "parent-key"),
			} as never,
			enableLsp: false,
		});

		expect(childModel).toBeUndefined();
		expect(childModelPattern).toEqual(["primary/declared-model"]);
		expect(childModelPatternAuthFallback).toBe("parent/session-model");
	});

	it("re-reads models.yml when the reused registry predates the declared model's provider", async () => {
		const dir = path.join(os.tmpdir(), `omp-subagent-late-provider-${Snowflake.next()}`);
		tempDirs.push(dir);
		fs.mkdirSync(dir, { recursive: true });
		const modelsPath = path.join(dir, "models.yml");
		fs.writeFileSync(modelsPath, "providers: {}\n");
		const authStorage = createInMemoryAuthStorage();
		try {
			const modelRegistry = new ModelRegistry(authStorage, modelsPath);
			expect(modelRegistry.find("late-provider", "late-model")).toBeUndefined();
			fs.writeFileSync(
				modelsPath,
				[
					"providers:",
					"  late-provider:",
					"    baseUrl: https://late.example.test/v1",
					"    auth: none",
					"    api: openai-completions",
					"    models:",
					"      - id: late-model",
				].join("\n"),
			);
			const later = new Date(Date.now() + 1000);
			fs.utimesSync(modelsPath, later, later);
			let childModel: Model | undefined;
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
				childModel = options?.model;
				return {
					session: createYieldingSession({ selector: "late-provider/late-model", isFallback: false }),
					extensionsResult: {},
					setToolUIContext: () => {},
				} as never;
			});

			await runSubprocess({
				cwd: "/tmp",
				agent,
				task: "work",
				index: 0,
				id: "late-provider",
				modelOverride: ["late-provider/late-model"],
				settings: Settings.isolated(),
				modelRegistry,
				enableLsp: false,
			});

			expect(childModel?.provider).toBe("late-provider");
			expect(childModel?.id).toBe("late-model");
		} finally {
			authStorage.close();
		}
	});

	it("reports why a startup fallback served the run on the settled result", async () => {
		const declared = model("primary", "declared-model");
		const reason =
			"Fallback: primary/declared-model -> parent/session-model\nprimary/declared-model has no working credentials";
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () =>
				({
					session: createYieldingSession({ selector: "parent/session-model", isFallback: true }),
					modelFallbackMessage: reason,
					extensionsResult: {},
					setToolUIContext: () => {},
				}) as never,
		);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "startup-fallback",
			modelOverride: ["primary/declared-model"],
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				refreshIfStale: async () => false,
				getAvailable: () => [declared],
				getApiKey: async () => undefined,
			} as never,
			enableLsp: false,
		});

		expect(result.resolvedModel).toBe("parent/session-model");
		expect(result.resolvedModelIsFallback).toBe(true);
		expect(result.resolvedModelFallbackReason).toBe(reason);
	});

	it("reports why a runtime retry fallback served the run on the settled result", async () => {
		const declared = model("primary", "declared-model");
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () =>
				({
					session: createYieldingSession(
						{ selector: "primary/declared-model", isFallback: false },
						{ to: { selector: "fallback/working-model", isFallback: true }, reason: "429 usage limit reached" },
					),
					extensionsResult: {},
					setToolUIContext: () => {},
				}) as never,
		);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "runtime-fallback",
			modelOverride: ["primary/declared-model"],
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [declared],
				getApiKey: async () => "key",
			} as never,
			enableLsp: false,
		});

		expect(result.resolvedModel).toBe("fallback/working-model");
		expect(result.resolvedModelIsFallback).toBe(true);
		expect(result.resolvedModelFallbackReason).toContain("primary/declared-model");
		expect(result.resolvedModelFallbackReason).toContain("429 usage limit reached");
	});
});
