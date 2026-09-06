import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { runEvalAgent } from "../../src/eval/agent-bridge";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../../src/eval/bridge-timeout";
import { IdleTimeout } from "../../src/eval/idle-timeout";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { disposeAllKernelSessions, executePython } from "../../src/eval/py/executor";
import { AgentProtocolHandler } from "../../src/internal-urls/agent-protocol";
import { resetRegisteredArtifactDirsForTests } from "../../src/internal-urls/registry-helpers";
import type { PlanModeState } from "../../src/plan-mode/state";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import * as taskDiscovery from "../../src/task/discovery";
import type { ExecutorOptions } from "../../src/task/executor";
import * as taskExecutor from "../../src/task/executor";
import * as isolationRunner from "../../src/task/isolation-runner";
import { AgentOutputManager } from "../../src/task/output-manager";
import type { AgentDefinition, AgentProgress, SingleResult, StructuredSubagentOutput } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const taskAgent = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Run the task.",
	source: "bundled",
	spawns: "*",
	model: ["@task"],
} satisfies AgentDefinition;

const reviewerAgent = {
	name: "reviewer",
	description: "Reviewer agent",
	systemPrompt: "Review the task.",
	source: "bundled",
	model: ["@smol"],
} satisfies AgentDefinition;

interface SessionOptions {
	cwd?: string;
	sessionFile?: string | null;
	artifactsDir?: string | null;
	spawns?: string | null;
	depth?: number;
	activeModel?: string;
	modelString?: string;
	enableLsp?: boolean;
	settings?: Settings;
	outputManager?: AgentOutputManager;
	planMode?: boolean;
	outputSchema?: unknown;
}

function makeSession(options: SessionOptions = {}): ToolSession {
	const settings =
		options.settings ??
		Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
		});
	const artifactsDir = options.artifactsDir ?? null;
	return {
		cwd: options.cwd ?? process.cwd(),
		hasUI: false,
		settings,
		taskDepth: options.depth ?? 0,
		enableLsp: options.enableLsp ?? true,
		agentOutputManager: options.outputManager,
		getSessionFile: () => options.sessionFile ?? null,
		getSessionSpawns: () => options.spawns ?? "*",
		getActiveModelString: () => options.activeModel ?? "p/active",
		getModelString: () => options.modelString ?? "p/fallback",
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "test-session",
		getEvalSessionId: () => "test-eval-session",
		outputSchema: options.outputSchema,
		getPlanModeState: options.planMode
			? () =>
					({
						enabled: true,
						planFilePath: path.join(options.cwd ?? process.cwd(), "plan.md"),
					}) satisfies PlanModeState
			: undefined,
	};
}

function mockAgents(agents: AgentDefinition[] = [taskAgent, reviewerAgent]): void {
	vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

function singleResult(options: ExecutorOptions, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

function makeEvalSession(
	tempDir: TempDir,
	prefix: string,
	settings?: Settings,
): { session: ToolSession; sessionFile: string; sessionId: string } {
	const sessionFile = path.join(tempDir.path(), "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	const session = makeSession({
		cwd: tempDir.path(),
		sessionFile,
		artifactsDir,
		settings,
		outputManager: new AgentOutputManager(() => artifactsDir),
	});
	return { session, sessionFile, sessionId: `${prefix}:${crypto.randomUUID()}` };
}

/**
 * Spy `runSubprocess` so a `parallel()` fan-out overlaps deterministically: every
 * bridge call parks until the pool saturates at `limit` concurrent calls in flight,
 * then all proceed. Proves the pool reaches its ceiling without a wall-clock sleep —
 * the pool itself caps how many run at once, so an unbounded pool would drive
 * `maxInFlight` past `limit` and fail the bound.
 */
function spyConcurrencyBarrier(limit: number): { maxInFlight: () => number } {
	let inFlight = 0;
	let max = 0;
	let saturate: (() => void) | undefined;
	const saturated = new Promise<void>(resolve => {
		saturate = resolve;
	});
	vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
		inFlight++;
		max = Math.max(max, inFlight);
		if (inFlight >= limit) saturate?.();
		try {
			await saturated;
			return singleResult(options, { output: options.assignment ?? "" });
		} finally {
			inFlight--;
		}
	});
	return { maxInFlight: () => max };
}

