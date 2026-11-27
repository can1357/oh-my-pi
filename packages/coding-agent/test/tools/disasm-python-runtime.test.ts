import { describe, expect, it } from "bun:test";
import { DisasmUnavailableError, type WorkerRuntime } from "@oh-my-pi/pi-coding-agent/disasm/backend";
import { memoizeWorkerRuntime } from "@oh-my-pi/pi-coding-agent/disasm/python-runtime";

/** A resolver that counts its runs and settles when the test says so. */
function controlled() {
	const pending: PromiseWithResolvers<WorkerRuntime>[] = [];
	const resolve = () => {
		const next = Promise.withResolvers<WorkerRuntime>();
		pending.push(next);
		return next.promise;
	};
	return { pending, resolve };
}

describe("memoizeWorkerRuntime", () => {
	it("shares one resolution between concurrent and later callers of the same backend and inputs", async () => {
		const { pending, resolve } = controlled();
		const inputs = ["/usr/bin/python3", "/opt/shared-install", "/work/shared"];
		const first = memoizeWorkerRuntime("ida", inputs, resolve);
		const second = memoizeWorkerRuntime("ida", [...inputs], resolve);
		expect(pending).toHaveLength(1);

		const runtime: WorkerRuntime = { pythonPath: "/usr/bin/python3", env: {} };
		pending[0].resolve(runtime);
		expect(await first).toBe(runtime);
		expect(await second).toBe(runtime);
		expect(await memoizeWorkerRuntime("ida", inputs, resolve)).toBe(runtime);
		expect(pending).toHaveLength(1);
	});

	it("resolves separately for another backend, another input, and an unset input", () => {
		const { pending, resolve } = controlled();
		void memoizeWorkerRuntime("ida", ["py", "/opt/split-install", "/work/split"], resolve);
		void memoizeWorkerRuntime("binja", ["py", "/opt/split-install", "/work/split"], resolve);
		void memoizeWorkerRuntime("ida", ["py", "/opt/split-install", "/work/elsewhere"], resolve);
		// Unset is its own value, and positions do not run together.
		void memoizeWorkerRuntime("ida", [undefined, "/opt/split-install", "/work/split"], resolve);
		void memoizeWorkerRuntime("ida", ["py", undefined, "/opt/split-install/work/split"], resolve);
		expect(pending).toHaveLength(5);
	});

	it("evicts a failed resolution so the next call retries, and reports the failure to everyone waiting on it", async () => {
		const { pending, resolve } = controlled();
		const inputs = [undefined, "/opt/retry-install", "/work/retry"];
		const first = memoizeWorkerRuntime("binja", inputs, resolve);
		const sharing = memoizeWorkerRuntime("binja", inputs, resolve);
		pending[0].reject(new DisasmUnavailableError("no interpreter"));
		await expect(first).rejects.toThrow("no interpreter");
		await expect(sharing).rejects.toThrow("no interpreter");

		const retry = memoizeWorkerRuntime("binja", inputs, resolve);
		expect(pending).toHaveLength(2);
		const runtime: WorkerRuntime = { pythonPath: "/usr/bin/python3", env: {} };
		pending[1].resolve(runtime);
		expect(await retry).toBe(runtime);
	});
});
