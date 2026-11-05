/**
 * Workflow VM: deterministic sandbox, per-call journal, resumeFrom prefix
 * replay, and a kill -9 resume smoke.
 *
 * The agent executor is injected (a fake that records calls), so the suite
 * exercises the tool, VM context, and journal without a live model. The kill
 * smoke runs the real tool in a child bun process whose fake executor hangs on
 * the second call; the parent SIGKILLs it, then resumes from the journal. That
 * is the "controllable fake executor recording to disk + SIGKILL" variant the
 * task brief allows instead of a full live task spawn.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { A2aAgentBridge } from "@oh-my-pi/pi-coding-agent/a2a/agent-bridge";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { acquireSessionSpawnPermit, releaseSessionSpawnPermit } from "@oh-my-pi/pi-coding-agent/task/spawn-limiter";
import * as structuredModule from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { StructuredSubagentResult } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { hashAgentCall, WorkflowJournal, resolveWorkflowJournalPath } from "@oh-my-pi/pi-coding-agent/workflow/journal";
import { BUILTIN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { BUILTIN_TOOLS } from "@oh-my-pi/pi-coding-agent/tools";
import { WorkflowTool, type WorkflowToolDetails } from "@oh-my-pi/pi-coding-agent/workflow/tool";
import { assertNoModuleLoading, type WorkflowAgentCaller } from "@oh-my-pi/pi-coding-agent/workflow/vm";

/**
 * Independent snapshot of every global the workflow contract may expose.
 * Deliberately duplicated from the implementation allowlist: if either list
 * broadens without the other, the sweep test fails.
 */
const EXPECTED_GLOBAL_NAMES = new Set<string>([
	"AggregateError",
	"Array",
	"ArrayBuffer",
	"AsyncDisposableStack",
	"Atomics",
	"BigInt",
	"BigInt64Array",
	"BigUint64Array",
	"Boolean",
	"DataView",
	"Date",
	"DisposableStack",
	"Error",
	"EvalError",
	"FinalizationRegistry",
	"Float16Array",
	"Float32Array",
	"Float64Array",
	"Function",
	"Infinity",
	"Int16Array",
	"Int32Array",
	"Int8Array",
	"Intl",
	"Iterator",
	"JSON",
	"Map",
	"Math",
	"NaN",
	"Number",
	"Object",
	"Promise",
	"Proxy",
	"RangeError",
	"ReferenceError",
	"Reflect",
	"RegExp",
	"Set",
	"ShadowRealm",
	"SharedArrayBuffer",
	"String",
	"SuppressedError",
	"Symbol",
	"SyntaxError",
	"Temporal",
	"TypeError",
	"URIError",
	"Uint16Array",
	"Uint32Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"WeakMap",
	"WeakRef",
	"WeakSet",
	"WebAssembly",
	"console",
	"decodeURI",
	"decodeURIComponent",
	"encodeURI",
	"encodeURIComponent",
	"escape",
	"eval",
	"globalThis",
	"isFinite",
	"isNaN",
	"parseFloat",
	"parseInt",
	"undefined",
	"unescape",
	"agent",
	"parallel",
	"pipeline",
	"phase",
	"log",
	"clock",
	"args",
	"require",
	"process",
]);

const tempDirs: string[] = [];
const childProcesses: ReturnType<typeof Bun.spawn>[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-workflow-"));
	tempDirs.push(dir);
	return dir;
}

function makeSession(dir: string): ToolSession {
	// The tool only needs the session file here; the agent executor is injected,
	// so a full ToolSession (settings, registry, ...) would be dead weight.
	return {
		cwd: dir,
		hasUI: false,
		getSessionFile: () => path.join(dir, "session.jsonl"),
		getSessionSpawns: () => null,
	} as unknown as ToolSession;
}

interface RecordingRunner extends WorkflowAgentCaller {
	calls: string[];
	maxActive: number;
	active: number;
}

interface ConcurrencyGate {
	readonly expected: number;
	readonly promise: Promise<void>;
	release(): void;
}

/** Release a runner once `expected` calls overlap, so concurrency is observed without real timers. */
function concurrencyGate(expected: number): ConcurrencyGate {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { expected, promise, release: resolve };
}

