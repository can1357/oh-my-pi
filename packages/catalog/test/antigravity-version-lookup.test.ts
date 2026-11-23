import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import {
	DEFAULT_ANTIGRAVITY_VERSION,
	ensureAntigravityVersion,
	getAntigravityPlatform,
	getAntigravityUserAgent,
} from "@oh-my-pi/pi-catalog/wire/gemini-headers";

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

describe("getAntigravityUserAgent", () => {
	const ENV_NAMES = [
		"PI_AI_ANTIGRAVITY_VERSION",
		"PI_AI_ANTIGRAVITY_CL",
		"PI_AI_ANTIGRAVITY_OS",
		"PI_AI_ANTIGRAVITY_ARCH",
		"PI_AI_ANTIGRAVITY_AUTH_METHOD",
		"PI_AI_ANTIGRAVITY_PURPOSE",
	] as const;
	const saved = ENV_NAMES.map(name => [name, process.env[name]] as const);

	beforeEach(() => {
		for (const name of ENV_NAMES) delete process.env[name];
		// Pin the version and host so a manifest discovered by another test cannot leak in.
		process.env.PI_AI_ANTIGRAVITY_VERSION = DEFAULT_ANTIGRAVITY_VERSION;
		process.env.PI_AI_ANTIGRAVITY_OS = "linux";
		process.env.PI_AI_ANTIGRAVITY_ARCH = "amd64";
	});

	afterEach(() => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	it("falls back to the 2.34.0 hub release", () => {
		expect(DEFAULT_ANTIGRAVITY_VERSION).toBe("2.34.0");
		expect(getAntigravityUserAgent()).toBe(
			"antigravity/hub/2.34.0 (aidev_client; os_type=linux; arch=amd64; cl=1005016104)",
		);
	});

	it("appends auth_method and purpose only when their env overrides are set", () => {
		expect(getAntigravityUserAgent()).not.toContain("auth_method=");
		expect(getAntigravityUserAgent()).not.toContain("purpose=");

		process.env.PI_AI_ANTIGRAVITY_AUTH_METHOD = "gateway";
		expect(getAntigravityUserAgent()).toBe(
			"antigravity/hub/2.34.0 (aidev_client; os_type=linux; arch=amd64; cl=1005016104; auth_method=gateway)",
		);

		process.env.PI_AI_ANTIGRAVITY_PURPOSE = "test-purpose";
		expect(getAntigravityUserAgent()).toEndWith("; auth_method=gateway; purpose=test-purpose)");

		delete process.env.PI_AI_ANTIGRAVITY_AUTH_METHOD;
		expect(getAntigravityUserAgent()).toEndWith("; cl=1005016104; purpose=test-purpose)");
	});
});
