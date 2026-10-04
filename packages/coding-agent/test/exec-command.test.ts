import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { execCommand } from "../src/exec/exec";

const HANG = ["-e", "setTimeout(() => {}, 30_000)"];

describe("execCommand", () => {
	it("reports a non-zero code when the timeout kills the process", async () => {
		const result = await execCommand(process.execPath, HANG, process.cwd(), { timeout: 50 });
		expect(result.killed).toBe(true);
		expect(result.code).toBe(-1);
	});

	it("reports a non-zero code when the signal aborts the process", async () => {
		const controller = new AbortController();
		const pending = execCommand(process.execPath, HANG, process.cwd(), { signal: controller.signal });
		controller.abort();
		const result = await pending;
		expect(result.killed).toBe(true);
		expect(result.code).toBe(-1);
	});

	it("reports cancellation when the child traps SIGTERM and exits zero", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "exec-graceful-"));
		const marker = path.join(dir, "ready");
		const watcher = fs.watch(dir);
		const ready = Promise.withResolvers<void>();
		watcher.once("change", () => ready.resolve());

		try {
			const controller = new AbortController();
			// The child signals readiness after installing its handler; its timer never fires.
			const script = `process.on("SIGTERM", () => process.exit(0)); await Bun.write(${JSON.stringify(marker)}, "ready"); setTimeout(() => {}, 30_000);`;
			const pending = execCommand(process.execPath, ["-e", script], process.cwd(), { signal: controller.signal });
			await ready.promise;
			controller.abort();
			const result = await pending;
			expect(result.killed).toBe(true);
			expect(result.code).toBe(-1);
		} finally {
			watcher.close();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});
