import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import {
	ensureAntigravityVersion,
	getAntigravityPlatform,
	getAntigravityVersion,
	resetAntigravityVersionForTest,
} from "@oh-my-pi/pi-catalog/wire/gemini-headers";

const RETRY_WINDOW_MS = 10 * 60_000;
const RECHECK_WINDOW_MS = 60 * 60_000;
let clock = Date.now();
const savedVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;

function countingFetch(respond: () => Promise<Response>): { fetcher: FetchImpl; calls: () => number } {
	let calls = 0;
	const fetcher = Object.assign(
		(_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
			calls++;
			return respond();
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetcher, calls: () => calls };
}

function manifest(version: string): Response {
	return new Response(`version: ${version}\npath: Antigravity-${version}.zip\n`);
}

function advance(ms: number): void {
	clock += ms;
	setSystemTime(new Date(clock));
}

/** Lets a background re-check whose manifest already answered finish updating the cache. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("ensureAntigravityVersion", () => {
	beforeEach(() => {
		delete process.env.PI_AI_ANTIGRAVITY_VERSION;
		resetAntigravityVersionForTest();
		clock = Date.now();
		setSystemTime(new Date(clock));
	});

	afterEach(() => {
		resetAntigravityVersionForTest();
		setSystemTime();
		if (savedVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
		else process.env.PI_AI_ANTIGRAVITY_VERSION = savedVersion;
	});

	it("does not refetch a failed manifest until the retry window passes", async () => {
		const { fetcher, calls } = countingFetch(async () => new Response("unavailable", { status: 503 }));

		await ensureAntigravityVersion(fetcher);
		await ensureAntigravityVersion(fetcher);
		expect(calls()).toBe(1);

		advance(RETRY_WINDOW_MS + 1);
		await ensureAntigravityVersion(fetcher);
		expect(calls()).toBe(2);
	});

	it("lets an aborted caller stop waiting without cancelling the shared lookup", async () => {
		const release = Promise.withResolvers<Response>();
		const { fetcher, calls } = countingFetch(() => release.promise);
		const controller = new AbortController();

		const aborted = ensureAntigravityVersion(fetcher, controller.signal);
		let concurrentSettled = false;
		const concurrent = ensureAntigravityVersion(fetcher).then(() => {
			concurrentSettled = true;
		});
		controller.abort();
		await aborted;

		expect(concurrentSettled).toBe(false);
		expect(calls()).toBe(1);

		release.resolve(new Response("unavailable", { status: 503 }));
		await concurrent;
		expect(calls()).toBe(1);
	});

	it("does not refetch a discovered version inside the re-check window", async () => {
		const { fetcher, calls } = countingFetch(async () => manifest("9.1.0"));

		await ensureAntigravityVersion(fetcher);
		expect(getAntigravityVersion()).toBe("9.1.0");
		advance(RECHECK_WINDOW_MS - 1);
		await ensureAntigravityVersion(fetcher);
		expect(calls()).toBe(1);
	});

	it("re-checks in the background after the window, without holding the caller, and adopts a newer release", async () => {
		await ensureAntigravityVersion(countingFetch(async () => manifest("9.2.0")).fetcher);
		expect(getAntigravityVersion()).toBe("9.2.0");

		advance(RECHECK_WINDOW_MS + 1);
		const release = Promise.withResolvers<Response>();
		const { fetcher, calls } = countingFetch(() => release.promise);
		const recheck = ensureAntigravityVersion(fetcher);
		// The stale call settles before the manifest answers; the old version stays in use meanwhile.
		const settledFirst = await Promise.race([recheck.then(() => true), Promise.resolve().then(() => false)]);
		expect(settledFirst).toBe(true);
		expect(calls()).toBe(1);
		expect(getAntigravityVersion()).toBe("9.2.0");

		release.resolve(manifest("9.3.0"));
		await flushMicrotasks();
		expect(getAntigravityVersion()).toBe("9.3.0");
	});

	it("keeps the discovered version after a failed re-check and backs off", async () => {
		await ensureAntigravityVersion(countingFetch(async () => manifest("9.4.0")).fetcher);

		advance(RECHECK_WINDOW_MS + 1);
		const { fetcher, calls } = countingFetch(async () => new Response("unavailable", { status: 503 }));
		await ensureAntigravityVersion(fetcher);
		await flushMicrotasks();
		expect(calls()).toBe(1);
		expect(getAntigravityVersion()).toBe("9.4.0");

		await ensureAntigravityVersion(fetcher);
		expect(calls()).toBe(1);
		advance(RETRY_WINDOW_MS + 1);
		await ensureAntigravityVersion(fetcher);
		expect(calls()).toBe(2);
	});
});

describe("getAntigravityPlatform", () => {
	it("reports the native build shipped for each host OS, not the host arch", () => {
		expect(getAntigravityPlatform("darwin")).toEqual({ os: "darwin", arch: "arm64" });
		expect(getAntigravityPlatform("linux")).toEqual({ os: "linux", arch: "amd64" });
		expect(getAntigravityPlatform("win32")).toEqual({ os: "windows", arch: "amd64" });
	});

	it("falls back to the Linux build on an OS without a native client", () => {
		expect(getAntigravityPlatform("freebsd")).toEqual({ os: "linux", arch: "amd64" });
	});
});
