import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getBundledAgent, parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { type ExecutorOptions, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as path from "node:path";

type RuntimeModelDefinition = NonNullable<ProviderConfigInput["models"]>[number] & { provider: string };
interface ServedRequest {
	selector: string;
	purpose: "classification" | "work";
	reasoning_effort?: string;
	tool_choice?: unknown;
}
interface RuntimeFixture {
	registry: ModelRegistry;
	cwd: string;
	requests: ServedRequest[];
}
type ScriptedResponse = "yield" | "answer" | "read" | "unavailable";

function modelDefinition(provider: string, id: string): RuntimeModelDefinition {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max] },
		compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
		supportsTools: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

const primary = modelDefinition("issue2750-primary", "bad-runtime-model");
const fallback = modelDefinition("issue2750-fallback", "working-model");
const unrelated = modelDefinition("issue2750-global", "other-model");
const primarySelector = `${primary.provider}/${primary.id}`;
const fallbackSelector = `${fallback.provider}/${fallback.id}`;
const unrelatedSelector = `${unrelated.provider}/${unrelated.id}`;
const createAgentSession = sdkModule.createAgentSession;
const sessions: AgentSession[] = [];
const resources: Array<{ dir: TempDir; authStorage: AuthStorage; stop: () => void }> = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	// Only discovery/tool breadth is isolated; the SDK and recovery are real.
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		if (!options) throw new Error("Expected worker options");
		const result = await createAgentSession({
			...options,
			agentDir: options.cwd,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			preloadedCustomToolPaths: [],
			toolNames: ["read", "yield"],
		});
		sessions.push(result.session);
		return result;
	});
});

async function createRegistry(
	models: RuntimeModelDefinition[] = [primary, fallback, unrelated],
	response: (request: ServedRequest, index: number) => ScriptedResponse = () => "yield",
): Promise<RuntimeFixture> {
	const requests: ServedRequest[] = [];
	let workRequestCount = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			const body = (await request.json()) as {
				model: string;
				reasoning_effort?: string;
				tool_choice?: unknown;
				tools?: Array<{ function?: { name?: string } }>;
			};
			const provider = new URL(request.url).pathname.split("/")[1]!;
			// AUTO judgments use the real text-judge protocol, not the worker's yield schema.
			const classification = !body.tools?.some(tool => tool.function?.name === "yield");
			const served: ServedRequest = {
				selector: `${provider}/${body.model}`,
				purpose: classification ? "classification" : "work",
				reasoning_effort: body.reasoning_effort,
				tool_choice: body.tool_choice,
			};
			requests.push(served);
			const next = classification ? "classification" : response(served, workRequestCount++);
			if (next === "unavailable") {
				return Response.json({ error: { message: "Model unavailable at this endpoint" } }, { status: 404 });
			}
			const delta =
				next === "classification" || next === "answer"
					? { role: "assistant", content: next === "classification" ? "medium" : "work completed" }
					: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "runtime-yield",
									type: "function",
									function:
										next === "read"
											? { name: "read", arguments: '{"path":"worker-input.txt"}' }
											: { name: "yield", arguments: '{"data":{"completed":true}}' },
								},
							],
						};
			return new Response(
				`data: ${JSON.stringify({
					id: "runtime-fixture",
					object: "chat.completion.chunk",
					created: 0,
					choices: [{ index: 0, delta }],
				})}\n\n` +
					`data: ${JSON.stringify({
						id: "runtime-fixture",
						object: "chat.completion.chunk",
						created: 0,
						choices: [
							{
								index: 0,
								delta: {},
								finish_reason: next === "answer" || next === "classification" ? "stop" : "tool_calls",
							},
						],
					})}\n\n` +
					"data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const dir = TempDir.createSync("omp-subagent-runtime-route-");
	await Bun.write(dir.join("worker-input.txt"), "worker fixture input");
	const authStorage = await AuthStorage.create(":memory:");
	resources.push({ dir, authStorage, stop: () => server.stop(true) });
	const registry = new ModelRegistry(authStorage, path.join(dir.path(), "models.yml"));
	for (const provider of new Set(models.map(candidate => candidate.provider))) {
		const baseUrl = new URL(`${provider}/v1`, server.url).toString();
		registry.registerProvider(provider, {
			api: "openai-completions",
			baseUrl,
			apiKey: "test-key",
			models: models
				.filter(candidate => candidate.provider === provider)
				.map(candidate => ({ ...candidate, baseUrl })),
		});
	}
	return { registry, cwd: dir.path(), requests };
}

