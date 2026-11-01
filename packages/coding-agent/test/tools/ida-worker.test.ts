import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, acquireFileLock } from "@oh-my-pi/pi-utils";
import type { IdbLocation } from "../../src/ida/store";
import { IdaWorker } from "../../src/ida/supervisor";

const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");

/** Permissive stand-ins for idalib's modules so `worker.py` runs its real protocol loop without IDA. */
const STUB = `
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
    def hook(self):
        return True

def module_getattr(name):
    if name.startswith("__"):
        raise AttributeError(name)
    return type(name, (_Any,), {})
`;
const STUB_MODULE = "from _omp_ida_stub import _Any, module_getattr as __getattr__\n";
const STUB_MODULES = [
	"idapro",
	"ida_auto",
	"ida_bytes",
	"ida_funcs",
	"ida_hexrays",
	"ida_idaapi",
	"ida_idp",
	"ida_lines",
	"ida_loader",
	"ida_nalt",
	"ida_name",
	"ida_segment",
	"ida_typeinf",
	"ida_ua",
	"ida_xref",
	"idautils",
];
const STUB_DATABASE = `${STUB_MODULE}
class Database(_Any):
    module = "stub.bin"
    format = "stub"
    architecture = "metapc"
    bitness = 64

    @classmethod
    def open(cls, *args, **kwargs):
        return cls()

    def close(self, save=False):
        pass
`;

interface ExecResult {
	value: string | null;
	error: string | null;
}

describe("IDA worker protocol", () => {
	let dir: string;
	let worker: IdaWorker;
	let env: Record<string, string>;

	const stubLocation = (name: string): IdbLocation => ({
		id: name,
		dir,
		sourcePath: path.join(dir, `${name}.bin`),
		kind: "inplace",
		openPath: path.join(dir, `${name}.i64`),
		isNew: false,
		lockTarget: path.join(dir, `${name}.i64`),
	});

	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "ida-worker-"));
		const stubs = path.join(dir, "stubs");
		await Bun.write(path.join(stubs, "_omp_ida_stub.py"), STUB);
		for (const name of STUB_MODULES) await Bun.write(path.join(stubs, `${name}.py`), STUB_MODULE);
		await Bun.write(path.join(stubs, "ida_domain", "__init__.py"), STUB_DATABASE);
		await Bun.write(path.join(stubs, "ida_domain", "database.py"), STUB_MODULE);
		await Bun.write(path.join(stubs, "ida_domain", "xrefs.py"), STUB_MODULE);

		env = {};
		for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
		env.PYTHONPATH = stubs;
		env.PYTHONUNBUFFERED = "1";
		env.PYTHONIOENCODING = "utf-8";
		const loc = stubLocation("stub");
		const lock = await acquireFileLock(loc.lockTarget);
		worker = await IdaWorker.start(loc, { pythonPath, env }, lock, 0);
	});

	afterAll(async () => {
		await worker?.close({ save: false }).catch(() => {});
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("interrupts a running exec and keeps answering the next request on the same worker", async () => {
		const pid = worker.pid;
		const interrupted = await worker.request<ExecResult>("exec", { code: "while True: pass" }, { timeoutMs: 300 });
		expect(interrupted.error).toContain("KeyboardInterrupt");

		const next = await worker.request<ExecResult>("exec", { code: "6 * 7" });
		expect(next).toMatchObject({ value: "42", error: null });
		expect(worker.pid).toBe(pid);
	});

	it("contains an interrupt that arrives while uninterruptible native code runs", async () => {
		const pid = worker.pid;
		// `sum` over a range runs in C with no bytecode boundary, so the interrupt can only fire after it returns.
		const late = await worker.request<ExecResult>(
			"exec",
			{ code: "x = sum(range(60_000_000))\nx" },
			{ timeoutMs: 100 },
		);
		expect(late.value === "1799999970000000" || late.error?.includes("KeyboardInterrupt")).toBe(true);

		for (let i = 0; i < 5; i++) {
			const next = await worker.request<ExecResult>("exec", { code: `${i} + 1` });
			expect(next).toMatchObject({ value: String(i + 1), error: null });
		}
		expect(worker.pid).toBe(pid);
	});

	// The 30 s limit covers starting a second Python worker on a loaded host.
	it("keeps an idle database open for an idle-close longer than one platform timer", async () => {
		// `ida.idleCloseSec` reaches the worker as seconds × 1000. 2,147,484 s is the
		// first whole second past the ~24.8-day delay a single platform timer holds;
		// a raw setTimeout fires it after 1 ms and closes the database at once.
		const idleCloseMs = 2_147_484 * 1000;
		const loc = stubLocation("long-idle");
		const lock = await acquireFileLock(loc.lockTarget);
		vi.useFakeTimers();
		let longIdle: IdaWorker | undefined;
		try {
			// Opening arms the idle close on the fake clock.
			longIdle = await IdaWorker.start(loc, { pythonPath, env }, lock, idleCloseMs);
			const close = vi.spyOn(longIdle, "close").mockResolvedValue();

			vi.advanceTimersByTime(idleCloseMs - 1);
			expect(close).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1);
			expect(close).toHaveBeenCalledWith({ save: true });
		} finally {
			vi.useRealTimers();
			vi.restoreAllMocks();
			await longIdle?.close({ save: false }).catch(() => {});
		}
	}, 30_000);
});
