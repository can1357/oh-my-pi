import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { createNpmVersionLookup } from "@oh-my-pi/pi-catalog/wire/npm-client-version";

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

describe("createNpmVersionLookup", () => {
	let clock = Date.now();
	const advance = (ms: number) => {
		clock += ms;
		setSystemTime(new Date(clock));
	};

	afterEach(() => {
		setSystemTime();
	});

	it("adopts the dist-tags `latest` version and ignores other channels", async () => {
		const lookup = createNpmVersionLookup("@scope/tool");
		const { fetcher, urls } = countingFetch(
			distTags({ latest: "1.4.0", preview: "1.5.0-preview.0", nightly: "1.5.0-nightly.20261104" }),
		);

		await lookup.ensure(fetcher);

		expect(urls).toEqual(["https://registry.npmjs.org/-/package/@scope/tool/dist-tags"]);
		expect(lookup.current()).toBe("1.4.0");
	});

	it("rejects prerelease and malformed `latest` values", async () => {
		for (const latest of ["1.5.0-preview.0", "v1.4.0", "1.4", "", 140, null]) {
			const lookup = createNpmVersionLookup("@scope/tool");
			await lookup.ensure(countingFetch(distTags({ latest })).fetcher);
			expect(lookup.current()).toBeUndefined();
		}
		const lookup = createNpmVersionLookup("@scope/tool");
		await lookup.ensure(countingFetch(async () => new Response("not json", { status: 200 })).fetcher);
		expect(lookup.current()).toBeUndefined();
	});

	it("backs off after a failure instead of refetching per call", async () => {
		const lookup = createNpmVersionLookup("@scope/tool");
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
		const lookup = createNpmVersionLookup("@scope/tool");
		const { fetcher } = countingFetch(async () => {
			throw new TypeError("network down");
		});

		await expect(lookup.ensure(fetcher)).resolves.toBeUndefined();
		expect(lookup.current()).toBeUndefined();
	});

	it("shares one in-flight lookup across concurrent callers", async () => {
		const lookup = createNpmVersionLookup("@scope/tool");
		const release = Promise.withResolvers<Response>();
		const { fetcher, urls } = countingFetch(() => release.promise);

		const callers = [lookup.ensure(fetcher), lookup.ensure(fetcher), lookup.ensure(fetcher)];
		release.resolve(new Response(JSON.stringify({ latest: "2.0.0" }), { status: 200 }));
		await Promise.all(callers);

		expect(urls).toHaveLength(1);
		expect(lookup.current()).toBe("2.0.0");
	});

	it("lets an aborted caller stop waiting without cancelling the shared lookup", async () => {
		const lookup = createNpmVersionLookup("@scope/tool");
		const release = Promise.withResolvers<Response>();
		const { fetcher, urls } = countingFetch(() => release.promise);
		const controller = new AbortController();

		const aborted = lookup.ensure(fetcher, controller.signal);
		let concurrentSettled = false;
		const concurrent = lookup.ensure(fetcher).then(() => {
			concurrentSettled = true;
		});
		controller.abort();
		await aborted;
		expect(concurrentSettled).toBe(false);

		release.resolve(new Response(JSON.stringify({ latest: "2.0.0" }), { status: 200 }));
		await concurrent;
		expect(urls).toHaveLength(1);
		expect(lookup.current()).toBe("2.0.0");
	});

	it("re-checks after the TTL, adopting a newer release and keeping the last good on failure", async () => {
		const lookup = createNpmVersionLookup("@scope/tool");
		let respond = distTags({ latest: "1.0.0" });
		const { fetcher, urls } = countingFetch(() => respond());

		await lookup.ensure(fetcher);
		await lookup.ensure(fetcher);
		expect(urls).toHaveLength(1);
		expect(lookup.current()).toBe("1.0.0");

		advance(TTL_MS + 1);
		respond = distTags({ latest: "1.1.0" });
		await lookup.ensure(fetcher);
		expect(urls).toHaveLength(2);
		expect(lookup.current()).toBe("1.1.0");

		advance(TTL_MS + 1);
		respond = async () => new Response("unavailable", { status: 503 });
		await lookup.ensure(fetcher);
		expect(urls).toHaveLength(3);
		expect(lookup.current()).toBe("1.1.0");

		// The failed re-check backs off rather than retrying on every call.
		await lookup.ensure(fetcher);
		expect(urls).toHaveLength(3);
	});

	it("honors custom TTL and retry windows", async () => {
		const lookup = createNpmVersionLookup("@scope/tool", { ttlMs: 1_000, retryMs: 500 });
		let respond = distTags({ latest: "1.0.0" });
		const { fetcher, urls } = countingFetch(() => respond());

		await lookup.ensure(fetcher);
		advance(1_001);
		respond = async () => new Response("unavailable", { status: 503 });
		await lookup.ensure(fetcher);
		expect(urls).toHaveLength(2);
		advance(501);
		await lookup.ensure(fetcher);
		expect(urls).toHaveLength(3);
		expect(lookup.current()).toBe("1.0.0");
	});

	it("resetForTest drops the cached version and back-off", async () => {
		const lookup = createNpmVersionLookup("@scope/tool");
		const { fetcher, urls } = countingFetch(distTags({ latest: "1.0.0" }));

		await lookup.ensure(fetcher);
		lookup.resetForTest();
		expect(lookup.current()).toBeUndefined();
		await lookup.ensure(fetcher);
		expect(urls).toHaveLength(2);
	});
});