describe("runEvalAgent", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
	});

	it("resolves the default task agent and agent overrides", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options =>
			singleResult(options, {
				output: options.agent.name,
			}),
		);
		const session = makeSession();

		const defaultResult = await runEvalAgent({ prompt: "hello" }, { session });
		const overrideResult = await runEvalAgent({ prompt: "hello", agent: "reviewer" }, { session });

		expect(defaultResult.text).toBe("task");
		expect(overrideResult.text).toBe("reviewer");
		expect(runSpy.mock.calls[0]?.[0].agent.name).toBe("task");
		expect(runSpy.mock.calls[1]?.[0].agent.name).toBe("reviewer");
	});

	it("throws for an unknown agent", async () => {
		mockAgents([taskAgent]);
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		await expect(runEvalAgent({ prompt: "hello", agent: "missing" }, { session: makeSession() })).rejects.toThrow(
			'Unknown agent "missing"',
		);
	});

	it("enforces shared spawn restrictions", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		await expect(runEvalAgent({ prompt: "hello" }, { session: makeSession({ spawns: "" }) })).rejects.toThrow(
			"spawns disabled",
		);
		await expect(
			runEvalAgent({ prompt: "hello", agent: "task" }, { session: makeSession({ spawns: "reviewer" }) }),
		).rejects.toThrow("Allowed: reviewer");
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("defaults to the first allowed spawn under restricted eval policies", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options =>
			singleResult(options, {
				output: options.agent.name,
			}),
		);

		const result = await runEvalAgent({ prompt: "hello" }, { session: makeSession({ spawns: "reviewer,task" }) });

		expect(result.text).toBe("reviewer");
		expect(runSpy.mock.calls[0]?.[0].agent.name).toBe("reviewer");
	});

	it("honors task.maxRecursionDepth without an eval-specific ceiling", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		await expect(
			runEvalAgent(
				{ prompt: "hello" },
				{
					session: makeSession({
						settings: Settings.isolated({
							"async.enabled": false,
							"task.isolation.mode": "none",
							"task.maxRecursionDepth": 0,
						}),
					}),
				},
			),
		).rejects.toThrow("maximum depth is 0");

		await runEvalAgent(
			{ prompt: "hello" },
			{
				session: makeSession({
					depth: 3,
					settings: Settings.isolated({
						"async.enabled": false,
						"task.isolation.mode": "none",
						"task.maxRecursionDepth": -1,
					}),
				}),
			},
		);
		expect(runSpy).toHaveBeenCalledTimes(1);
	});

	it("runs plan-mode eval agents with an attenuated policy", async () => {
		mockAgents([{ ...taskAgent, tools: ["ast_grep", "write"] }]);
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		await expect(
			runEvalAgent({ prompt: "hello" }, { session: makeSession({ planMode: true }) }),
		).resolves.toMatchObject({
			text: "ok",
		});
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy.mock.calls[0]?.[0].agent.tools).toEqual(["read", "grep", "glob", "web_search", "ast_grep"]);
		expect(runSpy.mock.calls[0]?.[0].agent.spawns).toBeUndefined();
		await expect(
			runEvalAgent({ prompt: "unsafe", isolated: true }, { session: makeSession({ planMode: true }) }),
		).rejects.toThrow("isolation, apply, and merge controls are unavailable in plan mode");
		expect(runSpy).toHaveBeenCalledTimes(1);
	});

	it("passes parent execution options and only sets outputSchema when schema is supplied", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));
		const abortController = new AbortController();
		const schema = { type: "object", properties: { ok: { type: "boolean" } } };
		const session = makeSession({
			depth: 2,
			activeModel: "p/current",
			modelString: "p/fallback",
			settings: Settings.isolated({
				"async.enabled": false,
				"task.isolation.mode": "none",
				"task.enableLsp": true,
				// Default task.maxRecursionDepth is 2, which would now (correctly)
				// block depth=2 — widen it so the test still exercises depth=2.
				"task.maxRecursionDepth": -1,
			}),
		});

		await runEvalAgent({ prompt: " hello ", label: "My Agent", schema }, { session, signal: abortController.signal });
		await runEvalAgent({ prompt: "plain" }, { session });

		const firstOptions = runSpy.mock.calls[0]?.[0];
		const secondOptions = runSpy.mock.calls[1]?.[0];
		if (!firstOptions || !secondOptions) throw new Error("runSubprocess was not called");
		expect(firstOptions.taskDepth).toBe(2);
		expect(firstOptions.signal).toBe(abortController.signal);
		expect(firstOptions.parentActiveModelPattern).toBe("p/current");
		expect(firstOptions.outputSchema).toBe(schema);
		expect(firstOptions.outputSchemaOverridesAgent).toBe(true);
		expect(firstOptions.assignment).toBe("hello");
		expect(firstOptions.description).toBe("My Agent");
		// No per-call override: the agent's own frontmatter model applies.
		expect(firstOptions.modelOverride).toEqual(["p/current"]);
		expect(secondOptions.outputSchema).toBeUndefined();
		expect(secondOptions.outputSchemaOverridesAgent).toBeUndefined();
	});

	it("drops a per-call model argument on agent() (removed, issue #6438)", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		// The schema strips unknown keys; a legacy `model` argument is silently
		// discarded so resolution is identical to omitting it — the agent's own
		// frontmatter model applies (issue #6438).
		await runEvalAgent({ prompt: "work", model: "default" }, { session: makeSession() });
		await runEvalAgent({ prompt: "work" }, { session: makeSession() });

		const withModel = runSpy.mock.calls[0]?.[0];
		const withoutModel = runSpy.mock.calls[1]?.[0];
		expect(withModel?.modelOverride).toEqual(withoutModel?.modelOverride);
	});
	it("returns host-parsed data for caller, agent, and inherited schemas", async () => {
		const agentSchema = { type: "object" };
		const sessionSchema = { type: "object" };
		const callerSchema = { type: "object" };
		const frontmatterAgent = { ...reviewerAgent, name: "structured", output: agentSchema };
		mockAgents([taskAgent, frontmatterAgent]);
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			const source = options.outputSchemaOverridesAgent
				? "caller"
				: options.agent.name === "structured"
					? "agent"
					: "session";
			const structuredOutput: StructuredSubagentOutput = {
				source,
				mode: options.outputSchemaMode ?? "permissive",
				status: "valid",
				data: { source },
			};
			return singleResult(options, { output: "not JSON", structuredOutput });
		});

		const caller = await runEvalAgent(
			{ prompt: "caller", schema: callerSchema, schemaMode: "strict" },
			{ session: makeSession({ outputSchema: sessionSchema }) },
		);
		const frontmatter = await runEvalAgent(
			{ prompt: "agent", agent: "structured" },
			{ session: makeSession({ outputSchema: sessionSchema }) },
		);
		const inherited = await runEvalAgent(
			{ prompt: "session" },
			{ session: makeSession({ outputSchema: sessionSchema }) },
		);

		expect(caller.data).toEqual({ source: "caller" });
		expect(caller.details).toMatchObject({ schemaSource: "caller", schemaMode: "strict", schemaStatus: "valid" });
		expect(frontmatter.data).toEqual({ source: "agent" });
		expect(inherited.data).toEqual({ source: "session" });
		expect(runSpy.mock.calls.map(([options]) => options.outputSchema)).toEqual([
			callerSchema,
			agentSchema,
			sessionSchema,
		]);
	});

	it("keeps bridge kernels independent while inheriting non-plan LSP and IRC policy", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));
		// makeSession() defaults to enableLsp: true and task.enableLsp: true.
		const session = makeSession();

		await runEvalAgent({ prompt: "hello" }, { session });

		const options = runSpy.mock.calls[0]?.[0];
		if (!options) throw new Error("runSubprocess was not called");
		expect(options.enableLsp).toBe(true);
		expect(options.enableIrc).toBe(true);
		expect(options.keepAlive).toBe(false);
		expect(options.parentEvalSessionId).toBeUndefined();
	});

	it("registers temp artifact dirs for in-memory handle results so agent URLs resolve", async () => {
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			if (!options.artifactsDir) throw new Error("artifactsDir missing");
			await fs.mkdir(options.artifactsDir, { recursive: true });
			await fs.writeFile(path.join(options.artifactsDir, `${options.id}.md`), "recoverable output");
			return singleResult(options, { output: "recoverable output" });
		});

		const result = await runEvalAgent({ prompt: "hello", handle: true }, { session: makeSession() });
		const resource = await new AgentProtocolHandler().resolve(new URL(`agent://${result.details.id}`) as never);

		expect(resource.content).toBe("recoverable output");
	});

	it("unregisters eval subagents through the bridge cleanup path", async () => {
		AgentRegistry.resetGlobalForTests();
		mockAgents();
		const order: string[] = [];
		let disposed = false;
		const cleanupSession = {
			prepareForHeadlessAdvisorDrain: () => {
				order.push("prepare");
			},
			waitForAdvisorCatchup: async () => {
				order.push("catchup");
				return true;
			},
			dispose: async () => {
				order.push("dispose");
				disposed = true;
			},
		} as unknown as AgentSession;
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				session: cleanupSession,
				status: "idle",
			});
			await taskExecutor.finalizeSubagentLifecycle({
				id: options.id,
				session: cleanupSession,
				aborted: false,
				keepAlive: options.keepAlive !== false,
				isolated: options.worktree !== undefined,
				agentIdleTtlMs: 0,
				reviveSession: null,
			});
			return singleResult(options);
		});

		await runEvalAgent({ prompt: "hello", label: "Cleanup" }, { session: makeSession() });

		expect(disposed).toBe(true);
		// The advisor's final-turn review is drained before the runtime is torn
		// down (#9505): a graceful subagent finish must not abandon the yield.
		expect(order).toEqual(["prepare", "catchup", "dispose"]);
		expect(AgentRegistry.global().get("Cleanup")).toBeUndefined();
		expect(
			AgentRegistry.global()
				.listVisibleTo("Main")
				.map(ref => ref.id),
		).not.toContain("Cleanup");
	});

	it("maps successful and failed subagent results", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess");
		runSpy.mockImplementationOnce(async options =>
			singleResult(options, {
				id: "0-EvalAgent",
				output: "done",
				resolvedModel: "p/model",
			}),
		);
		runSpy.mockImplementationOnce(async options =>
			singleResult(options, {
				exitCode: 1,
				output: "",
				stderr: "stderr",
				error: "boom",
			}),
		);

		const result = await runEvalAgent({ prompt: "hello" }, { session: makeSession() });
		expect(result).toEqual({
			text: "done",
			details: { agent: "task", id: "0-EvalAgent", model: "p/model", structured: false },
		});
		await expect(runEvalAgent({ prompt: "fail" }, { session: makeSession() })).rejects.toThrow("boom");
	});

	// Regression: a runtime-limit abort returns exitCode=1, stderr="", error=undefined,
	// aborted=true, abortReason="Subagent runtime limit exceeded (...)". The previous
	// failure-message coalesce stopped at the empty `stderr` (since `??` only skips
	// nullish values) and shipped an empty error through the bridge — Python then
	// surfaced the generic `bridge call '__agent__' failed`. See #2006.
	it("surfaces abortReason for aborts that leave stderr empty", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess");
		runSpy.mockImplementationOnce(async options =>
			singleResult(options, {
				exitCode: 1,
				output: "",
				stderr: "",
				error: undefined,
				aborted: true,
				abortReason: "Subagent runtime limit exceeded (task.maxRuntimeMs=900000)",
			}),
		);
		runSpy.mockImplementationOnce(async options =>
			singleResult(options, {
				exitCode: 1,
				output: "",
				stderr: "   ",
				error: "   ",
				aborted: true,
				abortReason: "Cancelled by caller",
			}),
		);
		runSpy.mockImplementationOnce(async options =>
			singleResult(options, {
				exitCode: 1,
				output: "",
				stderr: "",
				error: undefined,
			}),
		);

		await expect(runEvalAgent({ prompt: "slow" }, { session: makeSession() })).rejects.toThrow(
			"Subagent runtime limit exceeded (task.maxRuntimeMs=900000)",
		);
		// Whitespace-only stderr/error must not mask abortReason either.
		await expect(runEvalAgent({ prompt: "cancelled" }, { session: makeSession() })).rejects.toThrow(
			"Cancelled by caller",
		);
		// Last resort: still produce a non-empty message even when nothing useful is set,
		// so Python never falls back to `bridge call '__agent__' failed`.
		await expect(runEvalAgent({ prompt: "blank" }, { session: makeSession() })).rejects.toThrow(
			"agent() subagent 'task' failed.",
		);
	});
});

