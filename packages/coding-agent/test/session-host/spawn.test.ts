import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pidAlive } from "@oh-my-pi/pi-coding-agent/ipc/private-endpoint";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	connectSessionHost,
	type SpawnSessionHostOptions,
	spawnSessionHost,
} from "@oh-my-pi/pi-coding-agent/session-host/client";
import { listSessionHosts, type SessionHostEntry } from "@oh-my-pi/pi-coding-agent/session-host/registry";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const MODEL_ARGS = [
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--provider",
	"anthropic",
	"--model",
	"claude-sonnet-4-5",
];

let dir: string;
let registryDir: string;
/** Every host a test spawned; a failed test must not leave a detached host running. */
const spawned: number[] = [];

beforeEach(async () => {
	dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-host-spawn-"));
	registryDir = path.join(dir, "registry");
	// No network: a dummy key makes the model available, and discovery hits a closed port.
	await Bun.write(
		path.join(dir, "models.yml"),
		"providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:9\n    apiKey: test-dummy-key\n",
	);
});
afterEach(async () => {
	for (const pid of spawned.splice(0)) if (pidAlive(pid)) process.kill(pid, "SIGKILL");
	await removeWithRetries(dir);
});

/** A host isolated in `dir`: the env overlay keeps it out of the real agent and config dirs. */
async function spawnHost(options: Partial<SpawnSessionHostOptions> = {}): Promise<SessionHostEntry> {
	const entry = await spawnSessionHost({
		cwd: dir,
		registryDir,
		env: { PI_CODING_AGENT_DIR: dir, HOME: dir, USERPROFILE: dir },
		args: MODEL_ARGS,
		...options,
	});
	spawned.push(entry.pid);
	return entry;
}

/** Another process's exit has no event to await here: the host is detached and its handle stays inside spawnSessionHost. */
async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await Bun.sleep(25);
	}
}

/** Its own files, checked directly: a listing would prune a dead host's leftovers itself. */
function artifactsLeft(entry: SessionHostEntry): string[] {
	return [path.join(registryDir, `${entry.hostId}.json`), entry.endpoint].filter(file => fs.existsSync(file));
}

