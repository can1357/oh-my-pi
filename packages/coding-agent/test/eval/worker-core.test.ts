import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { shadowSnapshotDigest } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/eval/js/worker-core";
import type {
	SessionSnapshot,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import { postmortem } from "@oh-my-pi/pi-utils";

interface WorkerHarness {
	send(message: WorkerInbound): void;
	onMessage(handler: (message: WorkerOutbound) => void): () => void;
}

function createWorkerHarness(): WorkerHarness {
	const hostListeners = new Set<(message: WorkerOutbound) => void>();
	const workerListeners = new Set<(message: WorkerInbound) => void>();
	const transport: Transport = {
		send: message => {
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(message);
			});
		},
		onMessage: handler => {
			workerListeners.add(handler);
			return () => workerListeners.delete(handler);
		},
		close: () => {},
	};
	new WorkerCore(transport, {
		mode: "inline",
		interceptUnhandledRejections: postmortem.interceptUnhandledRejections,
	});
	return {
		send(message) {
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(message);
			});
		},
		onMessage(handler) {
			hostListeners.add(handler);
			return () => hostListeners.delete(handler);
		},
	};
}

function waitForMessage(
	harness: WorkerHarness,
	predicate: (message: WorkerOutbound) => boolean,
): Promise<WorkerOutbound> {
	const { promise, resolve } = Promise.withResolvers<WorkerOutbound>();
	let unsubscribe = (): void => {};
	unsubscribe = harness.onMessage(message => {
		if (!predicate(message)) return;
		unsubscribe();
		resolve(message);
	});
	return promise;
}

async function initializeWorker(harness: WorkerHarness, snapshot: SessionSnapshot): Promise<void> {
	const ready = waitForMessage(harness, message => message.type === "ready");
	harness.send({ type: "init", snapshot });
	expect((await ready).type).toBe("ready");
}

function installFatalCapture(): {
	fatal: unknown[];
	uninstall: () => void;
} {
	const fatal: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		fatal.push(reason);
	};
	const onUncaught = (err: Error): void => {
		fatal.push(err);
	};
	process.on("unhandledRejection", onUnhandled);
	process.on("uncaughtException", onUncaught);
	return {
		fatal,
		uninstall: () => {
			process.off("unhandledRejection", onUnhandled);
			process.off("uncaughtException", onUncaught);
		},
	};
}

