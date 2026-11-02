import { afterEach, describe, expect, it, vi } from "bun:test";
import { handleDiscourse } from "@oh-my-pi/pi-coding-agent/web/scrapers/discourse";
import { handleMastodon } from "@oh-my-pi/pi-coding-agent/web/scrapers/mastodon";

type FetchArgs = Parameters<typeof fetch>;

/** Route every fetch to `respond`, counting calls. */
function mockFetch(respond: (url: string, init?: RequestInit) => Promise<Response> | Response): {
	calls: () => number;
} {
	let calls = 0;
	const implementation = async (...[input, init]: FetchArgs): Promise<Response> => {
		calls++;
		return respond(input instanceof Request ? input.url : String(input), init);
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(implementation, { preconnect: globalThis.fetch.preconnect }),
	);
	return { calls: () => calls };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("mastodon instance probe", () => {
	it("does not let one caller's abort decide the shared probe verdict for concurrent callers", async () => {
		const host = "probe-abort.mastodon.test";
		const instance = Promise.withResolvers<void>();
		let statusRequested = false;
		mockFetch(async (url, init) => {
			if (url.endsWith("/api/v1/instance")) {
				const signal = init?.signal;
				const settled = Promise.withResolvers<void>();
				signal?.addEventListener("abort", () => settled.reject(signal.reason), { once: true });
				instance.promise.then(settled.resolve);
				await settled.promise;
				return Response.json({ uri: host });
			}
			statusRequested = true;
			return new Response("not found", { status: 404 });
		});

		const abortFirst = new AbortController();
		const first = handleMastodon(`https://${host}/@alice/1`, 20, abortFirst.signal);
		const second = handleMastodon(`https://${host}/@alice/1`, 20);
		abortFirst.abort();
		expect(await first).toBeNull();
		instance.resolve();

		expect(await second).toBeNull();
		// The second caller saw a positive verdict and went on to fetch the status.
		expect(statusRequested).toBe(true);
	});

	it("re-probes after an inconclusive server error instead of memoizing it", async () => {
		const host = "probe-503.mastodon.test";
		const { calls } = mockFetch(() => new Response("unavailable", { status: 503 }));
		expect(await handleMastodon(`https://${host}/@alice/1`, 20)).toBeNull();
		const afterFirst = calls();
		expect(afterFirst).toBeGreaterThan(0);
		expect(await handleMastodon(`https://${host}/@alice/1`, 20)).toBeNull();
		expect(calls()).toBeGreaterThan(afterFirst);
	});
});

describe("discourse origin memo", () => {
	it("skips a host whose topic API answered with an HTML 404, until the negative expires", async () => {
		const host = "html-404.discourse.test";
		const { calls } = mockFetch(() => new Response("<html>not found</html>", { status: 404 }));
		expect(await handleDiscourse(`https://${host}/t/slug/1`, 20)).toBeNull();
		const afterFirst = calls();
		expect(afterFirst).toBeGreaterThan(0);
		expect(await handleDiscourse(`https://${host}/t/slug/2`, 20)).toBeNull();
		expect(calls()).toBe(afterFirst);

		// Eleven minutes later the negative verdict has lapsed.
		const now = performance.now();
		vi.spyOn(performance, "now").mockReturnValue(now + 11 * 60_000);
		expect(await handleDiscourse(`https://${host}/t/slug/3`, 20)).toBeNull();
		expect(calls()).toBeGreaterThan(afterFirst);
	});

	it("keeps fetching from a real instance that answers a deleted topic with a JSON 404", async () => {
		const host = "json-404.discourse.test";
		const { calls } = mockFetch(() => Response.json({ errors: ["not found"] }, { status: 404 }));
		expect(await handleDiscourse(`https://${host}/t/slug/1`, 20)).toBeNull();
		const afterFirst = calls();
		expect(await handleDiscourse(`https://${host}/t/slug/2`, 20)).toBeNull();
		expect(calls()).toBeGreaterThan(afterFirst);
	});
});
