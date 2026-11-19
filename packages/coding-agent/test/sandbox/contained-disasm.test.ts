/**
 * Disassemblers under the OS sandbox: the bytes omp reads from a binary (header sniff, content hash,
 * the store staging copy) come through the contained host's verified handle, and the Python worker
 * that opens and saves databases and runs `exec` code is spawned inside the container, its unit
 * hosted in this omp process instead of the daemon. idalib is not needed: the worker runs against
 * stub modules. The contained cases skip where no backend exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DISASM_BACKENDS, type WorkerRuntime } from "@oh-my-pi/pi-coding-agent/disasm/backend";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/daemon/client";
import { openLocalDisasmUnit } from "@oh-my-pi/pi-coding-agent/daemon/modules/disasm";
import {
	acquireDatabase,
	findDatabaseHandle,
	findOpenDatabase,
	listDatabases,
	reachesDatabase,
	releaseDatabases,
} from "@oh-my-pi/pi-coding-agent/disasm/client";
import {
	containedWorkerSpawner,
	containedWorkerSpawnRequest,
	workerEndpointDir,
} from "@oh-my-pi/pi-coding-agent/disasm/contained";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { parseDatabaseHandle } from "@oh-my-pi/pi-coding-agent/disasm/protocol";
import * as disasmRuntime from "@oh-my-pi/pi-coding-agent/disasm/runtime";
import {
	type DatabaseLocation,
	isExecutableFile,
	locateDatabase,
	prepareStoreDir,
} from "@oh-my-pi/pi-coding-agent/disasm/store";
import { DisasmWorker, type WorkerSpawnSpec } from "@oh-my-pi/pi-coding-agent/disasm/supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { withContainedFileAccess } from "@oh-my-pi/pi-coding-agent/sandbox/file-access";
import { sandboxCallDenial } from "@oh-my-pi/pi-coding-agent/sandbox/gate";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxAllowWrite,
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { acquireFileLock, isFileLockHeld, setAgentDir } from "@oh-my-pi/pi-utils";
import { createIdaWorkerRuntime } from "../helpers/ida-worker";
import { TEST_PYTHON } from "../helpers/python";
import {
	beginContainedSandboxTest,
	CONTAINED_SOURCE_RUNS,
	type ContainedSandboxTest,
	containedToolSession,
	endContainedSandboxTest,
	failure,
	SANDBOX_BACKEND_PRESENT,
} from "../helpers/sandbox-test-state";

const IDA = DISASM_BACKENDS.ida;
/** Header of an ELF file: enough for `isExecutableHeader`. */
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60, 1)]);

interface ExecResult {
	output: string;
	value: string | null;
	error: string | null;
}

let contained: ContainedSandboxTest;
let settings: Settings;
/** `<root>/workspace`. */
let workspace: string;
/** `<root>/outside`: not writable when contained; readable unless denied. */
let outside: string;
/** `<root>/store`: where store databases live (omp-owned). */
let store: string;

function storeLocation(sourcePath: string, id: string): DatabaseLocation {
	const dir = path.join(store, id);
	const stagedPath = path.join(dir, path.basename(sourcePath));
	return {
		id,
		dir,
		sourcePath,
		stagedPath,
		kind: "store",
		openPath: stagedPath,
		isNew: true,
		lockTarget: path.join(dir, "db"),
	};
}

beforeEach(async () => {
	contained = await beginContainedSandboxTest("contained-disasm");
	({ settings, workspace, outside } = contained);
	store = path.join(path.dirname(workspace), "store");
	fs.mkdirSync(store);
});

afterEach(async () => {
	try {
		await releaseDatabases();
	} finally {
		await endContainedSandboxTest(contained);
	}
});

