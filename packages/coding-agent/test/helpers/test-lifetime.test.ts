import { describe, expect } from "bun:test";
import { checkCalls, guard, spyOn, trackTestLifetime, vi } from "./test-lifetime";

const { test, beforeEach, afterEach, beforeAll, afterAll } = trackTestLifetime();

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

/** A registry that hands out its own cached plain data, as `ModelRegistry.getAll()` does. */
class Catalog {
	#models = [{ id: "original", tags: ["a"] }];
	#record = { key: "original" };
	getAll(): Array<{ id: string; tags: string[] }> {
		return this.#models;
	}
	async load(): Promise<{ key: string }> {
		return this.#record;
	}
	self(): Catalog {
		return this;
	}
	snapshot(): { models: Array<{ id: string; tags: string[] }>; record: { key: string } } {
		return { models: this.#models, record: this.#record };
	}
}

/** A class that remembers every instance it builds, as `Settings` does in `liveSettingsInstances`. */
class Remembered {
	static #live: Remembered[] = [];
	static build(name: string): Remembered {
		const instance = new Remembered(name);
		Remembered.#live.push(instance);
		return instance;
	}
	static names(): string[] {
		return Remembered.#live.map(instance => instance.name);
	}
	private constructor(readonly name: string) {}
}
const rememberedModule = { Remembered };

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
	// A module's process-wide cache, reached through a guarded namespace as test files reach
	// `invalidateAllCommandConfigs`: the destructured function checks every caller.
	const commandCache = new Map([["key", "cached"]]);
	const { invalidateAll } = guard({ invalidateAll: () => commandCache.clear() });
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
		attempts.moduleFunction = outcome(async () => {
			await release.promise;
			invalidateAll();
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
		expect(Object.keys(results)).toHaveLength(10);
		expect(shared.get("openai")).toBe("fresh");
		expect(shared.limits.marks).toEqual([]);
		expect(config.mode).toBe("initial");
		expect(binding).toBe("initial");
		expect("mock" in Date.now).toBe(false);
		expect(commandCache.get("key")).toBe("cached");
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

describe("data a guard hands out", () => {
	const catalog = guard(new Catalog());
	const release = Promise.withResolvers<void>();
	const attempts: Record<string, Promise<string>> = {};

	test("suspends with writes pending to aliases of the guard's own data", () => {
		// Plain data reached through the guard while the test is live: a cached array, one of its
		// elements, a nested array, a method's plain result, and a resolved promise's value.
		const models = catalog.getAll();
		const first = models[0];
		const snapshot = catalog.snapshot();
		const loaded = catalog.load();
		const later = (write: () => unknown) =>
			outcome(async () => {
				await release.promise;
				await write();
			});
		attempts.element = later(() => {
			first.id = "stale";
		});
		attempts.arrayPush = later(() => models.push({ id: "stale", tags: [] }));
		attempts.nestedArray = later(() => first.tags.push("stale"));
		attempts.methodResult = later(() => {
			snapshot.record.key = "stale";
		});
		attempts.promiseResult = later(async () => {
			(await loaded).key = "stale";
		});
		attempts.iterated = later(() => {
			for (const model of models) model.id = "stale";
		});
	});

	test("finds every write stopped and the data unchanged", async () => {
		release.resolve();
		const results = Object.fromEntries(
			await Promise.all(Object.entries(attempts).map(async ([shape, result]) => [shape, await result] as const)),
		);
		expect(results).toEqual(Object.fromEntries(Object.keys(attempts).map(shape => [shape, RESUMED])));
		expect(Object.keys(results)).toHaveLength(6);
		expect(catalog.getAll()).toEqual([{ id: "original", tags: ["a"] }]);
		expect((await catalog.load()).key).toBe("original");
	});

	test("lets a live test write through that data, and keeps one guard per object", () => {
		const raw = new Catalog();
		const live = guard(raw);
		live.getAll()[0].tags.push("b");
		expect(raw.getAll()[0].tags).toEqual(["a", "b"]);
		expect(live.self()).toBe(live);
		expect(live.getAll()).toBe(live.getAll());
	});
});

describe("a teardown's continuation after its hook returned", () => {
	const shared = guard(new Credentials());
	let late: Promise<string> | undefined;

	afterEach(() => {
		// Runs right after the hook returns, before the next test starts.
		late ??= outcome(() => Promise.resolve().then(() => shared.set("openai", "after teardown returned")));
	});

	test("ends with that continuation queued", () => {
		shared.set("openai", "first test");
	});

	test("never sees it land", async () => {
		expect(await late).toBe(RESUMED);
		expect(shared.get("openai")).toBe("first test");
	});
});

describe("suite hooks that outlive their suite", () => {
	const shared = guard(new Credentials());
	const release = Promise.withResolvers<void>();
	let setupWrite: Promise<string> | undefined;
	let teardownWrite: Promise<string> | undefined;

	describe("a suite whose hooks leave writes pending", () => {
		beforeAll(() => {
			setupWrite = outcome(async () => {
				await release.promise;
				shared.set("openai", "from beforeAll");
			});
		});
		afterAll(() => {
			teardownWrite = outcome(async () => {
				await release.promise;
				shared.set("openai", "from afterAll");
			});
		});
		test("runs between them", () => {
			shared.set("openai", "suite test");
		});
	});

	describe("the next suite", () => {
		test("never sees either write land", async () => {
			shared.set("openai", "next suite");
			release.resolve();
			expect(await setupWrite).toBe(RESUMED);
			expect(await teardownWrite).toBe(RESUMED);
			expect(shared.get("openai")).toBe("next suite");
		});
	});
});

describe("a module reached through checkCalls", () => {
	const { Remembered: Checked } = checkCalls(rememberedModule);
	const release = Promise.withResolvers<void>();
	let stale: Promise<string> | undefined;

	test("hands a live caller the real instance", () => {
		const built = Checked.build("live");
		expect(built).toBeInstanceOf(Remembered);
		expect(Remembered.names()).toContain(built.name);
		stale = outcome(async () => {
			await release.promise;
			Checked.build("stale");
		});
	});

	test("refuses a factory call from a body whose test ended", async () => {
		release.resolve();
		expect(await stale).toBe(RESUMED);
		expect(Remembered.names()).toEqual(["live"]);
	});
});
