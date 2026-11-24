/**
 * One scope-benchmark run: copy a task's fixture into a fresh temp workspace, drive an
 * in-process omp session (default tools, no user skills/rules/context files/extensions) on
 * the task prompt, then measure where the wall time went and verify the outcome.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	AgentRegistry,
	type AgentSession,
	createAgentSession,
	SessionManager,
	type SessionStats,
} from "@oh-my-pi/pi-coding-agent";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/utils/render-utils";
import { isEnoent, logger, TempDir } from "@oh-my-pi/pi-utils";
import type { SharedInfra } from "@oh-my-pi/typescript-edit-benchmark/in-process-client";
import { analyzeCalls, type ToolCallRecord } from "./checks";
import type { ScopeRun } from "./result";
import type { ScopeTask, VerifySpec } from "./tasks";

/** A literal `find` → `replace` substitution on the rendered system prompt. */
export type PromptRewrite = readonly [find: string, replace: string];

/** Session settings shared by every run of an arm. */
export interface TrialConfig {
	model: string;
	thinking: ConfiguredThinkingLevel | undefined;
	/** Text appended to the system prompt. */
	appendSystemPrompt: string | undefined;
	/** Handlebars text replacing the system prompt template. */
	systemPromptTemplate: string | undefined;
	/** Substitutions applied, in order, to every rendered prompt block (template, project block, appended text). */
	rewrites: readonly PromptRewrite[];
	timeoutMs: number;
	/** Job directory; the run's trace lands in `traces/`. */
	jobDir: string;
}

/** Prefix of the failure line {@link score} adds; {@link rescoreRun} replaces it. */
const SCOPE_FAILURE = "changed outside scope: ";
const VERIFY_TIMEOUT_MS = 120_000;
/** Tool installs and harness state, not the agent's edits. */
const IGNORED_DIRS = ["node_modules/", ".git/", ".omp/"];

/** Content hash per workspace-relative file. */
async function snapshot(root: string): Promise<Map<string, number | bigint>> {
	const files = new Map<string, number | bigint>();
	for await (const file of new Bun.Glob("**/*").scan({ cwd: root, dot: true, onlyFiles: true })) {
		if (IGNORED_DIRS.some(dir => file.startsWith(dir) || file.includes(`/${dir}`))) continue;
		files.set(file, Bun.hash(await fs.readFile(path.join(root, file))));
	}
	return files;
}

/**
 * Applies `rewrites` to every block of the rendered system prompt.
 * @throws when a `find` occurs in no block: the prompt moved on and the arm would silently equal its baseline.
 */
function rewritePrompt(blocks: string[], rewrites: readonly PromptRewrite[]): string[] {
	let rewritten = blocks;
	for (const [find, replace] of rewrites) {
		if (!rewritten.some(block => block.includes(find))) {
			throw new Error(`rewrite target is not in the system prompt: ${find.trim().slice(0, 80)}`);
		}
		rewritten = rewritten.map(block => block.replaceAll(find, replace));
	}
	return rewritten;
}

/** Pairs tool start/end events into timed {@link ToolCallRecord}s, live or replayed from a trace. */
class CallTimeline {
	readonly calls: ToolCallRecord[] = [];
	readonly intervals: Array<[number, number]> = [];
	#running = new Map<string, { call: ToolCallRecord; start: number }>();

	start(id: string, name: string, args: unknown, t: number): void {
		const call: ToolCallRecord = { name, args, ms: 0 };
		this.calls.push(call);
		this.#running.set(id, { call, start: t });
	}

	end(id: string, t: number): void {
		const entry = this.#running.get(id);
		if (!entry) return;
		entry.call.ms = t - entry.start;
		this.intervals.push([entry.start, t]);
		this.#running.delete(id);
	}
}

/** A tool start/end line of a run trace (`traces/<task>__<n>.txt`). */
interface TraceToolEvent {
	type: "tool_execution_start" | "tool_execution_end";
	t: number;
	toolCallId: string;
	toolName: string;
	args?: unknown;
}

function isTraceToolEvent(value: unknown): value is TraceToolEvent {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		(value.type === "tool_execution_start" || value.type === "tool_execution_end") &&
		"t" in value &&
		typeof value.t === "number" &&
		"toolCallId" in value &&
		typeof value.toolCallId === "string" &&
		"toolName" in value &&
		typeof value.toolName === "string"
	);
}

/** Run fields derived from tool calls, file changes, and verifier results under a task's spec. */
type Score = Pick<ScopeRun, "pass" | "failures" | "checks" | "postEditReads" | "outOfScope">;

