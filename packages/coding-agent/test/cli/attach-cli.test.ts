import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ensurePrivateDir, privateEndpoint } from "@oh-my-pi/pi-coding-agent/ipc/private-endpoint";
import {
	SESSION_HOST_REGISTRY_VERSION,
	type SessionHostEntry,
	writeHostEntry,
} from "@oh-my-pi/pi-coding-agent/session-host/registry";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const CLI = path.join(import.meta.dir, "..", "..", "src", "cli.ts");
const CONFIG_DIR_NAME = ".omp-attach-test";
const LIVE_ID = "aaaaaaaaaaaaaaaa";
const DEAD_ID = "bbbbbbbbbbbbbbbb";

let home: string;
let server: net.Server | undefined;

afterEach(async () => {
	if (server) {
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		server = undefined;
		await closed.promise;
	}
	if (home) await removeWithRetries(home);
});

function entry(hostId: string, endpoint: string, overrides: Partial<SessionHostEntry> = {}): SessionHostEntry {
	return {
		version: SESSION_HOST_REGISTRY_VERSION,
		hostId,
		pid: process.pid,
		endpoint,
		token: "secret-token-".repeat(5),
		cwd: home,
		sessionFile: undefined,
		title: undefined,
		clients: 0,
		busy: false,
		startedAt: Date.now(),
		...overrides,
	};
}

async function attach(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", CLI, "attach", ...args], {
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			PI_CONFIG_DIR: CONFIG_DIR_NAME,
			PI_CODING_AGENT_DIR: path.join(home, CONFIG_DIR_NAME, "agent"),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	return { stdout, stderr, exitCode };
}

/** A listening in-process stand-in for a live host; closed in `afterEach`. */
async function listen(dir: string, hostId: string): Promise<string> {
	await ensurePrivateDir(dir, "test");
	const endpoint = await privateEndpoint(dir, hostId, { prefix: "host", label: "test" });
	server = net.createServer(socket => socket.on("error", () => {}));
	const listening = Promise.withResolvers<void>();
	server.listen(endpoint, () => listening.resolve());
	await listening.promise;
	return endpoint;
}

describe("omp attach", () => {
	it("prints a tokenless JSON array of live hosts and prunes dead ones", async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-"));
		const dir = path.join(home, CONFIG_DIR_NAME, "run", "session-hosts");
		const endpoint = await listen(dir, LIVE_ID);
		await writeHostEntry(entry(LIVE_ID, endpoint, { title: "demo", clients: 2, busy: true }), dir);
		await writeHostEntry(entry(DEAD_ID, path.join(dir, "gone.sock")), dir);

		const { stdout, stderr, exitCode } = await attach("--json");
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		const hosts = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(hosts.map(h => h.hostId)).toEqual([LIVE_ID]);
		expect(hosts[0]).toMatchObject({ endpoint, title: "demo", clients: 2, busy: true });
		expect("token" in hosts[0]).toBe(false);
		expect(stdout).not.toContain("secret-token");
		expect(await Bun.file(path.join(dir, `${DEAD_ID}.json`)).exists()).toBe(false);

		const human = await attach();
		expect(human.exitCode).toBe(0);
		expect(human.stdout).toBe(`${LIVE_ID}  2  busy  ${home}  demo\n`);
	});

	it("strips control sequences and newlines from registry text so a hostile entry cannot forge rows", async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-"));
		const dir = path.join(home, CONFIG_DIR_NAME, "run", "session-hosts");
		const endpoint = await listen(dir, LIVE_ID);
		const title = `evil\x1b]0;pwned\x07\x1b[31m red\n${DEAD_ID}  0  idle  /forged  row`;
		await writeHostEntry(entry(LIVE_ID, endpoint, { title }), dir);

		const { stdout, exitCode } = await attach();
		expect(exitCode).toBe(0);
		expect(stdout).not.toContain("\x1b");
		expect(stdout).not.toContain("\x07");
		expect(stdout.split("\n")).toEqual([expect.stringMatching(new RegExp(`^${LIVE_ID}  0  idle  `)), ""]);
	});

	it("reports an empty registry", async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-"));
		const { stdout, exitCode } = await attach();
		expect(exitCode).toBe(0);
		expect(stdout).toBe("No session hosts running.\n");
	});

	it("accepts a target but requires a terminal to open its TUI", async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-"));
		const { exitCode, stderr } = await attach("some-target");
		expect(exitCode).toBe(1);
		expect(stderr).toContain("attach <target> requires an interactive terminal");
	});

	it("keeps --json as a listing-only option", async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-"));
		const { exitCode, stderr } = await attach("--json", "some-target");
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("--json lists session hosts and takes no target");
	});
});
