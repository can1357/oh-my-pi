import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";

// The probe races a full CLI boot (`bun src/cli.ts` plus session setup and
// the RPC handshake). That boot takes seconds locally and tens of seconds on
// loaded CI runners, so the read loop carries its own deadline inside bun's:
// on expiry the child is reaped and the failure surfaces the exit code and
// the stderr tail instead of a bare timeout or an `undefined` response.
const PROBE_DEADLINE_MS = 45_000;
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
	const readProbe = (async () => {
		for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
			if (isRecord(frame) && frame.type === "response" && frame.id === "probe") {
				return frame;
			}
		}
		return undefined;
	})();

	let result: unknown;
	let exitCode: number | null;
	try {
		result = await Promise.race([readProbe, Bun.sleep(PROBE_DEADLINE_MS).then(() => timedOut)]);
	} finally {
		child.stdin.end();
		child.kill();
		exitCode = await child.exited.catch(() => null);
	}

	const stderr = await stderrPromise;
	if (result === timedOut) {
		throw new Error(
			`RPC probe response not received within ${PROBE_DEADLINE_MS}ms (exit ${String(exitCode)}); child stderr tail:\n${stderr.slice(-STDERR_TAIL_CHARS)}`,
		);
	}
	const stateResponse = result as Record<string, unknown> | undefined;
	if (stateResponse === undefined) {
		throw new Error(
			`RPC child stdout ended without the probe response (exit ${String(exitCode)}); child stderr tail:\n${stderr.slice(-STDERR_TAIL_CHARS)}`,
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