function score(
	task: ScopeTask,
	run: {
		calls: readonly ToolCallRecord[];
		/** Every workspace-relative file before or after the run. */
		files: readonly string[];
		changed: readonly string[];
		error: string | null;
		verifyFailures: readonly string[];
	},
): Score {
	const outOfScope = run.changed.filter(file => !task.scope.some(glob => new Bun.Glob(glob).match(file)));
	const analysis = analyzeCalls(run.calls, {
		allowedChecks: task.allowedChecks.map(source => new RegExp(source)),
		// The agent names files relative to its cwd (`src/x.ts`, `../lib/x.ts`) or absolutely; both contain this form.
		paths: run.files.map(file => path.relative(task.cwd, file).replace(/^(?:\.\.\/)+/, "")),
	});
	const failures =
		outOfScope.length > 0
			? [...run.verifyFailures, `${SCOPE_FAILURE}${outOfScope.join(", ")}`]
			: [...run.verifyFailures];
	return {
		pass: run.error === null && failures.length === 0,
		failures,
		checks: analysis.checks,
		postEditReads: analysis.postEditReads,
		outOfScope,
	};
}

/**
 * Re-derives a recorded run's checks, post-edit reads, scope, and pass under `task`'s current
 * spec and classifier by replaying the tool calls in its trace. Verifier results are kept as
 * recorded: the workspace is gone.
 */
export async function rescoreRun(run: ScopeRun, task: ScopeTask, jobDir: string): Promise<ScopeRun> {
	const timeline = new CallTimeline();
	for (const event of Bun.JSONL.parse(await Bun.file(path.join(jobDir, run.trace)).text())) {
		if (!isTraceToolEvent(event)) continue;
		if (event.type === "tool_execution_start") timeline.start(event.toolCallId, event.toolName, event.args, event.t);
		else timeline.end(event.toolCallId, event.t);
	}
	const fixture = (await snapshot(task.repoDir)).keys();
	return {
		...run,
		...score(task, {
			calls: timeline.calls,
			files: [...new Set([...fixture, ...run.changed])],
			changed: run.changed,
			error: run.error,
			verifyFailures: run.failures.filter(failure => !failure.startsWith(SCOPE_FAILURE)),
		}),
	};
}

/** Total length of the union of `[start, end]` intervals: parallel tool calls count once. */
function busyMs(intervals: ReadonlyArray<readonly [number, number]>): number {
	let total = 0;
	let reached = Number.NEGATIVE_INFINITY;
	for (const [start, end] of intervals.toSorted((a, b) => a[0] - b[0])) {
		if (end <= reached) continue;
		total += end - Math.max(start, reached);
		reached = end;
	}
	return total;
}

