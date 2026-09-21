import { afterEach, describe, expect, it } from "bun:test";

const PRELUDE_URL = new URL("../../src/eval/js/shared/prelude.txt", import.meta.url);

type WaitFn = (handles: unknown, opts?: unknown, ...rest: unknown[]) => Promise<unknown[]>;
type HandleCtor = new (
	kind: string,
	id: string,
	schema?: unknown,
) => { wait: (...args: unknown[]) => Promise<unknown> };

async function loadFreshPrelude(calls: Array<{ name: string; args: unknown }>): Promise<{
	wait: WaitFn;
	AgentHandle: HandleCtor;
}> {
	(globalThis as Record<string, unknown>).__omp_js_prelude_loaded__ = false;
	(globalThis as Record<string, unknown>).__omp_call_tool__ = async (name: string, args: unknown) => {
		calls.push({ name, args });
		throw new Error(`unexpected bridge call ${name}`);
	};
	(0, eval)(await Bun.file(PRELUDE_URL).text());
	const g = globalThis as Record<string, unknown>;
	return { wait: g.wait, AgentHandle: g.AgentHandle } as { wait: WaitFn; AgentHandle: HandleCtor };
}

afterEach(() => {
	delete (globalThis as Record<string, unknown>).wait;
	delete (globalThis as Record<string, unknown>).AgentHandle;
});

describe("eval js prelude wait() timeout (issue #12549)", () => {
	it("accepts a positional timeout in seconds", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const { wait, AgentHandle } = await loadFreshPrelude(calls);
		const handle = new AgentHandle("agent", "a1");

		await expect(wait([handle], 30)).rejects.toThrow();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("__wait__");
		expect(calls[0]?.args).toMatchObject({ timeoutMs: 30_000 });
	});

	it("accepts a positional timeout on AgentHandle.wait", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const { AgentHandle } = await loadFreshPrelude(calls);
		const handle = new AgentHandle("agent", "a1");

		await expect(handle.wait(45)).rejects.toThrow();
		expect(calls[0]?.args).toMatchObject({ timeoutMs: 45_000 });
	});

	it("keeps the options-object form working", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const { wait, AgentHandle } = await loadFreshPrelude(calls);
		const handle = new AgentHandle("agent", "a1");

		await expect(wait([handle], { timeout: 10 })).rejects.toThrow();
		expect(calls.at(-1)?.args).toMatchObject({ timeoutMs: 10_000 });
	});

	it("rejects mixing an options object with positional args", async () => {
		const { wait, AgentHandle } = await loadFreshPrelude([]);
		const handle = new AgentHandle("agent", "a1");

		await expect(wait([handle], { timeout: 10 }, true)).rejects.toThrow(TypeError);
	});
});
