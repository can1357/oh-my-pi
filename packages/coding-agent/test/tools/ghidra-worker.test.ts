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

/** API-shaped Java doubles keep these regressions independent of a local Ghidra install. */
const OBJC_CONTRACT = `
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
import jpype
import pyghidra

spec = importlib.util.spec_from_file_location("worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
worker._init_java()

class DataType:
    def __init__(self, *args):
        self.args = args

class JavaIterator:
    def __init__(self, values):
        self.values = iter(values)
        self.pending = None
    def hasNext(self):
        self.pending = next(self.values, None)
        return self.pending is not None
    def next(self):
        return self.pending

class Function:
    def __init__(self, name):
        self.name = name
        self.fixup = "bad-fixup"
        self.update = None
        self.source = worker.SourceType.ANALYSIS
    def getName(self):
        return self.name
    def getCallFixup(self):
        return self.fixup
    def getSignatureSource(self):
        return self.source
    def setCallFixup(self, value):
        assert program.active
        self.fixup = value
        program.changed = True
    def updateFunction(self, *args):
        assert program.active
        self.update = args
        self.source = args[-1]
        program.changed = True
        program.events.append("signature:" + self.name)

class Program(pyghidra.StubProgram):
    def __init__(self, format, analyzed, existing, arm64=True, objc=True):
        super().__init__()
        self.format = format
        self.analyzed = analyzed
        self.types = dict(existing)
        self.original = dict(existing)
        self.active = 0
        self.events = []
        self.arm64 = arm64
        self.objc = objc
        self.changed = False
        self.saves = 0
        self.functions = [Function(name) for name in (
            "_objc_retain_x19", "_objc_retain_x99", "_objc_retain_x19_suffix",
            "prefix_objc_retain_x19", "_objc_release_x19")]
        if not objc:
            self.functions = [Function("main")]
    def getExecutableFormat(self):
        return self.format
    def getMemory(self):
        name = "__objc_selrefs" if self.objc else "__text"
        return SimpleNamespace(getBlocks=lambda: [SimpleNamespace(getName=lambda: name)])
    def isChanged(self):
        return self.changed
    def save(self, description, monitor):
        super().save(description, monitor)
        self.saves += 1
        self.changed = False
    def getRegister(self, name):
        return name if self.arm64 and name in ("x0", "x19") else None
    def getFunctionManager(self):
        return self
    def getFunctions(self, forward):
        assert forward is True
        return JavaIterator(self.functions)
    def getDataTypeManager(self):
        return self
    def getDataType(self, *args):
        return self.types.get(str(args[-1]).split("/")[-1])
    def addDataType(self, datatype, conflict):
        assert self.active
        name = datatype.args[-2] if len(datatype.args) > 2 else datatype.args[0]
        assert name not in self.types, "existing typedef must not be replaced"
        self.types[name] = datatype
        self.events.append("seed:" + name)
        self.changed = True
        return datatype
    def startTransaction(self, description):
        self.active += 1
        return super().startTransaction(description)
    def endTransaction(self, tid, commit):
        assert self.active and commit
        self.active -= 1
        super().endTransaction(tid, commit)

class List:
    @staticmethod
    def of(*values):
        return list(values)

original_jclass = jpype.JClass
def jclass(name):
    short = name.rsplit(".", 1)[-1]
    if short == "Objc2Constants":
        return SimpleNamespace(CATEGORY_PATH="/Objective-C")
    if short in ("PointerDataType", "TypedefDataType", "VariableStorage", "ParameterImpl", "ReturnParameterImpl"):
        return DataType
    if short in ("VoidDataType", "CharDataType"):
        return SimpleNamespace(dataType=short)
    if short == "DataTypeConflictHandler":
        return SimpleNamespace(DEFAULT_HANDLER=object())
    if short == "Function$FunctionUpdateType":
        return SimpleNamespace(CUSTOM_STORAGE="custom-storage")
    if name == "java.util.List":
        return List
    return original_jclass(name)
jpype.JClass = jclass
worker.SourceType = SimpleNamespace(USER_DEFINED="user-defined", ANALYSIS="analysis")
worker.GhidraProgramUtilities = SimpleNamespace(isAnalyzed=lambda p: p.analyzed)

case = sys.argv[2]
existing = {} if case in ("fresh", "non-objc") else (
    {"ID": object(), "SEL": object()} if case in ("cached", "user-defined") else {"ID": object()})
program = Program("ELF" if case == "elf" else "Mac OS X Mach-O",
                  case != "fresh", existing, arm64=case != "non-arm64", objc=case != "non-objc")
if case == "user-defined":
    program.functions[0].source = worker.SourceType.USER_DEFINED
    program.functions[0].update = ("existing user signature",)
    user_signature = program.functions[0].update
def analyze(p, monitor):
    if p.format == "Mac OS X Mach-O" and p.objc:
        assert set(p.types) == {"ID", "SEL"}, "analysis ran before Objective-C typedef seeding"
    p.events.append("analyze")
    p.analyzed = True
    p.changed = True
    monitor.cancel()
pyghidra.analyze = analyze
pyghidra.consume_program = lambda *args: (program, object())
project = pyghidra.StubProject()
project.getFile = lambda path: None if case in ("fresh", "elf") else object()
pyghidra.open_project = lambda *args, **kwargs: project
binary = Path(sys.argv[3]) / "objc.bin"
binary.write_bytes(b"Objective-C worker fixture")
worker._rpc_open({"binary": str(binary), "project": sys.argv[3]})
assert all(program.types[name] is value for name, value in program.original.items())
assert program.events.count("analyze") == (1 if case in ("fresh", "missing", "non-arm64") else 0)
if case in ("elf", "non-objc"):
    assert program.types == program.original
    assert all(f.update is None and f.fixup == "bad-fixup" for f in program.functions)
    assert program.events == [] and program.saves == 0 and not program.isChanged()
else:
    assert set(program.types) == {"ID", "SEL"}
    assert worker._seed_objc_types(program) is False, "seeding must be idempotent"
    for name, base in (("ID", "VoidDataType"), ("SEL", "CharDataType")):
        if name not in program.original:
            pointer = program.types[name].args[-1]
            assert pointer.args == (base, 8), "Objective-C typedef has incorrect pointer type"
    repaired = program.functions[0]
    if case == "non-arm64":
        assert repaired.update is None
    elif case == "user-defined":
        assert repaired.update is user_signature and repaired.fixup == "bad-fixup"
        assert repaired.getSignatureSource() == worker.SourceType.USER_DEFINED
        assert program.events == [] and program.saves == 0 and not program.isChanged()
    else:
        assert repaired.fixup is None
        convention, result, parameters, update_type, force, source = repaired.update
        assert convention == "default"
        assert update_type == "custom-storage" and source == worker.SourceType.ANALYSIS
        assert repaired.getSignatureSource() == worker.SourceType.ANALYSIS
        assert len(parameters) == 1
        assert result.args[-2].args == (program, "x0")
        assert parameters[0].args[-2].args == (program, "x19")
    assert all(f.update is None and f.fixup == "bad-fixup" for f in program.functions[1:])
if case == "cached":
    saved = program.saves
    signature = program.functions[0].update
    events = list(program.events)
    worker._close(False)
    worker._rpc_open({"binary": str(binary), "project": sys.argv[3]})
    assert program.saves == saved and not program.isChanged(), "reopening a repaired cache must not save"
    assert program.events == events and program.functions[0].update is signature
    with pyghidra.transaction(program, "analyzer reinstalls fixup"):
        program.functions[0].setCallFixup("analyzer-fixup")
    worker._close(False)
    worker._rpc_open({"binary": str(binary), "project": sys.argv[3]})
    assert program.functions[0].fixup is None, "analysis signatures must be repaired again after analysis reinstalls a fixup"
    assert program.functions[0].getSignatureSource() == worker.SourceType.ANALYSIS
    assert program.events.count("signature:_objc_retain_x19") == 2
    assert program.events.count("analyze") == 0 and program.saves == saved + 1
    with pyghidra.transaction(program, "user signature"):
        program.functions[0].updateFunction("user-selected signature", worker.SourceType.USER_DEFINED)
        program.functions[0].setCallFixup("user-fixup")
    worker._rpc_save({})
    saved = program.saves
    signature = program.functions[0].update
    worker._close(False)
    worker._rpc_open({"binary": str(binary), "project": sys.argv[3]})
    assert program.functions[0].update is signature, "a saved user signature must survive reopening"
    assert program.functions[0].fixup == "user-fixup", "a saved user signature's fixup must survive reopening"
    assert program.saves == saved and not program.isChanged(), "reopening must not rewrite the user signature"
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

	for (const [scenario, contract] of [
		["fresh", "seeds missing typedefs before first analysis and repairs retain register storage"],
		["missing", "reanalyzes an old Mach-O cache missing SEL without replacing its existing ID"],
		["cached", "repairs retain storage in a fully seeded cache without unnecessary analysis"],
		["user-defined", "preserves an existing user-defined retain signature and fixup on first open without saving"],
		["elf", "leaves non-Mach-O typedefs and retain-like function names unchanged"],
		["non-objc", "does not seed, reanalyze, or save an already analyzed C/C++ Mach-O"],
		["non-arm64", "skips retain storage repair when the program has no arm64 x0 register"],
	] as const) {
		it(contract, async () => {
			if (dir === undefined) throw new Error("worker fixture was not initialized");
			const child = Bun.spawn(
				[
					pythonPath,
					"-c",
					OBJC_CONTRACT,
					path.resolve(import.meta.dir, "../../src/ghidra/worker.py"),
					scenario,
					dir,
				],
				{
					env: { ...process.env, PYTHONPATH: path.join(dir, "stubs"), GHIDRA_INSTALL_DIR: dir },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
		});
	}
});
