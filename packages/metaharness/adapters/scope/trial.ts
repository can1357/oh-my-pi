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

/** Session settings shared by every run of an arm. */
export interface TrialConfig {
	model: string;
	thinking: ConfiguredThinkingLevel | undefined;
	/** Text appended to the system prompt. */
	appendSystemPrompt: string | undefined;
	/** Handlebars text replacing the system prompt template. */
	systemPromptTemplate: string | undefined;
	timeoutMs: number;
	/** Job directory; the run's trace lands in `traces/`. */
	jobDir: string;
}

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

	const calls: ToolCallRecord[] = [];
	const running = new Map<string, { call: ToolCallRecord; start: number }>();
	const intervals: Array<[number, number]> = [];
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
				const call: ToolCallRecord = { name: event.toolName, args: event.args, ms: 0 };
				calls.push(call);
				running.set(event.toolCallId, { call, start: t });
				record({ type: event.type, t, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
			} else if (event.type === "tool_execution_end") {
				const entry = running.get(event.toolCallId);
				if (entry) {
					entry.call.ms = t - entry.start;
					intervals.push([entry.start, t]);
					running.delete(event.toolCallId);
				}
				record({ type: event.type, t, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
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
	const outOfScope = changed.filter(file => !task.scope.some(glob => new Bun.Glob(glob).match(file)));
	const analysis = analyzeCalls(calls, {
		allowedChecks: task.allowedChecks.map(source => new RegExp(source)),
		// The agent names files relative to its cwd (`src/x.ts`, `../lib/x.ts`) or absolutely; both contain this form.
		paths: files.map(file => path.relative(task.cwd, file).replace(/^(?:\.\.\/)+/, "")),
	});
	const failures = error === null ? await verify(task.verify, root, [...after.keys()], answer) : [];
	if (outOfScope.length > 0) failures.push(`changed outside scope: ${outOfScope.join(", ")}`);
	return {
		task: task.id,
		attempt,
		pass: error === null && failures.length === 0,
		error,
		failures,
		wallMs: Math.round(wallMs),
		modelMs: Math.round(modelMs),
		toolMs: Math.round(busyMs(intervals)),
		turns,
		toolCalls: calls.length,
		checks: analysis.checks,
		postEditReads: analysis.postEditReads,
		changed,
		outOfScope,
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
