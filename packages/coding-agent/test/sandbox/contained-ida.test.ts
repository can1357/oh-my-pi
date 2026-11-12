/**
 * IDA under the OS sandbox: the bytes omp reads from a binary (header sniff, content hash, the
 * store staging copy) come through the contained host's verified handle, and the Python worker that
 * opens and saves databases and runs `exec` code is spawned inside the container. idalib is not
 * needed: the worker runs against stub modules. The contained cases skip where no backend exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { containedIdaSpawnRequest, containedIdaWorkerSpawner } from "@oh-my-pi/pi-coding-agent/ida/contained";
import { type IdbLocation, isExecutableFile, locateIdb, prepareStoreDir } from "@oh-my-pi/pi-coding-agent/ida/store";
import { IdaWorker } from "@oh-my-pi/pi-coding-agent/ida/supervisor";
import { withContainedFileAccess } from "@oh-my-pi/pi-coding-agent/sandbox/file-access";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
	cfgSandboxNetworkMode,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as natives from "@oh-my-pi/pi-natives";
import { acquireFileLock, TempDir } from "@oh-my-pi/pi-utils";
import { writeIdaStubs } from "../helpers/ida-stub";
import { TEST_PYTHON } from "../helpers/python";
import { CONTAINED_SOURCE_RUNS } from "../helpers/sandbox-test-state";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";

const supported =
	typeof natives.sandboxSupport === "function" &&
	typeof natives.SandboxProcess === "function" &&
	natives.sandboxSupport().supported;

/** Header of an ELF file: enough for `isExecutableHeader`. */
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60, 1)]);

let state: SettingsTestState | undefined;
let settings: Settings;
let scratch: TempDir;
/** `<scratch>/workspace`, realpath'd. */
let workspace: string;
/** `<scratch>/outside`: not writable when contained; readable unless denied. */
let outside: string;
/** `<scratch>/store`: where store databases live (omp-owned). */
let store: string;
let sessionKey: string;
let sessionCounter = 0;

