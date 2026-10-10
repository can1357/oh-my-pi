import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type ExecutorOptions, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as path from "node:path";

interface AuthFixture {
	registry: ModelRegistry;
	cwd: string;
	requests: Array<{ selector: string; reasoning_effort?: string }>;
}

const parentSelector = "issue985-parent/parent";
const taskSelector = "issue985-task/task";
const alternateSelector = "issue985-parent/alternate";
const createAgentSession = sdkModule.createAgentSession;
const sessions: AgentSession[] = [];
const resources: Array<{ dir: TempDir; authStorage: AuthStorage; stop: () => void }> = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	// Keep the real SDK's model resolution, auth and provider transport.
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
			toolNames: ["yield"],
		});
		sessions.push(result.session);
		return result;
	});
});

async function createRegistry(taskAuth: "apiKey" | "none" | "oauth" = "oauth"): Promise<AuthFixture> {
	const requests: Array<{ selector: string; reasoning_effort?: string }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			const body = (await request.json()) as { model: string; reasoning_effort?: string };
			const provider = new URL(request.url).pathname.startsWith("/parent/") ? "issue985-parent" : "issue985-task";
			requests.push({ selector: `${provider}/${body.model}`, reasoning_effort: body.reasoning_effort });
			return new Response(
				`data: ${JSON.stringify({
					id: "auth-fixture",
					object: "chat.completion.chunk",
					created: 0,
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: "auth-yield",
										type: "function",
										function: { name: "yield", arguments: '{"data":{"completed":true}}' },
									},
								],
							},
						},
					],
				})}\n\n` +
					'data: {"id":"auth-fixture","object":"chat.completion.chunk","created":0,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
					"data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const dir = TempDir.createSync("omp-subagent-route-auth-");
	const authStorage = await AuthStorage.create(":memory:");
	resources.push({ dir, authStorage, stop: () => server.stop(true) });
	const modelsPath = path.join(dir.path(), "models.yml");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				"issue985-parent": {
					api: "openai-completions",
					baseUrl: new URL("parent/v1", server.url).toString(),
					apiKey: "parent-test-key",
					models: [
						{ id: "parent", reasoning: false, supportsTools: true },
						{
							id: "alternate",
							reasoning: true,
							supportsTools: true,
							thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
							compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
						},
					],
				},
				"issue985-task": {
					api: "openai-completions",
					baseUrl: new URL("task/v1", server.url).toString(),
					auth: taskAuth,
					...(taskAuth === "apiKey" ? { apiKey: "task-test-key" } : {}),
					models: [{ id: "task", reasoning: false, supportsTools: true }],
				},
			},
		}),
	);
	return { registry: new ModelRegistry(authStorage, modelsPath), cwd: dir.path(), requests };
}

