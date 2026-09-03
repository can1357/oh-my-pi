/**
 * ACP stdout-hygiene smoke: launching `omp acp` must not leak any banner,
 * progress text, or stray non-JSON bytes onto stdout — that channel is owned
 * by the JSON-RPC protocol. We spawn the CLI as a subprocess, send a single
 * `initialize` frame, and assert the first stdout line parses cleanly as a
 * JSON-RPC response.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type AcpProc = Bun.Subprocess<"pipe", "pipe", "pipe">;

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

const cleanupRoots: string[] = [];
let activeProc: AcpProc | undefined;

/**
 * Tear the child down deterministically. Once the initialize frame has been
 * asserted there is no graceful-shutdown behavior under test, so close stdin
 * and kill the throwaway process rather than parking on a grace-period timer.
 */
async function teardown(proc: AcpProc): Promise<void> {
	// Close stdin so any blocking read in the child wakes up.
	try {
		proc.stdin.end();
	} catch {
		// already closed
	}
	// Best-effort detach from stdout/stderr so the child's pipe writes don't
	// block on a full buffer once we stop draining.
	for (const stream of [proc.stdout, proc.stderr] as Array<ReadableStream<Uint8Array> | undefined>) {
		if (!stream) continue;
		try {
			await stream.cancel();
		} catch {
			// reader may already be detached
		}
	}

	try {
		proc.kill("SIGKILL");
	} catch {
		// already exited
	}
	await proc.exited;
}

afterEach(async () => {
	if (activeProc) {
		const proc = activeProc;
		activeProc = undefined;
		try {
			await teardown(proc);
		} catch {
			// teardown is already best-effort; never let cleanup fail a test
		}
	}
	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

async function readFirstFrame(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const newlineIdx = buffer.indexOf("\n");
		if (newlineIdx >= 0) {
			reader.releaseLock();
			return buffer.slice(0, newlineIdx);
		}
	}
	reader.releaseLock();
	return buffer;
}

describe("ACP stdout hygiene", () => {
	it("emits a JSON-RPC initialize response as the first bytes on stdout", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-acp-stdout-"));
		cleanupRoots.push(root);
		const xdg = path.join(root, "xdg");
		const agentDir = path.join(root, "agent");
		await fs.promises.mkdir(xdg, { recursive: true });
		await fs.promises.mkdir(agentDir, { recursive: true });

		// NOTE: we intentionally do NOT override HOME. Bun keys its transpile
		// cache at `$HOME/.bun/install/cache`; pointing HOME at a fresh tmp
		// dir forces a full re-transpile of the CLI's module graph on every
		// run (~12s cold vs ~0.4s warm). XDG_* and PI_CODING_AGENT_DIR
		// already isolate PI's on-disk state for this smoke test.
		const proc = Bun.spawn(["bun", cliEntry, "acp"], {
			cwd: repoRoot,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				XDG_DATA_HOME: xdg,
				XDG_CONFIG_HOME: xdg,
				PI_CODING_AGENT_DIR: agentDir,
				PI_NO_TITLE: "1",
				NO_COLOR: "1",
			},
		});
		activeProc = proc;

		// Buffer stderr in the background so we can assert no JSON-RPC frame
		// leaks onto it. The pump exits the moment stderr closes, which
		// happens during teardown — we never wait on it from the test body.
		const stderrChunks: Uint8Array[] = [];
		const stderrPump = (async () => {
			const reader = proc.stderr.getReader();
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					if (value) stderrChunks.push(value);
				}
			} catch {
				// reader cancelled by teardown — expected
			} finally {
				try {
					reader.releaseLock();
				} catch {
					// already released
				}
			}
		})();

		const initRequest = {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { auth: { terminal: true } } },
		};
		proc.stdin.write(new TextEncoder().encode(`${JSON.stringify(initRequest)}\n`));
		proc.stdin.flush();

		const firstLine = await readFirstFrame(proc.stdout);
		expect(firstLine[0]).toBe("{");

		const message = JSON.parse(firstLine) as {
			jsonrpc?: string;
			id?: unknown;
			result?: { protocolVersion?: number; authMethods?: Array<{ type?: string; id?: string }> };
			error?: unknown;
		};
		expect(message.jsonrpc).toBe("2.0");
		expect(message.id).toBe(1);
		expect(message.error).toBeUndefined();
		expect(message.result?.protocolVersion).toBe(1);
		expect(message.result?.authMethods).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "agent" }),
				expect.objectContaining({ type: "terminal", id: "terminal" }),
			]),
		);

		// First frame is good. Tear the child down now so the test body's
		// wall time is bounded by "boot + first frame", not by waiting for
		// stderr or a delayed shutdown. teardown() closes the pipes and kills
		// the throwaway child, which also resolves stderrPump.
		await teardown(proc);
		activeProc = undefined;
		await stderrPump;

		const stderrText = Buffer.concat(stderrChunks).toString("utf8");
		// Guard against JSON-RPC frames sneaking onto stderr. Normal stderr
		// output (warnings, telemetry, etc.) is allowed, but anything that
		// parses as a JSON-RPC envelope on the wrong channel is a misroute.
		for (const line of stderrText.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("{")) continue;
			let parsed: { jsonrpc?: unknown } | undefined;
			try {
				parsed = JSON.parse(trimmed) as { jsonrpc?: unknown };
			} catch {
				continue;
			}
			expect(parsed?.jsonrpc, `JSON-RPC frame leaked to stderr: ${trimmed}`).toBeUndefined();
		}
	}, 60_000);
});
