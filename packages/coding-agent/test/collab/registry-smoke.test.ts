/**
 * Real two-process smoke test for the local Collab host registry (issue #6099).
 *
 * A genuine child Bun process publishes over a Unix socket / named pipe.
 * The parent discovers metadata without capabilities, retrieves a link only
 * on explicit request through the real CLI, and observes crash pruning.
 * All writes stay under temp dirs, including a fake HOME for the CLI path.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CollabListJsonOutput } from "@oh-my-pi/pi-coding-agent/cli/collab-cli";
import { COLLAB_REGISTRY_VERSION, listCollabHosts } from "@oh-my-pi/pi-coding-agent/collab/registry";

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
	// Drain stderr continuously without waiting for the long-lived helper to exit.
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
	it("discovers a separately-spawned host without a URL and prunes it after a crash", async () => {
		const dir = await tempDir("omp-collab-smoke-seam-");
		const marker = `seam-${Date.now().toString(36)}`;
		const instanceId = "seam-host";
		const { child, stderr } = spawnHelper([dir, marker, instanceId]);

		const ready = await readUntil(child.stdout, "READY", READY_TIMEOUT_MS);
		expect({ ready, stderr: stderr() }).toEqual({ ready: true, stderr: "" });

		const hosts = await listCollabHosts({ dir });
		expect(hosts).toHaveLength(1);
		expect(hosts[0]).toMatchObject({ instanceId, pid: child.pid, sessionId: `session-${marker}` });
		expect(hosts[0]).not.toHaveProperty("url");
		expect(JSON.stringify(hosts)).not.toContain(`https://collab.example/control/${marker}`);
		expect(JSON.stringify(hosts)).not.toContain(`https://collab.example/view/${marker}`);

		// SIGKILL cannot run shutdown hooks; the next list must prune the endpoint.
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

	it("lists metadata and explicitly retrieves control or view links through the real CLI under a fake HOME", async () => {
		const home = await tempDir("omp-collab-smoke-home-");
		const marker = `cli-${Date.now().toString(36)}`;
		const instanceId = "cli-host";
		const controlUrl = `https://collab.example/control/${marker}`;
		const viewUrl = `https://collab.example/view/${marker}`;
		// Clear every override that could redirect the registry outside the fake HOME.
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			NO_COLOR: "1",
			OMP_SMOKE_MARKER: marker,
			OMP_SMOKE_INSTANCE_ID: instanceId,
		};
		delete env.PI_CONFIG_DIR;
		delete env.PI_PROFILE;
		delete env.OMP_PROFILE;
		delete env.PI_CODING_AGENT_DIR;

		const { child, stderr } = spawnHelper([], env);
		const ready = await readUntil(child.stdout, "READY", READY_TIMEOUT_MS);
		expect({ ready, helperStderr: stderr() }).toEqual({ ready: true, helperStderr: "" });

		const runCli = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
			const cli = Bun.spawn([process.execPath, CLI_PATH, "collab", ...args], {
				cwd: path.resolve(import.meta.dir, "../.."),
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			liveChildren.push(cli);
			const [code, stdout, cliStderr] = await Promise.all([
				cli.exited,
				new Response(cli.stdout).text(),
				new Response(cli.stderr).text(),
			]);
			return { code, stdout, stderr: cliStderr };
		};

		const listed = await runCli(["list", "--json"]);
		expect({ code: listed.code, stderr: listed.stderr }).toEqual({ code: 0, stderr: "" });
		const listJson: CollabListJsonOutput = JSON.parse(listed.stdout);
		const hosts = await listCollabHosts({ dir: path.join(home, ".omp", "run", "collab-hosts") });
		expect(listJson).toEqual({ version: COLLAB_REGISTRY_VERSION, hosts });
		expect(listJson.hosts).toHaveLength(1);
		expect(listJson.hosts[0]).toMatchObject({ instanceId, pid: child.pid });
		expect(listJson.hosts[0]).not.toHaveProperty("url");
		expect(listed.stdout).not.toContain(controlUrl);
		expect(listed.stdout).not.toContain(viewUrl);

		const control = await runCli(["link", instanceId, "--json"]);
		expect({ code: control.code, stderr: control.stderr }).toEqual({ code: 0, stderr: "" });
		expect(JSON.parse(control.stdout)).toEqual({
			version: COLLAB_REGISTRY_VERSION,
			instanceId,
			generation: 1,
			access: "control",
			url: controlUrl,
		});
		const view = await runCli(["link", String(child.pid), "--view"]);
		expect(view).toEqual({ code: 0, stdout: `${viewUrl}\n`, stderr: "" });

		const missing = await runCli(["link", "missing-host"]);
		expect(missing.code).toBe(1);
		expect(missing.stdout).toBe("");
		expect(missing.stderr).toMatch(/^error: [^\n]*missing-host\n$/);

		// SIGTERM allows clean withdrawal, unlike the crash path above.
		child.kill("SIGTERM");
		expect(await child.exited).toBe(0);
		const afterStop = await waitUntil(async () => {
			const result = await runCli(["list", "--json"]);
			const json: CollabListJsonOutput = JSON.parse(result.stdout);
			return result.code === 0 && json.hosts.length === 0;
		}, CLI_TIMEOUT_MS);
		expect(afterStop).toBe(true);
	}, 120_000);
});