describe("the contained disassembler worker's spawn request", () => {
	it("reads the interpreter, the staged script and the backend install; writes only its endpoint's and a store database's directory", async () => {
		const script = path.join(os.tmpdir(), "omp-ida-worker-1", "runner-abc.py");
		const venv = path.join(os.homedir(), ".venvs", "ida");
		const install = path.join(os.homedir(), "ida-9");
		const userDirs = [path.join(os.homedir(), ".idapro"), path.join(os.homedir(), ".idapro-extra")];
		const runtime: WorkerRuntime = {
			pythonPath: path.join(venv, "bin", "python"),
			env: { VIRTUAL_ENV: venv, IDADIR: install, IDAUSR: userDirs.join(path.delimiter), PATH: "/usr/bin" },
		};
		const endpointDir = path.join(os.tmpdir(), "omp-dsm-x");
		const endpoint = path.join(endpointDir, "worker.sock");
		const spec = (loc: DatabaseLocation, workerRuntime = runtime): WorkerSpawnSpec => ({
			backend: IDA,
			loc,
			runtime: workerRuntime,
			script,
			args: ["--socket", endpoint],
			endpoint,
			env: { ...workerRuntime.env, OMP_DISASM_WORKER_TOKEN: "token" },
		});

		const inStore = await containedWorkerSpawnRequest(spec(storeLocation(path.join(outside, "prog.bin"), "s1")));
		expect(inStore.cwd).toBe(path.join(store, "s1"));
		expect(inStore.argv).toEqual([runtime.pythonPath, "-u", script, "--socket", endpoint]);
		expect(inStore.env.OMP_DISASM_WORKER_TOKEN).toBe("token");
		expect(inStore.extraWrite).toEqual([endpointDir, path.join(store, "s1")]);
		expect(inStore.extraRead).toEqual(expect.arrayContaining([path.dirname(script), venv, install, ...userDirs]));

		// Ghidra needs its install and the JDK it runs on.
		const ghidraHome = path.join(os.homedir(), "ghidra_12");
		const jdk = path.join(os.homedir(), "jdk-25");
		const ghidra = await containedWorkerSpawnRequest({
			...spec(storeLocation(path.join(outside, "prog.bin"), "g1"), {
				pythonPath: runtime.pythonPath,
				env: { GHIDRA_INSTALL_DIR: ghidraHome, JAVA_HOME: jdk },
			}),
			backend: DISASM_BACKENDS.ghidra,
		});
		expect(ghidra.extraRead).toEqual(expect.arrayContaining([ghidraHome, jdk]));

		// An in-place database is writable only where the sandbox policy already lets the workspace write.
		const inPlace: DatabaseLocation = {
			id: "p1",
			dir: workspace,
			sourcePath: path.join(workspace, "prog.i64"),
			stagedPath: path.join(workspace, "prog.i64"),
			kind: "inplace",
			openPath: path.join(workspace, "prog.i64"),
			isNew: false,
			lockTarget: path.join(workspace, "prog.i64"),
		};
		const request = await containedWorkerSpawnRequest(spec(inPlace));
		expect(request.cwd).toBe(workspace);
		expect(request.extraWrite).toEqual([endpointDir]);
	});
});

describe("looking up an open database without the sandbox", () => {
	it("rejects when the daemon client cannot be created, instead of reporting no database", async () => {
		cfgSandboxEnabled.set(settings, false);
		vi.spyOn(daemonClient, "daemonClient").mockRejectedValue(new Error("daemon token unreadable"));
		const error = await failure(findOpenDatabase(containedToolSession(contained), "ida", "some-database"));
		expect((error as Error | undefined)?.message).toBe("daemon token unreadable");
	});

	it("follows the session's own settings, not the process's, in choosing where databases live", async () => {
		// The process enables the sandbox; this session's settings do not.
		const session = { ...containedToolSession(contained), settings: Settings.isolated({ "sandbox.enabled": false }) };
		vi.spyOn(daemonClient, "daemonClient").mockRejectedValue(new Error("daemon used"));
		const error = await failure(findOpenDatabase(session as ToolSession, "ida", "some-database"));
		expect((error as Error | undefined)?.message).toBe("daemon used");
	});
});

