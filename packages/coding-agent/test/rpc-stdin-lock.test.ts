import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";

// The probe races a full CLI boot (`bun src/cli.ts` plus session setup and
// the RPC handshake). That boot takes seconds locally and tens of seconds on
// loaded CI runners, so the read loop carries its own deadline inside bun's:
// on expiry the child is reaped and the failure surfaces the exit code and
// the stderr tail instead of a bare timeout or an `undefined` response.
// Reaping and the stderr drain carry their own bounds too: SIGTERM first,
// then SIGKILL, so a wedged child or a descendant holding the pipe open
// cannot fall through to bun's bare 60 s timeout.
const PROBE_DEADLINE_MS = 40_000;
const REAP_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 2_000;
const STDERR_TAIL_CHARS = 2000;

async function expectRpcOwnsStdin(): Promise<void> {
	const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
	const extensionPath = path.join(import.meta.dir, "fixtures", "locked-stdin-reader.ts");
	const child = Bun.spawn(
		[
			"bun",
			cliPath,
			"--extension",
			extensionPath,
			"--mode",
			"rpc",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd: path.join(import.meta.dir, ".."),
			env: { ...Bun.env, PI_NO_TITLE: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderrPromise = new Response(child.stderr).text();

	child.stdin.write(`${JSON.stringify({ type: "get_state", id: "probe" })}\n`);
	await child.stdin.flush();

	const timedOut = Symbol("probe-timed-out");
	let probeError: unknown;
	const readProbe = (async (): Promise<Record<string, unknown> | undefined> => {
		try {
			for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
				if (isRecord(frame) && frame.type === "response" && frame.id === "probe") {
					return frame;
				}
			}
		} catch (err) {
			probeError = err;
		}
		return undefined;
	})();

	let result: Record<string, unknown> | undefined | typeof timedOut;
	let exitCode: number | null;
	try {
		result = await Promise.race([readProbe, Bun.sleep(PROBE_DEADLINE_MS).then((): typeof timedOut => timedOut)]);
	} finally {
		try {
			child.stdin.end();
		} catch {}
		try {
			child.kill();
		} catch {}
		exitCode = await Promise.race([child.exited.catch(() => null), Bun.sleep(REAP_TIMEOUT_MS).then(() => null)]);
		if (exitCode === null) {
			try {
				child.kill("SIGKILL");
			} catch {}
			exitCode = await Promise.race([child.exited.catch(() => null), Bun.sleep(KILL_TIMEOUT_MS).then(() => null)]);
		}
	}

	let stderrError: unknown;
	const readStderr = stderrPromise.catch((err: unknown) => {
		stderrError = err;
		return `<stderr read failed: ${String(err)}>`;
	});
	let stderr: string | null = await Promise.race([readStderr, Bun.sleep(REAP_TIMEOUT_MS).then((): null => null)]);
	if (stderr === null) {
		try {
			child.kill("SIGKILL");
		} catch {}
		stderr = await Promise.race([readStderr, Bun.sleep(KILL_TIMEOUT_MS).then((): null => null)]);
		if (stderr === null) {
			throw new Error(
				`RPC child stderr drain timed out (exit ${String(exitCode)}; probe ${result === timedOut ? "deadline expired" : result === undefined ? "stdout ended without response" : "response received"}); killing the child did not release the pipe — possible descendant holding stderr open`,
			);
		}
	}
	if (stderrError !== undefined) {
		throw new Error(
			`RPC child stderr unreadable (exit ${String(exitCode)}; probe ${result === timedOut ? "deadline expired" : result === undefined ? "stdout ended without response" : "response received"}; stderr read failed: ${String(stderrError)}); stdin-ownership invariant unverifiable`,
		);
	}
	if (result === timedOut) {
		throw new Error(
			`RPC probe response not received within ${PROBE_DEADLINE_MS}ms (exit ${String(exitCode)}); child stderr tail:\n${stderr.slice(-STDERR_TAIL_CHARS)}`,
		);
	}
	const stateResponse = result;
	if (stateResponse === undefined) {
		throw new Error(
			`RPC child stdout ended without the probe response (exit ${String(exitCode)}${probeError === undefined ? "" : `; stdout read failed: ${String(probeError)}`}); child stderr tail:\n${stderr.slice(-STDERR_TAIL_CHARS)}`,
		);
	}
	// The adversarial fixture is EXPECTED to fail loading — RPC claimed stdin
	// first — and its surfaced load notice (#4954) mentions the locked stream.
	// Any OTHER "ReadableStream is locked" line means RPC lost stdin ownership.
	for (const line of stderr.split("\n").filter(l => l.includes("ReadableStream is locked"))) {
		expect(line).toContain("Failed to load extension");
	}
	expect(stateResponse.success).toBe(true);
}

// rpc-ui shares this exact pre-discovery claim path (`rpc || rpc-ui`) in main;
// a second full CLI startup would exercise no distinct ownership behavior.
describe("RPC mode stdin ownership", () => {
	test("claims stdin before extensions can lock its singleton stream", () => expectRpcOwnsStdin(), 60000);
});