function recordingRunner(
	behavior: (prompt: string) => { result: string; tokens: number } | Promise<{ result: string; tokens: number }>,
	gate?: ConcurrencyGate,
): RecordingRunner {
	const calls: string[] = [];
	const state = { active: 0, maxActive: 0 };
	const runner = (async (prompt: string) => {
		calls.push(prompt);
		state.active += 1;
		state.maxActive = Math.max(state.maxActive, state.active);
		try {
			if (gate) {
				if (state.active >= gate.expected) gate.release();
				await gate.promise;
			}
			return await behavior(prompt);
		} finally {
			state.active -= 1;
		}
	}) as RecordingRunner;
	Object.defineProperty(runner, "calls", { get: () => calls });
	Object.defineProperty(runner, "maxActive", { get: () => state.maxActive });
	Object.defineProperty(runner, "active", { get: () => state.active });
	return runner;
}

function textOf(result: AgentToolResult<WorkflowToolDetails>): string {
	const first = result.content[0];
	return first !== undefined && first.type === "text" ? first.text : "";
}

function journalLines(dir: string): Array<Record<string, unknown>> {
	const journalPath = path.join(dir, "workflow", "session", "journal.jsonl");
	return fs
		.readFileSync(journalPath, "utf8")
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

/** A `runStructuredSubagent` return value with the child's settled fields overridden. */
function structuredResult(dir: string, overrides: Record<string, unknown>): StructuredSubagentResult {
	return {
		result: {
			index: 0,
			id: "wf-child",
			agent: "task",
			agentSource: "bundled",
			task: "workflow prompt",
			assignment: "workflow prompt",
			exitCode: 0,
			output: "",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
			...overrides,
		},
		policy: {},
		mergeSummary: "",
		changesApplied: null,
		artifactsDir: dir,
		temporaryArtifacts: false,
	} as unknown as StructuredSubagentResult;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const proc of childProcesses.splice(0)) {
		try {
			proc.kill(9);
		} catch {
			// already gone
		}
	}
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("workflow journal", () => {
	it("folds started/completed lines into one call per index", () => {
		const dir = tempDir();
		const journal = new WorkflowJournal(path.join(dir, "journal.jsonl"));
		const promptHash = hashAgentCall({ prompt: "hello", agent: "task" });
		journal.append({
			runId: "run-1",
			index: 0,
			promptHash,
			agent: "task",
			result: null,
			tokens: 0,
			status: "started",
		});
		journal.append({
			runId: "run-1",
			index: 0,
			promptHash,
			agent: "task",
			result: "answer",
			tokens: 42,
			status: "completed",
		});
		const run = journal.readRun("run-1");
		expect(run).toBeDefined();
		expect(run?.calls).toHaveLength(1);
		expect(run?.calls[0]).toMatchObject({ index: 0, status: "completed", result: "answer", tokens: 42 });
	});

	it("tolerates a truncated final line (a kill mid-write)", () => {
		const dir = tempDir();
		const journalPath = path.join(dir, "journal.jsonl");
		const journal = new WorkflowJournal(journalPath);
		journal.append({
			runId: "run-2",
			index: 0,
			promptHash: "abc",
			agent: "default",
			result: "ok",
			tokens: 1,
			status: "completed",
		});
		fs.appendFileSync(journalPath, '{"runId":"run-2","index":1,"promptHa');
		const run = journal.readRun("run-2");
		expect(run?.calls).toHaveLength(1);
		expect(run?.calls[0].result).toBe("ok");
	});

	it("starts a fresh line when appending after a truncated tail", () => {
		const dir = tempDir();
		const journalPath = path.join(dir, "journal.jsonl");
		const journal = new WorkflowJournal(journalPath);
		journal.append({
			runId: "run-3",
			index: 0,
			promptHash: "abc",
			agent: "default",
			result: "ok",
			tokens: 1,
			status: "completed",
		});
		fs.appendFileSync(journalPath, '{"runId":"run-3","index":1,"promptHa');
		journal.append({
			runId: "run-3",
			index: 2,
			promptHash: "def",
			agent: "default",
			result: "second",
			tokens: 2,
			status: "completed",
		});
		const run = journal.readRun("run-3");
		expect(run?.calls.map(call => [call.index, call.result])).toEqual([
			[0, "ok"],
			[2, "second"],
		]);
	});

	it("is stable across key order and sensitive to agent/prompt changes", () => {
		const a = hashAgentCall({ prompt: "p", agent: "task" });
		const b = hashAgentCall({ agent: "task", prompt: "p" });
		expect(a).toBe(b);
		expect(hashAgentCall({ prompt: "p", agent: "other" })).not.toBe(a);
		expect(hashAgentCall({ prompt: "q", agent: "task" })).not.toBe(a);
	});

	it("resolves under the session's workflow directory", () => {
		const dir = tempDir();
		const journalPath = resolveWorkflowJournalPath(makeSession(dir));
		expect(journalPath).toBe(path.join(dir, "workflow", "session", "journal.jsonl"));
	});
});

describe("workflow tool", () => {
	it("runs a script with three agent calls and journals every call", async () => {
		const dir = tempDir();
		const runner = recordingRunner(prompt => ({ result: `out:${prompt}`, tokens: prompt.length }));
		const tool = new WorkflowTool(makeSession(dir), { runner });
		const result = await tool.execute("call-1", {
			script: `
				const a = await agent("one");
				const b = await agent("two");
				const c = await agent("three");
				log("finished", args);
				return [a.result, b.result, c.result];
			`,
			args: "hello",
		});

		expect(runner.calls).toEqual(["one", "two", "three"]);
		expect(result.content[0].type).toBe("text");
		const text = textOf(result);
		expect(text).toContain("out:one");
		expect(text).toContain("out:three");
		expect(text).toContain("finished hello");

		const details = result.details as { runId: string; executed: number; cached: number };
		expect(details.executed).toBe(3);
		expect(details.cached).toBe(0);

		const lines = journalLines(dir);
		const runIds = new Set(lines.map(line => line.runId));
		expect(runIds.size).toBe(1);
		expect(runIds.has(details.runId)).toBe(true);
		const statuses = lines.filter(line => line.runId === details.runId).map(line => line.status);
		expect(statuses).toEqual(["started", "completed", "started", "completed", "started", "completed"]);
		const indices = lines.filter(line => line.status === "completed").map(line => line.index);
		expect(indices).toEqual([0, 1, 2]);
		for (const line of lines) {
			expect(typeof line.promptHash).toBe("string");
			expect((line.promptHash as string).length).toBe(64);
			expect(line.agent).toBe("default");
		}
	});

	it("resumes a failed run: matching prefix is cached, the divergence tail executes", async () => {
		const dir = tempDir();
		const script = `
			const a = await agent("one");
			const b = await agent("two");
			const c = await agent("three");
			return { values: [a.result, b.result, c.result], cached: [a.cached === true, b.cached === true, c.cached === true] };
		`;
		const failing = recordingRunner(prompt => {
			if (prompt === "two") throw new Error("two failed");
			return { result: `out:${prompt}`, tokens: 1 };
		});
		const first = new WorkflowTool(makeSession(dir), { runner: failing });
		await expect(first.execute("call-1", { script })).rejects.toThrow(/two failed/);

		const journal = new WorkflowJournal(path.join(dir, "workflow", "session", "journal.jsonl"));
		const runId = journalLinearRunId(dir);
		const run = journal.readRun(runId);
		expect(run?.calls.map(call => [call.index, call.status])).toEqual([
			[0, "completed"],
			[1, "failed"],
		]);
		expect(run?.calls[1].error).toContain("two failed");

		const resumed = recordingRunner(prompt => ({ result: `retry:${prompt}`, tokens: 2 }));
		const second = new WorkflowTool(makeSession(dir), { runner: resumed });
		const result = await second.execute("call-2", { script, resumeFrom: runId });

		expect(resumed.calls).toEqual(["two", "three"]);
		expect(textOf(result)).toContain("retry:two");
		expect(textOf(result)).toContain("retry:three");
		const details = result.details as { executed: number; cached: number; runId: string; result: unknown };
		expect(details.result).toEqual({
			values: ["out:one", "retry:two", "retry:three"],
			cached: [true, false, false],
		});
		expect(details.executed).toBe(2);
		expect(details.cached).toBe(1);

		const resumedLines = journalLines(dir).filter(line => line.runId === details.runId);
		expect(resumedLines.map(line => line.status)).toEqual(["cached", "started", "completed", "started", "completed"]);
	});

	it("replays only a strict prefix: a later hash match does not resurrect caching after a divergence", async () => {
		const dir = tempDir();
		const base = `
			const a = await agent("one");
			const b = await agent("two");
			const c = await agent("three");
			return [a.result, b.result, c.result];
		`;
		const firstRunner = recordingRunner(prompt => ({ result: `out:${prompt}`, tokens: 1 }));
		const first = new WorkflowTool(makeSession(dir), { runner: firstRunner });
		const firstResult = await first.execute("call-1", { script: base });
		const runId = (firstResult.details as { runId: string }).runId;

		const changed = base.replace('agent("two")', 'agent("two-changed")');
		const secondRunner = recordingRunner(prompt => ({ result: `out:${prompt}`, tokens: 1 }));
		const second = new WorkflowTool(makeSession(dir), { runner: secondRunner });
		await second.execute("call-2", { script: changed, resumeFrom: runId });

		// "three" still has the same prompt hash, but it follows the divergence.
		expect(secondRunner.calls).toEqual(["two-changed", "three"]);
	});

	it("can be resumed again from a run that was itself resumed", async () => {
		const dir = tempDir();
		const script = `return [(await agent("one")).result, (await agent("two")).result];`;
		const firstRunner = recordingRunner(prompt => ({ result: `out:${prompt}`, tokens: 1 }));
		const first = new WorkflowTool(makeSession(dir), { runner: firstRunner });
		const firstResult = await first.execute("call-1", { script });
		const run1 = (firstResult.details as { runId: string }).runId;

		const secondRunner = recordingRunner(prompt => ({ result: `retry:${prompt}`, tokens: 2 }));
		const second = new WorkflowTool(makeSession(dir), { runner: secondRunner });
		const secondResult = await second.execute("call-2", { script, resumeFrom: run1 });
		const run2 = (secondResult.details as { runId: string; cached: number; executed: number }).runId;
		expect(secondRunner.calls).toEqual([]);
		expect((secondResult.details as { cached: number }).cached).toBe(2);

		const thirdRunner = recordingRunner(prompt => ({ result: `third:${prompt}`, tokens: 3 }));
		const third = new WorkflowTool(makeSession(dir), { runner: thirdRunner });
		const thirdResult = await third.execute("call-3", { script, resumeFrom: run2 });
		expect(thirdRunner.calls).toEqual([]);
		expect((thirdResult.details as { cached: number; executed: number }).cached).toBe(2);
		expect((thirdResult.details as { executed: number }).executed).toBe(0);
		expect((thirdResult.details as { result: unknown }).result).toEqual(["out:one", "out:two"]);
	});

	it("records a failed agent call and reflects it in the journal", async () => {
		const dir = tempDir();
		const runner = recordingRunner(prompt => {
			if (prompt === "boom") throw new Error("agent exploded");
			return { result: prompt, tokens: 1 };
		});
		const tool = new WorkflowTool(makeSession(dir), { runner });
		await expect(tool.execute("call-1", { script: `await agent("boom"); return "unreachable";` })).rejects.toThrow(
			/agent exploded/,
		);
		const lines = journalLines(dir);
		expect(lines.map(line => line.status)).toEqual(["started", "failed"]);
		expect(lines[1].error).toContain("agent exploded");
		expect(lines[1].result).toBeNull();
	});

	it("journals a non-throwing child failure as failed and re-executes it on resume", async () => {
		const dir = tempDir();
		const script = `return (await agent("one")).result;`;
		const run = vi.spyOn(structuredModule, "runStructuredSubagent");
		run.mockResolvedValueOnce(
			structuredResult(dir, {
				exitCode: 1,
				output: "half done",
				stderr: "boom",
				error: "provider exploded",
			}),
		);
		const first = new WorkflowTool(makeSession(dir));
		await expect(first.execute("call-1", { script })).rejects.toThrow(/provider exploded/);

		const journal = new WorkflowJournal(path.join(dir, "workflow", "session", "journal.jsonl"));
		const runId = journalLinearRunId(dir);
		// The executor reports this failure as a value; the journal must not
		// record it as a completed call (a resume would then replay it as an
		// answer instead of retrying).
		expect(journal.readRun(runId)?.calls.map(call => [call.index, call.status])).toEqual([[0, "failed"]]);
		expect(journal.readRun(runId)?.calls[0].error).toContain("provider exploded");

		run.mockResolvedValueOnce(structuredResult(dir, { exitCode: 0, output: "the answer\n" }));
		const second = new WorkflowTool(makeSession(dir));
		const result = await second.execute("call-2", { script, resumeFrom: runId });
		const details = result.details as { executed: number; cached: number; result: unknown };
		expect(details.executed).toBe(1);
		expect(details.cached).toBe(0);
		expect(details.result).toBe("the answer");
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("takes the session's shared spawn slot, refusing under maxConcurrency=1 + refuse", async () => {
		const dir = tempDir();
		const session = {
			...makeSession(dir),
			settings: Settings.isolated({ "task.maxConcurrency": 1, "task.concurrencyPolicy": "refuse" }),
		} as ToolSession;
		// A permit already held by another spawn path in this session (a task
		// call, the pi.spawnSubagent seam) must bound workflow agent() too.
		await acquireSessionSpawnPermit(session);
		try {
			const tool = new WorkflowTool(session);
			await expect(tool.execute("call-1", { script: `return (await agent("one")).result;` })).rejects.toThrow(
				/Concurrent subagent limit reached/,
			);
		} finally {
			releaseSessionSpawnPermit(session);
		}
	});

	it("rejects a remote A2A agent instead of running its placeholder definition locally", async () => {
		const dir = tempDir();
		const bridge = new A2aAgentBridge();
		bridge.add({
			name: "a2a:main",
			description: "Remote Main",
			url: "http://127.0.0.1:7391/",
			cardName: "Main",
			skillId: "main",
		});
		const session = { ...makeSession(dir), getA2aBridge: () => bridge } as ToolSession;
		const tool = new WorkflowTool(session);
		await expect(
			tool.execute("call-1", { script: `return (await agent("work", { agent: "a2a:main" })).result;` }),
		).rejects.toThrow(/remote A2A agent and can only be spawned by the task tool/);
	});

	it("rejects an unknown resumeFrom run", async () => {
		const dir = tempDir();
		const tool = new WorkflowTool(makeSession(dir), {
			runner: recordingRunner(prompt => ({ result: prompt, tokens: 0 })),
		});
		await expect(
			tool.execute("call-1", { script: `return await agent("one");`, resumeFrom: "missing-run" }),
		).rejects.toThrow(/missing-run/);
	});

	it("respects the parallel concurrency limit and preserves result order", async () => {
		const dir = tempDir();
		const gate = concurrencyGate(2);
		const runner = recordingRunner(prompt => ({ result: `r:${prompt}`, tokens: 1 }), gate);
		const tool = new WorkflowTool(makeSession(dir), { runner });
		const result = await tool.execute("call-1", {
			script: `
				const out = await parallel([1, 2, 3, 4, 5], async (n) => {
					const r = await agent("p" + n);
					return r.result;
				}, { concurrency: 2 });
				return out;
			`,
		});
		expect(runner.maxActive).toBe(2);
		expect(textOf(result)).toContain('"r:p1"');
		expect(textOf(result)).toContain('"r:p5"');
	});

	it("rejects nested parallel/pipeline fan-out", async () => {
		const dir = tempDir();
		const tool = new WorkflowTool(makeSession(dir), {
			runner: recordingRunner(prompt => ({ result: prompt, tokens: 0 })),
		});
		await expect(
			tool.execute("call-1", {
				script: `await parallel([1], async () => { await parallel([2], async () => {}); }); return "unreachable";`,
			}),
		).rejects.toThrow(/only one parallel\(\)\/pipeline\(\) may be in flight/);
	});

	it("runs pipeline stages sequentially per item", async () => {
		const dir = tempDir();
		const runner = recordingRunner(prompt => ({ result: `[${prompt}]`, tokens: 1 }));
		const tool = new WorkflowTool(makeSession(dir), { runner });
		const result = await tool.execute("call-1", {
			script: `
				const out = await pipeline([1, 2], async (n) => (await agent("a" + n)).result, async (prev, n) => (await agent("b" + n)).result + "->" + prev, { concurrency: 2 });
				return out;
			`,
		});
		expect(runner.calls).toEqual(["a1", "a2", "b1", "b2"]);
		expect(textOf(result)).toContain("[b1]->[a1]");
		expect(textOf(result)).toContain("[b2]->[a2]");
	});

	it("moves an item to the next pipeline stage while another is still in the first", async () => {
		const dir = tempDir();
		const a2Started = concurrencyGate(1);
		const releaseA1 = concurrencyGate(1);
		const b1Ran = concurrencyGate(1);
		const releaseA2 = concurrencyGate(1);
		const calls: string[] = [];
		const runner: WorkflowAgentCaller = async prompt => {
			calls.push(prompt);
			if (prompt === "a1") await releaseA1.promise;
			if (prompt === "a2") {
				a2Started.release();
				await releaseA2.promise;
			}
			if (prompt === "b1") b1Ran.release();
			return { result: prompt, tokens: 1 };
		};
		const tool = new WorkflowTool(makeSession(dir), { runner });
		const execution = tool.execute("call-1", {
			script: `return await pipeline([1, 2], async (n) => (await agent("a" + n)).result, async (prev) => (await agent("b" + (prev === "a1" ? 1 : 2))).result);`,
		});

		await a2Started.promise;
		releaseA1.release();
		await b1Ran.promise;
		expect(calls).toEqual(["a1", "a2", "b1"]);
		releaseA2.release();
		await execution;
		expect(calls).toEqual(["a1", "a2", "b1", "b2"]);
	});

	it("streams phase and log updates", async () => {
		const dir = tempDir();
		const tool = new WorkflowTool(makeSession(dir), {
			runner: recordingRunner(prompt => ({ result: prompt, tokens: 0 })),
		});
		const updates: string[] = [];
		await tool.execute("call-1", { script: `phase("scan"); log("hello", 42); return 1;` }, undefined, partial => {
			const first = partial.content[0];
			if (first !== undefined && first.type === "text") updates.push(first.text);
		});
		expect(updates).toEqual(["workflow phase: scan", "workflow log: hello 42"]);
	});

	it("is registered as a builtin tool", async () => {
		expect(BUILTIN_TOOL_NAMES).toContain("workflow");
		const tool = await BUILTIN_TOOLS.workflow(makeSession(tempDir()));
		expect(tool?.name).toBe("workflow");
	});

	it("returns a deterministic clock counter and exposes args", async () => {
		const dir = tempDir();
		const tool = new WorkflowTool(makeSession(dir), {
			runner: recordingRunner(prompt => ({ result: prompt, tokens: 0 })),
		});
		const result = await tool.execute("call-1", {
			script: `return { ticks: [clock(), clock(), clock()], args };`,
			args: "--flag value",
		});
		expect(textOf(result)).toContain('"ticks": [');
		expect(textOf(result)).toContain('"--flag value"');
		expect(textOf(result)).toMatch(/"ticks": \[\s*1,\s*2,\s*3\s*\]/);
	});
});

describe("workflow determinism", () => {
	const cases: Array<{ name: string; script: string; pattern: RegExp }> = [
		{ name: "Date.now", script: `return Date.now();`, pattern: /Date\.now is disabled.*determinism.*clock\(\)/ },
		{ name: "new Date", script: `return new Date().getTime();`, pattern: /Date is disabled.*determinism/ },
		{ name: "Math.random", script: `return Math.random();`, pattern: /Math\.random is disabled.*determinism/ },
		{ name: "require", script: `return require("node:fs");`, pattern: /require is not available.*workflow scripts/ },
		{ name: "process", script: `return process.env;`, pattern: /process is not available.*workflow scripts/ },
		{
			name: "static import",
			script: `import fs from "node:fs";\nreturn fs;`,
			pattern: /workflow script syntax error:.*import/,
		},
		{
			name: "dynamic import",
			script: `return await import("node:fs");`,
			pattern: /dynamic import\(\) is not available/,
		},
		{ name: "Function constructor", script: `return Function("return 1")();`, pattern: /code generation/i },
		{
			name: "Temporal.Now",
			script: `return Temporal.Now.instant();`,
			pattern: /Temporal\.Now is disabled.*determinism/,
		},
	];

	for (const testCase of cases) {
		it(`rejects ${testCase.name} with a clear error`, async () => {
			const dir = tempDir();
			const tool = new WorkflowTool(makeSession(dir), {
				runner: recordingRunner(prompt => ({ result: prompt, tokens: 0 })),
			});
			await expect(tool.execute("call-1", { script: testCase.script })).rejects.toThrow(testCase.pattern);
		});
	}

	it("bounds a synchronous infinite loop", async () => {
		const dir = tempDir();
		const tool = new WorkflowTool(makeSession(dir), {
			runner: recordingRunner(prompt => ({ result: prompt, tokens: 0 })),
			syncTimeoutMs: 50,
		});
		await expect(tool.execute("call-1", { script: `while (true) {}` })).rejects.toThrow(/synchronous time limit/);
	});

	it("cancels the wait on a non-settling script via the abort signal", async () => {
		const dir = tempDir();
		const started = concurrencyGate(1);
		const controller = new AbortController();
		const runner: WorkflowAgentCaller = async () => {
			started.release();
			return await new Promise<never>(() => {});
		};
		const tool = new WorkflowTool(makeSession(dir), { runner });
		const execution = tool.execute("call-1", { script: `return await agent("hang");` }, controller.signal);
		await started.promise;
		controller.abort();
		await expect(execution).rejects.toThrow(/Operation aborted/);
		expect(journalLines(dir).map(line => line.status)).toEqual(["started"]);
	});

	it("exposes only the documented global allowlist", async () => {
		const dir = tempDir();
		const tool = new WorkflowTool(makeSession(dir), {
			runner: recordingRunner(prompt => ({ result: prompt, tokens: 0 })),
		});
		const hostileNames = [
			"Bun",
			"fetch",
			"setTimeout",
			"setInterval",
			"WebSocket",
			"crypto",
			"performance",
			"navigator",
		];
		const result = await tool.execute("call-1", {
			script: `
				return {
					names: Object.getOwnPropertyNames(globalThis).sort(),
					hostile: ${JSON.stringify(hostileNames)}.map(name => [name, typeof globalThis[name]]),
				};
			`,
		});
		const details = result.details as { result: { names: string[]; hostile: Array<[string, string]> } };
		const unexpected = details.result.names.filter(name => !EXPECTED_GLOBAL_NAMES.has(name));
		expect(unexpected).toEqual([]);
		for (const required of [
			"Object",
			"Promise",
			"JSON",
			"Math",
			"Date",
			"agent",
			"parallel",
			"pipeline",
			"phase",
			"log",
			"clock",
			"args",
			"console",
		]) {
			expect(details.result.names).toContain(required);
		}
		expect(details.result.hostile).toEqual(hostileNames.map(name => [name, "undefined"]));
	});

	it("rejects module loading in the preflight itself", () => {
		expect(() => assertNoModuleLoading(`import fs from "node:fs";`)).toThrow(/workflow script syntax error:.*import/);
		expect(() => assertNoModuleLoading(`return import("node:fs");`)).toThrow(/dynamic import\(\) is not available/);
	});

	it("does not leak host bridge functions into the script scope", async () => {
		const dir = tempDir();
		const tool = new WorkflowTool(makeSession(dir), {
			runner: recordingRunner(prompt => ({ result: prompt, tokens: 0 })),
		});
		const result = await tool.execute("call-1", {
			script: `
				return {
					agentBridge: typeof __hostAgent,
					logBridge: typeof __hostLog,
					phaseBridge: typeof __hostPhase,
					argsBridge: typeof __args,
					consoleConstructorLeak: (() => {
						try { return console.log.constructor("return typeof process")(); } catch (e) { return e.name; }
					})(),
					globalProtoLeak: (() => {
						try { return Object.getPrototypeOf(globalThis).constructor.constructor("return typeof process")(); } catch (e) { return e.name; }
					})(),
					agentCtorLeak: (() => {
						try { return agent.constructor.constructor("return typeof process")(); } catch (e) { return e.name; }
					})(),
					shadowRealmLeak: (() => {
						try { return new ShadowRealm().evaluate("typeof process"); } catch (e) { return e.name + ": " + e.message; }
					})(),
				};
			`,
		});
		expect(textOf(result)).toContain('"agentBridge": "undefined"');
		expect(textOf(result)).toContain('"logBridge": "undefined"');
		expect(textOf(result)).toContain('"phaseBridge": "undefined"');
		expect(textOf(result)).toContain('"argsBridge": "undefined"');
		expect(textOf(result)).toContain('"consoleConstructorLeak": "EvalError"');
		expect(textOf(result)).toContain('"globalProtoLeak": "EvalError"');
		expect(textOf(result)).toContain('"agentCtorLeak": "EvalError"');
		expect(textOf(result)).toContain('"shadowRealmLeak": "ReferenceError: ShadowRealm is disabled');
	});
});

describe("workflow kill-resume smoke", () => {
	it("does not re-execute a completed call after SIGKILL mid-run", async () => {
		const dir = tempDir();
		const executions = path.join(dir, "executions.log");
		const harness = path.join(dir, "harness.mjs");
		const toolModule = path.resolve(import.meta.dir, "../src/workflow/tool.ts");
		fs.writeFileSync(
			harness,
			`
import * as fs from "node:fs";
import { WorkflowTool } from ${JSON.stringify(toolModule)};

const dir = process.argv[2];
const executions = process.argv[3];
const record = (message) => fs.appendFileSync(executions, message + "\\n");
const runner = async (prompt) => {
	record(prompt);
	if (prompt === "second") {
		process.stdout.write("READY\\n");
		await new Promise(() => {});
	}
	return { result: "child:" + prompt, tokens: 3 };
};
const session = { getSessionFile: () => dir + "/session.jsonl" };
const tool = new WorkflowTool(session, { runner });
await tool.execute("smoke", {
	script: \`
		const a = await agent("first");
		const b = await agent("second");
		const c = await agent("third");
		return { values: [a.result, b.result, c.result], cached: [a.cached === true, b.cached === true, c.cached === true] };
	\`,
});
`,
		);

		const child = Bun.spawn([process.execPath, harness, dir, executions], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: { ...process.env, PI_CODING_AGENT_DIR: path.join(os.homedir(), ".omp-fork") },
			stdout: "pipe",
			stderr: "pipe",
		});
		childProcesses.push(child);

		// Real wall clock is deliberate here: the child is a separate process,
		// so fake timers cannot drive its progress. Wait on its stdout signal
		// instead of sleeping for a guessed duration.
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let childOutput = "";
		while (!childOutput.includes("READY")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			childOutput += decoder.decode(chunk.value);
		}
		expect(childOutput).toContain("READY");
		expect(fs.readFileSync(executions, "utf8")).toContain("second");
		child.kill(9);
		await child.exited;

		const journal = new WorkflowJournal(path.join(dir, "workflow", "session", "journal.jsonl"));
		const runId = journalLinearRunId(dir);
		const killedRun = journal.readRun(runId);
		expect(killedRun?.calls.map(call => [call.index, call.status])).toEqual([
			[0, "completed"],
			[1, "started"],
		]);

		const resumedPrompts: string[] = [];
		const resumeRunner: WorkflowAgentCaller = async prompt => {
			resumedPrompts.push(prompt);
			fs.appendFileSync(executions, prompt + "\n");
			return { result: `resumed:${prompt}`, tokens: 4 };
		};
		const tool = new WorkflowTool(makeSession(dir), { runner: resumeRunner });
		const result = await tool.execute("resume", {
			script: `
					const a = await agent("first");
					const b = await agent("second");
					const c = await agent("third");
					return { values: [a.result, b.result, c.result], cached: [a.cached === true, b.cached === true, c.cached === true] };
				`,
			resumeFrom: runId,
		});

		expect(resumedPrompts).toEqual(["second", "third"]);
		const details = result.details as { result: unknown };
		expect(details.result).toEqual({
			values: ["child:first", "resumed:second", "resumed:third"],
			cached: [true, false, false],
		});

		const executed = fs.readFileSync(executions, "utf8").trim().split("\n");
		expect(executed.filter(prompt => prompt === "first")).toHaveLength(1);
		expect(executed.filter(prompt => prompt === "second")).toHaveLength(2);
		expect(executed.filter(prompt => prompt === "third")).toHaveLength(1);
	}, 25_000);
});

function journalLinearRunId(dir: string): string {
	const lines = journalLines(dir);
	const runId = lines[0]?.runId;
	if (typeof runId !== "string") throw new Error("journal has no runId");
	return runId;
}