/** Verifier misses for the finished workspace and the agent's final reply. */
async function verify(spec: VerifySpec, root: string, files: readonly string[], answer: string): Promise<string[]> {
	const failures: string[] = [];
	const expected = spec.files ?? {};
	for (const file in expected) {
		let text: string;
		try {
			text = await Bun.file(path.join(root, file)).text();
		} catch (err) {
			if (!isEnoent(err)) throw err;
			failures.push(`${file} is missing`);
			continue;
		}
		for (const pattern of expected[file]) {
			if (!new RegExp(pattern).test(text)) failures.push(`${file} lacks /${pattern}/`);
		}
	}
	const absent = (spec.absent ?? []).map(pattern => new RegExp(pattern));
	if (absent.length > 0) {
		for (const file of files) {
			const text = await Bun.file(path.join(root, file)).text();
			for (const pattern of absent) if (pattern.test(text)) failures.push(`${file} still matches ${pattern}`);
		}
	}
	for (const command of spec.commands ?? []) {
		const proc = Bun.spawn(command.argv, {
			cwd: path.join(root, command.cwd ?? "."),
			stdout: "pipe",
			stderr: "pipe",
			timeout: VERIFY_TIMEOUT_MS,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const shown = `\`${command.argv.join(" ")}\``;
		if (exitCode !== 0) {
			const last = `${stdout}\n${stderr}`.trim().split("\n").at(-1) ?? "";
			failures.push(`${shown} exited ${exitCode}: ${last.slice(0, 160)}`);
		} else if (command.stdout !== undefined && !new RegExp(command.stdout).test(stdout)) {
			failures.push(`${shown} printed no /${command.stdout}/`);
		}
	}
	for (const pattern of spec.answer ?? []) {
		if (!new RegExp(pattern, "i").test(answer)) failures.push(`answer lacks /${pattern}/`);
	}
	return failures;
}

/**
 * Runs attempt `attempt` of `task` and returns its measurements.
 * Provider failures and timeouts land in {@link ScopeRun.error}; only harness bugs (an
 * unreadable fixture, an unwritable job dir) throw.
 */
export async function runTrial(
	task: ScopeTask,
	attempt: number,
	config: TrialConfig,
	shared: SharedInfra,
): Promise<ScopeRun> {
	await using workspace = await TempDir.create("@metaharness-scope-");
	const root = workspace.path();
	await fs.cp(task.repoDir, root, { recursive: true });
	const before = await snapshot(root);
	const cwd = path.join(root, task.cwd);

	const trace = path.join("traces", `${task.id}__${attempt}.txt`);
	const sink = Bun.file(path.join(config.jobDir, trace)).writer();
	const record = (event: object) => sink.write(`${JSON.stringify(event)}\n`);
	record({ type: "prompt", cwd: task.cwd, text: task.prompt });

	const timeline = new CallTimeline();
	let modelMs = 0;
	let turns = 0;
	let error: string | null = null;
	let answer = "";
	let stats: SessionStats | undefined;
	let promptStart = performance.now();
	let wallMs = 0;
	let session: AgentSession | undefined;
	try {
		({ session } = await createAgentSession({
			cwd,
			modelPattern: config.model,
			disableModelFallback: true,
			thinkingLevel: config.thinking,
			appendSystemPrompt: config.appendSystemPrompt,
			systemPromptTemplate: config.systemPromptTemplate,
			systemPrompt: config.rewrites.length > 0 ? blocks => rewritePrompt(blocks, config.rewrites) : undefined,
			authStorage: shared.authStorage,
			modelRegistry: shared.modelRegistry,
			sessionManager: SessionManager.inMemory(cwd),
			// Concurrent top-level sessions in one process each need their own registry.
			agentRegistry: new AgentRegistry(),
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			rules: [],
			contextFiles: [],
			disableExtensionDiscovery: true,
		}));
		session.subscribe(event => {
			const t = Math.round(performance.now() - promptStart);
			if (event.type === "tool_execution_start") {
				timeline.start(event.toolCallId, event.toolName, event.args, t);
				record({ type: event.type, t, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
			} else if (event.type === "tool_execution_end") {
				timeline.end(event.toolCallId, t);
				record({
					type: event.type,
					t,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
				});
			} else if (event.type === "message_end") {
				if (event.message.role === "assistant") {
					turns++;
					modelMs += event.message.duration ?? 0;
				}
				record({ type: event.type, t, message: event.message });
			}
		});
		const active = session;
		const timer = setTimeout(() => {
			error = `timed out after ${config.timeoutMs / 1000}s`;
			active.abort().catch(err => logger.warn("scope benchmark: abort failed", { err }));
		}, config.timeoutMs);
		promptStart = performance.now();
		try {
			await session.prompt(task.prompt, { expandPromptTemplates: false });
			await session.waitForIdle();
		} finally {
			clearTimeout(timer);
			wallMs = performance.now() - promptStart;
		}
		answer = session.getLastAssistantText() ?? "";
		stats = session.getSessionStats();
	} catch (err) {
		error ??= err instanceof Error ? err.message : String(err);
	} finally {
		await session?.dispose();
		await sink.end();
	}

	const after = await snapshot(root);
	const files = [...new Set([...before.keys(), ...after.keys()])].sort();
	const changed = files.filter(file => before.get(file) !== after.get(file));
	// Hidden checks land only now: the agent never saw them, and they never count as its changes.
	if (task.hiddenDir) await fs.cp(task.hiddenDir, root, { recursive: true });
	const verifyFailures = error === null ? await verify(task.verify, root, [...after.keys()], answer) : [];
	return {
		task: task.id,
		attempt,
		error,
		...score(task, { calls: timeline.calls, files, changed, error, verifyFailures }),
		wallMs: Math.round(wallMs),
		modelMs: Math.round(modelMs),
		toolMs: Math.round(busyMs(timeline.intervals)),
		turns,
		toolCalls: timeline.calls.length,
		changed,
		tokens: {
			input: stats?.tokens.input ?? 0,
			output: stats?.tokens.output ?? 0,
			reasoning: stats?.tokens.reasoning ?? 0,
			cacheRead: stats?.tokens.cacheRead ?? 0,
		},
		costUsd: stats?.cost ?? 0,
		trace,
	};
}
