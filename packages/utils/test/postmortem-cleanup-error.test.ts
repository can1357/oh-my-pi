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

	it("keeps unmarked unhandled rejections fatal", async () => {
		const result = await runPostmortemProbe(`
			import "${postmortemModuleUrl}";

			Promise.reject(new Error("unexpected cleanup rejection"));
			await Promise.resolve();
		`);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("[Unhandled Rejection] Error: unexpected cleanup rejection");
	});

	it("prints registered recovery commands before fatal cleanup", async () => {
		const result = await runPostmortemProbe(`
			import { postmortem } from "${postmortemModuleUrl}";

			postmortem.registerFatalRecoveryHint(() => ({
				label: "Main",
				command: "omp --resume 019cafe0-dead-beef",
			}));
			Promise.reject(new Error("session crashed"));
			await Promise.resolve();
		`);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("[Unhandled Rejection] Error: session crashed");
		expect(result.stderr).toContain("[Recovery]\n  Main: omp --resume 019cafe0-dead-beef");
	});

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
});
