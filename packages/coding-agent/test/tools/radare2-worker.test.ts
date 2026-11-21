import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, acquireFileLock } from "@oh-my-pi/pi-utils";
import { DISASM_BACKENDS } from "../../src/disasm/backend";
import { backendForHost } from "../../src/disasm/client";
import type { DatabaseLocation } from "../../src/disasm/store";
import { DisasmWorker } from "../../src/disasm/supervisor";

const pythonName = "python" + "3";
const pythonPath = Bun.env.PYTHON ?? ($which(pythonName) ? pythonName : "python");

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** Stub r2pipe driven entirely by the worker protocol; no radare2 install needed. */
const STUB_R2PIPE = `
import builtins
import os
import base64

_LOG = os.environ["OMP_R2_STUB_LOG"]
_FAIL_PDGJ = {"value": False}

def _record(line):
    with builtins.open(_LOG, "a", encoding="utf-8") as handle:
        handle.write(line + chr(10))

class StubR2:
    def __init__(self, target, flags):
        self.target = target
        self.flags = flags
        self.functions = [{"name": "main", "offset": 4096, "size": 64}]
        self.comments = {}
        self.signature = {"name": "main", "ret": "int", "argc": 0, "args": []}
    def cmd(self, text):
        _record("cmd:" + text)
        for extra in str(text).replace(";", "\\n").split("\\n")[1:]:
            if extra.strip():
                _record("cmd:" + extra.strip())
        if text == "__stub_fail_pdgj":
            _FAIL_PDGJ["value"] = True
        elif text == "__stub_ok_pdgj":
            _FAIL_PDGJ["value"] = False
        elif text.startswith("?v "):
            return "0x1000" + chr(10)
        elif text.startswith("afn "):
            name = text[4:].split(" @ ")[0]
            for function in self.functions:
                if function["offset"] == 4096:
                    function["name"] = name
            return ""
        elif text.startswith("af @ "):
            self.functions.append({"name": "fcn.2000", "offset": 8192, "size": 16})
            return ""
        elif text.startswith("afs "):
            decl = text[4:].split(" @ ")[0]
            if "rejected_stub" in decl:
                return "ERROR: at line 1: Cannot find ( in function definition"
            head = decl.split("(")[0].strip().split()
            self.signature = {"name": head[-1], "ret": " ".join(head[:-1]), "argc": 0, "args": []}
            return ""
        elif text.startswith("CC "):
            value, _, addr_text = text[3:].rpartition(" @ ")
            addr = int(addr_text, 16)
            if value.startswith("base64:"):
                value = base64.b64decode(value[7:]).decode("utf-8")
            if value == "__stub_hang_read":
                _record("read_blocked")
                value = self.process.stdout.read(1).decode("utf-8", "replace")
            self.comments[addr] = (self.comments.get(addr, "") + " " + value).strip()
            return ""
        return ""
    def cmdj(self, text):
        _record("cmdj:" + text)
        if text == "iIj":
            return {"arch": "x86", "bits": 64, "bintype": "elf", "class": "ELF64", "os": "linux"}
        if text == "iSj":
            return [{"name": ".text", "vaddr": 4096, "size": 128, "perm": "r-x"}]
        if text == "iej":
            return [{"vaddr": 4096}]
        if text == "aflj":
            return self.functions
        if text == "CCj":
            return [{"offset": addr, "type": "CCu", "name": value} for addr, value in self.comments.items()]
        if text.startswith("afsj"):
            return dict(self.signature)
        if text == "iij":
            return [{"name": "puts", "libname": "libc.so.6"}]
        if text == "iEj":
            return [{"name": "main", "vaddr": 4096}]
        if text == "izzj":
            return [{"vaddr": 8192, "string": "hello"}]
        if text.startswith("pdgj"):
            if _FAIL_PDGJ["value"]:
                raise RuntimeError("pdgj unavailable")
            return {"code": chr(10) + "int main(void) {" + chr(10) + "  return 0;" + chr(10) + "}" + chr(10), "annotations": []}
        if text.startswith("pdcj"):
            return {"code": chr(10) + "int main(void) { return 0; }" + chr(10), "annotations": []}
        if text.startswith("pdfj"):
            return {"name": "main", "addr": 4096, "size": 64, "ops": [
                {"addr": 4096, "opcode": "push rbp", "disasm": "push rbp"},
                {"addr": 4097, "opcode": "ret", "disasm": "ret"},
            ]}
        if text.startswith("pdj"):
            return [{"addr": 4096, "opcode": "push rbp", "disasm": "push rbp"}]
        if text.startswith("axtj"):
            return [{"from": 8192, "type": "CALL", "fcn_name": "caller"}]
        if text.startswith("axfj"):
            return [{"to": 4096, "type": "CALL", "fcn": {"name": "callee"}}]
        return {}
    def quit(self):
        _record("quit")
    def terminate(self):
        _record("terminate")

def open(target, flags=None, radare2home=None):
    extra = ":" + os.path.realpath(os.path.join(radare2home, "radare2")) if radare2home else ""
    _record("open:" + str(target) + ":" + ",".join(flags or []) + extra)
    return StubR2(target, flags)
`;

