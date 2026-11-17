import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, acquireFileLock } from "@oh-my-pi/pi-utils";
import { DISASM_BACKENDS } from "../../src/disasm/backend";
import type { DatabaseLocation } from "../../src/disasm/store";
import { DisasmWorker } from "../../src/disasm/supervisor";

const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");

/** Python-only fixtures exercise the real worker protocol without a JVM or Ghidra install. */
const STUB = `
from pathlib import Path

def project_path(path):
    if any(part.startswith(".") for part in Path(path).parts):
        raise ValueError("Path element starting with '.' is not permitted")
    if not Path(path).is_dir():
        raise ValueError("project directory does not exist")
    return Path(path)

class _Any:
    def __init__(self, *args, **kwargs):
        pass
    def __call__(self, *args, **kwargs):
        return _Any()
    def __getattr__(self, name):
        return _Any()
    def __iter__(self):
        return iter(())
    def __bool__(self):
        return False
    def __str__(self):
        return "stub"
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc_value, traceback):
        return False
`;

const STUB_JPYPE = `
from _omp_ghidra_stub import _Any, project_path

class JLong(int):
    pass

class _Flat:
    def __init__(self, program):
        pass
    def toAddr(self, value):
        if not isinstance(value, JLong) and value >= 2**31:
            raise OverflowError("Cannot convert value to Java int")
        return _Any()
    def getBytes(self, address, size):
        return [-1, 0, 127, -128][:size]

class _Monitor:
    def __init__(self, cancel_enabled):
        self.cancelled = False
    def cancel(self):
        self.cancelled = True
    def clearCancelled(self):
        self.cancelled = False

class _ProjectLocator:
    def __init__(self, directory, name):
        self.lock_file = project_path(directory) / (name + ".lock")
    def getProjectLockFile(self):
        return self.lock_file

def JClass(name):
    if name == "ghidra.framework.model.ProjectLocator":
        return _ProjectLocator
    if name == "ghidra.util.task.TaskMonitorAdapter":
        return _Monitor
    if name == "ghidra.program.flatapi.FlatProgramAPI":
        return _Flat
    return _Any()
`;

const STUB_PYGHIDRA = `
from contextlib import contextmanager
from _omp_ghidra_stub import _Any, project_path

class StubMemory:
    def contains(self, address):
        return True

class StubProgram(_Any):
    def __init__(self):
        self.last_commit = True
        self.next_transaction = 0
    def getName(self):
        return "stub.bin"
    def getDefaultPointerSize(self):
        return 8
    def getMemory(self):
        return StubMemory()
    def isChanged(self):
        return False
    def save(self, description, monitor):
        if monitor.cancelled:
            raise RuntimeError("operation cancelled")
    def startTransaction(self, description):
        self.next_transaction += 1
        return self.next_transaction
    def endTransaction(self, tid, commit):
        self.last_commit = commit

class StubProject(_Any):
    def getProjectData(self):
        return self
    def getFile(self, path):
        return None

def open_project(path, name, create=False):
    project_path(path)
    return StubProject()

def consume_program(project, path):
    return StubProgram(), object()

def program_loader():
    return _Any()

def analyze(program, monitor):
    monitor.cancel()

@contextmanager
def transaction(program, description):
    tid = program.startTransaction(description)
    try:
        yield
    except BaseException:
        program.endTransaction(tid, False)
        raise
    else:
        program.endTransaction(tid, True)
`;

const STUB_LAUNCHER = `
class HeadlessPyGhidraLauncher:
    def __init__(self, install_dir):
        pass
    def add_vmargs(self, *args):
        pass
    def start(self, **kwargs):
        pass
`;

interface ExecResult {
	value: string | null;
	error: string | null;
}

describe("Ghidra worker protocol from a hidden managed store", () => {
	let dir: string | undefined;
	let worker: DisasmWorker;

	beforeAll(async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ghidra-worker-"));
		dir = tempDir;
		const stubs = path.join(tempDir, "stubs");
		await Bun.write(path.join(stubs, "_omp_ghidra_stub.py"), STUB);
		await Bun.write(path.join(stubs, "jpype.py"), STUB_JPYPE);
		await Bun.write(path.join(stubs, "pyghidra", "__init__.py"), STUB_PYGHIDRA);
		await Bun.write(path.join(stubs, "pyghidra", "launcher.py"), STUB_LAUNCHER);
		const databaseDir = path.join(tempDir, ".omp", "db");
		const binary = path.join(databaseDir, "stub.bin");
		await Bun.write(binary, "Ghidra worker protocol fixture\n");

		const env: Record<string, string> = {};
		for (const key in process.env) {
			const value = process.env[key];
			if (value !== undefined) env[key] = value;
		}
		env.PYTHONPATH = stubs;
		env.PYTHONUNBUFFERED = "1";
		env.PYTHONIOENCODING = "utf-8";
		env.GHIDRA_INSTALL_DIR = tempDir;
		const loc: DatabaseLocation = {
			id: "stub",
			dir: databaseDir,
			sourcePath: binary,
			stagedPath: binary,
			kind: "store",
			openPath: binary,
			isNew: true,
			lockTarget: path.join(databaseDir, "omp.gpr"),
		};
		const lock = await acquireFileLock(loc.lockTarget);
		try {
			worker = await DisasmWorker.start(DISASM_BACKENDS.ghidra, loc, { pythonPath, env }, lock, 0);
		} catch (error) {
			lock.release();
			throw error;
		}
	});

	afterAll(async () => {
		try {
			await worker?.close({ save: false });
		} finally {
			if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("interrupts an infinite exec via stdin and keeps answering on the same worker", async () => {
		const pid = worker.pid;
		const interrupted = await worker.request<ExecResult>("exec", { code: "while True: pass" }, { timeoutMs: 300 });
		expect(interrupted.error).toContain("KeyboardInterrupt");

		const next = await worker.request<ExecResult>("exec", { code: "6 * 7" });
		expect(next).toMatchObject({ value: "42", error: null });
		expect(worker.pid).toBe(pid);
	});

	it("reads signed Java bytes at a 64-bit Mach-O address without choosing the int overload", async () => {
		const read = await worker.request<ExecResult>("exec", { code: "read_bytes(0x100000000, 4).hex()" });
		expect(read).toMatchObject({ value: "'ff007f80'", error: null });
	});

	it("rolls back the program transaction when exec fails", async () => {
		const failed = await worker.request<ExecResult>("exec", { code: "raise ValueError('x')" });
		expect(failed.error).toContain("ValueError: x");

		const next = await worker.request<ExecResult>("exec", { code: "program.last_commit" });
		expect(next).toMatchObject({ value: "False", error: null });
	});
});