describe.skipIf(!SANDBOX_BACKEND_PRESENT || !CONTAINED_SOURCE_RUNS)("omp's reads of a binary in the sandbox", () => {
	it("hashes, sniffs and stages a workspace binary but refuses a symlink to a denied one, leaving nothing staged", async () => {
		const secret = path.join(outside, "secret.bin");
		const payload = Buffer.concat([ELF, Buffer.alloc(3 * 1024 * 1024, 7)]);
		fs.writeFileSync(secret, payload);
		fs.writeFileSync(path.join(workspace, "prog.bin"), payload);
		fs.symlinkSync(secret, path.join(workspace, "link.bin"));
		cfgSandboxDenyRead.set(settings, [outside]);
		await withContainedFileAccess(containedToolSession(contained), async () => {
			// Called directly, so omp's path check never runs: the container must refuse the symlink.
			const located = await locateDatabase(IDA, path.join(workspace, "prog.bin"));
			expect(located.kind).toBe("store");
			expect(await isExecutableFile(path.join(workspace, "prog.bin"))).toBe(true);
			expect(await failure(locateDatabase(IDA, path.join(workspace, "link.bin")))).toBeInstanceOf(Error);
			expect(await isExecutableFile(path.join(workspace, "link.bin"))).toBe(false);

			const ok = storeLocation(path.join(workspace, "prog.bin"), "ok");
			await prepareStoreDir(IDA, ok);
			expect(fs.readFileSync(ok.stagedPath).equals(payload)).toBe(true);
			expect(ok.isNew).toBe(true);

			const denied = storeLocation(path.join(workspace, "link.bin"), "denied");
			expect(await failure(prepareStoreDir(IDA, denied))).toBeInstanceOf(Error);
			expect(fs.existsSync(denied.stagedPath)).toBe(false);
		});
	});
});

describe.skipIf(!SANDBOX_BACKEND_PRESENT)("the contained worker's endpoint directory", () => {
	it("is made in the temp dir unless contained processes may write there, then in the agent dir, else refused", async () => {
		const agentDir = path.join(path.dirname(workspace), "agent");
		fs.mkdirSync(agentDir);
		setAgentDir(agentDir);
		const sandbox = await SandboxRuntime.for(workspace);
		const inTemp = await workerEndpointDir(sandbox);
		expect(path.dirname(inTemp)).toBe(fs.realpathSync(os.tmpdir()));

		cfgSandboxAllowWrite.set(settings, [os.tmpdir()]);
		const inAgentDir = await workerEndpointDir(sandbox);
		expect(path.dirname(inAgentDir)).toBe(fs.realpathSync(agentDir));

		cfgSandboxAllowWrite.set(settings, [os.tmpdir(), agentDir]);
		const error = await failure(workerEndpointDir(sandbox));
		expect((error as Error | undefined)?.message).toContain("needs a directory they cannot write");
		// Refused candidates are removed again.
		expect(fs.readdirSync(os.tmpdir()).filter(entry => entry.startsWith("omp-dsm-"))).toEqual([
			path.basename(inTemp),
		]);
		expect(fs.readdirSync(agentDir).filter(entry => entry.startsWith("omp-dsm-"))).toEqual([
			path.basename(inAgentDir),
		]);
	});
});

describe.skipIf(!SANDBOX_BACKEND_PRESENT)("an in-place database's lock in the in-process unit", () => {
	/** An in-process unit for the in-place database `db`, whose worker spawn only reports that it was reached. */
	function inplaceUnit(db: string): { failure: Promise<unknown>; spawned: string[] } {
		const spawned: string[] = [];
		const loc: DatabaseLocation = {
			id: "inplace-lock",
			dir: path.dirname(db),
			sourcePath: db,
			stagedPath: db,
			kind: "inplace",
			openPath: db,
			isNew: false,
			lockTarget: db,
		};
		const unit = openLocalDisasmUnit(
			"local:inplace-lock",
			{ backend: "ida", loc, runtime: { pythonPath: "python3", env: {} }, idleCloseMs: 0, maxOpen: 1 },
			{
				files: async () => ({ endpoint: path.join(store, "dsm.sock") }),
				prepare: async () => {},
				spawn: {
					spawn: async () => {
						// The unit holds the database's lock by now.
						spawned.push(isFileLockHeld(db) ? "locked" : "unlocked");
						throw new Error("spawn reached");
					},
				},
				lockDenial: async dir =>
					sandboxCallDenial({
						settings,
						workspace,
						name: "IDA database",
						subjects: () => [{ kind: "write", target: dir }],
						requestTool: () => true,
					}),
			},
			() => {},
		);
		return { failure: failure(unit.opened()), spawned };
	}

	it("is refused, creating no lock file, when the database's directory is outside the writable roots, even if the file itself is granted", async () => {
		const db = path.join(outside, "locked.i64");
		fs.writeFileSync(db, "idb");
		const refused = inplaceUnit(db);

		expect(((await refused.failure) as Error).message).toContain("outside the sandbox's writable roots");
		expect(refused.spawned).toEqual([]);
		expect(fs.existsSync(`${db}.lock`)).toBe(false);

		const fileOnly = path.join(outside, "file-only.i64");
		fs.writeFileSync(fileOnly, "idb");
		cfgSandboxAllowWrite.set(settings, [fileOnly]);
		const granted = inplaceUnit(fileOnly);

		expect(((await granted.failure) as Error).message).toContain(
			`${outside} is outside the sandbox's writable roots`,
		);
		expect(granted.spawned).toEqual([]);
	});

	it("still takes its lock next to the database where the workspace may write", async () => {
		const db = path.join(workspace, "writable.i64");
		fs.writeFileSync(db, "idb");
		const { failure: opened, spawned } = inplaceUnit(db);

		expect(((await opened) as Error).message).toContain("spawn reached");
		expect(spawned).toEqual(["locked"]);
	});
});

