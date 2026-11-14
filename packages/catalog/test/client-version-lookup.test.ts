import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { createVersionLookup, npmLatestVersion } from "@oh-my-pi/pi-catalog/wire/client-version-lookup";

const TTL_MS = 60 * 60_000;
const RETRY_MS = 10 * 60_000;

function countingFetch(respond: () => Promise<Response>): { fetcher: FetchImpl; urls: string[] } {
	const urls: string[] = [];
	const fetcher = Object.assign(
		(input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
			urls.push(String(input));
			return respond();
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetcher, urls };
}

const distTags = (tags: Record<string, unknown>) => async () => new Response(JSON.stringify(tags), { status: 200 });
const npmLookup = (options: { ttlMs?: number; retryMs?: number } = {}) =>
	createVersionLookup({ resolve: npmLatestVersion("@scope/tool"), ...options });

/** True when `promise` is already settled: its reaction is queued before a fresh sentinel's. */
function settlesNow(promise: Promise<unknown>): Promise<boolean> {
	return Promise.race([promise.then(() => true), Promise.resolve().then(() => false)]);
}

/** Lets a background lookup whose source already answered finish updating the cache. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("createVersionLookup", () => {
	let clock = Date.now();
	const advance = (ms: number) => {
		clock += ms;
		setSystemTime(new Date(clock));
	};

	beforeEach(() => {
		clock = Date.now();
		setSystemTime(new Date(clock));
	});

	afterEach(() => {
		setSystemTime();
	});

	it("awaits the lookup on a cold cache", async () => {
		const lookup = createVersionLookup({ resolve: async () => "1.0.0" });
		const release = Promise.withResolvers<string>();
		const pending = createVersionLookup({ resolve: () => release.promise });

		await lookup.ensure();
		expect(lookup.current()).toBe("1.0.0");

		const cold = pending.ensure();
		expect(await settlesNow(cold)).toBe(false);
		release.resolve("2.0.0");
		await cold;
		expect(pending.current()).toBe("2.0.0");
	});

	it("refreshes a stale version in the background and returns at once", async () => {
		const versions = ["1.0.0", "1.1.0"];
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const lookup = createVersionLookup({
			resolve: async () => {
				const version = versions[calls++];
				if (calls > 1) await release.promise;
				return version;
			},
		});

		await lookup.ensure();
		advance(TTL_MS + 1);
		const stale = lookup.ensure();
		expect(await settlesNow(stale)).toBe(true);
		expect(calls).toBe(2);
		expect(lookup.current()).toBe("1.0.0");

		// A second stale caller joins the background refresh instead of starting another.
		await lookup.ensure();
		expect(calls).toBe(2);

		release.resolve();
		await flushMicrotasks();
		expect(lookup.current()).toBe("1.1.0");
	});

	it("keeps the last good version when a background refresh fails, then backs off", async () => {
		let fail = false;
		let calls = 0;
		const lookup = createVersionLookup({
			resolve: async () => {
				calls++;
				if (fail) throw new TypeError("network down");
				return "1.0.0";
			},
		});

		await lookup.ensure();
		advance(TTL_MS + 1);
		fail = true;
		await lookup.ensure();
		await flushMicrotasks();
		expect(calls).toBe(2);
		expect(lookup.current()).toBe("1.0.0");

		await lookup.ensure();
		expect(calls).toBe(2);
		advance(RETRY_MS + 1);
		await lookup.ensure();
		expect(calls).toBe(3);
	});

	it("starts no lookup for an already-aborted signal", async () => {
		const lookup = npmLookup();
		const { fetcher, urls } = countingFetch(distTags({ latest: "1.0.0" }));

		await lookup.ensure(fetcher, AbortSignal.abort());
		expect(urls).toHaveLength(0);

		await lookup.ensure(fetcher);
		advance(TTL_MS + 1);
		await lookup.ensure(fetcher, AbortSignal.abort());
		expect(urls).toHaveLength(1);
	});

	it("lets an aborted caller stop waiting without cancelling the shared lookup", async () => {
		const lookup = npmLookup();
		const release = Promise.withResolvers<Response>();
		const { fetcher, urls } = countingFetch(() => release.promise);
		const controller = new AbortController();

		const aborted = lookup.ensure(fetcher, controller.signal);
		const concurrent = lookup.ensure(fetcher);
		controller.abort();
		await aborted;
		expect(await settlesNow(concurrent)).toBe(false);

		release.resolve(new Response(JSON.stringify({ latest: "2.0.0" }), { status: 200 }));
		await concurrent;
		expect(urls).toHaveLength(1);
		expect(lookup.current()).toBe("2.0.0");
	});

	it("shares one in-flight lookup across concurrent callers", async () => {
		const lookup = npmLookup();
		const release = Promise.withResolvers<Response>();
		const { fetcher, urls } = countingFetch(() => release.promise);

		const callers = [lookup.ensure(fetcher), lookup.ensure(fetcher), lookup.ensure(fetcher)];
		release.resolve(new Response(JSON.stringify({ latest: "2.0.0" }), { status: 200 }));
		await Promise.all(callers);

		expect(urls).toHaveLength(1);
		expect(lookup.current()).toBe("2.0.0");
	});

	it("backs off after a cold failure instead of refetching per call", async () => {
		const lookup = npmLookup();
		const { fetcher, urls } = countingFetch(async () => new Response("unavailable", { status: 503 }));

		await lookup.ensure(fetcher);
		await lookup.ensure(fetcher);
		expect(urls).toHaveLength(1);
		expect(lookup.current()).toBeUndefined();

		advance(RETRY_MS + 1);
		await lookup.ensure(fetcher);
		expect(urls).toHaveLength(2);
	});

	it("treats a thrown fetch as a silent failure", async () => {
		const lookup = npmLookup();
		const { fetcher } = countingFetch(async () => {
			throw new TypeError("network down");
		});

		await expect(lookup.ensure(fetcher)).resolves.toBeUndefined();
		expect(lookup.current()).toBeUndefined();
	});

	it("honors custom TTL and retry windows", async () => {
		const lookup = npmLookup({ ttlMs: 1_000, retryMs: 500 });
		let respond = distTags({ latest: "1.0.0" });
		const { fetcher, urls } = countingFetch(() => respond());

		await lookup.ensure(fetcher);
		advance(999);
		await lookup.ensure(fetcher);
		expect(urls).toHaveLength(1);
		advance(2);
		respond = async () => new Response("unavailable", { status: 503 });
		await lookup.ensure(fetcher);
		await flushMicrotasks();
		expect(urls).toHaveLength(2);
		advance(501);
		await lookup.ensure(fetcher);
		expect(urls).toHaveLength(3);
		expect(lookup.current()).toBe("1.0.0");
	});

	it("never re-checks a version with an infinite TTL", async () => {
		const lookup = createVersionLookup({ ttlMs: Number.POSITIVE_INFINITY, resolve: async () => "1.0.0" });
		const { fetcher, urls } = countingFetch(distTags({ latest: "1.0.0" }));
		await lookup.ensure(fetcher);
		advance(TTL_MS * 1_000);
		await lookup.ensure(fetcher);
		expect(urls).toHaveLength(0);
		expect(lookup.current()).toBe("1.0.0");
	});

	it("resetForTest drops the cached version and back-off", async () => {
		const lookup = npmLookup();
		const { fetcher, urls } = countingFetch(distTags({ latest: "1.0.0" }));

		await lookup.ensure(fetcher);
		lookup.resetForTest();
		expect(lookup.current()).toBeUndefined();
		await lookup.ensure(fetcher);
		expect(urls).toHaveLength(2);
	});
});

describe("npmLatestVersion", () => {
	it("adopts the dist-tags `latest` version and ignores other channels", async () => {
		const lookup = npmLookup();
		const { fetcher, urls } = countingFetch(
			distTags({ latest: "1.4.0", preview: "1.5.0-preview.0", nightly: "1.5.0-nightly.20261104" }),
		);

		await lookup.ensure(fetcher);

		expect(urls).toEqual(["https://registry.npmjs.org/-/package/@scope/tool/dist-tags"]);
		expect(lookup.current()).toBe("1.4.0");
	});

	it("rejects prerelease and malformed `latest` values", async () => {
		const resolve = npmLatestVersion("@scope/tool");
		const signal = AbortSignal.timeout(5_000);
		for (const latest of ["1.5.0-preview.0", "v1.4.0", "1.4", "", 140, null]) {
			expect(await resolve(countingFetch(distTags({ latest })).fetcher, signal)).toBeNull();
		}
		expect(await resolve(countingFetch(distTags({ next: "1.0.0" })).fetcher, signal)).toBeNull();
		expect(await resolve(countingFetch(async () => new Response("[]", { status: 200 })).fetcher, signal)).toBeNull();
		await expect(
			resolve(countingFetch(async () => new Response("not json", { status: 200 })).fetcher, signal),
		).rejects.toThrow();
	});
});
