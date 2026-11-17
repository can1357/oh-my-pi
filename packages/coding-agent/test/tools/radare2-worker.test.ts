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

/** Stub r2pipe driven entirely by the worker protocol; no radare2 install needed. */
const STUB_R2PIPE = `
import builtins
import os

_LOG = os.environ["OMP_R2_STUB_LOG"]

def _record(line):
    with builtins.open(_LOG, "a", encoding="utf-8") as handle:
        handle.write(line + "\\n")

class StubR2:
    def __init__(self, target, flags):
        self.target = target
        self.flags = flags
    def cmd(self, text):
        _record("cmd:" + text)
        return ""
    def cmdj(self, text):
        _record("cmdj:" + text)
        if text == "iIj":
            return [{"name": "stub.bin", "bin": {"arch": "x86", "bits": 64, "class": "elf"}}]
        return {}
    def quit(self):
        _record("quit")
    def terminate(self):
        _record("terminate")

def open(target, flags=None):
    _record("open:" + str(target) + ":" + ",".join(flags or []))
    return StubR2(target, flags)
`;

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
});

describe("radare2 daemon labels", () => {
	it("labels omp.radare2.* hosts as radare2", () => {
		expect(backendForHost("omp.radare2.abc")).toBe("radare2");
	});
});