function toolSession(): ToolSession {
	return {
		cwd: workspace,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => sessionKey,
		getArtifactsDir: () => path.join(path.dirname(workspace), "artifacts"),
		settings: Settings.isolated({ "lsp.enabled": false }),
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

/** The rejection of `promise`, settled before any `expect` (see contained-file-access.test.ts). */
function failure(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

function storeLocation(sourcePath: string, id: string): IdbLocation {
	const dir = path.join(store, id);
	return {
		id,
		dir,
		sourcePath,
		kind: "store",
		openPath: path.join(dir, path.basename(sourcePath)),
		isNew: true,
		lockTarget: path.join(dir, "db"),
	};
}

beforeEach(async () => {
	state = beginSettingsTest();
	restoreEnvValue("PI_SANDBOX", undefined);
	// Not under the OS temp dir: on Linux the sandbox hides the host's /tmp.
	scratch = TempDir.createSync(path.join(os.homedir(), ".omp-contained-ida-"));
	const root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	outside = path.join(root, "outside");
	store = path.join(root, "store");
	const tmp = path.join(root, "tmp");
	for (const dir of [workspace, outside, store, tmp, path.join(root, "artifacts")]) fs.mkdirSync(dir);
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	settings = await Settings.init({ inMemory: true, cwd: workspace });
	cfgSandboxNetworkMode.set(settings, "deny");
	cfgSandboxEnabled.set(settings, true);
	sessionKey = `contained-ida-test-${++sessionCounter}`;
	SandboxRuntime.resetForTest();
});

afterEach(async () => {
	try {
		releaseShellSessions(sessionKey);
		await (await SandboxRuntime.for(workspace)).dispose();
		SandboxRuntime.resetForTest();
	} finally {
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		scratch.removeSync();
	}
});

describe("the contained IDA worker's spawn request", () => {
	it("reads the interpreter, the staged script and the IDA directories; writes only a store database's directory", async () => {
		const script = path.join(os.tmpdir(), "omp-ida-worker-1", "runner-abc.py");
		const venv = path.join(os.homedir(), ".venvs", "ida");
		const install = path.join(os.homedir(), "ida-9");
		const userDirs = [path.join(os.homedir(), ".idapro"), path.join(os.homedir(), ".idapro-extra")];
		const runtime = {
			pythonPath: path.join(venv, "bin", "python"),
			env: { VIRTUAL_ENV: venv, IDADIR: install, IDAUSR: userDirs.join(path.delimiter), PATH: "/usr/bin" },
		};

		const inStore = await containedIdaSpawnRequest(
			storeLocation(path.join(outside, "prog.bin"), "s1"),
			runtime,
			script,
		);
		expect(inStore.argv).toEqual([runtime.pythonPath, "-u", script]);
		expect(inStore.cwd).toBe(path.join(store, "s1"));
		expect(inStore.extraWrite).toEqual([path.join(store, "s1")]);
		expect(inStore.extraRead).toEqual(expect.arrayContaining([path.dirname(script), venv, install, ...userDirs]));
		// The wrapper cannot be sent SIGINT: the worker takes interrupts as stdin frames.
		expect(inStore.env.OMP_IDA_FRAME_INTERRUPTS).toBe("1");
		expect(inStore.env.IDADIR).toBe(install);

		// An in-place database is writable only where the sandbox policy already lets the workspace write.
		const inPlace: IdbLocation = {
			id: "p1",
			dir: workspace,
			sourcePath: path.join(workspace, "prog.i64"),
			kind: "inplace",
			openPath: path.join(workspace, "prog.i64"),
			isNew: false,
			lockTarget: path.join(workspace, "prog.i64"),
		};
		const request = await containedIdaSpawnRequest(inPlace, runtime, script);
		expect(request.cwd).toBe(workspace);
		expect(request.extraWrite ?? []).toEqual([]);
	});
});

describe.skipIf(!supported || !CONTAINED_SOURCE_RUNS)("omp's reads of a binary in the sandbox", () => {
	it("hashes and sniffs a workspace binary but refuses a symlink to a denied one", async () => {
		const secret = path.join(outside, "secret.bin");
		fs.writeFileSync(secret, ELF);
		fs.writeFileSync(path.join(workspace, "prog.bin"), ELF);
		fs.symlinkSync(secret, path.join(workspace, "link.bin"));
		cfgSandboxDenyRead.set(settings, [outside]);
		await withContainedFileAccess(toolSession(), async () => {
			// Called directly, so omp's path check never runs: the container must refuse the symlink.
			const located = await locateIdb(path.join(workspace, "prog.bin"));
			expect(located.kind).toBe("store");
			expect(located.id.endsWith("-prog.bin")).toBe(true);
			expect(await isExecutableFile(path.join(workspace, "prog.bin"))).toBe(true);
			expect(await failure(locateIdb(path.join(workspace, "link.bin")))).toBeInstanceOf(Error);
			expect(await isExecutableFile(path.join(workspace, "link.bin"))).toBe(false);
		});
	});

	it("stages a workspace binary into the store and refuses a symlink to a denied one, leaving nothing staged", async () => {
		const secret = path.join(outside, "secret.bin");
		const payload = Buffer.concat([ELF, Buffer.alloc(3 * 1024 * 1024, 7)]);
		fs.writeFileSync(secret, payload);
		fs.writeFileSync(path.join(workspace, "prog.bin"), payload);
		fs.symlinkSync(secret, path.join(workspace, "link.bin"));
		cfgSandboxDenyRead.set(settings, [outside]);
		await withContainedFileAccess(toolSession(), async () => {
			const ok = storeLocation(path.join(workspace, "prog.bin"), "ok");
			await prepareStoreDir(ok);
			expect(fs.readFileSync(path.join(ok.dir, "prog.bin")).equals(payload)).toBe(true);
			expect(ok.isNew).toBe(true);

			const denied = storeLocation(path.join(workspace, "link.bin"), "denied");
			expect(await failure(prepareStoreDir(denied))).toBeInstanceOf(Error);
			expect(fs.existsSync(path.join(denied.dir, "link.bin"))).toBe(false);
		});
	});
});

describe.skipIf(!supported || !CONTAINED_SOURCE_RUNS || !TEST_PYTHON)("the IDA worker in the sandbox", () => {
	it("runs contained: writes its store directory, is refused elsewhere, and still takes interrupts", async () => {
		const stubs = path.join(workspace, "stubs");
		await writeIdaStubs(stubs);
		const secret = path.join(outside, "secret.txt");
		fs.writeFileSync(secret, "top secret\n");
		cfgSandboxDenyRead.set(settings, [secret]);
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
		Object.assign(env, { PYTHONPATH: stubs, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" });
		const loc = storeLocation(path.join(workspace, "stub.bin"), "worker");
		fs.mkdirSync(loc.dir);
		loc.openPath = path.join(loc.dir, "stub.bin.i64");
		loc.isNew = false;
		const lock = await acquireFileLock(loc.lockTarget);
		const sandbox = await SandboxRuntime.for(workspace);
		const worker = await IdaWorker.start(loc, { pythonPath: TEST_PYTHON!, env }, lock, 0, {
			spawn: containedIdaWorkerSpawner(sandbox),
			onStderr: () => {},
		});
		try {
			const exec = (code: string, timeoutMs?: number) =>
				worker.request<{ output: string; value: string | null; error: string | null }>(
					"exec",
					{ code },
					{ timeoutMs },
				);
			const inside = path.join(loc.dir, "written.txt");
			const stray = path.join(outside, "stray.txt");
			expect((await exec(`open(${JSON.stringify(inside)}, "w").write("ok")`)).error).toBeNull();
			expect(fs.readFileSync(inside, "utf8")).toBe("ok");

			const refusedWrite = await exec(`open(${JSON.stringify(stray)}, "w").write("x")`);
			expect(refusedWrite.error).not.toBeNull();
			expect(fs.existsSync(stray)).toBe(false);

			const refusedRead = await exec(`print(open(${JSON.stringify(secret)}).read())`);
			expect(refusedRead.error).not.toBeNull();
			expect(JSON.stringify(refusedRead)).not.toContain("top secret");

			// The sandbox wrapper cannot be sent SIGINT; the interrupt frame must still stop a running exec.
			const interrupted = await exec("while True: pass", 500);
			expect(interrupted.error).toContain("KeyboardInterrupt");
			expect((await exec("6 * 7")).value).toBe("42");
		} finally {
			await worker.close({ save: false }).catch(() => {});
		}
	});
});