describe("spawnSessionHost", () => {
	it("spawns a detached host that outlives its spawner's client and exits on the last exit", async () => {
		const entry = await spawnHost();
		expect(pidAlive(entry.pid)).toBe(true);
		const a = new RpcClient({ spawn: () => connectSessionHost({ entry, client: { kind: "test" }, ui: false }) });
		await a.start();
		expect((await a.getState()).sessionFile).toBe(entry.sessionFile);
		await a.stop(); // socket close = detach
		expect(pidAlive(entry.pid)).toBe(true);
		const b = new RpcClient({ spawn: () => connectSessionHost({ entry, client: { kind: "test" }, ui: false }) });
		await b.start();
		await b.exit();
		await waitFor(() => !pidAlive(entry.pid), 10_000);
		expect(artifactsLeft(entry)).toEqual([]);
		// A clean exit removes the spawner's log of it too.
		expect(fs.existsSync(path.join(registryDir, `${entry.hostId}.log`))).toBe(false);
		expect(await listSessionHosts(registryDir)).toEqual([]);
	}, 150_000);

	// SIGTERM on Windows is TerminateProcess: no handler runs, so these POSIX signal contracts cannot hold there.
	const itPosix = it.skipIf(process.platform === "win32");

	itPosix(
		"disposes its session and withdraws its registry entry and socket when terminated by a signal",
		async () => {
			const marker = path.join(dir, "session-shutdown");
			const extension = path.join(dir, "shutdown-marker.ts");
			await Bun.write(
				extension,
				`import * as fs from "node:fs";\nexport default function (pi) {\n\tpi.on("session_shutdown", () => fs.writeFileSync(${JSON.stringify(marker)}, "disposed"));\n}\n`,
			);
			const entry = await spawnHost({ args: [...MODEL_ARGS, "-e", extension] });
			const a = new RpcClient({ spawn: () => connectSessionHost({ entry, client: { kind: "test" }, ui: false }) });
			await a.start();
			// The detach queues a registry rewrite (`clients: 0`) that the signal exit must not let land after it withdraws.
			await a.detach();
			process.kill(entry.pid, "SIGTERM");
			await waitFor(() => !pidAlive(entry.pid), 10_000);
			expect(artifactsLeft(entry)).toEqual([]);
			expect(fs.existsSync(marker)).toBe(true);
			// Not a clean exit: the log stays for diagnosis.
			expect(fs.existsSync(path.join(registryDir, `${entry.hostId}.log`))).toBe(true);
		},
		150_000,
	);

	itPosix(
		"lets a signal during the last client's exit wait for the session to finish disposing",
		async () => {
			const [started, release, done] = ["started", "release", "done"].map(name => path.join(dir, name));
			const extension = path.join(dir, "gated-shutdown.ts");
			await Bun.write(
				extension,
				`import * as fs from "node:fs";
export default function (pi) {
	pi.on("session_shutdown", async () => {
		fs.writeFileSync(${JSON.stringify(started)}, "");
		while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
		fs.writeFileSync(${JSON.stringify(done)}, "");
	});
}
`,
			);
			const entry = await spawnHost({ args: [...MODEL_ARGS, "-e", extension] });
			const b = new RpcClient({ spawn: () => connectSessionHost({ entry, client: { kind: "test" }, ui: false }) });
			await b.start();
			await b.exit();
			await waitFor(() => fs.existsSync(started), 10_000);
			process.kill(entry.pid, "SIGTERM");
			// Deliberate stall, not a duration guess: the condition is whether the host keeps itself alive for the
			// dispose in progress, and a host that does not has no event to await.
			await Bun.sleep(500);
			expect(pidAlive(entry.pid)).toBe(true);
			fs.writeFileSync(release, "");
			await waitFor(() => !pidAlive(entry.pid), 10_000);
			expect(fs.existsSync(done)).toBe(true);
		},
		150_000,
	);

	itPosix(
		"keeps its session and keeps serving clients when a hangup reaches it",
		async () => {
			const entry = await spawnHost();
			process.kill(entry.pid, "SIGHUP");
			// A host that honored the hangup (the default handler disposes and exits) would be gone within a beat.
			// The claim is an absence, which has no event to await: the host must still be there when the window ends.
			await expect(waitFor(() => !pidAlive(entry.pid), 500)).rejects.toThrow("waitFor timed out");
			expect(await listSessionHosts(registryDir)).toHaveLength(1);
			const a = new RpcClient({ spawn: () => connectSessionHost({ entry, client: { kind: "test" }, ui: false }) });
			await a.start();
			expect((await a.getState()).sessionFile).toBe(entry.sessionFile);
			// Only a client's exit stops it.
			await a.exit();
			await waitFor(() => !pidAlive(entry.pid), 10_000);
			expect(artifactsLeft(entry)).toEqual([]);
		},
		150_000,
	);

	it("registers in a relative registry dir resolved by the spawner, leaving other files there alone", async () => {
		// A registry directory shared with a file that is not an entry.
		await fs.promises.mkdir(registryDir, { mode: 0o700 });
		await Bun.write(path.join(registryDir, "package.json"), "{}");
		// The host runs in another directory, where the relative path names something else.
		const project = path.join(dir, "project");
		await fs.promises.mkdir(project);
		const entry = await spawnHost({ cwd: project, registryDir: path.relative(process.cwd(), registryDir) });
		expect((await listSessionHosts(registryDir)).map(e => e.hostId)).toEqual([entry.hostId]);
		expect(fs.existsSync(path.join(registryDir, "package.json"))).toBe(true);
		const a = new RpcClient({ spawn: () => connectSessionHost({ entry, client: { kind: "test" }, ui: false }) });
		await a.start();
		await a.exit();
		await waitFor(() => !pidAlive(entry.pid), 10_000);
		expect(await fs.promises.readdir(registryDir)).toEqual(expect.arrayContaining(["package.json"]));
		expect(await listSessionHosts(registryDir)).toEqual([]);
	}, 150_000);

	it("kills a host that has not registered by the deadline", async () => {
		const error = await spawnHost({ timeoutMs: 1 }).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(Error);
		const pid = Number(/pid (\d+)/.exec((error as Error).message)?.[1]);
		expect(pid).toBeGreaterThan(0);
		spawned.push(pid);
		await waitFor(() => !pidAlive(pid), 10_000);
	}, 30_000);

	it("rejects early, naming the host's log, when the host exits before registering", async () => {
		const error = await spawnHost({ args: ["--no-such-flag"], timeoutMs: 120_000 }).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(Error);
		const logPath = /log: (\S+\.log)$/.exec((error as Error).message)?.[1];
		expect(logPath && path.dirname(logPath)).toBe(registryDir);
		expect(await Bun.file(logPath!).text()).toContain("unknown flag: --no-such-flag");
		expect(await listSessionHosts(registryDir)).toEqual([]);
	}, 30_000); // far below timeoutMs: only an early rejection passes
});
