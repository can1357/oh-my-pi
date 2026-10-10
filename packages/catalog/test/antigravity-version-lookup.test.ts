import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { ensureAntigravityVersion } from "@oh-my-pi/pi-catalog/wire/gemini-headers";

const RETRY_WINDOW_MS = 10 * 60_000;
// The lookup state is process-wide; every test starts on a fresh clock past any
// backoff an earlier test (or file) left behind.
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

describe("ensureAntigravityVersion", () => {
	beforeEach(() => {
		delete process.env.PI_AI_ANTIGRAVITY_VERSION;
		clock += RETRY_WINDOW_MS * 10;
		setSystemTime(new Date(clock));
	});

	afterEach(() => {
		setSystemTime();
		if (savedVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
		else process.env.PI_AI_ANTIGRAVITY_VERSION = savedVersion;
	});

	it("does not refetch a failed manifest until the retry window passes", async () => {
		const { fetcher, calls } = countingFetch(async () => new Response("unavailable", { status: 503 }));

		await ensureAntigravityVersion(fetcher);
		await ensureAntigravityVersion(fetcher);
		expect(calls()).toBe(1);

		clock += RETRY_WINDOW_MS + 1;
		setSystemTime(new Date(clock));
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
});
