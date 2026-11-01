import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import {
	disposeAllVmContexts,
	disposeVmContextsByOwner,
	type JsEvalWorkerHandle,
	setJsEvalWorkerFactoriesForTests,
} from "../../src/eval/js/context-manager";
import type { WorkerOutbound } from "../../src/eval/js/worker-protocol";
import { executeJs } from "../../src/eval/js/executor";
import { getEvalState } from "../../src/eval/state";
import { setSupersededKernelGraceMs } from "../../src/eval/superseded-reclaim";
import { AgentOutputManager } from "../../src/task/output-manager";
import type { ToolSession } from "../../src/tools";

/**
 * A JavaScript eval worker runs in a subprocess of its own, and an owner's
 * disposal promises that the processes that owner was using are down when it
 * returns. Sending `SIGKILL` is not that: the signal is delivered at once, but
 * the process exits, and is reaped, afterwards. A disposal that returns on the
 * signal returns while the process is still in the process table — measured
 * as `R` at return after waits of 974 and 994 ms.
 *
 * These tests run the real worker subprocess the production factory starts,
 * not a thread standing in for it, and read its state from `/proc`, so "gone"
 * means reaped by its parent. A pid is told from its reuse by its start time.
 */

const PROCESS_TESTS = process.platform === "linux";
// The reclaim is deliberately deferred, so the cases that watch one use a real
// timer shortened to milliseconds: it races a real subprocess, which no fake
// clock drives.
const TEST_GRACE_MS = 50;

/** A session shaped as the executor consumes it, with an eval-state bucket of its own. */
function makeSession(cwd: string, owner: string): ToolSession {
	const artifactsDir = path.join(cwd, "artifacts");
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "task.isolation.enabled": false }),
		asyncJobManager: new AsyncJobManager({}),
		taskDepth: 0,
		enableLsp: false,
		agentOutputManager: new AgentOutputManager(() => artifactsDir),
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => owner,
		getEvalSessionId: () => `eval:${cwd}`,
		getEvalKernelOwnerId: () => owner,
	};
}

interface ProcessIdentity {
	pid: number;
	/** Field 22 of `/proc/<pid>/stat`; a reused pid has another. */
	startTime: string;
}

/** The fields of `/proc/<pid>/stat` after the command name, or undefined once the pid is gone. */
async function statFields(pid: number): Promise<string[] | undefined> {
	try {
		const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
	} catch {
		return undefined;
	}
}

/** The process's `/proc` state letter, or `gone` once it has been reaped. */
async function processState(identity: ProcessIdentity): Promise<string> {
	const fields = await statFields(identity.pid);
	if (fields === undefined || fields[19] !== identity.startTime) return "gone";
	return fields[0] ?? "gone";
}

interface StartedWorker {
	identity: ProcessIdentity;
	session: ToolSession;
	output: string;
}

/** Run `code` in `cwd` for `owner`; the cell must print `worker-pid:<pid>`. */
async function runCell(cwd: string, owner: string, code: string): Promise<StartedWorker> {
	const session = makeSession(cwd, owner);
	const result = await executeJs(code, {
		cwd,
		sessionId: `js:cwd:${cwd}`,
		kernelOwnerId: owner,
		session,
		timeoutMs: 120_000,
	});
	if (result.exitCode !== 0) throw new Error(`cell failed: ${result.output}`);
	const pid = Number(/worker-pid:(\d+)/.exec(result.output)?.[1]);
	if (!Number.isInteger(pid)) throw new Error(`cell answered without a pid: ${result.output}`);
	// The production factory runs the cell in a subprocess; our own pid would
	// mean it fell back to a thread, which is not what these cases are about.
	expect(pid).not.toBe(process.pid);
	const fields = await statFields(pid);
	if (fields?.[19] === undefined) throw new Error(`worker ${pid} is already gone`);
	return { identity: { pid, startTime: fields[19] }, session, output: result.output };
}

const PID_CELL = "return 'worker-pid:' + process.pid;";

/** Resolves once teardown of the context `session` used has begun: the registry reported its worker dead. */
async function teardownStarted(session: ToolSession): Promise<void> {
	// Polled: the registry reports the state change to the session and to
	// nothing a test can await.
	while (getEvalState(session)?.runtimes.find(runtime => runtime.language === "js")?.alive !== false) {
		await Bun.sleep(5);
	}
}

/** Resolves once the process is gone. */
async function reaped(identity: ProcessIdentity): Promise<void> {
	// Polled: the reaped process is not ours, so there is no exit event to await.
	while ((await processState(identity)) !== "gone") await Bun.sleep(25);
}

