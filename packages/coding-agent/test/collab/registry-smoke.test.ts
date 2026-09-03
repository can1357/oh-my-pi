/**
 * Real two-process smoke test for the local Collab host registry (issue #6099).
 *
 * Unlike the unit tests, nothing here is stubbed: a genuine child Bun process
 * publishes a live host over a real Unix socket / named pipe, and the parent
 * discovers it through {@link listCollabHosts} and through the shipped
 * `omp collab list` CLI. This defends the cross-process contracts that in-process
 * tests cannot reach:
 *   - a separately-spawned host is discoverable with its real PID and
 *     mode-scoped URLs;
 *   - a hard-killed (SIGKILL) host is pruned from the registry on the next list;
 *   - the end-user CLI emits the documented versioned JSON for live hosts.
 *
 * All writes are confined to temp dirs (including a fake $HOME for the CLI path),
 * so the suite is full-suite safe and never touches the real `~/.omp`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listCollabHosts } from "@oh-my-pi/pi-coding-agent/collab/registry";

const HELPER_PATH = path.resolve(import.meta.dir, "helpers/registry-host-process.ts");
const CLI_PATH = path.resolve(import.meta.dir, "../../src/cli.ts");
const READY_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 15_000;
const CLI_TIMEOUT_MS = 60_000;

const cleanupDirs: string[] = [];
const liveChildren: { kill(signal?: NodeJS.Signals): void; exited: Promise<number> }[] = [];

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

// Cross-process integration: fake timers cannot advance a real OS process.
async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await Bun.sleep(50);
	}
	return condition();
}

/** Read `stream` until `needle` appears or `timeoutMs` elapses. */
async function readUntil(stream: ReadableStream<Uint8Array>, needle: string, timeoutMs: number): Promise<boolean> {
	const decoder = new TextDecoder();
	let buffer = "";
	const scan = (async () => {
		for await (const chunk of stream) {
			buffer += decoder.decode(chunk, { stream: true });
			if (buffer.includes(needle)) return true;
		}
		return false;
	})();
	return Promise.race([scan, Bun.sleep(timeoutMs).then(() => false)]);
}

interface Helper {
	child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	/** Snapshot of everything the helper has written to stderr so far. */
	stderr(): string;
}

