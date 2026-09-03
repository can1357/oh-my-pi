import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";

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

	let stateResponse: Record<string, unknown> | undefined;
	try {
		for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
			if (isRecord(frame) && frame.type === "response" && frame.id === "probe") {
				stateResponse = frame;
				break;
			}
		}
	} finally {
		child.stdin.end();
		child.kill();
		await child.exited.catch(() => {});
	}

	const stderr = await stderrPromise;
	// The adversarial fixture is EXPECTED to fail loading — RPC claimed stdin
	// first — and its surfaced load notice (#4954) mentions the locked stream.
	// Any OTHER "ReadableStream is locked" line means RPC lost stdin ownership.
	for (const line of stderr.split("\n").filter(l => l.includes("ReadableStream is locked"))) {
		expect(line).toContain("Failed to load extension");
	}
	expect(stateResponse?.success).toBe(true);
}

// rpc-ui shares this exact pre-discovery claim path (`rpc || rpc-ui`) in main;
// a second full CLI startup would exercise no distinct ownership behavior.
describe("RPC mode stdin ownership", () => {
	test("claims stdin before extensions can lock its singleton stream", () => expectRpcOwnsStdin(), 30000);
});
