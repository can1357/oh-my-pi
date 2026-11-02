import { describe, expect } from "bun:test";
import { guard, spyOn, trackTestLifetime, vi } from "./test-lifetime";

const { test, beforeEach, afterEach } = trackTestLifetime();

const RESUMED = "this test body resumed after its test ended; it stopped before touching shared state";

class Limits {
	marks: string[] = [];
	mark(id: string): void {
		this.marks.push(id);
	}
}

/** Shared state with private fields, a sub-object and a method, as `AuthStorage` has. */
class Credentials {
	#keys = new Map<string, string>();
	limits = new Limits();
	set(provider: string, key: string): void {
		this.#keys.set(provider, key);
	}
	get(provider: string): string | undefined {
		return this.#keys.get(provider);
	}
}

/** What a resumed continuation did: wrote, or stopped with the error it threw. */
async function outcome(write: () => unknown): Promise<string> {
	try {
		await write();
		return "wrote";
	} catch (error) {
		return (error as Error).message;
	}
}

describe("a body that outlives its test", () => {
	const shared = guard(new Credentials());
	const config = guard({ mode: "initial", describe: () => "config" });
	let binding = guard("initial");
	const release = Promise.withResolvers<void>();
	const attempts: Record<string, Promise<string>> = {};

	test("suspends with every shape of later write still pending", () => {
		// Each shape a static check missed: the write is reached after the test ended.
		const limits = shared.limits;
		const install = spyOn;
		const writeThrough = (target: Credentials) => target.set("openai", "stale");
		attempts.afterAwait = outcome(async () => {
			await release.promise;
			shared.set("openai", "stale");
		});
		attempts.aliasTakenBeforeAwait = outcome(async () => {
			await release.promise;
			limits.mark("stale");
		});
		attempts.helper = outcome(async () => {
			await release.promise;
			writeThrough(shared);
		});
		attempts.thenCallback = outcome(() => release.promise.then(() => shared.set("openai", "stale")));
		attempts.reflectSet = outcome(async () => {
			await release.promise;
			Reflect.set(config, "mode", "stale");
		});
		attempts.defineProperty = outcome(async () => {
			await release.promise;
			Object.defineProperty(config, "mode", { value: "stale" });
		});
		attempts.aliasedSpyOn = outcome(async () => {
			await release.promise;
			install(shared, "get").mockReturnValue("stale");
		});
		attempts.viSpyOn = outcome(async () => {
			await release.promise;
			vi.spyOn(Date, "now").mockReturnValue(0);
		});
		attempts.bindingWrite = outcome(async () => {
			await release.promise;
			binding = guard("stale");
		});
		// The body returns here with its writes pending, so this test ends while they wait.
	});

	test("finds every one of them stopped, and its own state untouched", async () => {
		shared.set("openai", "fresh");
		release.resolve();

		const results = Object.fromEntries(
			await Promise.all(Object.entries(attempts).map(async ([shape, result]) => [shape, await result] as const)),
		);
		expect(results).toEqual(Object.fromEntries(Object.keys(attempts).map(shape => [shape, RESUMED])));
		expect(Object.keys(results)).toHaveLength(9);
		expect(shared.get("openai")).toBe("fresh");
		expect(shared.limits.marks).toEqual([]);
		expect(config.mode).toBe("initial");
		expect(binding).toBe("initial");
		expect("mock" in Date.now).toBe(false);
	});
});

describe("a live test", () => {
	test("reads, writes and spies through a guard, and the spy lands on the object itself", () => {
		const raw = new Credentials();
		const shared = guard(raw);
		shared.set("openai", "live");
		expect(raw.get("openai")).toBe("live");
		expect(guard(raw)).toBe(shared);
		expect(shared.limits).toBe(shared.limits);

		const mark = vi.spyOn(shared.limits, "mark");
		raw.limits.mark("from-production");
		expect(mark).toHaveBeenCalledWith("from-production");
		vi.restoreAllMocks();
		expect("mock" in raw.limits.mark).toBe(false);
	});
});

describe("a setup that outlives its test", () => {
	let fixture = guard({ owner: "initial" });
	const release = Promise.withResolvers<void>();
	let stale: Promise<string> | undefined;

	beforeEach(() => {
		// The first setup leaves a write pending, as a timed-out `beforeEach` would.
		stale ??= outcome(async () => {
			await release.promise;
			fixture = guard({ owner: "first setup" });
		});
	});

	test("ends with its setup's write still pending", () => {
		expect(fixture.owner).toBe("initial");
	});

	test("never sees that write land", async () => {
		fixture = guard({ owner: "second test" });
		release.resolve();
		expect(await stale).toBe(RESUMED);
		expect(fixture.owner).toBe("second test");
	});
});

describe("a teardown that outlives its test", () => {
	const shared = guard(new Credentials());
	const release = Promise.withResolvers<void>();
	let stale: Promise<string> | undefined;

	afterEach(() => {
		stale ??= outcome(async () => {
			await release.promise;
			shared.set("openai", "first teardown");
		});
	});

	test("ends with its teardown's write still pending", () => {
		shared.set("openai", "first test");
	});

	test("never sees that write land", async () => {
		shared.set("openai", "second test");
		release.resolve();
		expect(await stale).toBe(RESUMED);
		expect(shared.get("openai")).toBe("second test");
	});
});