/** Cancellation stub: exposes a real child so the worker's SIGKILL/reap is observable. */
const STUB_R2PIPE_PROCESS = STUB_R2PIPE.replace("import builtins\nimport os\n", "import builtins\nimport os\nimport subprocess\n")
	.replace(
		"class StubR2:\n    def __init__(self, target, flags):\n        self.target = target\n        self.flags = flags\n",
		`class TrackedPopen(subprocess.Popen):
    def kill(self):
        _record("kill:" + str(self.pid))
        return super().kill()
    def wait(self, timeout=None):
        code = super().wait(timeout=timeout)
        _record("reaped:" + str(self.pid) + ":" + str(code))
        return code

class StubR2:
    def __init__(self, target, flags):
        self.target = target
        self.flags = flags
        self.process = TrackedPopen(
            [os.sys.executable, "-c", "import time; time.sleep(60)"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        _record("child:" + str(self.process.pid))
`,
	)
	.replace(
		'    def quit(self):\n        _record("quit")\n',
		'    def quit(self):\n        _record("quit")\n        self.process.kill()\n        self.process.wait()\n',
	);

/** Hung-read stub: CC blocks on the child's stdout until the child is killed. */
const STUB_R2PIPE_HANG_READ = STUB_R2PIPE_PROCESS
	.replace("stdout=subprocess.DEVNULL,", "stdout=subprocess.PIPE,");