describe("WorkerCore", () => {
	it("reports same-realm cwd conflicts through the worker protocol", async () => {
		const first = createWorkerHarness();
		const second = createWorkerHarness();
		const cwd = process.cwd();
		await initializeWorker(first, { cwd, sessionId: "same-realm-first", localRoots: {} });
		await initializeWorker(second, { cwd, sessionId: "same-realm-second", localRoots: {} });

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_core_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};
		try {
			first.send({
				type: "run",
				runId: "hold-first-runtime",
				code: "globalThis.__omp_worker_core_gate.entered(); await globalThis.__omp_worker_core_gate.wait;",
				filename: "[same-realm-first].js",
				snapshot: { cwd, sessionId: "same-realm-first", localRoots: {} },
			});
			await entered.promise;

			const result = waitForMessage(
				second,
				message => message.type === "result" && message.runId === "overlap-second-runtime",
			);
			second.send({
				type: "run",
				runId: "overlap-second-runtime",
				code: "1 + 1;",
				filename: "[same-realm-second].js",
				snapshot: { cwd, sessionId: "same-realm-second", localRoots: {} },
			});

			expect(await result).toMatchObject({
				type: "result",
				runId: "overlap-second-runtime",
				ok: false,
				error: { message: "Cannot run code while another same-realm JS runtime is running" },
			});
		} finally {
			gate.resolve();
			delete (globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_core_gate;
			first.send({ type: "close" });
			second.send({ type: "close" });
		}
	});

	it("re-init while a same-realm run is live does not crash the process", async () => {
		const first = createWorkerHarness();
		const second = createWorkerHarness();
		const cwd = process.cwd();
		await initializeWorker(first, { cwd, sessionId: "reinit-first", localRoots: {} });
		await initializeWorker(second, { cwd, sessionId: "reinit-second", localRoots: {} });

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_core_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};

		const { fatal, uninstall } = installFatalCapture();
		try {
			first.send({
				type: "run",
				runId: "hold-for-reinit",
				code: "globalThis.__omp_worker_core_gate.entered(); await globalThis.__omp_worker_core_gate.wait;",
				filename: "[reinit-first].js",
				snapshot: { cwd, sessionId: "reinit-first", localRoots: {} },
			});
			await entered.promise;

			// Re-init the second core while the first still owns the realm. Production
			// inline workers deliver this on a microtask; a setCwd throw here used to
			// become a process-fatal unhandledRejection / uncaughtException.
			const reinit = waitForMessage(second, message => message.type === "ready" || message.type === "init-failed");
			second.send({ type: "init", snapshot: { cwd, sessionId: "reinit-second", localRoots: {} } });
			const reply = await reinit;
			expect(reply.type).toBe("ready");

			// Concurrent run still fails at the exclusive run boundary, via protocol.
			const result = waitForMessage(
				second,
				message => message.type === "result" && message.runId === "overlap-after-reinit",
			);
			second.send({
				type: "run",
				runId: "overlap-after-reinit",
				code: "1 + 1;",
				filename: "[reinit-second].js",
				snapshot: { cwd, sessionId: "reinit-second", localRoots: {} },
			});
			expect(await result).toMatchObject({
				type: "result",
				runId: "overlap-after-reinit",
				ok: false,
				error: { message: "Cannot run code while another same-realm JS runtime is running" },
			});

			// Drain microtasks so a latent fatal would surface.
			await Bun.sleep(0);
			expect(fatal).toEqual([]);
		} finally {
			uninstall();
			gate.resolve();
			delete (globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_core_gate;
			first.send({ type: "close" });
			second.send({ type: "close" });
		}
	});

	it("concurrent inits under a live same-realm run stay process-safe", async () => {
		const first = createWorkerHarness();
		const second = createWorkerHarness();
		const third = createWorkerHarness();
		const cwd = process.cwd();
		await initializeWorker(first, { cwd, sessionId: "init-live-first", localRoots: {} });
		await initializeWorker(second, { cwd, sessionId: "init-live-second", localRoots: {} });
		await initializeWorker(third, { cwd, sessionId: "init-live-third", localRoots: {} });

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_core_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};

		const { fatal, uninstall } = installFatalCapture();
		try {
			first.send({
				type: "run",
				runId: "hold-for-multi-init",
				code: "globalThis.__omp_worker_core_gate.entered(); await globalThis.__omp_worker_core_gate.wait;",
				filename: "[init-live-first].js",
				snapshot: { cwd, sessionId: "init-live-first", localRoots: {} },
			});
			await entered.promise;

			const readySecond = waitForMessage(
				second,
				message => message.type === "ready" || message.type === "init-failed",
			);
			const readyThird = waitForMessage(
				third,
				message => message.type === "ready" || message.type === "init-failed",
			);
			second.send({ type: "init", snapshot: { cwd, sessionId: "init-live-second", localRoots: {} } });
			third.send({ type: "init", snapshot: { cwd, sessionId: "init-live-third", localRoots: {} } });
			expect((await readySecond).type).toBe("ready");
			expect((await readyThird).type).toBe("ready");

			const resultSecond = waitForMessage(
				second,
				message => message.type === "result" && message.runId === "overlap-second",
			);
			const resultThird = waitForMessage(
				third,
				message => message.type === "result" && message.runId === "overlap-third",
			);
			second.send({
				type: "run",
				runId: "overlap-second",
				code: "2",
				filename: "[init-live-second].js",
				snapshot: { cwd, sessionId: "init-live-second", localRoots: {} },
			});
			third.send({
				type: "run",
				runId: "overlap-third",
				code: "3",
				filename: "[init-live-third].js",
				snapshot: { cwd, sessionId: "init-live-third", localRoots: {} },
			});
			expect(await resultSecond).toMatchObject({
				type: "result",
				runId: "overlap-second",
				ok: false,
				error: { message: "Cannot run code while another same-realm JS runtime is running" },
			});
			expect(await resultThird).toMatchObject({
				type: "result",
				runId: "overlap-third",
				ok: false,
				error: { message: "Cannot run code while another same-realm JS runtime is running" },
			});

			await Bun.sleep(0);
			expect(fatal).toEqual([]);
		} finally {
			uninstall();
			gate.resolve();
			delete (globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_core_gate;
			first.send({ type: "close" });
			second.send({ type: "close" });
			third.send({ type: "close" });
		}
	});

	it("first init while a same-realm run is live fails via init-failed and recovers", async () => {
		const first = createWorkerHarness();
		const second = createWorkerHarness(); // never initialized: no runtime exists yet
		const cwd = process.cwd();
		await initializeWorker(first, { cwd, sessionId: "first-init-live-first", localRoots: {} });

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_core_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};

		const { fatal, uninstall } = installFatalCapture();
		try {
			const firstText = waitForMessage(
				first,
				message => message.type === "text" && message.runId === "hold-for-first-init",
			);
			const firstResult = waitForMessage(
				first,
				message => message.type === "result" && message.runId === "hold-for-first-init",
			);
			first.send({
				type: "run",
				runId: "hold-for-first-init",
				code: "globalThis.__omp_worker_core_gate.entered(); await globalThis.__omp_worker_core_gate.wait; __omp_session__.sessionId;",
				filename: "[first-init-live-first].js",
				snapshot: { cwd, sessionId: "first-init-live-first", localRoots: {} },
			});
			await entered.promise;

			// A fresh runtime's install would Object.assign over the live runtime's
			// globals mid-run; it must fail via the protocol instead.
			const reply = waitForMessage(second, message => message.type === "ready" || message.type === "init-failed");
			second.send({ type: "init", snapshot: { cwd, sessionId: "first-init-live-second", localRoots: {} } });
			expect(await reply).toMatchObject({
				type: "init-failed",
				error: { message: "Cannot initialize a JS runtime while another same-realm JS runtime is running" },
			});

			// The held run's globals were not clobbered: it still resolves its own
			// session bag and completes cleanly.
			gate.resolve();
			expect(await firstText).toMatchObject({
				type: "text",
				runId: "hold-for-first-init",
				chunk: "first-init-live-first\n",
			});
			expect(await firstResult).toMatchObject({ type: "result", runId: "hold-for-first-init", ok: true });

			// Once the realm is free, the same core initializes cleanly.
			await initializeWorker(second, { cwd, sessionId: "first-init-live-second", localRoots: {} });

			// Drain the microtask queue so any latent fatal would surface.
			for (let i = 0; i < 8; i++) await Promise.resolve();
			expect(fatal).toEqual([]);
		} finally {
			uninstall();
			gate.resolve();
			delete (globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_core_gate;
			first.send({ type: "close" });
			second.send({ type: "close" });
		}
	});

	it("keeps the process cwd while another cell is mid-run", async () => {
		const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cwd-a-"));
		const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cwd-b-"));
		const chdirs: string[] = [];
		const hostListeners = new Set<(message: WorkerOutbound) => void>();
		const workerListeners = new Set<(message: WorkerInbound) => void>();
		const transport: Transport = {
			send: message => {
				queueMicrotask(() => {
					for (const listener of hostListeners) listener(message);
				});
			},
			onMessage: handler => {
				workerListeners.add(handler);
				return () => workerListeners.delete(handler);
			},
			close: () => {},
		};
		new WorkerCore(transport, { mode: "isolated", chdir: cwd => chdirs.push(cwd) });
		const harness: WorkerHarness = {
			send(message) {
				queueMicrotask(() => {
					for (const listener of workerListeners) listener(message);
				});
			},
			onMessage(handler) {
				hostListeners.add(handler);
				return () => hostListeners.delete(handler);
			},
		};

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_cwd_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_cwd_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};
		try {
			await initializeWorker(harness, { cwd: dirA, sessionId: "cwd-race", localRoots: {} });
			expect(chdirs).toEqual([dirA]);

			const holdResult = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "cwd-hold",
			);
			harness.send({
				type: "run",
				runId: "cwd-hold",
				code: "globalThis.__omp_worker_cwd_gate.entered(); await globalThis.__omp_worker_cwd_gate.wait;",
				filename: "[cwd-race-hold].js",
				snapshot: { cwd: dirA, sessionId: "cwd-race", localRoots: {} },
			});
			await entered.promise;

			// A second cell with a different cwd while the first is suspended must
			// not move the realm-wide process cwd out from under the live cell.
			const skipLog = waitForMessage(
				harness,
				message => message.type === "log" && message.msg.includes("kept its process cwd"),
			);
			const overlapResult = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "cwd-overlap",
			);
			harness.send({
				type: "run",
				runId: "cwd-overlap",
				code: "1 + 1;",
				filename: "[cwd-race-overlap].js",
				snapshot: { cwd: dirB, sessionId: "cwd-race", localRoots: {} },
			});
			expect(await overlapResult).toMatchObject({ type: "result", runId: "cwd-overlap", ok: true });
			expect(chdirs).not.toContain(dirB);
			await skipLog;

			gate.resolve();
			expect(await holdResult).toMatchObject({ type: "result", runId: "cwd-hold", ok: true });

			// With the realm quiet again, the next cell lands the deferred move.
			const soloResult = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "cwd-solo",
			);
			harness.send({
				type: "run",
				runId: "cwd-solo",
				code: "2 + 2;",
				filename: "[cwd-race-solo].js",
				snapshot: { cwd: dirB, sessionId: "cwd-race", localRoots: {} },
			});
			expect(await soloResult).toMatchObject({ type: "result", runId: "cwd-solo", ok: true });
			expect(chdirs.at(-1)).toBe(dirB);
		} finally {
			gate.resolve();
			delete (globalThis as { __omp_worker_cwd_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_cwd_gate;
			harness.send({ type: "close" });
			await fs.rm(dirA, { recursive: true, force: true });
			await fs.rm(dirB, { recursive: true, force: true });
		}
	});

	it("survives concurrent same-realm setCwd in a child process with postmortem loaded", async () => {
		// Process-level oracle: the production crash was postmortem killing the process
		// after an unhandled rejection from concurrent inline setCwd. This must stay green
		// even when postmortem's fatal handlers are installed.
		const postmortemUrl = pathToFileURL(path.resolve(import.meta.dir, "../../../utils/src/postmortem.ts")).href;
		const runtimeUrl = pathToFileURL(path.resolve(import.meta.dir, "../../src/eval/js/shared/runtime.ts")).href;

		const probe = `import { pathToFileURL } from "node:url";

await import(${JSON.stringify(postmortemUrl)});
const { JsRuntime } = await import(${JSON.stringify(runtimeUrl)});

const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "child-first" });
const second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "child-second" });
const gate = Promise.withResolvers();
const entered = Promise.withResolvers();

const hooks = {
	onText() {},
	onDisplay() {},
	callTool: async () => undefined,
};

second.setRunScope({ gate: gate.promise, entered: () => entered.resolve() });
const hold = second.run("entered(); await gate;", "[child-second].js", hooks);
await entered.promise;

// Historical crash path: concurrent setCwd while another same-realm runtime is live.
first.setCwd(process.cwd() + "/child-pending");
second.setCwd(process.cwd());

// Microtask delivery must not become process-fatal either.
queueMicrotask(() => {
	first.setCwd(process.cwd() + "/child-pending-2");
});
await Promise.resolve();
await Bun.sleep(0);

gate.resolve();
await hold;
first.dispose();
second.dispose();
console.log("survived concurrent setCwd");
process.exit(0);
`;

		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-same-realm-"));
		const probePath = path.join(root, "probe.ts");
		try {
			await Bun.write(probePath, probe);
			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
			});
			// Real process liveness cannot use fake timers. Bound a wedged child, but
			// clear the watchdog on the normal path so it never becomes a fixed wait.
			const watchdog = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
			}, 5000);
			try {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				expect(exitCode).toBe(0);
				expect(stdout).toContain("survived concurrent setCwd");
				expect(stderr).not.toContain("[Unhandled Rejection]");
				expect(stderr).not.toContain("[Uncaught Exception]");
				expect(stderr).not.toContain("another same-realm JS runtime is running");
			} finally {
				clearTimeout(watchdog);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("returns a safe snapshot only while the JavaScript runtime is idle", async () => {
		const harness = createWorkerHarness();
		const snapshot = { cwd: process.cwd(), sessionId: "shadow-snapshot-worker" };
		await initializeWorker(harness, snapshot);
		const reply = waitForMessage(
			harness,
			message => message.type === "shadow-snapshot" && message.id === "snapshot-1",
		);
		harness.send({ type: "shadow-snapshot", id: "snapshot-1", snapshot });
		const message = await reply;
		if (message.type !== "shadow-snapshot") throw new Error("expected shadow snapshot reply");
		expect(message.eligible).toBe(true);
		expect(message.snapshot?.revision).toBe(0);
	});

	it("starts a real cell only when the retained snapshot still matches", async () => {
		const harness = createWorkerHarness();
		const snapshot = { cwd: process.cwd(), sessionId: "atomic-shadow-worker" };
		await initializeWorker(harness, snapshot);
		const snapshotReply = waitForMessage(
			harness,
			message => message.type === "shadow-snapshot" && message.id === "atomic-snapshot",
		);
		harness.send({ type: "shadow-snapshot", id: "atomic-snapshot", snapshot });
		const captured = await snapshotReply;
		if (captured.type !== "shadow-snapshot" || !captured.snapshot) throw new Error("expected snapshot");
		const admission = waitForMessage(
			harness,
			message => message.type === "shadow-run" && message.id === "atomic-run",
		);
		const result = waitForMessage(harness, message => message.type === "result" && message.runId === "atomic-run-id");
		harness.send({
			type: "run-if-snapshot-matches",
			id: "atomic-run",
			runId: "atomic-run-id",
			code: "globalThis.atomicShadowValue = true;",
			filename: "atomic-shadow.ts",
			snapshot,
			expectedRevision: captured.snapshot.revision,
			expectedDigest: shadowSnapshotDigest(captured.snapshot),
		});
		await expect(admission).resolves.toMatchObject({ eligible: true });
		await expect(result).resolves.toMatchObject({ ok: true });
	});

	it("rejects an atomic run after retained state changes", async () => {
		const harness = createWorkerHarness();
		const snapshot = { cwd: process.cwd(), sessionId: "atomic-shadow-mismatch" };
		await initializeWorker(harness, snapshot);
		const capturedReply = waitForMessage(
			harness,
			message => message.type === "shadow-snapshot" && message.id === "mismatch-snapshot",
		);
		harness.send({ type: "shadow-snapshot", id: "mismatch-snapshot", snapshot });
		const captured = await capturedReply;
		if (captured.type !== "shadow-snapshot" || !captured.snapshot) throw new Error("expected snapshot");
		const mutationResult = waitForMessage(
			harness,
			message => message.type === "result" && message.runId === "mutation",
		);
		harness.send({
			type: "run",
			runId: "mutation",
			code: "globalThis.atomicMismatch = true;",
			filename: "mutation.ts",
			snapshot,
		});
		await mutationResult;
		const rejected = waitForMessage(
			harness,
			message => message.type === "shadow-run" && message.id === "mismatch-run",
		);
		harness.send({
			type: "run-if-snapshot-matches",
			id: "mismatch-run",
			runId: "should-not-run",
			code: "throw new Error('must not execute');",
			filename: "mismatch.ts",
			snapshot,
			expectedRevision: captured.snapshot.revision,
			expectedDigest: shadowSnapshotDigest(captured.snapshot),
		});
		await expect(rejected).resolves.toMatchObject({ eligible: false, reason: "snapshot changed" });
	});
});
