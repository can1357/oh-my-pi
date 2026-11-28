import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const SRC = path.resolve(import.meta.dir, "../src");

const sharedAuthStorage = createInMemoryAuthStorage();
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * `omp render` opens a copy of a live session: same session id, another omp process. Its
 * teardown must leave the live process's bash leftovers alone.
 */
describe.skipIf(process.platform === "win32")("AgentSession leftovers of another omp process", () => {
	let tempDir: TempDir;
	let worker: Subprocess | undefined;
	let leftoverPid = 0;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-foreign-leftovers-");
		worker = undefined;
		leftoverPid = 0;
	});

	afterEach(async () => {
		worker?.kill("SIGKILL");
		if (leftoverPid > 0) {
			try {
				process.kill(leftoverPid, "SIGKILL");
			} catch {}
		}
		try {
			await tempDir.remove();
		} catch {}
	});

	/** Another omp process whose bash tool leaves `cmd &` running under `sessionId`; resolves with that leftover's pid. */
	async function startForeignLeftover(sessionId: string): Promise<number> {
		const dir = tempDir.path();
		const pidFile = path.join(dir, "leftover.pid");

		await Bun.write(
			path.join(dir, "sleeper.ts"),
			`await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));\nawait Bun.sleep(300_000);\n`,
		);
		// The live omp: its bash tool leaves `cmd &` running, then it keeps going.
		await Bun.write(
			path.join(dir, "worker.ts"),
			`import { Settings } from ${JSON.stringify(`${SRC}/config/settings`)};
import { BashTool } from ${JSON.stringify(`${SRC}/tools/bash`)};
const tool = new BashTool({
	cwd: ${JSON.stringify(dir)},
	hasUI: false,
	skills: [],
	getSessionFile: () => null,
	getSessionId: () => ${JSON.stringify(sessionId)},
	settings: Settings.isolated({
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"bashInterceptor.enabled": false,
	}),
	getClientBridge: () => undefined,
} as never);
await tool.execute("call-bg", {
	command: ${JSON.stringify(`'${process.execPath}' '${path.join(dir, "sleeper.ts")}' >/dev/null 2>&1 &`)},
});
await Bun.sleep(300_000);
`,
		);
		worker = Bun.spawn([process.execPath, path.join(dir, "worker.ts")], {
			cwd: dir,
			stdio: ["ignore", "ignore", "inherit"],
		});

		// A separate process's spawn has no event to await here: poll its pid file, bounded at
		// ~30s (the worker imports the bash tool cold).
		for (let i = 0; i < 3000 && !leftoverPid; i++) {
			await Bun.sleep(10);
			if (fs.existsSync(pidFile)) leftoverPid = Number(fs.readFileSync(pidFile, "utf8")) || 0;
		}
		expect(leftoverPid).toBeGreaterThan(0);
		if (process.platform === "linux") {
			// Tagged as a leftover of this session id.
			expect(fs.readFileSync(`/proc/${leftoverPid}/environ`, "utf8")).toContain(`OMP_BASH_SESSION=${sessionId}`);
		}
		return leftoverPid;
	}

	/** A session with `sessionManager`'s id in this process, reaping on (the default), disposed. */
	async function disposeSession(sessionManager: SessionManager): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: sharedModelRegistry,
		});
		await session.dispose();
	}

	it("does not reap a process another live omp's bash call left running under the same session id", async () => {
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const pid = await startForeignLeftover(sessionManager.getSessionId());

		await disposeSession(sessionManager);
		// Proving a kill did not happen needs a real window: the SIGKILL would have landed in it.
		await Bun.sleep(200);
		expect(alive(pid)).toBe(true);
	}, 60_000);

	it("reaps the `&` leftover of an omp that died without its session-end reap", async () => {
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const pid = await startForeignLeftover(sessionManager.getSessionId());
		worker?.kill("SIGKILL");
		await worker?.exited;
		expect(alive(pid)).toBe(true);

		await disposeSession(sessionManager);
		// The SIGKILL is sent before dispose resolves; the process table drops the pid once it lands.
		for (let i = 0; i < 500 && alive(pid); i++) await Bun.sleep(10);
		expect(alive(pid)).toBe(false);
	}, 60_000);
});