function workerOptions(
	fixture: AuthFixture,
	settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
	agentModel: string[] = [taskSelector],
): ExecutorOptions {
	return {
		cwd: fixture.cwd,
		agent: {
			name: "task",
			description: "test",
			systemPrompt: "test",
			source: "bundled",
			model: agentModel,
			tools: ["yield"],
		},
		task: "work",
		index: 0,
		id: "auth-worker",
		settings,
		modelRegistry: fixture.registry,
		parentActiveModelPattern: parentSelector,
		modelAuthority: {
			settings,
			agentName: "task",
			agentModel,
			getParentModel: () => fixture.registry.find("issue985-parent", "parent"),
			getParentSelector: () => parentSelector,
		},
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

describe("issue #985: implicit auth fallback and explicit admission", () => {
	test("serves an omitted unauthenticated agent model on the authenticated live parent", async () => {
		const fixture = await createRegistry();
		const result = await runSubprocess(workerOptions(fixture));
		expect(result.exitCode, result.stderr).toBe(0);
		expect(fixture.requests.map(request => request.selector)).toEqual([parentSelector]);
		expect(result.resolvedModelIdentity).toBe(parentSelector);
	});

	for (const selector of [taskSelector, "issue985-task/missing", alternateSelector]) {
		test(`rejects explicit ${selector} without substituting the authenticated parent`, async () => {
			const fixture = await createRegistry();
			const settings = Settings.isolated({
				modelRoles: { default: parentSelector },
				"retry.fallbackChains": { default: [selector === alternateSelector ? parentSelector : alternateSelector] },
			});
			const result = await runSubprocess({
				...workerOptions(fixture, settings),
				modelOverride: selector,
				explicitModelSelection: true,
			});
			expect(result.exitCode, result.stderr).toBe(1);
			expect(fixture.requests).toEqual([]);
		});
	}

	for (const auth of ["apiKey", "none"] as const) {
		for (const explicit of [false, true]) {
			test(`serves ${auth} task auth without parent substitution (${explicit ? "explicit" : "omitted"})`, async () => {
				const fixture = await createRegistry(auth);
				const result = await runSubprocess({
					...workerOptions(fixture),
					...(explicit ? { modelOverride: taskSelector, explicitModelSelection: true } : {}),
				});
				expect(result.exitCode, result.stderr).toBe(0);
				expect(fixture.requests.map(request => request.selector)).toEqual([taskSelector]);
				expect(result.resolvedModelIdentity).toBe(taskSelector);
			});
		}
	}

	test("serves a later authorized explicit candidate at its exact supported effort", async () => {
		const fixture = await createRegistry();
		const result = await runSubprocess({
			...workerOptions(fixture, undefined, [taskSelector, alternateSelector]),
			modelOverride: [taskSelector, `${alternateSelector}:high`],
			explicitModelSelection: true,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(fixture.requests).toEqual([{ selector: alternateSelector, reasoning_effort: "high" }]);
		expect(result.resolvedThinkingLevel).toBe(Effort.High);
	});

	test("uses only the explicit role's auth fallback rather than the default chain", async () => {
		const fixture = await createRegistry();
		const settings = Settings.isolated({
			modelRoles: { qa: taskSelector, default: parentSelector },
			"retry.fallbackChains": { qa: [alternateSelector], default: [parentSelector] },
		});
		const result = await runSubprocess({
			...workerOptions(fixture, settings),
			modelOverride: "@qa",
			explicitModelSelection: true,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(fixture.requests.map(request => request.selector)).toEqual([alternateSelector]);
	});

	test("omitted role routing skips a disabled provider while an explicit disabled pin fails (#11709)", async () => {
		const fixture = await createRegistry("apiKey");
		const settings = Settings.isolated({
			disabledProviders: ["issue985-task"],
			// Startup skips disabled candidates in the configured selection, not the runtime retry chain.
			modelRoles: { qa: `${taskSelector},${alternateSelector}` },
			"retry.fallbackChains": { qa: [alternateSelector] },
		});
		const options = workerOptions(fixture, settings, ["@qa"]);
		const implicit = await runSubprocess({ ...options, id: "disabled-implicit" });
		expect(implicit.exitCode, implicit.stderr).toBe(0);
		expect(fixture.requests.map(request => request.selector)).toEqual([alternateSelector]);
		const explicit = await runSubprocess({
			...options,
			id: "disabled-explicit",
			modelOverride: taskSelector,
			explicitModelSelection: true,
		});
		expect(explicit.exitCode, explicit.stderr).toBe(1);
		expect(fixture.requests.map(request => request.selector)).toEqual([alternateSelector]);
	});

	for (const selector of [`${taskSelector}:invalid`, "default:high"]) {
		test(`rejects explicit ${selector} instead of weakening or inheriting the parent`, async () => {
			const fixture = await createRegistry("apiKey");
			const result = await runSubprocess({
				...workerOptions(fixture),
				modelOverride: selector,
				explicitModelSelection: true,
			});
			expect(result.exitCode, result.stderr).toBe(1);
			expect(fixture.requests).toEqual([]);
		});
	}
});