describe("radare2 worker protocol from a hidden managed store", () => {
	let dir: string | undefined;
	let databaseDir: string;
	let log: string;
	let worker: DisasmWorker;

	beforeAll(async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radare2-worker-"));
		dir = tempDir;
		log = path.join(tempDir, "r2.log");
		databaseDir = path.join(tempDir, ".omp", "db");
		await Bun.write(log, "");
		await Bun.write(path.join(tempDir, "stubs", "r2pipe.py"), STUB_R2PIPE);
		const binary = path.join(databaseDir, "stub.bin");
		await Bun.write(binary, "radare2 worker protocol fixture\n");

		const env: Record<string, string> = {};
		for (const key in process.env) {
			const value = process.env[key];
			if (value !== undefined) env[key] = value;
		}
		env.PYTHONPATH = path.join(tempDir, "stubs");
		env.PYTHONUNBUFFERED = "1";
		env.PYTHONIOENCODING = "utf-8";
		env.RADARE2_BIN = path.join(tempDir, "radare2");
		env.OMP_R2_STUB_LOG = log;
		const loc: DatabaseLocation = {
			id: "stub",
			dir: databaseDir,
			sourcePath: binary,
			stagedPath: binary,
			kind: "store",
			openPath: binary,
			isNew: true,
			lockTarget: path.join(databaseDir, "omp.r2"),
		};
		const lock = await acquireFileLock(loc.lockTarget);
		try {
			worker = await DisasmWorker.start(DISASM_BACKENDS.radare2, loc, { pythonPath, env }, lock, 0);
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

	it("opens, saves and closes a radare2 project from a hidden managed store", async () => {
		const marker = path.join(databaseDir, "omp.r2");
		expect(worker.idbPath).toBe(marker);
		expect(worker.info).toEqual({ module: "stub.bin", format: "elf", arch: "x86", bitness: 64 });

		const saved = await worker.request<{ idb: string }>("save", {});
		expect(saved).toEqual({ idb: marker });
		expect(await Bun.file(marker).exists()).toBe(true);
		expect(await Bun.file(log).text()).toContain("cmd:Ps omp");

		await worker.close({ save: false });
		expect(await Bun.file(log).text()).toContain("quit");
	});

	it("spawns the configured radare2 binary instead of PATH radare2", async () => {
		const configured = path.join(dir!, "radare2");
		const openLine = (await Bun.file(log).text()).split("\n").find(line => line.startsWith("open:"));
		expect(openLine).toBe(`open:${path.join(databaseDir, "stub.bin")}:-e,dir.projects=${databaseDir},-N:${configured}`);
	});
});

describe("radare2 saved-project reopen", () => {
	let dir: string | undefined;
	let databaseDir: string;
	let log: string;
	let reopened: DisasmWorker | undefined;

	beforeAll(async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radare2-reopen-"));
		dir = tempDir;
		databaseDir = path.join(tempDir, ".omp", "db");
		log = path.join(tempDir, "r2.log");
		const stubs = path.join(tempDir, "stubs");
		await Bun.write(path.join(stubs, "r2pipe.py"), STUB_R2PIPE);
		await Bun.write(log, "");
		const binary = path.join(databaseDir, "stub.bin");
		await Bun.write(binary, "radare2 reopen fixture\n");

		const env: Record<string, string> = {};
		for (const key in process.env) {
			const value = process.env[key];
			if (value !== undefined) env[key] = value;
		}
		env.PYTHONPATH = stubs;
		env.PYTHONUNBUFFERED = "1";
		env.PYTHONIOENCODING = "utf-8";
		env.OMP_R2_STUB_LOG = log;
		const loc: DatabaseLocation = {
			id: "stub",
			dir: databaseDir,
			sourcePath: binary,
			stagedPath: binary,
			kind: "store",
			openPath: binary,
			isNew: true,
			lockTarget: path.join(databaseDir, "omp.r2"),
		};
		const createdLock = await acquireFileLock(loc.lockTarget);
		let created: DisasmWorker | undefined;
		try {
			created = await DisasmWorker.start(DISASM_BACKENDS.radare2, loc, { pythonPath, env }, createdLock, 0);
			await created.request("save", {});
		} finally {
			await created?.close({ save: false });
		}
		const reopenLock = await acquireFileLock(loc.lockTarget);
		try {
			reopened = await DisasmWorker.start(
				DISASM_BACKENDS.radare2,
				{ ...loc, isNew: false },
				{ pythonPath, env },
				reopenLock,
				0,
			);
		} catch (error) {
			reopenLock.release();
			throw error;
		}
	});

	afterAll(async () => {
		try {
			await reopened?.close({ save: false });
		} finally {
			if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("reopens a saved project with dir.projects configured before the project load", async () => {
		expect(reopened?.info).toEqual({ module: "stub.bin", format: "elf", arch: "x86", bitness: 64 });
		const lines = (await Bun.file(log).text()).split("\n").filter(Boolean);
		expect(lines.find(line => line.startsWith("open:-:"))).toBe(
			`open:-:-e,dir.projects=${databaseDir},-p,omp`,
		);
	});
});

describe("radare2 daemon labels", () => {
	it("labels omp.radare2.* hosts as radare2", () => {
		expect(backendForHost("omp.radare2.abc")).toBe("radare2");
	});
});

type ExecResult = { output: string; value: string | null; error: string | null };

describe("radare2 views and exec", () => {
	let dir: string | undefined;
	let databaseDir: string;
	let log: string;
	let worker: DisasmWorker;

	beforeAll(async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radare2-views-"));
		dir = tempDir;
		databaseDir = path.join(tempDir, ".omp", "db");
		log = path.join(tempDir, "r2.log");
		await Bun.write(log, "");
		await Bun.write(path.join(tempDir, "stubs", "r2pipe.py"), STUB_R2PIPE);
		const binary = path.join(databaseDir, "stub.bin");
		await Bun.write(binary, "radare2 views fixture\n");

		const env: Record<string, string> = {};
		for (const key in process.env) {
			const value = process.env[key];
			if (value !== undefined) env[key] = value;
		}
		env.PYTHONPATH = path.join(tempDir, "stubs");
		env.PYTHONUNBUFFERED = "1";
		env.PYTHONIOENCODING = "utf-8";
		env.RADARE2_BIN = path.join(tempDir, "radare2");
		env.OMP_R2_STUB_LOG = log;
		const loc: DatabaseLocation = {
			id: "stub",
			dir: databaseDir,
			sourcePath: binary,
			stagedPath: binary,
			kind: "store",
			openPath: binary,
			isNew: true,
			lockTarget: path.join(databaseDir, "omp.r2"),
		};
		const lock = await acquireFileLock(loc.lockTarget);
		try {
			worker = await DisasmWorker.start(DISASM_BACKENDS.radare2, loc, { pythonPath, env }, lock, 0);
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

	it("returns every dsm view from r2 JSON commands", async () => {
		const views = [
			{ kind: "overview" },
			{ kind: "imports" },
			{ kind: "exports" },
			{ kind: "strings" },
			{ kind: "pseudocode", target: "0x1000" },
			{ kind: "asm", target: "0x1000" },
			{ kind: "xrefs", target: "0x1000" },
		];
		for (const view of views) {
			const result = await worker.request<{ text: string }>("view", view);
			expect(typeof result.text).toBe("string");
			expect(result.text.length).toBeGreaterThan(0);
			if (view.kind === "xrefs") expect(result.text).toContain("caller");
		}
		const lines = (await Bun.file(log).text()).split("\n").filter(Boolean);
		for (const command of ["iij", "iEj", "izzj", "pdgj", "pdfj", "axtj"]) {
			expect(lines.some(line => line.startsWith("cmdj:" + command))).toBe(true);
		}
	});

	it("falls back to pdcj when pdgj is unavailable", async () => {
		await worker.request("exec", { code: "r2.cmd('__stub_fail_pdgj')" });
		try {
			const result = await worker.request<{ text: string }>("view", { kind: "pseudocode", target: "0x1000" });
			expect(typeof result.text).toBe("string");
			expect(result.text.length).toBeGreaterThan(0);
			const lines = (await Bun.file(log).text()).split("\n").filter(Boolean);
			expect(lines.some(line => line.startsWith("cmdj:pdcj"))).toBe(true);
		} finally {
			await worker.request("exec", { code: "r2.cmd('__stub_ok_pdgj')" });
		}
	});

	it("exec captures output, last value and error with a persistent namespace", async () => {
		const set = await worker.request<ExecResult>("exec", { code: "print('setting'); r2_answer = 6 * 7" });
		expect(set).toEqual({ output: "setting\n", value: null, error: null });

		const read = await worker.request<ExecResult>("exec", { code: "r2_answer" });
		expect(read).toEqual({ output: "", value: "42", error: null });

		const failed = await worker.request<ExecResult>("exec", { code: "raise ValueError('boom')" });
		expect(failed.output).toBe("");
		expect(failed.value).toBeNull();
		expect(failed.error).toContain("ValueError: boom");

		const helpers = await worker.request<ExecResult>("exec", {
			code: "sorted(name for name in globals() if name in ('r2', 'help_radare2'))",
		});
		expect(helpers.value).toBe("['help_radare2', 'r2']");
	});
});

type StubWorker = { worker: DisasmWorker; dir: string; databaseDir: string; log: string; marker: string };
type MutationResult = { ea: string; [key: string]: unknown };

/** Start a radare2 worker against a fresh temp tree; frameMode forces an stdin interrupt frame. */
async function startStubWorker(prefix: string, frameMode = false, childProcess = false, hangRead = false): Promise<StubWorker> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const databaseDir = path.join(dir, ".omp", "db");
	const log = path.join(dir, "r2.log");
	const stubs = path.join(dir, "stubs");
	await Bun.write(log, "");
	await Bun.write(path.join(stubs, "r2pipe.py"), hangRead ? STUB_R2PIPE_HANG_READ : childProcess ? STUB_R2PIPE_PROCESS : STUB_R2PIPE);
	const binary = path.join(databaseDir, "stub.bin");
	await Bun.write(binary, "radare2 mutation fixture\n");
	const env: Record<string, string> = {};
	for (const key in process.env) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	env.PYTHONPATH = stubs;
	env.PYTHONUNBUFFERED = "1";
	env.PYTHONIOENCODING = "utf-8";
	env.RADARE2_BIN = path.join(dir, "radare2");
	env.OMP_R2_STUB_LOG = log;
	const loc: DatabaseLocation = {
		id: "stub",
		dir: databaseDir,
		sourcePath: binary,
		stagedPath: binary,
		kind: "store",
		openPath: binary,
		isNew: true,
		lockTarget: path.join(databaseDir, "omp.r2"),
	};
	const backend = frameMode ? { ...DISASM_BACKENDS.radare2, interrupt: "frame" as const } : DISASM_BACKENDS.radare2;
	const lock = await acquireFileLock(loc.lockTarget);
	try {
		return {
			worker: await DisasmWorker.start(backend, loc, { pythonPath, env }, lock, 0),
			dir,
			databaseDir,
			log,
			marker: path.join(databaseDir, "omp.r2"),
		};
	} catch (error) {
		lock.release();
		throw error;
	}
}

async function stopStubWorker(stub: StubWorker): Promise<void> {
	try {
		await stub.worker.close({ save: false });
	} finally {
		await fs.rm(stub.dir, { recursive: true, force: true });
	}
}
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}


describe("radare2 mutations and cancellation", () => {
	let stub: StubWorker;

	beforeAll(async () => {
		stub = await startStubWorker("radare2-mutations-");
	});

	afterAll(async () => {
		await stopStubWorker(stub);
	});

	it("renames, comments, sets types and creates functions", async () => {
		const renamed = await stub.worker.request<MutationResult>("rename", { target: "main", name: "entry_main" });
		expect(renamed).toMatchObject({ ea: "0x1000" });

		const commented = await stub.worker.request<MutationResult>("comment", { target: "main", text: "entry" });
		expect(commented).toMatchObject({ ea: "0x1000" });

		const typed = await stub.worker.request<MutationResult>("set_type", { target: "main", decl: "int main(void)" });
		expect(typed).toMatchObject({ ea: "0x1000" });

		const made = await stub.worker.request<MutationResult>("make_function", { target: "0x2000" });
		expect(made).toMatchObject({ ea: "0x2000" });

		const lines = (await Bun.file(stub.log).text()).split("\n").filter(Boolean);
		for (const cmd of [
			"cmd:afn entry_main @ 0x1000",
			`cmd:CC base64:${base64("entry")} @ 0x1000`,
			"cmd:afs int main(void) @ 0x1000",
			"cmd:af @ 0x2000",
		]) {
			expect(lines).toContain(cmd);
		}

		expect(stub.worker.needsSave).toBe(true);
		expect(await stub.worker.request<{ idb: string }>("save", {})).toEqual({ idb: stub.marker });
		expect(stub.worker.needsSave).toBe(false);
	});

	it("repeatable comments are written at the target and its xrefs", async () => {
		await stub.worker.request("comment", { target: "main", text: "shared", repeatable: true });
		const lines = (await Bun.file(stub.log).text()).split("\n").filter(Boolean);
		for (const addr of ["0x1000", "0x2000"]) {
			expect(lines).toContain(`cmd:CC base64:${base64("shared")} @ ${addr}`);
		}
		expect(lines.some(line => line.startsWith("cmdj:axtj"))).toBe(true);
	});

	it("rejects a type declaration that r2 cannot parse without renaming the function", async () => {
		const before = await Bun.file(stub.log).text();
		await expect(stub.worker.request("set_type", { target: "main", decl: "not a declaration" })).rejects.toThrow(/declaration/i);
		const after = await Bun.file(stub.log).text();
		expect(after.slice(before.length)).not.toContain("cmd:afs");
	});

	it("reports an r2-level afs rejection without flipping dirty or renaming", async () => {
		await stub.worker.request("save", {});
		expect(stub.worker.needsSave).toBe(false);
		const before = await Bun.file(stub.log).text();
		await expect(
			stub.worker.request("set_type", { target: "main", decl: "void rejected_stub(void)" }),
		).rejects.toThrow(/rejected/i);
		const lines = (await Bun.file(stub.log).text()).slice(before.length).split("\n").filter(Boolean);
		expect(lines).toContain("cmd:afs void rejected_stub(void) @ 0x1000");
		expect(lines.some(line => line.startsWith("cmd:afn"))).toBe(false);
		expect(stub.worker.needsSave).toBe(false);
		const name = await stub.worker.request<ExecResult>("exec", { code: "func('main')['name']" });
		expect(name.value).toContain("entry_main");
	});

	it("writes comment text as base64 without executing separators", async () => {
		const text = "quoted \"x\"; afn injected @ 0x1000\n# next line";
		const before = await Bun.file(stub.log).text();
		const result = await stub.worker.request<MutationResult>("comment", { target: "main", text, repeatable: true });
		expect(result).toMatchObject({ ea: "0x1000" });
		const after = (await Bun.file(stub.log).text()).slice(before.length);
		expect(after).toContain(`cmd:CC base64:${base64(text)} @ 0x1000`);
		expect(after).toContain(`cmd:CC base64:${base64(text)} @ 0x2000`);
		expect(after).not.toContain("cmd:afn injected @ 0x1000");
		expect(after).not.toContain("cmd:# next line");
		const roundTrip = await stub.worker.request<ExecResult>("exec", {
			code: "import base64\n[base64.b64encode(c['name'].encode('utf-8')).decode('ascii') for c in r2.cmdj('CCj') if c['offset'] == 4096]",
		});
		const encodedValue = roundTrip.value?.match(/'([A-Za-z0-9+/=]+)'/)?.[1];
		expect(encodedValue).toBeDefined();
		expect(Buffer.from(encodedValue!, "base64").toString("utf8")).toContain(text);
	});

	it("applies char *main(void) as a pointer return and marks dirty", async () => {
		await stub.worker.request("save", {});
		const typed = await stub.worker.request<MutationResult>("set_type", { target: "main", decl: "char *main(void)" });
		expect(typed).toMatchObject({ ea: "0x1000" });
		expect(stub.worker.needsSave).toBe(true);
		const lines = (await Bun.file(stub.log).text()).split("\n").filter(Boolean);
		expect(lines).toContain("cmd:afs char* main(void) @ 0x1000");
		const sig = await stub.worker.request<ExecResult>("exec", { code: "r2.cmdj('afsj')" });
		expect(sig.value).toContain("'name': 'main'");
		expect(sig.value).toContain("'ret': 'char*'");
	});

	it("kills and reaps a radare2 child when a _nul_io read hangs", async () => {
		const hangStub = await startStubWorker("radare2-hang-read-", false, true, true);
		try {
			const before = await Bun.file(hangStub.log).text();
			const childPids = [...before.matchAll(/^child:(\d+)$/gm)].map(match => Number(match[1]));
			const childPid = childPids.at(-1);
			expect(childPid).toBeDefined();
			expect(pidAlive(childPid!)).toBe(true);

			const started = Date.now();
			await expect(
				hangStub.worker.request(
					"comment",
					{ target: "main", text: "__stub_hang_read" },
					{ timeoutMs: 300 },
				),
			).rejects.toThrow(/interrupted/i);
			expect(Date.now() - started).toBeLessThan(5_000);
			const after = await Bun.file(hangStub.log).text();
			expect(after).toContain("read_blocked");
			expect(after).toContain(`kill:${childPid}`);
			expect(after).toContain(`reaped:${childPid}:`);
			if (process.platform !== "win32") expect(after).toContain(`reaped:${childPid}:-9`);
			expect(pidAlive(childPid!)).toBe(false);

			await hangStub.worker.close({ save: false });
			const lock = await acquireFileLock(hangStub.marker);
			lock.release();
		} finally {
			await stopStubWorker(hangStub);
		}
	}, 15_000);

	it("interrupt frame terminates r2 and preserves the last saved project", async () => {
		const cancelStub = await startStubWorker("radare2-cancel-", true, true);
		try {
			await cancelStub.worker.request("save", {});
			const before = await Bun.file(cancelStub.log).text();
			const childPids = [...before.matchAll(/^child:(\d+)$/gm)].map(match => Number(match[1]));
			const childPid = childPids.at(-1);
			expect(childPid).toBeDefined();
			expect(pidAlive(childPid!)).toBe(true);

			const interrupted = await cancelStub.worker.request<ExecResult>(
				"exec",
				{ code: "while True: pass" },
				{ timeoutMs: 300 },
			);
			expect(interrupted.error?.toLowerCase()).toContain("interrupted");
			const after = await Bun.file(cancelStub.log).text();
			expect(after).toContain(`kill:${childPid}`);
			expect(after).toContain(`reaped:${childPid}:`);
			if (process.platform !== "win32") expect(after).toContain(`reaped:${childPid}:-9`);
			expect(pidAlive(childPid!)).toBe(false);
			expect(await Bun.file(cancelStub.marker).exists()).toBe(true);
		} finally {
			await stopStubWorker(cancelStub);
		}
	}, 15_000);

	it("POSIX SIGINT SIGKILLs and reaps r2 and preserves the last saved project", async () => {
		const signalStub = await startStubWorker("radare2-signal-", false, true);
		try {
			await signalStub.worker.request("save", {});
			const before = await Bun.file(signalStub.log).text();
			const childPids = [...before.matchAll(/^child:(\d+)$/gm)].map(match => Number(match[1]));
			const childPid = childPids.at(-1);
			expect(childPid).toBeDefined();
			expect(pidAlive(childPid!)).toBe(true);

			const interrupted = await signalStub.worker.request<ExecResult>(
				"exec",
				{ code: "while True: pass" },
				{ timeoutMs: 300 },
			);
			expect(interrupted.error?.toLowerCase()).toContain("interrupted");
			const after = await Bun.file(signalStub.log).text();
			expect(after).toContain(`kill:${childPid}`);
			expect(after).toContain(`reaped:${childPid}:`);
			if (process.platform !== "win32") expect(after).toContain(`reaped:${childPid}:-9`);
			expect(pidAlive(childPid!)).toBe(false);
			expect(await Bun.file(signalStub.marker).exists()).toBe(true);
		} finally {
			await stopStubWorker(signalStub);
		}
	}, 15_000);

	it("emits an interrupted frame when an interrupt lands before dispatch", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "radare2-interrupt-gap-"));
		try {
			const stubs = path.join(dir, "stubs");
			const result = path.join(dir, "frames.json");
			await Bun.write(path.join(stubs, "r2pipe.py"), STUB_R2PIPE);
			await Bun.write(path.join(dir, "worker.py"), DISASM_BACKENDS.radare2.workerScript);
			await Bun.write(path.join(dir, "probe.py"), `
import json
import sys
sys.path.insert(0, ${JSON.stringify(dir)})
import worker
frames = []
worker._send = lambda frame: frames.append(frame)
def interrupt(*args, **kwargs):
    raise KeyboardInterrupt()
worker._run = interrupt
worker._handle('{"id": 7, "method": "view", "params": {}}')
with open(${JSON.stringify(result)}, "w") as handle:
    json.dump(frames, handle)
`);
			const log = path.join(dir, "r2.log");
			await Bun.write(log, "");
			const env: Record<string, string> = {};
			for (const key in process.env) {
				const value = process.env[key];
				if (value !== undefined) env[key] = value;
			}
			env.PYTHONPATH = stubs;
			env.OMP_R2_STUB_LOG = log;
			const proc = Bun.spawn([pythonPath, path.join(dir, "probe.py")], { env, stdout: "pipe", stderr: "pipe" });
			expect(await proc.exited).toBe(0);
			const frames = JSON.parse(await Bun.file(result).text());
			expect(frames).toEqual([
				{ id: 7, ok: false, error: { type: "KeyboardInterrupt", message: "interrupted" } },
			]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("radare2 executable staging", () => {
	it("copies the configured binary on Windows when symlinks are privileged", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "radare2-staging-"));
		try {
			const stubs = path.join(dir, "stubs");
			const projectDir = path.join(dir, "project");
			const configured = path.join(dir, "custom-r2");
			const result = path.join(dir, "result.json");
			await fs.mkdir(projectDir, { recursive: true });
			await Bun.write(path.join(stubs, "r2pipe.py"), STUB_R2PIPE);
			await Bun.write(configured, "radare2 shim fixture\n");
			await Bun.write(path.join(dir, "worker.py"), DISASM_BACKENDS.radare2.workerScript);
			await Bun.write(path.join(dir, "probe.py"), `
import json
import os
import sys
sys.path.insert(0, ${JSON.stringify(dir)})
import worker
worker._WINDOWS = True
def deny_symlink(*args, **kwargs):
    raise OSError(1314, "A required privilege is not held by the client")
worker.os.symlink = deny_symlink
try:
    shim = worker._r2_exe_home(${JSON.stringify(projectDir)})
    link = os.path.join(shim, "radare2.exe")
    with open(link, "rb") as handle:
        payload = handle.read().decode("utf-8")
    result = {"shim": shim, "is_symlink": os.path.islink(link), "payload": payload}
except Exception as exc:
    result = {"error": str(exc), "type": type(exc).__name__}
with open(${JSON.stringify(result)}, "w") as handle:
    json.dump(result, handle)
`);
			const log = path.join(dir, "r2.log");
			await Bun.write(log, "");
			const env: Record<string, string> = {};
			for (const key in process.env) {
				const value = process.env[key];
				if (value !== undefined) env[key] = value;
			}
			env.PYTHONPATH = stubs;
			env.PYTHONIOENCODING = "utf-8";
			env.RADARE2_BIN = configured;
			env.OMP_R2_STUB_LOG = log;
			const proc = Bun.spawn([pythonPath, path.join(dir, "probe.py")], { env, stdout: "pipe", stderr: "pipe" });
			expect(await proc.exited).toBe(0);
			const staged = JSON.parse(await Bun.file(result).text()) as {
				shim?: string;
				is_symlink?: boolean;
				payload?: string;
				error?: string;
			};
			expect(staged.error).toBeUndefined();
			expect(staged.shim).toBe(path.join(projectDir, ".omp-r2-bin"));
			expect(staged.is_symlink).toBe(false);
			expect(staged.payload).toBe("radare2 shim fixture\n");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
