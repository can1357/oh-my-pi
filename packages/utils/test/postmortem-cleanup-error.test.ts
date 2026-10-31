import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { postmortem } from "@oh-my-pi/pi-utils";

const postmortemModuleUrl = pathToFileURL(join(import.meta.dir, "../src/index.ts")).href;

async function runPostmortemProbe(
	source: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const root = await mkdtemp(join(tmpdir(), "omp-postmortem-probe-"));
	const probePath = join(root, "probe.ts");
	try {
		await Bun.write(probePath, source);
		const proc = Bun.spawn([process.execPath, probePath], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, OMP_AGENT_DIR: join(root, "agent") },
		});
		// Process-level regressions can hang the child; the watchdog bounds the fixture without slowing
		// green runs (the race resolves on exit). Generous deadline: a cold bun spawn transpiling the
		// pi-utils module graph can take multiple seconds on a loaded parallel CI runner (observed >2s).
		const watchdog = Bun.sleep(15_000).then(() => {
			proc.kill();
			return -999;
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			Promise.race([proc.exited, watchdog]),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function wrapCause(reason: Error, wrapperCount: number): Error {
	let current = reason;
	for (let index = 0; index < wrapperCount; index++) {
		current = new Error(`wrapper ${index}`, { cause: current });
	}
	return current;
}

describe("postmortem expected cleanup errors", () => {
	it("marks errors with the well-known cleanup symbol and recognizes them", () => {
		const reason = new Error("browser run ended");

		const marked = postmortem.markExpectedCleanupError(reason);

		expect(marked).toBe(reason);
		expect(Reflect.get(reason, Symbol.for("omp.expectedCleanupError"))).toBe(true);
		expect(postmortem.isExpectedCleanupError(reason)).toBe(true);
	});

	it("recognizes marked cleanup errors through bounded cause chains", () => {
		const marked = postmortem.markExpectedCleanupError(new Error("browser run ended"));
		const withinLimit = wrapCause(marked, 7);
		const beyondLimit = wrapCause(marked, 8);

		expect(postmortem.isExpectedCleanupError(withinLimit)).toBe(true);
		expect(postmortem.isExpectedCleanupError(beyondLimit)).toBe(false);
	});

	it("requires an explicit cleanup marker for aborts and closed sockets", () => {
		const abort = new DOMException("operation aborted", "AbortError");
		const closedSocket = Object.assign(new Error("Socket is closed"), { code: "ERR_SOCKET_CLOSED" });

		expect(postmortem.isExpectedCleanupError(abort)).toBe(false);
		expect(postmortem.isExpectedCleanupError(new Error("request failed", { cause: closedSocket }))).toBe(false);
		expect(postmortem.isExpectedCleanupError(postmortem.markExpectedCleanupError(abort))).toBe(true);
		expect(
			postmortem.isExpectedCleanupError(
				new Error("request failed", { cause: postmortem.markExpectedCleanupError(closedSocket) }),
			),
		).toBe(true);
		expect(postmortem.isExpectedCleanupError(new Error("Socket is closed"))).toBe(false);
	});

	it("lets the process survive an unhandled rejection whose cause chain is marked", async () => {
		const result = await runPostmortemProbe(`
			import { postmortem } from "${postmortemModuleUrl}";

			const marked = postmortem.markExpectedCleanupError(new Error("browser run ended"));
			Promise.reject(new Error("abort wrapper", { cause: marked }));
			await Promise.resolve();
			console.log("survived expected cleanup rejection");
		`);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("survived expected cleanup rejection");
		expect(result.stderr).not.toContain("[Unhandled Rejection]");
	});

	it("keeps an unmarked unhandled AbortError fatal", async () => {
		const result = await runPostmortemProbe(`
			import "${postmortemModuleUrl}";

			Promise.reject(new DOMException("unexpected abort rejection", "AbortError"));
			await Promise.resolve();
		`);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("[Unhandled Rejection] AbortError: unexpected abort rejection");
	});

	it("keeps an unmarked ERR_SOCKET_CLOSED rejection fatal", async () => {
		const result = await runPostmortemProbe(`
			import "${postmortemModuleUrl}";

			Promise.reject(Object.assign(new Error("unexpected socket rejection"), { code: "ERR_SOCKET_CLOSED" }));
			await Promise.resolve();
		`);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("[Unhandled Rejection] Error: unexpected socket rejection");
	});

	it("lets the process survive an uncaught exception that is marked as expected cleanup", async () => {
		const result = await runPostmortemProbe(`
			import { postmortem } from "${postmortemModuleUrl}";

			queueMicrotask(() => {
				throw postmortem.markExpectedCleanupError(new Error("expected cleanup exception"));
			});
			await Promise.resolve();
			console.log("survived expected cleanup exception");
		`);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("survived expected cleanup exception");
		expect(result.stderr).not.toContain("[Uncaught Exception]");
	});

	it("keeps a synchronously thrown unmarked AbortError fatal", async () => {
		const result = await runPostmortemProbe(`
			import "${postmortemModuleUrl}";

			queueMicrotask(() => {
				throw new DOMException("unexpected abort exception", "AbortError");
			});
			await Promise.resolve();
		`);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("[Uncaught Exception] AbortError: unexpected abort exception");
	});

	it("keeps unmarked uncaught exceptions fatal", async () => {
		const result = await runPostmortemProbe(`
			import "${postmortemModuleUrl}";

			queueMicrotask(() => {
				throw new Error("unexpected cleanup exception");
			});
			await Promise.resolve();
		`);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("[Uncaught Exception] Error: unexpected cleanup exception");
	});

	it("prints recovery commands for a session that fatal cleanup saved", async () => {
		// Teardown can save a session (an unsent draft, an aborted first reply) and then
		// unregister its hint, so the hint is read after cleanup from a snapshot.
		const result = await runPostmortemProbe(`
			import { postmortem } from "${postmortemModuleUrl}";

			let saved = false;
			const cancelHint = postmortem.registerFatalRecoveryHint(() =>
				saved ? { label: "Main", command: "omp --resume 019cafe0-dead-beef" } : undefined,
			);
			postmortem.register("session", async () => {
				await Promise.resolve();
				saved = true;
				cancelHint();
			});
			Promise.reject(new Error("session crashed"));
			await Promise.resolve();
		`);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("[Unhandled Rejection] Error: session crashed");
		expect(result.stderr).toContain("[Recovery]\n  Main: omp --resume 019cafe0-dead-beef");
	});

	it.skipIf(process.platform === "win32")(
		"prints recovery commands once when repeated SIGTERMs stop the process",
		async () => {
			const result = await runPostmortemProbe(`
			import { postmortem } from "${postmortemModuleUrl}";

			let saved = false;
			const cancelHint = postmortem.registerFatalRecoveryHint(() =>
				saved ? { label: "Main", command: "omp --resume 019cafe0-dead-beef" } : undefined,
			);
			postmortem.register("session", async () => {
				// postmortem's own SIGTERM listener runs first, so once this one fires the
				// repeated signal's handler has already joined the running cleanup.
				const repeated = Promise.withResolvers<void>();
				process.once("SIGTERM", () => repeated.resolve());
				process.kill(process.pid, "SIGTERM");
				await repeated.promise;
				saved = true;
				cancelHint();
			});
			// Keep-alive only: a real child process must stay open until its SIGTERM handler
			// exits it, and a fake clock cannot hold the event loop open.
			setInterval(() => {}, 60_000);
			process.kill(process.pid, "SIGTERM");
		`);

			expect(result.exitCode).toBe(143);
			expect(result.stderr).toContain("[Stopped by SIGTERM]\n[Recovery]\n  Main: omp --resume 019cafe0-dead-beef");
			expect(result.stderr.split("[Recovery]")).toHaveLength(2);
		},
	);

	it("exits after an uncaught exception when terminal stderr is revoked", async () => {
		const result = await runPostmortemProbe(`
			import { spyOn } from "bun:test";
			import "${postmortemModuleUrl}";

			spyOn(process.stderr, "write").mockImplementation(() => {
				throw Object.assign(new Error("terminal revoked"), { code: "EIO" });
			});
			queueMicrotask(() => {
				throw new Error("fatal after disconnect");
			});
			await Promise.withResolvers<void>().promise;
		`);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("[Uncaught Exception] Error: fatal after disconnect");
	});

	it("releases manual cleanup at the deadline even when a callback never settles", async () => {
		const result = await runPostmortemProbe(`
			import { vi } from "bun:test";
			import { postmortem } from "${postmortemModuleUrl}";

			vi.useFakeTimers();
			postmortem.register("never-settles", () => Promise.withResolvers<void>().promise);

			let settled = false;
			const cleanup = postmortem.cleanup().then(() => {
				settled = true;
			});
			await Promise.resolve();
			if (settled) {
				console.error("cleanup settled before the deadline");
				process.exit(2);
			}

			vi.advanceTimersByTime(9999);
			await Promise.resolve();
			if (settled) {
				console.error("cleanup settled before the full deadline");
				process.exit(3);
			}

			vi.advanceTimersByTime(1);
			await cleanup;
			if (!settled) {
				console.error("cleanup stayed pending after the deadline");
				process.exit(4);
			}
			console.log("cleanup deadline released");
		`);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("cleanup deadline released");
		expect(result.stderr).not.toContain("cleanup stayed pending after the deadline");
	});

	it("holds cleanup open past the default deadline for a pending callback with a longer deadlineMs", async () => {
		const result = await runPostmortemProbe(`
			import { vi } from "bun:test";
			import { postmortem } from "${postmortemModuleUrl}";

			vi.useFakeTimers();
			// Give a pass whose deadline fired the microtasks it needs to settle.
			const flush = async () => {
				for (let i = 0; i < 20; i++) await Promise.resolve();
			};
			const save = Promise.withResolvers<void>();
			let saved = false;
			postmortem.register("slow-save", async () => {
				await save.promise;
				saved = true;
			}, { deadlineMs: 30_000 });

			let settled = false;
			const cleanup = postmortem.cleanup().then(() => {
				settled = true;
			});
			vi.advanceTimersByTime(20_000);
			await flush();
			if (settled) {
				console.error("cleanup gave up on a pending save at the default deadline");
				process.exit(2);
			}
			save.resolve();
			await cleanup;
			if (!saved) {
				console.error("cleanup settled before the save finished");
				process.exit(3);
			}

			const hung = Promise.withResolvers<void>();
			postmortem.register("hung-save", () => hung.promise, { deadlineMs: 30_000 });
			settled = false;
			const bounded = postmortem.cleanup().then(() => {
				settled = true;
			});
			vi.advanceTimersByTime(29_000);
			await flush();
			if (settled) {
				console.error("cleanup settled before the callback's own deadline");
				process.exit(4);
			}
			vi.advanceTimersByTime(2_000);
			// The expiry check runs on a timer the hold's own deadline schedules.
			await flush();
			vi.advanceTimersByTime(1_000);
			await bounded;
			console.log("cleanup waited for the save and stayed bounded");
		`);

		expect(result.stderr).not.toContain("cleanup gave up on a pending save");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("cleanup waited for the save and stayed bounded");
	});

	// One probe per case. `save` is the callback exit may wait on. `screen` is another owner (a
	// terminal, say); it writes "released" to stderr once it has let go of the screen. `before`
	// names a stderr marker the wait line must follow, or null when no line may appear.
	const releaseScreenSoon = `postmortem.register("screen", () => new Promise<void>(resolve => setTimeout(() => { fs.writeSync(2, "released\\n"); resolve(); }, 100)));`;
	const waitMessageCases: Record<string, { script: string; before: string | null }> = {
		"prints once the other callbacks finish while the save is pending": {
			script: `
				postmortem.register("save", () => save.promise, saveOptions);
				${releaseScreenSoon}
				const cleanup = postmortem.cleanup();
				await step(100); await step(1);
				// Past the default deadline too: the line must still appear only once.
				await step(10_000);
				save.resolve(); await cleanup;`,
			before: "released",
		},
		"prints nothing for a save that already finished": {
			script: `
				save.resolve();
				postmortem.register("save", () => save.promise, saveOptions);
				${releaseScreenSoon}
				const cleanup = postmortem.cleanup();
				await step(100); await step(1);
				await cleanup;`,
			before: null,
		},
		"prints at the default deadline when another callback hangs": {
			script: `
				postmortem.register("save", () => save.promise, saveOptions);
				postmortem.register("screen", () => Promise.withResolvers<void>().promise);
				const cleanup = postmortem.cleanup();
				await step(9_000);
				fs.writeSync(2, "nine seconds\\n");
				await step(1_000);
				save.resolve(); await step(1); await cleanup;`,
			before: "nine seconds",
		},
		"prints for a save registered late, after the other callbacks finished": {
			script: `
				const keeper = Promise.withResolvers<void>();
				postmortem.register("keeper", () => keeper.promise, { deadlineMs: 30_000 });
				${releaseScreenSoon}
				const cleanup = postmortem.cleanup();
				await step(100); await step(1);
				postmortem.register("save", () => save.promise, saveOptions);
				await step(1);
				save.resolve(); keeper.resolve(); await cleanup;`,
			before: "released",
		},
	};
	for (const [name, testCase] of Object.entries(waitMessageCases)) {
		it(`waitMessage ${name}`, async () => {
			const result = await runPostmortemProbe(`
				import * as fs from "node:fs";
				import { vi } from "bun:test";
				import { postmortem } from "${postmortemModuleUrl}";

				vi.useFakeTimers();
				const step = async (ms: number) => {
					for (let i = 0; i < 20; i++) await Promise.resolve();
					vi.advanceTimersByTime(ms);
					for (let i = 0; i < 20; i++) await Promise.resolve();
				};
				const save = Promise.withResolvers<void>();
				const saveOptions = { deadlineMs: 30_000, waitMessage: "Saving the token" };
				${testCase.script}
				console.log("cleanup done");
			`);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("cleanup done");
			if (testCase.before === null) {
				expect(result.stderr).not.toContain("Saving the token");
				return;
			}
			expect(result.stderr.match(/Saving the token \(up to \d+ s\)…/g)).toHaveLength(1);
			// Never before the other owners are done with the screen (or the default deadline passed).
			expect(result.stderr.indexOf(testCase.before)).toBeGreaterThanOrEqual(0);
			expect(result.stderr.indexOf(testCase.before)).toBeLessThan(result.stderr.indexOf("Saving the token"));
		});
	}

	it("keeps the default deadline once a callback with a longer deadlineMs has settled", async () => {
		const result = await runPostmortemProbe(`
			import { vi } from "bun:test";
			import { postmortem } from "${postmortemModuleUrl}";

			vi.useFakeTimers();
			const flush = async () => {
				for (let i = 0; i < 20; i++) await Promise.resolve();
			};
			postmortem.register("finished-save", async () => {}, { deadlineMs: 30_000 });
			postmortem.register("never-settles", () => Promise.withResolvers<void>().promise);

			let settled = false;
			const cleanup = postmortem.cleanup().then(() => {
				settled = true;
			});
			await flush();
			vi.advanceTimersByTime(9_000);
			await flush();
			if (settled) {
				console.error("cleanup settled before the default deadline");
				process.exit(2);
			}
			vi.advanceTimersByTime(2_000);
			await cleanup;
			console.log("cleanup ended at the default deadline");
		`);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("cleanup ended at the default deadline");
	});

	it("re-arms registrations after a manual cleanup keeps the process alive", async () => {
		const result = await runPostmortemProbe(`
			import { postmortem } from "${postmortemModuleUrl}";

			const order = [];
			await postmortem.cleanup();
			// Registered after a completed manual cleanup: must arm for the next pass,
			// not run immediately as a one-shot late callback.
			postmortem.register("late", () => { order.push("cleanup"); });
			order.push("registered");
			await postmortem.cleanup();
			console.log(JSON.stringify(order));
		`);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('["registered","cleanup"]');
	});

	it("runs a persistent owner again at real exit after a keep-alive cleanup", async () => {
		const result = await runPostmortemProbe(`
			import { postmortem } from "${postmortemModuleUrl}";

			const order = [];
			postmortem.register("persistent", () => { order.push("cleanup"); });
			await postmortem.cleanup();
			// The owner remains registered while its subsystem creates resources
			// again; the real exit must run the same registration a second time.
			order.push("reused");
			process.on("exit", () => { console.log(JSON.stringify(order)); });
			process.exit(0);
		`);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('["cleanup","reused","cleanup"]');
	});

	it("skips exit-only callbacks on keep-alive cleanup but runs them on the real exit", async () => {
		const result = await runPostmortemProbe(`
			import { postmortem } from "${postmortemModuleUrl}";

			const order = [];
			// Exit-only: a keep-alive cleanup must skip it without latching, so the
			// registration survives for the eventual real exit.
			postmortem.register("exit-only", () => { order.push("cleanup"); }, { exitOnly: true });
			await postmortem.cleanup();
			order.push("after-keepalive");
			process.on("exit", () => { console.log(JSON.stringify(order)); });
			process.exit(0);
		`);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('["after-keepalive","cleanup"]');
	});

	it("awaits an async callback registered mid-pass before cleanup() settles", async () => {
		const result = await runPostmortemProbe(`
			import { postmortem } from "${postmortemModuleUrl}";

			const order = [];
			postmortem.register("outer", () => {
				// Registered while the keep-alive pass is running: cleanup() must
				// join its async completion, not settle after the snapshot alone.
				postmortem.register("late", async () => {
					// One full event-loop turn: settles strictly after the snapshot pass.
					const { promise, resolve } = Promise.withResolvers();
					setImmediate(resolve);
					await promise;
					order.push("late");
				});
				order.push("outer");
			});
			await postmortem.cleanup();
			order.push("settled");
			console.log(JSON.stringify(order));
		`);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('["outer","late","settled"]');
	});

	it.skipIf(process.platform === "win32")("finishes an async late registration before a SIGTERM exit", async () => {
		const result = await runPostmortemProbe(`
			import { postmortem } from "${postmortemModuleUrl}";

			postmortem.register("outer", () => {
				// Registered during the signal-driven exit pass: the process must not
				// terminate until this async work completes.
				postmortem.register("late", async () => {
					// One full event-loop turn: settles strictly after the snapshot pass.
					const { promise, resolve } = Promise.withResolvers();
					setImmediate(resolve);
					await promise;
					console.log("late-done");
				});
			});
			process.kill(process.pid, "SIGTERM");
			// Stay alive until the signal path exits; the harness watchdog bounds a regression.
			await Promise.withResolvers().promise;
		`);

		expect(result.exitCode).toBe(143);
		expect(result.stdout).toContain("late-done");
	});
});