describe("agent() through eval runtimes", () => {
	// One shared JS worker backs every agent() JavaScript test below. Spawning a
	// worker (thread + module-graph import) is fixed infrastructure cost, not
	// behavior under test; reusing it keeps the suite fast. Each run still threads
	// its own ToolSession (settings/mock are read live through the bridge per call)
	// and top-level `const`/`let` are demoted to `var`, so reuse never leaks state
	// these tests observe. Torn down in afterAll via disposeAllVmContexts().
	const sharedJsSessionId = "agent-bridge-shared-js";

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		await disposeAllKernelSessions();
	});

	it("exposes agent() in JavaScript and parses structured output", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-js-");
		const { session, sessionFile } = makeEvalSession(tempDir, "js-agent");
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options =>
			singleResult(options, {
				output: options.outputSchema ? '{"ok":true,"n":3}' : "hello from agent",
				...(options.outputSchema
					? {
							structuredOutput: {
								source: "caller",
								mode: options.outputSchemaMode ?? "permissive",
								status: "valid",
								data: { ok: true, n: 3 },
							} satisfies StructuredSubagentOutput,
						}
					: {}),
			}),
		);

		const result = await executeJs(
			'const text = await agent("hi"); const data = await agent("json", { schema: { type: "object" } }); const node = await agent("handle", { schema: { type: "object" }, handle: true }); return JSON.stringify({ text, data, node });',
			{ cwd: tempDir.path(), sessionId: sharedJsSessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.output.trim());
		expect(output.text).toBe("hello from agent");
		expect(output.data).toEqual({ ok: true, n: 3 });
		expect(output.node.data).toEqual({ ok: true, n: 3 });
		expect(output.node.handle).toBe(`agent://${output.node.id}`);
	});

	it("bounds JavaScript parallel() by the task.maxConcurrency setting while preserving order", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-js-parallel-");
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
			"task.maxConcurrency": 2,
		});
		const { session, sessionFile } = makeEvalSession(tempDir, "js-agent-parallel", settings);
		mockAgents();
		const barrier = spyConcurrencyBarrier(2);

		const result = await executeJs(
			'const values = await parallel(["a", "b", "c", "d"].map(name => () => agent(name))); return JSON.stringify(values);',
			{ cwd: tempDir.path(), sessionId: sharedJsSessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual(["a", "b", "c", "d"]);
		expect(barrier.maxInFlight()).toBeGreaterThan(1);
		expect(barrier.maxInFlight()).toBeLessThanOrEqual(2);
	});

	it("propagates JavaScript parallel() rejections", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-js-reject-");
		const { session, sessionFile } = makeEvalSession(tempDir, "js-agent-reject");
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			if (options.assignment === "bad") {
				return singleResult(options, { exitCode: 1, output: "", stderr: "boom", error: "boom" });
			}
			return singleResult(options, { output: options.assignment ?? "" });
		});

		const result = await executeJs('await parallel([() => agent("ok"), () => agent("bad")]);', {
			cwd: tempDir.path(),
			sessionId: sharedJsSessionId,
			session,
			sessionFile,
		});

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("boom");
	});

	it("exposes agent() in the Python runtime", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-py-");
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "py-agent");
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options =>
			singleResult(options, {
				output: options.outputSchema ? "not JSON" : "hello from python",
				...(options.outputSchema
					? {
							structuredOutput: {
								source: "caller",
								mode: options.outputSchemaMode ?? "permissive",
								status: "valid",
								data: { ok: true },
							} satisfies StructuredSubagentOutput,
						}
					: {}),
			}),
		);

		const result = await executePython(
			'import json\nprint(agent("hi"))\nprint(json.dumps(agent("structured", schema={"type": "object"})))\nnode = agent("handle", schema={"type": "object"}, handle=True)\nprint(json.dumps({"data": node["data"], "handle": node["handle"], "id": node["id"]}))',
			{
				cwd: tempDir.path(),
				sessionId,
				sessionFile,
				kernelMode: "per-call",
				toolSession: session,
			},
		);
		if (result.exitCode === undefined && result.cancelled) {
			expect(result.output).toBe("");
			return; // kernel unavailable in this environment
		}

		expect(result.exitCode).toBe(0);
		const lines = result.output.trim().split("\n");
		expect(lines[0]).toBe("hello from python");
		expect(JSON.parse(lines[1] ?? "")).toEqual({ ok: true });
		const node = JSON.parse(lines[2] ?? "");
		expect(node.data).toEqual({ ok: true });
		expect(node.handle).toBe(`agent://${node.id}`);
	});

	it("bounds Python parallel() by the task.maxConcurrency setting while preserving order", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-py-parallel-");
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
			"task.maxConcurrency": 2,
		});
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "py-agent-parallel", settings);
		mockAgents();
		const barrier = spyConcurrencyBarrier(2);

		const result = await executePython(
			'import json\nprint(json.dumps(parallel([lambda n=n: agent(n) for n in ["a", "b", "c", "d"]])))',
			{ cwd: tempDir.path(), sessionId, sessionFile, kernelMode: "per-call", toolSession: session },
		);
		if (result.exitCode === undefined && result.cancelled) {
			expect(result.output).toBe("");
			return; // kernel unavailable in this environment
		}

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual(["a", "b", "c", "d"]);
		expect(barrier.maxInFlight()).toBeGreaterThan(1);
		expect(barrier.maxInFlight()).toBeLessThanOrEqual(2);
	});

	it("interrupting a Python parallel() fan-out aborts in-flight subagents and preserves session state", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-py-interrupt-");
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
			"task.maxConcurrency": 6,
		});
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "py-agent-interrupt", settings);
		mockAgents();
		// Each kernel worker thread blocks in a synchronous `urllib` bridge call,
		// joined by `parallel()`'s ThreadPoolExecutor exit. A turn cancel must
		// reach the subagents those calls started — the bridge is handed the real
		// signal, not the executor's kernel shield — while the kernel itself is
		// still interrupted cleanly before `parallel()` launches another wave.
		let inFlight = 0;
		let completed = 0;
		let abortedSubagents = 0;
		let markSaturated: (() => void) | undefined;
		const saturated = new Promise<void>(resolve => {
			markSaturated = resolve;
		});
		// Mirrors the real executor: park until the run finishes *or* the caller's
		// signal aborts. Nothing releases these agents, so the only way the cell
		// can settle is the abort actually reaching them.
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			// task.maxConcurrency=6 → six bridge calls block at once; signal then.
			if (++inFlight >= 6) markSaturated?.();
			const aborted = Promise.withResolvers<never>();
			const onAbort = () => aborted.reject(new Error("subagent aborted"));
			options.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				await aborted.promise;
			} catch {
				abortedSubagents++;
				return singleResult(options, { output: "", aborted: true, abortReason: "aborted by user" });
			} finally {
				options.signal?.removeEventListener("abort", onAbort);
			}
			completed++;
			return singleResult(options, { output: options.assignment ?? "" });
		});

		// Seed persistent session state and confirm the kernel is reusable.
		const seed = await executePython("PREP_MARKER = 4242", {
			cwd: tempDir.path(),
			sessionId,
			sessionFile,
			kernelMode: "session",
			toolSession: session,
		});
		if (seed.exitCode === undefined && seed.cancelled) {
			expect(seed.output).toBe("");
			return; // kernel unavailable in this environment
		}
		expect(seed.exitCode).toBe(0);

		const ac = new AbortController();
		// Abort the instant all six worker threads are confirmed blocked in their
		// bridge calls (condition-driven) instead of waiting a fixed wall second.
		void saturated.then(() => ac.abort(new Error("external interrupt")));

		const resultPromise = executePython(
			"import json\nprint(json.dumps(parallel([lambda n=n: agent(str(n)) for n in range(12)])))",
			{
				cwd: tempDir.path(),
				sessionId,
				sessionFile,
				kernelMode: "session",
				toolSession: session,
				idleTimeoutMs: 60_000,
				signal: ac.signal,
			},
		);
		await saturated;
		await Promise.resolve();
		expect(completed).toBe(0);
		const result = await resultPromise;

		// The interrupt reached every in-flight subagent: nothing here released
		// them, so the cell could only settle because the abort propagated.
		expect(abortedSubagents).toBe(6);
		expect(completed).toBe(0);
		// Cancelled, but cleanly: no hard-kill, and no second fan-out wave started.
		expect(result.cancelled).toBe(true);
		expect(result.output).not.toContain("Python kernel shutdown");
		expect(runSpy).toHaveBeenCalledTimes(6);

		// The persistent kernel survived the interrupt: prior state is intact.
		const after = await executePython("print(PREP_MARKER)", {
			cwd: tempDir.path(),
			sessionId,
			sessionFile,
			kernelMode: "session",
			toolSession: session,
		});
		expect(after.exitCode).toBe(0);
		expect(after.output.trim()).toBe("4242");
	}, 30_000);

	it("streams enriched agent progress through onStatus before the cell finishes", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-progress-");
		const { session, sessionFile } = makeEvalSession(tempDir, "js-agent-progress");
		mockAgents();

		const makeProgress = (options: ExecutorOptions, overrides: Partial<AgentProgress>): AgentProgress => ({
			index: options.index,
			id: options.id,
			agent: options.agent.name,
			agentSource: options.agent.source,
			status: "running",
			task: options.task,
			assignment: options.assignment,
			description: options.description,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			tokens: 0,
			requests: 0,
			cost: 0,
			durationMs: 0,
			...overrides,
		});

		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			options.onProgress?.(
				makeProgress(options, {
					status: "running",
					currentTool: "read",
					currentToolArgs: "config.ts",
					lastIntent: "Reading config",
					toolCount: 4,
					contextTokens: 5000,
					contextWindow: 200000,
					cost: 0.03,
					durationMs: 800,
					resolvedModel: "p/model",
				}),
			);
			options.onProgress?.(
				makeProgress(options, {
					status: "completed",
					toolCount: 7,
					contextTokens: 8000,
					contextWindow: 200000,
					cost: 0.06,
					durationMs: 1500,
					resolvedModel: "p/model",
				}),
			);
			return singleResult(options, { output: "done" });
		});

		const events: Array<{ op: string; [key: string]: unknown }> = [];
		const result = await executeJs('await agent("investigate", { label: "Scout" });', {
			cwd: tempDir.path(),
			sessionId: sharedJsSessionId,
			session,
			sessionFile,
			onStatus: event => events.push(event),
		});

		expect(result.exitCode).toBe(0);

		const agentEvents = events.filter(event => event.op === "agent");
		// Both throttled ticks were delivered live (the cell awaited agent() and
		// the executor collected them as displayOutputs too).
		expect(agentEvents.length).toBe(2);

		const running = agentEvents[0];
		expect(running.status).toBe("running");
		expect(running.currentTool).toBe("read");
		expect(running.lastIntent).toBe("Reading config");
		expect(running.contextTokens).toBe(5000);
		expect(running.taskPreview).toBe("investigate");
		expect(typeof running.id).toBe("string");

		// The final completion event keeps the rich stats — no sparse event
		// coalesces over it and drops toolCount/cost.
		const completed = agentEvents[1];
		expect(completed.status).toBe("completed");
		expect(completed.toolCount).toBe(7);
		expect(completed.cost).toBeCloseTo(0.06);
		expect(completed.id).toBe(running.id);

		// Same events are still present in the executor's returned displayOutputs.
		const displayAgentEvents = result.displayOutputs.filter(
			(output): output is Extract<typeof output, { type: "status" }> => output.type === "status",
		);
		expect(displayAgentEvents.length).toBe(2);
	});

	it("pauses the idle watchdog while a quiet agent() runs past the budget", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-timeout-pause-");
		const { session } = makeEvalSession(
			tempDir,
			"js-agent-timeout-pause",
			Settings.isolated({ "task.maxRuntimeMs": 1 }),
		);
		mockAgents();

		// runSubprocess runs far past the eval timeout budget and emits NO progress
		// of its own; the bridge pause must make that delegated time invisible to
		// the watchdog. Fake timers replace the real wait: the subprocess parks on
		// `released` so the test can advance the clock past the budget while the
		// bridge call is provably in flight, then release it deterministically.
		let release: (() => void) | undefined;
		const released = new Promise<void>(resolve => {
			release = resolve;
		});
		let markInFlight: (() => void) | undefined;
		const inFlight = new Promise<void>(resolve => {
			markInFlight = resolve;
		});
		let observedMaxRuntimeMs: number | undefined;
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			observedMaxRuntimeMs = options.maxRuntimeMs;
			markInFlight?.();
			await released;
			return singleResult(options, { output: "done" });
		});

		const ops: string[] = [];
		vi.useFakeTimers();
		using idle = new IdleTimeout(20);
		const resultPromise = runEvalAgent(
			{ prompt: "investigate" },
			{
				session,
				signal: idle.signal,
				emitStatus: event => {
					ops.push(event.op);
					if (event.op === EVAL_TIMEOUT_PAUSE_OP) idle.pause();
					if (event.op === EVAL_TIMEOUT_RESUME_OP) idle.resume();
				},
			},
		);

		// The bridge paused the watchdog; the subprocess is now blocked in flight.
		await inFlight;
		// `agent()` must not pin the wall-clock cap: leaving it unset lets the
		// executor inherit `task.maxRuntimeMs` exactly like the task tool does.
		expect(observedMaxRuntimeMs).toBeUndefined();
		// Burn far more than the 20ms budget while paused: the watchdog stays armed-off.
		vi.advanceTimersByTime(1_000);
		expect(idle.signal.aborted).toBe(false);

		release?.();
		const result = await resultPromise;

		expect(result.text).toBe("done");
		expect(ops).toEqual([EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP]);
		expect(idle.signal.aborted).toBe(false);

		// RESUME re-armed a fresh window; once the runtime stays idle past it the
		// watchdog finally fires.
		vi.advanceTimersByTime(idle.idleMs + 5);
		expect(idle.signal.aborted).toBe(true);
	});

	it("keeps timeout paused despite agent() progress snapshots", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-progress-timeout-pause-");
		const { session } = makeEvalSession(tempDir, "js-agent-progress-timeout-pause");
		mockAgents();

		// Stream frequent progress snapshots (op:"agent") well past the budget.
		// They render as status, but timeout accounting is controlled only by the
		// bridge pause/resume events — so even a flood of snapshots must not re-arm
		// the watchdog. Fake timers make "past the budget" deterministic: the
		// subprocess emits its snapshots, parks on `released`, and the test advances
		// the clock far past the window before releasing it.
		let release: (() => void) | undefined;
		const released = new Promise<void>(resolve => {
			release = resolve;
		});
		let markInFlight: (() => void) | undefined;
		const inFlight = new Promise<void>(resolve => {
			markInFlight = resolve;
		});
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			for (let i = 0; i < 20; i++) {
				options.onProgress?.({
					index: options.index,
					id: options.id,
					agent: options.agent.name,
					agentSource: options.agent.source,
					status: "running",
					task: options.task,
					assignment: options.assignment,
					description: options.description,
					recentTools: [],
					recentOutput: [],
					toolCount: i,
					tokens: 0,
					requests: 0,
					cost: 0,
					durationMs: i * 10,
				});
			}
			markInFlight?.();
			await released;
			return singleResult(options, { output: "done" });
		});

		const ops: string[] = [];
		vi.useFakeTimers();
		using idle = new IdleTimeout(250);
		const resultPromise = runEvalAgent(
			{ prompt: "investigate" },
			{
				session,
				signal: idle.signal,
				emitStatus: event => {
					ops.push(event.op);
					if (event.op === EVAL_TIMEOUT_PAUSE_OP) idle.pause();
					if (event.op === EVAL_TIMEOUT_RESUME_OP) idle.resume();
				},
			},
		);

		// All snapshots have streamed and the subprocess is blocked in flight.
		await inFlight;
		// Far exceed the 250ms budget while paused: the snapshots already delivered
		// must not have re-armed the watchdog.
		vi.advanceTimersByTime(10_000);
		expect(idle.signal.aborted).toBe(false);

		release?.();
		const result = await resultPromise;

		expect(result.text).toBe("done");
		expect(ops[0]).toBe(EVAL_TIMEOUT_PAUSE_OP);
		expect(ops).toContain("agent");
		expect(ops.at(-1)).toBe(EVAL_TIMEOUT_RESUME_OP);
		expect(idle.signal.aborted).toBe(false);
	});

	it("interrupting a JavaScript agent() aborts it at once but waits out its critical phase", async () => {
		// Regression: `onAbort` used to hard-kill the worker straight away, which
		// rejected the run while the untracked `handleToolCall` promise carried on
		// — so an isolation merge could keep cherry-picking after the cell had
		// already returned. Mirrors the Python bridge's shielded-signal contract.
		//
		// Asserted as an ordering, not a duration: the agent call must finish
		// before the cell settles. Killing early inverts the two.
		using tempDir = TempDir.createSync("@omp-eval-agent-js-interrupt-");
		const { session, sessionFile } = makeEvalSession(tempDir, "js-agent-interrupt");
		mockAgents();

		const order: string[] = [];
		const inFlight = Promise.withResolvers<void>();
		const sawAbort = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		// Stands in for the isolation merge: notices the abort, then keeps going.
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			options.signal?.addEventListener(
				"abort",
				() => {
					order.push("agent-saw-abort");
					sawAbort.resolve();
				},
				{ once: true },
			);
			inFlight.resolve();
			await release.promise;
			order.push("agent-returned");
			return singleResult(options, { output: "merged" });
		});

		const ac = new AbortController();
		const cell = executeJs('return await agent("merge");', {
			cwd: tempDir.path(),
			sessionId: "agent-bridge-js-interrupt",
			session,
			sessionFile,
			signal: ac.signal,
		}).finally(() => {
			order.push("cell-settled");
		});

		await inFlight.promise;
		ac.abort(new Error("external interrupt"));
		// Delegated work is notified immediately, before anything is released.
		await sawAbort.promise;
		// Drain the microtask queue. An abort that settled the run outright would
		// have resolved the cell by now; no wall clock is involved.
		for (let i = 0; i < 200; i++) await Promise.resolve();
		expect(order).toEqual(["agent-saw-abort"]);

		release.resolve();
		const result = await cell;

		expect(order).toEqual(["agent-saw-abort", "agent-returned", "cell-settled"]);
		expect(result.cancelled).toBe(true);
	}, 30_000);
});