function spawnHelper(args: string[], env?: Record<string, string | undefined>): Helper {
	const child = Bun.spawn([process.execPath, HELPER_PATH, ...args], {
		cwd: path.resolve(import.meta.dir, "../.."),
		env: env ?? process.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	liveChildren.push(child);
	// Drain stderr continuously: reading it to completion would block until the
	// (long-lived) helper exits, so accumulate chunks in the background instead.
	let stderrText = "";
	const decoder = new TextDecoder();
	void (async () => {
		for await (const chunk of child.stderr) stderrText += decoder.decode(chunk, { stream: true });
	})().catch(() => {});
	return { child, stderr: () => stderrText };
}

afterEach(async () => {
	for (const child of liveChildren.splice(0)) {
		try {
			child.kill("SIGKILL");
			await child.exited;
		} catch {
			// Already gone.
		}
	}
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("collab host registry (two-process smoke)", () => {
	it("discovers a separately-spawned host and prunes it after a crash", async () => {
		const dir = await tempDir("omp-collab-smoke-seam-");
		const marker = `seam-${Date.now().toString(36)}`;
		const { child, stderr } = spawnHelper([dir, marker]);

		const ready = await readUntil(child.stdout, "READY", READY_TIMEOUT_MS);
		expect({ ready, stderr: stderr() }).toEqual({ ready: true, stderr: "" });

		const hosts = await listCollabHosts({ dir });
		expect(hosts).toHaveLength(1);
		expect(hosts[0]?.pid).toBe(child.pid);
		expect(hosts[0]?.mode).toBe("write");
		expect(hosts[0]?.url).toBe(`https://collab.example/write/${marker}`);
		expect(hosts[0]?.sessionId).toBe(`session-${marker}`);

		const viewHosts = await listCollabHosts({ dir, mode: "view" });
		expect(viewHosts).toHaveLength(1);
		expect(viewHosts[0]?.mode).toBe("view");
		expect(viewHosts[0]?.url).toBe(`https://collab.example/view/${marker}`);

		// Hard kill: no chance to run cleanup handlers, so the next list must
		// prune the now-dead endpoint (crash-cleanup contract across processes).
		child.kill("SIGKILL");
		await child.exited;

		const pruned = await waitUntil(async () => {
			const remaining = await listCollabHosts({ dir });
			if (remaining.length !== 0) return false;
			const entries = await fs.readdir(dir);
			return !entries.some(name => name.endsWith(".json"));
		}, CLEANUP_TIMEOUT_MS);
		expect(pruned).toBe(true);
	}, 40_000);

	it("lists a live host through the real `collab list` CLI under a fake HOME", async () => {
		const home = await tempDir("omp-collab-smoke-home-");
		const marker = `cli-${Date.now().toString(36)}`;
		// Force the default registry dir (~/.omp/run/collab-hosts) to resolve
		// under the fake HOME by clearing every override that would redirect it.
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			NO_COLOR: "1",
			// Marker travels via env because argv[2] must stay empty (default dir).
			OMP_SMOKE_MARKER: marker,
		};
		delete env.PI_CONFIG_DIR;
		delete env.PI_PROFILE;
		delete env.OMP_PROFILE;
		delete env.PI_CODING_AGENT_DIR;

		// No dir argv → publishes to the default dir under the fake HOME.
		const { child, stderr } = spawnHelper([], env);
		const ready = await readUntil(child.stdout, "READY", READY_TIMEOUT_MS);
		expect({ ready, helperStderr: stderr() }).toEqual({ ready: true, helperStderr: "" });

		const runCli = async (extraArgs: string[]): Promise<{ code: number; json: unknown; stderr: string }> => {
			const cli = Bun.spawn([process.execPath, CLI_PATH, "collab", "list", "--json", ...extraArgs], {
				cwd: path.resolve(import.meta.dir, "../.."),
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, stdout, cliStderr] = await Promise.all([
				cli.exited,
				new Response(cli.stdout).text(),
				new Response(cli.stderr).text(),
			]);
			const brace = stdout.indexOf("{");
			if (brace < 0) {
				throw new Error(`CLI produced no JSON object (exit ${code}).\nstdout:\n${stdout}\nstderr:\n${cliStderr}`);
			}
			return { code, json: JSON.parse(stdout.slice(brace)), stderr: cliStderr };
		};

		const write = await runCli([]);
		expect(write.code).toBe(0);
		const writeJson = write.json as { version: number; mode: string; hosts: { pid: number; url: string }[] };
		expect(writeJson.version).toBe(1);
		expect(writeJson.mode).toBe("write");
		expect(writeJson.hosts).toHaveLength(1);
		expect(writeJson.hosts[0]?.pid).toBe(child.pid);
		expect(writeJson.hosts[0]?.url).toBe(`https://collab.example/write/${marker}`);

		const view = await runCli(["--view"]);
		expect(view.code).toBe(0);
		const viewJson = view.json as { mode: string; hosts: { url: string }[] };
		expect(viewJson.mode).toBe("view");
		expect(viewJson.hosts).toHaveLength(1);
		expect(viewJson.hosts[0]?.url).toBe(`https://collab.example/view/${marker}`);

		// Clean withdrawal: SIGTERM lets the host close its publication, so a
		// subsequent CLI list reports zero hosts.
		child.kill("SIGTERM");
		await child.exited;

		const afterStop = await waitUntil(async () => {
			const { json } = await runCli([]);
			return (json as { hosts: unknown[] }).hosts.length === 0;
		}, CLI_TIMEOUT_MS);
		expect(afterStop).toBe(true);
	}, 120_000);
});