function retrySettings(overrides: Readonly<Record<string, unknown>> = {}) {
	return Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
		"retry.baseDelayMs": 1,
		"retry.maxRetries": 1,
		...overrides,
	});
}

const agent = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled" as const,
	model: [primarySelector],
	tools: ["yield"],
};

function workerOptions(fixture: RuntimeFixture, settings = retrySettings()): ExecutorOptions {
	return {
		cwd: fixture.cwd,
		agent,
		task: "work",
		index: 0,
		id: "runtime-worker",
		settings,
		modelRegistry: fixture.registry,
		enableLsp: false,
		enableIrc: false,
		restrictToolNames: true,
	};
}

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	await Promise.all(sessions.splice(0).map(session => session.dispose()));
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	for (const { dir, authStorage, stop } of resources.splice(0)) {
		stop();
		authStorage.close();
		await dir.remove();
	}
});

describe("subagent runtime model resolution", () => {
	for (const level of [undefined, ThinkingLevel.High]) {
		it(`serves a literal model-id colon separately from effort (${level ?? "unset"})`, async () => {
			const literal = modelDefinition("issue2750-literal", "coding-router:max");
			const fixture = await createRegistry([literal]);
			const identity = `${literal.provider}/${literal.id}`;
			const selector = `${identity}${level ? `:${level}` : ""}`;
			const snapshots: AgentProgress[] = [];
			const result = await runSubprocess({
				...workerOptions(fixture),
				agent: { ...agent, model: [identity] },
				modelOverride: selector,
				explicitModelSelection: true,
				onProgress: progress => snapshots.push({ ...progress }),
			});
			expect(result.exitCode, result.stderr).toBe(0);
			expect(fixture.requests.map(request => request.selector)).toEqual([identity]);
			if (level) expect(fixture.requests[0]?.reasoning_effort).toBe(level);
			expect(result.resolvedModelIdentity).toBe(identity);
			expect(snapshots.findLast(progress => progress.resolvedModel)?.resolvedModelIdentity).toBe(identity);
		});
	}

	for (const mode of ["agent alias", "pre-expanded implicit role"] as const) {
		it(`omitted retries inherit the selected singleton role rather than a shared-primary default (${mode})`, async () => {
			const fixture = await createRegistry(undefined, request =>
				request.selector === primarySelector ? "unavailable" : "yield",
			);
			const settings = retrySettings({
				modelRoles: { qa: primarySelector, default: primarySelector },
				"retry.fallbackChains": { qa: [`${fallbackSelector}:high`], default: [unrelatedSelector] },
			});
			const result = await runSubprocess({
				...workerOptions(fixture, settings),
				agent: { ...agent, model: ["@qa"] },
				...(mode === "pre-expanded implicit role" ? { modelOverride: [primarySelector], modelRole: "qa" } : {}),
			});
			expect(result.exitCode, result.stderr).toBe(0);
			expect(fixture.requests.map(request => request.selector)).toEqual([primarySelector, fallbackSelector]);
			expect(fixture.requests.at(-1)?.reasoning_effort).toBe("high");
			expect(result.resolvedModel).toBe(`${fallbackSelector}:high`);
			expect(result.resolvedModelIsFallback).toBe(true);
		});
	}

	for (const model of [[primarySelector], ["@qa"]]) {
		it(`omitted singleton ${model[0]} inherits the configured default retry chain`, async () => {
			const fixture = await createRegistry(undefined, request =>
				request.selector === primarySelector ? "unavailable" : "yield",
			);
			const settings = retrySettings({
				modelRoles: { qa: primarySelector, default: primarySelector },
				"retry.fallbackChains": { default: [`${fallbackSelector}:high`] },
			});
			const result = await runSubprocess({
				...workerOptions(fixture, settings),
				agent: { ...agent, model },
			});
			expect(result.exitCode, result.stderr).toBe(0);
			expect(fixture.requests.map(request => request.selector)).toEqual([primarySelector, fallbackSelector]);
			expect(fixture.requests.at(-1)?.reasoning_effort).toBe("high");
			expect(result.resolvedModelIdentity).toBe(fallbackSelector);
		});
	}

	it("omitted ordered agent models keep their fallback reachable when default shares the primary", async () => {
		const fixture = await createRegistry(undefined, request =>
			request.selector === primarySelector ? "unavailable" : "yield",
		);
		const result = await runSubprocess({
			...workerOptions(
				fixture,
				retrySettings({
					modelRoles: { default: primarySelector },
					"retry.fallbackChains": { default: [unrelatedSelector] },
				}),
			),
			agent: { ...agent, model: [primarySelector, `${fallbackSelector}:high`] },
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(fixture.requests.map(request => request.selector)).toEqual([primarySelector, fallbackSelector]);
		expect(fixture.requests.at(-1)?.reasoning_effort).toBe("high");
	});

	for (const explicit of [false, true]) {
		it(`${explicit ? "explicit pin refuses" : "omitted worker serves"} the configured provider-wildcard fallback`, async () => {
			const mirror = modelDefinition(fallback.provider, primary.id);
			const mirrorSelector = `${mirror.provider}/${mirror.id}`;
			const fixture = await createRegistry([primary, mirror, unrelated], request =>
				request.selector === primarySelector ? "unavailable" : "yield",
			);
			const settings = retrySettings({
				modelRoles: { default: primarySelector },
				"retry.fallbackChains": { [`${primary.provider}/*`]: [`${mirror.provider}/*`] },
			});
			const result = await runSubprocess({
				...workerOptions(fixture, settings),
				...(explicit ? { modelOverride: primarySelector, explicitModelSelection: true } : {}),
			});
			expect(result.exitCode, result.stderr).toBe(explicit ? 1 : 0);
			expect(fixture.requests.map(request => request.selector)).toEqual(
				explicit ? [primarySelector] : [primarySelector, mirrorSelector],
			);
			if (!explicit) expect(result.resolvedModelIdentity).toBe(mirrorSelector);
		});
	}

	it("explicit role retries stay in that role's chain and retain exact fallback effort above the coarse ceiling", async () => {
		const fixture = await createRegistry(undefined, request =>
			request.selector === primarySelector ? "unavailable" : "yield",
		);
		const settings = retrySettings({
			modelRoles: { qa: primarySelector, default: primarySelector },
			"retry.fallbackChains": { qa: [`${fallbackSelector}:high`], default: [unrelatedSelector] },
			"task.maxEffort": "low",
		});
		const result = await runSubprocess({
			...workerOptions(fixture, settings),
			modelOverride: "@qa",
			explicitModelSelection: true,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(fixture.requests.map(request => request.selector)).toEqual([primarySelector, fallbackSelector]);
		expect(fixture.requests.at(-1)?.reasoning_effort).toBe("high");
		expect(result.resolvedThinkingLevel).toBe(ThinkingLevel.High);
	});

	it("explicit literal retries stay closed even when another role and default authorize the fallback", async () => {
		const fixture = await createRegistry(undefined, request =>
			request.selector === primarySelector ? "unavailable" : "yield",
		);
		const result = await runSubprocess({
			...workerOptions(
				fixture,
				retrySettings({
					modelRoles: { other: unrelatedSelector, default: primarySelector },
					"retry.fallbackChains": { default: [unrelatedSelector] },
				}),
			),
			modelOverride: primarySelector,
			explicitModelSelection: true,
		});
		expect(result.exitCode, result.stderr).toBe(1);
		expect(fixture.requests.map(request => request.selector)).toEqual([primarySelector]);
	});

	it("does not credit an approved fallback that failed before serving any work", async () => {
		const fixture = await createRegistry(undefined, (_request, index) => (index === 0 ? "answer" : "unavailable"));
		const result = await runSubprocess({
			...workerOptions(
				fixture,
				retrySettings({
					modelRoles: { qa: primarySelector },
					"retry.fallbackChains": { qa: [fallbackSelector] },
				}),
			),
			modelOverride: "@qa",
			explicitModelSelection: true,
		});
		expect(result.exitCode, result.stderr).toBe(1);
		expect(fixture.requests.map(request => request.selector)).toEqual([
			primarySelector,
			primarySelector,
			fallbackSelector,
		]);
		expect(result.resolvedModelIdentity).toBe(primarySelector);
		expect(result.resolvedModelIsFallback).toBe(false);
	});

	for (const [name, id] of [
		["scout", "claude-haiku-5-5"],
		["reviewer", "gpt-5.6-sol"],
	] as const) {
		it(`stock ${name} omission serves a fresh-role priority candidate instead of the live parent`, async () => {
			const priority = modelDefinition("issue2750-priority", id);
			const fixture = await createRegistry([primary, priority]);
			const stock = getBundledAgent(name);
			if (!stock) throw new Error(`Expected stock ${name} agent`);
			const settings = retrySettings();
			const result = await runSubprocess({
				...workerOptions(fixture, settings),
				agent: stock,
				thinkingLevel: stock.thinkingLevel,
				modelAuthority: {
					settings,
					agentName: stock.name,
					agentModel: stock.model,
					getParentModel: () => fixture.registry.find(primary.provider, primary.id),
					getParentSelector: () => `${primarySelector}:high`,
				},
			});
			expect(result.exitCode, result.stderr).toBe(0);
			expect(fixture.requests.map(request => request.selector)).toEqual([`${priority.provider}/${priority.id}`]);
		});
	}

	for (const [alias, selector] of [
		["pi/task", primarySelector],
		["pi/smol", fallbackSelector],
		["pi/slow", unrelatedSelector],
	] as const) {
		it(`omitted agent-file ${alias} retains legacy role resolution`, async () => {
			const fixture = await createRegistry();
			const settings = retrySettings({
				modelRoles: { task: primarySelector, smol: fallbackSelector, slow: unrelatedSelector },
			});
			const result = await runSubprocess({
				...workerOptions(fixture, settings),
				agent: parseAgent(
					path.join(fixture.cwd, "legacy-agent.md"),
					`---\nname: legacy-agent\ndescription: test\nmodel: ${alias}\ntools: yield\n---\nWork`,
					"project",
				),
			});
			expect(result.exitCode, result.stderr).toBe(0);
			expect(fixture.requests.map(request => request.selector)).toEqual([selector]);
		});
	}

	it("omitted agent-file model: default inherits the live parent rather than the configured default", async () => {
		const fixture = await createRegistry();
		const settings = retrySettings({ modelRoles: { default: unrelatedSelector } });
		const fileAgent = parseAgent(
			path.join(fixture.cwd, "inherit-agent.md"),
			"---\nname: inherit-agent\ndescription: test\nmodel: default\ntools: yield\n---\nWork",
			"project",
		);
		const result = await runSubprocess({
			...workerOptions(fixture, settings),
			agent: fileAgent,
			parentActiveModelPattern: primarySelector,
			modelAuthority: {
				settings,
				agentName: fileAgent.name,
				agentModel: fileAgent.model,
				getParentModel: () => fixture.registry.find(primary.provider, primary.id),
				getParentSelector: () => `${primarySelector}:high`,
			},
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(fixture.requests.map(request => request.selector)).toEqual([primarySelector]);
	});

	for (const [pattern, id] of [
		["claude-sonnet", "claude-sonnet-fixture"],
		["gpt-5", "gpt-5-fixture"],
	] as const) {
		it(`omitted configured fuzzy ${pattern} serves the matching catalog model without an exact pin`, async () => {
			const fuzzy = modelDefinition("issue2750-fuzzy", id);
			const fixture = await createRegistry([primary, fuzzy]);
			const result = await runSubprocess({
				...workerOptions(fixture, retrySettings({ modelRoles: { task: pattern } })),
				agent: { ...agent, model: ["@task"] },
			});
			expect(result.exitCode, result.stderr).toBe(0);
			expect(fixture.requests.map(request => request.selector)).toEqual([`${fuzzy.provider}/${fuzzy.id}`]);
		});
	}

	it("omitted disabled frontmatter serves the enabled configured default", async () => {
		const fixture = await createRegistry();
		const settings = retrySettings({
			disabledProviders: [primary.provider],
			modelRoles: { default: fallbackSelector },
		});
		const result = await runSubprocess({
			...workerOptions(fixture, settings),
			agent: parseAgent(
				path.join(fixture.cwd, "disabled-agent.md"),
				`---\nname: disabled-agent\ndescription: test\nmodel: ${primarySelector}\ntools: yield\n---\nWork`,
				"project",
			),
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(fixture.requests.map(request => request.selector)).toEqual([fallbackSelector]);
	});

	it("fixed-high final yield survives forced-tool reasoning suppression without weakening the request", async () => {
		const fixed = modelDefinition("issue2750-forced-tool", "kimi-style");
		fixed.compat = {
			...fixed.compat,
			supportsForcedToolChoice: true,
			disableReasoningOnForcedToolChoice: true,
		};
		const selector = `${fixed.provider}/${fixed.id}`;
		const fixture = await createRegistry([fixed], (_request, index) => (index < 3 ? "answer" : "yield"));
		const result = await runSubprocess({
			...workerOptions(fixture),
			agent: { ...agent, model: [selector] },
			modelOverride: `${selector}:high`,
			explicitModelSelection: true,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(fixture.requests).toHaveLength(4);
		expect(
			fixture.requests.every(request => request.selector === selector && request.reasoning_effort === "high"),
		).toBe(true);
		const toolChoice = fixture.requests.at(-1)?.tool_choice;
		if (toolChoice !== undefined && typeof toolChoice !== "string") {
			throw new Error("Expected final yield tool choice to be omitted or a string");
		}
		expect([undefined, "auto"]).toContain(toolChoice);
	});

	for (const explicit of [false, true]) {
		it(`${explicit ? "explicit @default refuses its next inference" : "stock @task omission keeps serving its initial parent"} after the live parent switches`, async () => {
			let liveParent = primary;
			const fixture = await createRegistry(undefined, (_request, index) => {
				if (index === 0) {
					liveParent = fallback;
					return "read";
				}
				return "yield";
			});
			const stockTask = getBundledAgent("task");
			if (!stockTask) throw new Error("Expected stock task agent");
			const settings = retrySettings();
			const result = await runSubprocess({
				...workerOptions(fixture, settings),
				agent: stockTask,
				thinkingLevel: stockTask.thinkingLevel,
				...(explicit ? { modelOverride: "@default", explicitModelSelection: true } : {}),
				modelAuthority: {
					settings,
					agentName: stockTask.name,
					agentModel: stockTask.model,
					getParentModel: () => fixture.registry.find(liveParent.provider, liveParent.id),
					getParentSelector: () => `${liveParent.provider}/${liveParent.id}:high`,
				},
			});
			expect(result.exitCode, result.stderr).toBe(explicit ? 1 : 0);
			const workRequests = fixture.requests.filter(request => request.purpose === "work");
			expect(workRequests.map(request => request.selector)).toEqual(
				explicit ? [primarySelector] : [primarySelector, primarySelector],
			);
			if (!explicit) {
				expect(fixture.requests.some(request => request.purpose === "classification")).toBe(true);
				expect(workRequests.every(request => request.reasoning_effort === Effort.Medium)).toBe(true);
			}
			expect(result.resolvedModelIdentity).toBe(primarySelector);
		});
	}

	for (const effort of [undefined, "lo"] as const) {
		it(`stock @task omission accepts a concrete parent effort with its role unset (${effort ?? "AUTO"})`, async () => {
			const fixture = await createRegistry();
			const stockTask = getBundledAgent("task");
			if (!stockTask) throw new Error("Expected stock task agent");
			const settings = retrySettings({ modelRoles: { default: primarySelector } });
			const result = await runSubprocess({
				...workerOptions(fixture, settings),
				agent: stockTask,
				thinkingLevel: stockTask.thinkingLevel,
				effort,
				modelAuthority: {
					settings,
					agentName: stockTask.name,
					agentModel: stockTask.model,
					getParentModel: () => fixture.registry.find(primary.provider, primary.id),
					getParentSelector: () => `${primarySelector}:high`,
				},
			});
			expect(result.exitCode, result.stderr).toBe(0);
			const workRequests = fixture.requests.filter(request => request.purpose === "work");
			expect(workRequests.map(request => request.selector)).toEqual([primarySelector]);
			if (effort === "lo") {
				expect(workRequests[0]?.reasoning_effort).toBe(Effort.Low);
				expect(fixture.requests.some(request => request.purpose === "classification")).toBe(false);
			} else {
				expect(fixture.requests.some(request => request.purpose === "classification")).toBe(true);
				expect(workRequests[0]?.reasoning_effort).toBe(Effort.Medium);
			}
		});
	}
});
