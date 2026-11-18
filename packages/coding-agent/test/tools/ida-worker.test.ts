import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "@oh-my-pi/pi-utils";
import { DISASM_BACKENDS } from "../../src/disasm/backend";
import type { DatabaseLocation } from "../../src/disasm/store";
import { DisasmWorker } from "../../src/disasm/supervisor";

import { createIdaWorkerRuntime } from "../helpers/ida-worker";

interface ExecResult {
	value: string | null;
	error: string | null;
}

describe("IDA worker protocol", () => {
	let dir: string;
	let worker: DisasmWorker;

	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "ida-worker-"));
		const runtime = await createIdaWorkerRuntime(dir);
		const loc: DatabaseLocation = {
			id: "stub",
			dir,
			sourcePath: path.join(dir, "stub.bin"),
			stagedPath: path.join(dir, "stub.bin"),
			kind: "inplace",
			openPath: path.join(dir, "stub.i64"),
			isNew: false,
			lockTarget: path.join(dir, "stub.i64"),
		};
		const lock = await acquireFileLock(loc.lockTarget);
		worker = await DisasmWorker.start(DISASM_BACKENDS.ida, loc, runtime, lock, 0);
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
});
