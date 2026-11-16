import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	SessionRuntimePool,
	type SessionRuntimeRetirement,
	type SessionRuntimeStore,
	sessionRuntimeStore,
} from "@oh-my-pi/pi-ai/providers/antigravity-cli/runtime-pool";

interface FakeRuntime {
	id: number;
	pending: boolean;
	closed: number;
	disposed: number;
}

interface Retirement {
	key: string;
	reason: SessionRuntimeRetirement;
}

function harness(options: { timeoutMs?: number; store?: SessionRuntimeStore<FakeRuntime> } = {}) {
	const created: FakeRuntime[] = [];
	const retirements: Retirement[] = [];
	const pool = new SessionRuntimePool<FakeRuntime>(
		() => {
			const runtime: FakeRuntime = { id: created.length, pending: false, closed: 0, disposed: 0 };
			created.push(runtime);
			return runtime;
		},
		async (runtime, key, reason) => {
			retirements.push({ key, reason });
			if (reason === "idle") runtime.closed++;
			else runtime.disposed++;
		},
		{ timeoutMs: options.timeoutMs ?? 60_000, canDispose: runtime => !runtime.pending },
		options.store,
	);
	return { pool, created, retirements };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("SessionRuntimePool", () => {
	it("retains one runtime per key and never instantiates on inspection", () => {
		const { pool, created } = harness();
		expect(pool.peek("a")).toBeUndefined();
		expect(created).toHaveLength(0);

		const first = pool.get("a");
		expect(pool.get("a")).toBe(first);
		const second = pool.get("b");
		expect(second).not.toBe(first);
		expect(pool.peek("a")).toBe(first);
		expect(pool.values()).toEqual([first, second]);
	});

	it("keeps a leased runtime out of idle retirement until the last release", async () => {
		vi.useFakeTimers();
		const { pool, created, retirements } = harness({ timeoutMs: 1_000 });
		const lease = pool.acquire("a");
		lease.release();

		vi.advanceTimersByTime(999);
		expect(retirements).toHaveLength(0);

		const second = pool.acquire("a");
		expect(second.value).toBe(lease.value);
		vi.advanceTimersByTime(10_000);
		expect(retirements).toHaveLength(0);
		expect(pool.peek("a")).toBe(lease.value);

		second.release();
		second.release();
		vi.advanceTimersByTime(1_000);
		expect(retirements).toEqual([{ key: "a", reason: "idle" }]);
		expect(pool.peek("a")).toBeUndefined();
		expect(created[0]?.closed).toBe(1);
		expect(created[0]?.disposed).toBe(0);
	});

	it("retries the idle timer while the runtime still owns work", () => {
		vi.useFakeTimers();
		const { pool, created, retirements } = harness({ timeoutMs: 1_000 });
		const runtime = pool.get("a");
		runtime.pending = true;

		vi.advanceTimersByTime(5_000);
		expect(retirements).toHaveLength(0);
		expect(pool.peek("a")).toBe(runtime);

		runtime.pending = false;
		vi.advanceTimersByTime(1_000);
		expect(retirements).toEqual([{ key: "a", reason: "idle" }]);
		expect(created).toHaveLength(1);
	});

	it("never returns an explicitly disposed runtime to a later request", async () => {
		const { pool, created, retirements } = harness();
		const first = pool.get("a");
		await pool.close("a");

		expect(retirements).toEqual([{ key: "a", reason: "dispose" }]);
		expect(first.disposed).toBe(1);
		expect(pool.peek("a")).toBeUndefined();
		expect(pool.values()).toEqual([]);

		const second = pool.get("a");
		expect(second).not.toBe(first);
		expect(created).toEqual([first, second]);
	});

	it("refuses to retire a missing, leased or busy entry as idle", async () => {
		const { pool, created, retirements } = harness();
		expect(await pool.closeIdle("a")).toBe(false);

		const lease = pool.acquire("a");
		expect(await pool.closeIdle("a")).toBe(false);
		lease.release();

		created[0]!.pending = true;
		expect(await pool.closeIdle("a")).toBe(false);

		created[0]!.pending = false;
		expect(await pool.closeIdle("a")).toBe(true);
		expect(retirements).toEqual([{ key: "a", reason: "idle" }]);
		expect(pool.peek("a")).toBeUndefined();
	});

	it("drains in-flight disposals before closeAll resolves", async () => {
		const settled: string[] = [];
		const gate = Promise.withResolvers<void>();
		const pool = new SessionRuntimePool<{ key: string }>(
			key => ({ key }),
			async (runtime, _key, reason) => {
				if (reason === "dispose" && runtime.key === "slow") await gate.promise;
				settled.push(runtime.key);
			},
			{ timeoutMs: 0 },
		);
		pool.get("fast");
		pool.get("slow");
		const closing = pool.close("slow");
		const drained = pool.closeAll();
		await Promise.resolve();
		expect(settled).toEqual(["fast"]);

		gate.resolve();
		await Promise.all([closing, drained]);
		expect(settled.sort()).toEqual(["fast", "slow"]);
		expect(pool.values()).toEqual([]);
	});

	it("leaves a caller-owned map as the source of truth", async () => {
		const states = new Map<string, unknown>();
		const foreign = { close: () => undefined };
		states.set("other-provider:session", foreign);
		const store = sessionRuntimeStore(
			states,
			(value): value is FakeRuntime => typeof value === "object" && value !== null && "pending" in value,
		);
		const { pool, created, retirements } = harness({ store });

		const runtime = pool.get("antigravity-acp:acct:default");
		expect(states.get("antigravity-acp:acct:default")).toBe(runtime);
		expect(pool.values()).toEqual([runtime]);

		states.delete("antigravity-acp:acct:default");
		expect(pool.peek("antigravity-acp:acct:default")).toBeUndefined();
		expect(pool.get("antigravity-acp:acct:default")).not.toBe(runtime);
		expect(created).toHaveLength(2);

		await pool.closeAll();
		expect(states.get("other-provider:session")).toBe(foreign);
		expect(states.has("antigravity-acp:acct:default")).toBe(false);
		expect(retirements.every(entry => entry.reason === "dispose")).toBe(true);
	});
});