describe.skipIf(!PROCESS_TESTS)("an owner's disposal and its JavaScript worker process", () => {
	const started: ProcessIdentity[] = [];

	afterEach(async () => {
		setSupersededKernelGraceMs();
		await disposeAllVmContexts();
		for (const identity of started.splice(0)) {
			if ((await processState(identity)) === "gone") continue;
			try {
				process.kill(identity.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	});

	it("returns only once the worker it closed has been reaped", async () => {
		using dir = TempDir.createSync("@js-exit-idle-");
		const owner = "agent-session:js-exit-idle";
		const { identity } = await runCell(dir.path(), owner, PID_CELL);
		started.push(identity);

		await disposeVmContextsByOwner(owner);
		expect(await processState(identity)).toBe("gone");
	}, 120_000);

	it("returns only once a worker that never answers the close request has been reaped", async () => {
		using dir = TempDir.createSync("@js-exit-stopped-");
		const owner = "agent-session:js-exit-stopped";
		const { identity } = await runCell(dir.path(), owner, PID_CELL);
		started.push(identity);
		// A stopped process answers nothing, so teardown falls through the close
		// handshake to the kill.
		process.kill(identity.pid, "SIGSTOP");

		await disposeVmContextsByOwner(owner);
		expect(await processState(identity)).toBe("gone");
	}, 120_000);

	it("returns only once the worker a reclaim it joined was closing has been reaped", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using firstDir = TempDir.createSync("@js-exit-join-a-");
		using secondDir = TempDir.createSync("@js-exit-join-b-");
		const owner = "agent-session:js-exit-join";
		const first = await runCell(firstDir.path(), owner, PID_CELL);
		started.push(first.identity);
		// Stopped, the left-behind worker keeps its reclaim inside teardown for
		// the whole close handshake, so the disposal below lands inside it.
		process.kill(first.identity.pid, "SIGSTOP");
		const second = await runCell(secondDir.path(), owner, PID_CELL);
		started.push(second.identity);
		await teardownStarted(first.session);

		await disposeVmContextsByOwner(owner);
		expect(await processState(first.identity)).toBe("gone");
		expect(await processState(second.identity)).toBe("gone");
	}, 120_000);

	it("tells the owner's next cell that the background threads its cells started ended with the reclaimed worker", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using firstDir = TempDir.createSync("@js-reclaim-threads-a-");
		using secondDir = TempDir.createSync("@js-reclaim-threads-b-");
		const owner = "agent-session:js-reclaim-threads";
		const script = path.join(firstDir.path(), "background.js");
		await Bun.write(script, "setInterval(() => {}, 1_000);\n");
		const first = await runCell(
			firstDir.path(),
			owner,
			[
				"const { Worker } = require('node:worker_threads');",
				`globalThis.__background = new Worker(${JSON.stringify(script)});`,
				"await new Promise(resolve => globalThis.__background.once('online', resolve));",
				"return 'worker-pid:' + process.pid;",
			].join("\n"),
		);
		started.push(first.identity);
		const second = await runCell(secondDir.path(), owner, PID_CELL);
		started.push(second.identity);
		// The process that held the background thread is gone, and with it the thread.
		await reaped(first.identity);

		const back = await runCell(firstDir.path(), owner, PID_CELL);
		started.push(back.identity);
		const notice = back.output.split("\n").find(line => line.startsWith("Kernel restarted:"));
		expect(notice).toContain(firstDir.path());
		expect(notice).toContain("background threads");
	}, 120_000);
});

/**
 * A worker that outlives its kill — a process stuck in uninterruptible I/O
 * survives `SIGKILL` until that I/O ends — cannot be confirmed down within
 * any bound, so the disposal that tried must not forget it. A real thread
 * stands in for the process here, because no portable test can hold a real
 * process in uninterruptible I/O; its handle reports the first kill
 * unconfirmed and leaves the thread running, as the operating system would.
 */
describe("a JavaScript worker whose exit a disposal could not confirm", () => {
	afterEach(() => {
		setSupersededKernelGraceMs();
	});

	it("is kept by the owner's disposal and ended by the process-wide disposal", async () => {
		const threads: { thread: Worker; hasExited: boolean; kills: number }[] = [];
		const spawn = (): JsEvalWorkerHandle => {
			const thread = new Worker(new URL("../../src/eval/js/worker-entry.ts", import.meta.url).href, {
				type: "module",
			});
			const exited = Promise.withResolvers<void>();
			const observed = { thread, hasExited: false, kills: 0 };
			thread.addEventListener("close", () => {
				observed.hasExited = true;
				exited.resolve();
			});
			threads.push(observed);
			return {
				mode: "worker",
				send: message => thread.postMessage(message),
				onMessage(handler) {
					const wrap = (event: MessageEvent): void => handler(event.data as WorkerOutbound);
					thread.addEventListener("message", wrap);
					return () => thread.removeEventListener("message", wrap);
				},
				onError(handler) {
					const onError = (event: ErrorEvent): void => handler(new Error(event.message || "worker error"));
					thread.addEventListener("error", onError);
					return () => thread.removeEventListener("error", onError);
				},
				// It never acknowledges the close request.
				close: async () => false,
				async terminate() {
					observed.kills += 1;
					if (observed.kills === 1) return false;
					thread.terminate();
					await exited.promise;
					return true;
				},
			};
		};
		const restore = setJsEvalWorkerFactoriesForTests({ spawnProcess: spawn, spawnWorker: spawn });
		try {
			using dir = TempDir.createSync("@js-unconfirmed-exit-");
			const owner = "agent-session:js-unconfirmed-exit";
			const result = await executeJs("return 1;", {
				cwd: dir.path(),
				sessionId: `js:cwd:${dir.path()}`,
				kernelOwnerId: owner,
				session: makeSession(dir.path(), owner),
				timeoutMs: 60_000,
			});
			expect(result.exitCode).toBe(0);

			await disposeVmContextsByOwner(owner);
			expect(threads[0]?.hasExited).toBe(false);

			await disposeAllVmContexts();
			expect(threads[0]?.hasExited).toBe(true);
		} finally {
			restore();
			await disposeAllVmContexts();
			for (const { thread } of threads) thread.terminate();
		}
	}, 60_000);
});