describe.skipIf(!SANDBOX_BACKEND_PRESENT || !CONTAINED_SOURCE_RUNS || !TEST_PYTHON)(
	"the disassembler worker in the sandbox",
	() => {
		it("runs contained: writes its store directory, is refused elsewhere, and still takes interrupts", async () => {
			const runtime = await createIdaWorkerRuntime(workspace);
			const loc = storeLocation(path.join(workspace, "stub.bin"), "worker");
			fs.mkdirSync(loc.dir);
			loc.openPath = path.join(loc.dir, "stub.bin.i64");
			loc.isNew = false;
			const lock = await acquireFileLock(loc.lockTarget);
			const sandbox = await SandboxRuntime.for(workspace);
			const endpointDir = await workerEndpointDir(sandbox);
			const worker = await DisasmWorker.spawn(
				IDA,
				loc,
				runtime,
				lock,
				{ endpoint: path.join(endpointDir, process.platform === "win32" ? "worker.port" : "worker.sock") },
				{ spawn: containedWorkerSpawner(sandbox), aliasRoot: sandbox.tempDir() },
			);
			try {
				await worker.open(loc);
				const exec = (code: string, timeoutMs?: number) =>
					worker.request<ExecResult>("exec", { code }, { timeoutMs });
				const inside = path.join(loc.dir, "written.txt");
				const stray = path.join(outside, "stray.txt");
				expect((await exec(`open(${JSON.stringify(inside)}, "w").write("ok")`)).error).toBeNull();
				expect(fs.readFileSync(inside, "utf8")).toBe("ok");

				const refusedWrite = await exec(`open(${JSON.stringify(stray)}, "w").write("x")`);
				expect(refusedWrite.error).not.toBeNull();
				expect(fs.existsSync(stray)).toBe(false);

				// The sandbox wrapper cannot be sent SIGINT; the interrupt frame must still stop a running exec.
				const interrupted = await exec("while True: pass", 500);
				expect(interrupted.error).toContain("KeyboardInterrupt");
				expect((await exec("6 * 7")).value).toBe("42");
			} finally {
				await worker.close({ save: false }).catch(() => {});
				fs.rmSync(endpointDir, { recursive: true, force: true });
			}
		});

		it("hosts a database in this process, never the daemon, and ends it on release", async () => {
			setAgentDir(path.join(path.dirname(workspace), "agent"));
			vi.spyOn(disasmRuntime, "resolveWorkerRuntime").mockResolvedValue(await createIdaWorkerRuntime(workspace));
			const daemon = vi.spyOn(daemonClient, "daemonClient").mockRejectedValue(new Error("daemon used"));
			const binary = path.join(workspace, "prog.bin");
			fs.writeFileSync(binary, ELF);
			const session = { ...containedToolSession(contained), settings } as ToolSession;

			const db = await withContainedFileAccess(session, () => acquireDatabase(session, "ida", binary));
			expect(db.status.state).toBe("open");
			const stray = path.join(outside, "stray.txt");
			const refused = await db.request<ExecResult>("exec", {
				code: `open(${JSON.stringify(stray)}, "w").write("x")`,
			});
			expect(refused.error).not.toBeNull();
			expect(fs.existsSync(stray)).toBe(false);

			expect((await listDatabases(session, "ida")).map(open => open.handle)).toEqual([db.handle]);
			expect(await findDatabaseHandle(session, parseDatabaseHandle(db.handle)!)).toBe(db);
			expect(await reachesDatabase(session, db)).toBe(true);
			// Without the sandbox the session reaches the daemon's databases only, never this process's.
			cfgSandboxEnabled.set(settings, false);
			expect(await reachesDatabase(session, db)).toBe(false);
			cfgSandboxEnabled.set(settings, true);

			await releaseDatabases();
			expect(db.connected).toBe(false);
			expect(await listDatabases(session, "ida")).toEqual([]);
			expect(daemon).not.toHaveBeenCalled();
		});

		it("listens where no other contained process can replace the endpoint or plant one beside it", async () => {
			setAgentDir(path.join(path.dirname(workspace), "agent"));
			vi.spyOn(disasmRuntime, "resolveWorkerRuntime").mockResolvedValue(await createIdaWorkerRuntime(workspace));
			const binary = path.join(workspace, "prog.bin");
			fs.writeFileSync(binary, ELF);
			const session = { ...containedToolSession(contained), settings } as ToolSession;
			const db = await withContainedFileAccess(session, () => acquireDatabase(session, "ida", binary));
			const listening = await db.request<ExecResult>("exec", {
				code: "import sys\nflag = '--socket' if '--socket' in sys.argv else '--port-file'\nprint(sys.argv[sys.argv.index(flag) + 1])",
			});
			const endpoint = listening.output.trim();
			const sandbox = await SandboxRuntime.for(workspace);
			expect(path.isAbsolute(endpoint)).toBe(true);
			expect(endpoint.startsWith(`${sandbox.tempDir()}${path.sep}`)).toBe(false);

			const planted = path.join(path.dirname(endpoint), "planted");
			const hijack = await executeBash(`mv '${endpoint}' '${endpoint}.moved'; : > '${planted}'`, {
				cwd: workspace,
				sessionKey: contained.sessionKey,
				sandboxWorkspace: workspace,
			});
			expect(hijack.exitCode).not.toBe(0);
			expect(fs.existsSync(endpoint)).toBe(true);
			expect(fs.existsSync(planted)).toBe(false);
			expect((await db.request<ExecResult>("exec", { code: "6 * 7" })).value).toBe("42");

			// The release removes the endpoint's directory before it returns.
			await releaseDatabases();
			expect(fs.existsSync(path.dirname(endpoint))).toBe(false);
		});

		it("quotes the worker's last output when it exits, never a file planted at its log path", async () => {
			const runtime = await createIdaWorkerRuntime(workspace);
			const loc = storeLocation(path.join(workspace, "stub.bin"), "exiting");
			fs.mkdirSync(loc.dir);
			loc.openPath = path.join(loc.dir, "stub.bin.i64");
			loc.isNew = false;
			const lock = await acquireFileLock(loc.lockTarget);
			const sandbox = await SandboxRuntime.for(workspace);
			const endpointDir = await workerEndpointDir(sandbox);
			// A log path every contained process may write, as one beside the socket in the sandbox's temp dir was.
			const logPath = path.join(sandbox.tempDir(), "worker.log");
			const worker = await DisasmWorker.spawn(
				IDA,
				loc,
				runtime,
				lock,
				{ endpoint: path.join(endpointDir, process.platform === "win32" ? "worker.port" : "worker.sock"), logPath },
				{ spawn: containedWorkerSpawner(sandbox), aliasRoot: sandbox.tempDir() },
			);
			const secret = path.join(outside, "secret.txt");
			fs.writeFileSync(secret, "TOP-SECRET-HOST-FILE\n");
			try {
				await worker.open(loc);
				// Contained code swaps the log for a link to a host file, writes its last words and exits.
				const code = [
					"import os, threading",
					`if os.path.lexists(${JSON.stringify(logPath)}): os.remove(${JSON.stringify(logPath)})`,
					`os.symlink(${JSON.stringify(secret)}, ${JSON.stringify(logPath)})`,
					"os.write(2, b'worker-last-words\\n')",
					"threading.Timer(0.2, lambda: os._exit(1)).start()",
				].join("\n");
				expect((await worker.request<ExecResult>("exec", { code })).error).toBeNull();
				await worker.exited;
				// The exit error gains the output tail once the exit handler drained the streams; no signal
				// exposes that handler's end, and a live contained worker's I/O cannot run on fake timers.
				let message = "";
				for (const deadline = Date.now() + 5_000; Date.now() < deadline; await Bun.sleep(100)) {
					message = ((await failure(worker.request("status", {}))) as Error).message;
					if (/exited \(code 1\): /.test(message)) break;
				}
				expect(message).toContain("worker-last-words");
				expect(message).not.toContain("TOP-SECRET-HOST-FILE");
			} finally {
				await worker.kill();
				fs.rmSync(endpointDir, { recursive: true, force: true });
			}
		});

		/** A contained session with the given disassembler settings and a stub worker; `open(name)` acquires a fresh binary. */
		async function inProcessDatabases(overrides: Record<string, number>) {
			setAgentDir(path.join(path.dirname(workspace), "agent"));
			vi.spyOn(disasmRuntime, "resolveWorkerRuntime").mockResolvedValue(await createIdaWorkerRuntime(workspace));
			const session = {
				...containedToolSession(contained),
				settings: Settings.isolated({ "lsp.enabled": false, "sandbox.enabled": true, ...overrides }),
			} as ToolSession;
			let variant = 0;
			const open = (name: string) => {
				const binary = path.join(workspace, name);
				// Distinct contents: distinct databases.
				fs.writeFileSync(binary, Buffer.concat([ELF, Buffer.from([++variant])]));
				return withContainedFileAccess(session, () => acquireDatabase(session, "ida", binary));
			};
			const listed = async () => (await listDatabases(session, "ida")).map(db => db.handle).sort();
			return { open, listed };
		}

		it("keeps at most disassembler.maxOpen databases in the process, evicting the least recently used idle one", async () => {
			const { open, listed } = await inProcessDatabases({
				"disassembler.maxOpen": 2,
				"disassembler.idleCloseSec": 0,
			});
			const first = await open("first.bin");
			const second = await open("second.bin");
			// Used after `second` opened: `second` is now the least recently used.
			expect((await first.request<ExecResult>("exec", { code: "6 * 7" })).value).toBe("42");
			const third = await open("third.bin");

			expect(await listed()).toEqual([first.handle, third.handle].sort());
			expect(second.connected).toBe(false);

			// A retained database is never evicted: the next open is refused instead.
			await first.retain();
			await third.retain();
			const error = await failure(open("fourth.bin"));
			expect((error as Error | undefined)?.message).toContain("disassembler.maxOpen = 2");
			expect(await listed()).toEqual([first.handle, third.handle].sort());
		});

		it("closes an unreferenced in-process database once it sat idle, never a retained one", async () => {
			const { open, listed } = await inProcessDatabases({ "disassembler.idleCloseSec": 1 });
			const retained = await open("retained.bin");
			await retained.retain();
			const idle = await open("idle.bin");

			// Real time: the idle close runs against a live contained worker, whose I/O fake timers cannot drive.
			const deadline = Date.now() + 10_000;
			while ((await listed()).includes(idle.handle) && Date.now() < deadline) await Bun.sleep(200);
			expect(await listed()).toEqual([retained.handle]);
			expect(idle.connected).toBe(false);
		});

		it("refuses an in-place database whose directory the session's sandbox does not allow, naming the request", async () => {
			setAgentDir(path.join(path.dirname(workspace), "agent"));
			vi.spyOn(disasmRuntime, "resolveWorkerRuntime").mockResolvedValue(await createIdaWorkerRuntime(workspace));
			const db = path.join(outside, "inplace.i64");
			fs.writeFileSync(db, "idb");
			const session = {
				...containedToolSession(contained),
				settings,
				isToolActive: (name: string) => name === "sandbox_request",
			} as ToolSession;

			const error = await failure(withContainedFileAccess(session, () => acquireDatabase(session, "ida", db)));
			expect((error as Error | undefined)?.message).toContain(`kind \`write\`, target \`${outside}\``);
			expect(fs.existsSync(`${db}.lock`)).toBe(false);
		});
	},
);