describe("runEvalAgent isolation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function isolatedSession(overrides: Partial<Parameters<typeof Settings.isolated>[0]> = {}): ToolSession {
		return makeSession({
			settings: Settings.isolated({
				"async.enabled": false,
				"task.isolation.mode": "auto",
				"task.isolation.merge": "patch",
				...overrides,
			}),
		});
	}

	function mockIsolationContext(): { repoRoot: string } {
		const repoRoot = "/repo-root";
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({
			repoRoot,
			baseline: {
				root: { repoRoot, headCommit: "HEAD", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
				nested: [],
			},
		});
		return { repoRoot };
	}

	it("rejects isolated=true when task.isolation.mode is 'none'", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));
		const prepSpy = vi.spyOn(isolationRunner, "prepareIsolationContext");

		const session = makeSession(); // default settings: isolation.mode === "none"

		await expect(runEvalAgent({ prompt: "do work", isolated: true }, { session })).rejects.toThrow(
			'task.isolation.mode to be set; current mode is "none"',
		);
		expect(prepSpy).not.toHaveBeenCalled();
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("stays non-isolated by default even when task.isolation.mode is set; isolated=true opts in", async () => {
		mockAgents();
		mockIsolationContext();
		const isolatedSpy = vi
			.spyOn(isolationRunner, "runIsolatedSubprocess")
			.mockImplementation(async opts => singleResult(opts.baseOptions, { output: "isolated-run" }));
		const plainSpy = vi
			.spyOn(taskExecutor, "runSubprocess")
			.mockImplementation(async options => singleResult(options, { output: "plain-run" }));
		const mergeSpy = vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "",
			changesApplied: true,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		});

		// Default (no isolated arg) — stays non-isolated even when settings allow it.
		const defaultResult = await runEvalAgent({ prompt: "default" }, { session: isolatedSession() });
		expect(plainSpy).toHaveBeenCalledTimes(1);
		expect(isolatedSpy).not.toHaveBeenCalled();
		expect(defaultResult.details.isolated).toBeUndefined();
		expect(defaultResult.details.changesApplied).toBeUndefined();
		expect(mergeSpy).not.toHaveBeenCalled();

		// Explicit isolated=true — opt-in turns it on and surfaces merge details.
		const explicitOn = await runEvalAgent({ prompt: "on", isolated: true }, { session: isolatedSession() });
		expect(isolatedSpy).toHaveBeenCalledTimes(1);
		expect(plainSpy).toHaveBeenCalledTimes(1);
		expect(explicitOn.details.isolated).toBe(true);
		expect(mergeSpy).toHaveBeenCalledTimes(1);
	});

	it("preserves temp artifacts for non-isolated handle outputs", async () => {
		mockAgents();
		const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		await runEvalAgent({ prompt: "plain handle", handle: true }, { session: makeSession() });

		const removedArtifactsDir = rmSpy.mock.calls.some(
			([target]) => typeof target === "string" && target.includes("omp-eval-agent-"),
		);
		expect(removedArtifactsDir).toBe(false);
	});

	it("forwards merge=false as patch mode and passes the worktree cwd through baseOptions", async () => {
		mockAgents();
		const { repoRoot } = mockIsolationContext();
		const isolatedSpy = vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts =>
			singleResult(opts.baseOptions, {
				output: "isolated-run",
				patchPath: `/artifacts/${opts.agentId}.patch`,
			}),
		);
		vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "\n\nApplied patches: yes",
			changesApplied: true,
			hadAnyChanges: true,
			mergedBranchForNestedPatches: false,
		});

		// Branch is the configured merge mode, but `merge: false` must demote to patch.
		const session = isolatedSession({ "task.isolation.merge": "branch" });
		const result = await runEvalAgent({ prompt: "migration", isolated: true, merge: false }, { session });

		expect(isolatedSpy).toHaveBeenCalledTimes(1);
		const isolatedCall = isolatedSpy.mock.calls[0]?.[0];
		if (!isolatedCall) throw new Error("runIsolatedSubprocess was not called");
		expect(isolatedCall.mergeMode).toBe("patch");
		expect(isolatedCall.baseOptions.cwd).toBe(session.cwd);
		expect(isolatedCall.context.repoRoot).toBe(repoRoot);
		expect(result.details.patchPath).toMatch(/\.patch$/);
		expect(result.text).toContain("Applied patches: yes");
	});

	it("keeps the timeout paused through isolation merge/apply so the cell can't abort mid-cherry-pick", async () => {
		mockAgents();
		mockIsolationContext();
		const ops: string[] = [];
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts => {
			ops.push("subprocess");
			return singleResult(opts.baseOptions, { output: "done", patchPath: `/artifacts/${opts.agentId}.patch` });
		});
		vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockImplementation(async () => {
			ops.push("merge");
			return {
				summary: "\n\nMerged",
				changesApplied: true,
				hadAnyChanges: true,
				mergedBranchForNestedPatches: false,
			};
		});

		await runEvalAgent(
			{ prompt: "migration", isolated: true },
			{
				session: isolatedSession(),
				emitStatus: event => {
					if (event.op === EVAL_TIMEOUT_PAUSE_OP || event.op === EVAL_TIMEOUT_RESUME_OP) ops.push(event.op);
				},
			},
		);

		const pauseIdx = ops.indexOf(EVAL_TIMEOUT_PAUSE_OP);
		const resumeIdx = ops.lastIndexOf(EVAL_TIMEOUT_RESUME_OP);
		const mergeIdx = ops.indexOf("merge");
		expect(pauseIdx).toBeGreaterThanOrEqual(0);
		expect(resumeIdx).toBeGreaterThan(pauseIdx);
		expect(mergeIdx).toBeGreaterThan(pauseIdx);
		expect(mergeIdx).toBeLessThan(resumeIdx);
	});

	it("keeps the timeout paused through isolation baseline capture", async () => {
		mockAgents();
		const ops: string[] = [];
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockImplementation(async () => {
			ops.push("prepare");
			return {
				repoRoot: "/repo-root",
				baseline: {
					root: {
						repoRoot: "/repo-root",
						headCommit: "HEAD",
						staged: "",
						unstaged: "",
						untracked: [],
						untrackedPatch: "",
					},
					nested: [],
				},
			};
		});
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts =>
			singleResult(opts.baseOptions, { output: "done", patchPath: `/artifacts/${opts.agentId}.patch` }),
		);
		vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "\n\nMerged",
			changesApplied: true,
			hadAnyChanges: true,
			mergedBranchForNestedPatches: false,
		});

		await runEvalAgent(
			{ prompt: "scout", isolated: true },
			{
				session: isolatedSession(),
				emitStatus: event => {
					if (event.op === EVAL_TIMEOUT_PAUSE_OP || event.op === EVAL_TIMEOUT_RESUME_OP) ops.push(event.op);
				},
			},
		);

		const pauseIdx = ops.indexOf(EVAL_TIMEOUT_PAUSE_OP);
		const resumeIdx = ops.lastIndexOf(EVAL_TIMEOUT_RESUME_OP);
		const prepareIdx = ops.indexOf("prepare");
		expect(pauseIdx).toBeGreaterThanOrEqual(0);
		expect(prepareIdx).toBeGreaterThan(pauseIdx);
		expect(prepareIdx).toBeLessThan(resumeIdx);
	});

	it("keeps schema-backed isolated output parseable by moving merge text into details", async () => {
		mockAgents();
		mockIsolationContext();
		const structuredOutput = JSON.stringify({ status: "ok" });
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts =>
			singleResult(opts.baseOptions, {
				output: structuredOutput,
				patchPath: `/artifacts/${opts.agentId}.patch`,
			}),
		);
		vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "\n\nNo changes to apply.",
			changesApplied: true,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		});

		const result = await runEvalAgent(
			{
				prompt: "structured",
				isolated: true,
				schema: {
					type: "object",
					properties: { status: { type: "string" } },
					required: ["status"],
				},
			},
			{ session: isolatedSession() },
		);

		expect(JSON.parse(result.text)).toEqual({ status: "ok" });
		expect(result.text).toBe(structuredOutput);
		expect(result.details.isolationSummary).toBe("No changes to apply.");
	});

	it("throws when an isolated apply fails so schema callers cannot mistake it for success", async () => {
		mockAgents();
		mockIsolationContext();
		const structuredOutput = JSON.stringify({ status: "ok" });
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts =>
			singleResult(opts.baseOptions, {
				output: structuredOutput,
				patchPath: `/artifacts/${opts.agentId}.patch`,
			}),
		);
		vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "\n\n<system-notification>Patch apply failed: conflict in foo.ts</system-notification>",
			changesApplied: false,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		});

		await expect(
			runEvalAgent(
				{
					prompt: "structured",
					isolated: true,
					schema: {
						type: "object",
						properties: { status: { type: "string" } },
						required: ["status"],
					},
				},
				{ session: isolatedSession() },
			),
		).rejects.toThrow(/isolated apply failed.*Patch apply failed.*Captured patch preserved at \/artifacts\//s);
	});

	it("surfaces the preserved patch path when branch-mode transfer fails before merge runs", async () => {
		mockAgents();
		mockIsolationContext();
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts =>
			singleResult(opts.baseOptions, {
				output: "ran",
				patchPath: `/artifacts/${opts.agentId}.patch`,
				error: "Merge failed: remote: garbage at end of loose object '4de7bad'",
			}),
		);
		const mergeSpy = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const session = isolatedSession({ "task.isolation.merge": "branch" });
		await expect(runEvalAgent({ prompt: "scout", isolated: true }, { session })).rejects.toThrow(
			/Merge failed.*garbage at end of loose object.*Captured patch preserved at \/artifacts\//s,
		);
		expect(mergeSpy).not.toHaveBeenCalled();
	});

	it("throws on apply failure for non-schema callers too instead of burying the warning in text", async () => {
		mockAgents();
		mockIsolationContext();
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts =>
			singleResult(opts.baseOptions, {
				output: "ran",
				branchName: `omp/task/${opts.agentId}`,
			}),
		);
		vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "\n\n<system-notification>Branch merge failed: omp/task/x.\nConflict: foo.ts</system-notification>",
			changesApplied: false,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		});

		const session = isolatedSession({ "task.isolation.merge": "branch" });
		await expect(runEvalAgent({ prompt: "scout", isolated: true }, { session })).rejects.toThrow(
			/isolated apply failed.*Branch merge failed.*Captured branch preserved as omp\/task\//s,
		);
	});

	it("persists captured nested patches to a recoverable file before throwing on apply failure", async () => {
		mockAgents();
		mockIsolationContext();
		const nestedPatch = "diff --git a/file b/file\n";
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts =>
			singleResult(opts.baseOptions, {
				output: "ran",
				patchPath: `/artifacts/${opts.agentId}.patch`,
				nestedPatches: [{ relativePath: "sub/nested", patch: nestedPatch }],
			}),
		);
		vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "\n\n<system-notification>Patch apply failed: conflict in foo.ts</system-notification>",
			changesApplied: false,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		});

		let caught: Error | undefined;
		try {
			await runEvalAgent({ prompt: "scout", isolated: true }, { session: isolatedSession() });
		} catch (err) {
			caught = err as Error;
		}
		expect(caught).toBeDefined();
		const match = caught?.message.match(/(\/[^\s,]+?\.nested-0-sub_nested\.patch)/);
		expect(match).not.toBeNull();
		const persistedPath = match?.[1];
		expect(persistedPath).toBeDefined();
		const contents = await fs.readFile(persistedPath!, "utf-8");
		expect(contents).toBe(nestedPatch);
		await fs.rm(path.dirname(persistedPath!), { recursive: true, force: true });
	});

	it("throws schema calls when nested patch application reports a warning", async () => {
		mockAgents();
		mockIsolationContext();
		const nestedPatch = "diff --git a/file b/file\n";
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts =>
			singleResult(opts.baseOptions, {
				output: JSON.stringify({ status: "ok" }),
				patchPath: `/artifacts/${opts.agentId}.patch`,
				nestedPatches: [{ relativePath: "sub/nested", patch: nestedPatch }],
			}),
		);
		vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "\n\nApplied patches: yes",
			changesApplied: true,
			hadAnyChanges: true,
			mergedBranchForNestedPatches: false,
		});
		vi.spyOn(isolationRunner, "applyEligibleNestedPatches").mockResolvedValue(
			"\n\n<system-notification>Some nested repository patches failed to apply.</system-notification>",
		);

		await expect(
			runEvalAgent(
				{
					prompt: "structured",
					isolated: true,
					schema: {
						type: "object",
						properties: { status: { type: "string" } },
						required: ["status"],
					},
				},
				{ session: isolatedSession() },
			),
		).rejects.toThrow(
			/nested patch apply failed.*Some nested repository patches failed to apply.*nested-0-sub_nested\.patch/s,
		);
	});

	it("skips the merge phase when apply=false and surfaces the patch artifact instead", async () => {
		mockAgents();
		mockIsolationContext();
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts =>
			singleResult(opts.baseOptions, {
				output: "captured",
				patchPath: "/artifacts/captured.patch",
			}),
		);
		const mergeSpy = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const result = await runEvalAgent(
			{ prompt: "scout", isolated: true, apply: false },
			{ session: isolatedSession() },
		);

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(result.details.isolated).toBe(true);
		expect(result.details.changesApplied).toBeNull();
		expect(result.details.patchPath).toBe("/artifacts/captured.patch");
		expect(result.text).toContain("/artifacts/captured.patch");
		expect(result.text).toContain("apply=false");
	});

	it("surfaces a captured branch name when apply=false and the run used branch mode", async () => {
		mockAgents();
		mockIsolationContext();
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts =>
			singleResult(opts.baseOptions, {
				output: "branched",
				branchName: `omp/task/${opts.agentId}`,
			}),
		);
		const mergeSpy = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const session = isolatedSession({ "task.isolation.merge": "branch" });
		const result = await runEvalAgent({ prompt: "scout", isolated: true, apply: false }, { session });

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(result.details.branchName).toMatch(/^omp\/task\//);
		expect(result.text).toContain("omp/task/");
		expect(result.text).toContain("apply=false");
	});

	it("surfaces nested patches when apply=false captured branch-mode nested-only changes", async () => {
		mockAgents();
		mockIsolationContext();
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts =>
			singleResult(opts.baseOptions, {
				output: "nested-only",
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		);
		const mergeSpy = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const session = isolatedSession({ "task.isolation.merge": "branch" });
		const result = await runEvalAgent({ prompt: "scout", isolated: true, apply: false }, { session });

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(result.details.branchName).toBeUndefined();
		expect(result.details.patchPath).toBeUndefined();
		expect(result.details.nestedPatches).toEqual([{ relativePath: "nested", patch: "diff --git a/file b/file\n" }]);
		expect(result.text).toContain("nested repository");
		expect(result.text).toContain("apply=false");
	});

	it("preserves the temp artifacts dir when apply=false so details.patchPath remains valid", async () => {
		mockAgents();
		mockIsolationContext();
		const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts =>
			singleResult(opts.baseOptions, { output: "captured", patchPath: `/artifacts/${opts.agentId}.patch` }),
		);

		const result = await runEvalAgent(
			{ prompt: "scout", isolated: true, apply: false },
			{ session: isolatedSession() },
		);

		expect(result.details.patchPath).toMatch(/\.patch$/);
		const removedArtifactsDir = rmSpy.mock.calls.some(
			([target]) => typeof target === "string" && target.includes("omp-eval-agent-"),
		);
		expect(removedArtifactsDir).toBe(false);
	});

	it("still cleans the temp artifacts dir when apply succeeds", async () => {
		mockAgents();
		mockIsolationContext();
		const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts =>
			singleResult(opts.baseOptions, { output: "captured", patchPath: `/artifacts/${opts.agentId}.patch` }),
		);
		vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "\n\nApplied",
			changesApplied: true,
			hadAnyChanges: true,
			mergedBranchForNestedPatches: false,
		});

		await runEvalAgent({ prompt: "scout", isolated: true }, { session: isolatedSession() });

		const removedArtifactsDir = rmSpy.mock.calls.some(
			([target]) => typeof target === "string" && target.includes("omp-eval-agent-"),
		);
		expect(removedArtifactsDir).toBe(true);
	});

	it("preserves the temp artifacts dir after a successful apply when handle is requested", async () => {
		mockAgents();
		mockIsolationContext();
		const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts =>
			singleResult(opts.baseOptions, { output: "captured", patchPath: `/artifacts/${opts.agentId}.patch` }),
		);
		vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "\n\nApplied",
			changesApplied: true,
			hadAnyChanges: true,
			mergedBranchForNestedPatches: false,
		});

		await runEvalAgent({ prompt: "scout", isolated: true, handle: true }, { session: isolatedSession() });

		const removedArtifactsDir = rmSpy.mock.calls.some(
			([target]) => typeof target === "string" && target.includes("omp-eval-agent-"),
		);
		expect(removedArtifactsDir).toBe(false);
	});
});
