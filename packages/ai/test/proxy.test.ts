import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai/types";
import {
	getProxyForProvider,
	isLocalOrMetadataHost,
	shouldBypassProxy,
	wrapFetchForProxy,
} from "@pk-nerdsaver-ai/pi-ai/utils/proxy";

const PROXY = "http://127.0.0.1:24560";

const isProxyEnvKey = (k: string): boolean => k.startsWith("PI_PROXY") || k === "NO_PROXY" || k === "no_proxy";

// Snapshot + clear every proxy-related env var so each test starts clean and
// leaves nothing behind for later files. Provider-specific tests use unique
// provider ids so the module-level resolver cache can never cross-contaminate.
let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = {};
	for (const key in Bun.env) {
		if (!isProxyEnvKey(key)) continue;
		saved[key] = Bun.env[key];
		delete Bun.env[key];
	}
});

afterEach(() => {
	const toDelete: string[] = [];
	for (const key in Bun.env) {
		if (isProxyEnvKey(key)) toDelete.push(key);
	}
	for (const key of toDelete) delete Bun.env[key];
	for (const key in saved) {
		const value = saved[key];
		if (value !== undefined) Bun.env[key] = value;
	}
});

describe("getProxyForProvider", () => {
	it("reads the provider-specific PI_PROXY_<PROVIDER> variable", () => {
		Bun.env.PI_PROXY_SAKANA = PROXY;
		expect(getProxyForProvider("sakana")).toBe(PROXY);
	});

	it("normalizes hyphenated provider ids to underscores", () => {
		Bun.env.PI_PROXY_GITHUB_COPILOT = PROXY;
		expect(getProxyForProvider("github-copilot")).toBe(PROXY);
	});

	it("falls back to the generic PI_PROXY when no provider-specific var is set", () => {
		Bun.env.PI_PROXY = PROXY;
		expect(getProxyForProvider("prov-fallback")).toBe(PROXY);
	});

	it("prefers the provider-specific var over the generic fallback", () => {
		Bun.env.PI_PROXY = "http://fallback:1";
		Bun.env.PI_PROXY_PREC_PROV = PROXY;
		expect(getProxyForProvider("prec-prov")).toBe(PROXY);
	});

	it("returns undefined when neither var is set", () => {
		expect(getProxyForProvider("none-prov")).toBeUndefined();
	});
});

describe("isLocalOrMetadataHost / shouldBypassProxy hard-coded ranges", () => {
	const bypassed = [
		"localhost",
		"app.localhost",
		"127.0.0.1",
		"127.5.5.5",
		"10.1.2.3",
		"192.168.1.1",
		"172.16.0.1",
		"172.31.255.255",
		"169.254.169.254", // EC2 IMDS
		"169.254.170.2", // ECS task credentials
		"metadata.google.internal",
	];
	for (const host of bypassed) {
		it(`bypasses ${host}`, () => {
			expect(isLocalOrMetadataHost(host)).toBe(true);
			expect(shouldBypassProxy(new URL(`http://${host}/x`))).toBe(true);
		});
	}

	// IPv6 hosts need bracket form inside a URL.
	const bypassedV6 = ["::1", "fd00:ec2::254", "fe80::1"];
	for (const host of bypassedV6) {
		it(`bypasses [${host}]`, () => {
			expect(isLocalOrMetadataHost(host)).toBe(true);
			expect(shouldBypassProxy(new URL(`http://[${host}]/x`))).toBe(true);
		});
	}

	const proxied = [
		"api.sakana.ai",
		"api.openai.com",
		"172.15.0.1", // just below the 172.16/12 block
		"172.32.0.1", // just above the 172.16/12 block
		"11.0.0.1", // not RFC1918
	];
	for (const host of proxied) {
		it(`does not bypass ${host}`, () => {
			expect(isLocalOrMetadataHost(host)).toBe(false);
			expect(shouldBypassProxy(new URL(`https://${host}/x`))).toBe(false);
		});
	}
});

describe("shouldBypassProxy NO_PROXY rules", () => {
	it("matches an exact host", () => {
		Bun.env.NO_PROXY = "api.sakana.ai";
		expect(shouldBypassProxy(new URL("https://api.sakana.ai/v1"))).toBe(true);
		expect(shouldBypassProxy(new URL("https://api.openai.com/v1"))).toBe(false);
	});

	it("matches a leading-dot suffix and the bare domain", () => {
		Bun.env.NO_PROXY = ".sakana.ai";
		expect(shouldBypassProxy(new URL("https://api.sakana.ai/v1"))).toBe(true);
		expect(shouldBypassProxy(new URL("https://sakana.ai/v1"))).toBe(true);
	});

	it("treats a bare domain as a suffix for subdomains", () => {
		Bun.env.NO_PROXY = "sakana.ai";
		expect(shouldBypassProxy(new URL("https://api.sakana.ai/v1"))).toBe(true);
	});

	it("bypasses everything for the wildcard rule", () => {
		Bun.env.NO_PROXY = "*";
		expect(shouldBypassProxy(new URL("https://api.openai.com/v1"))).toBe(true);
	});

	it("honors a port qualifier on the rule", () => {
		Bun.env.NO_PROXY = "api.sakana.ai:8080";
		// Target is https (port 443) → port mismatch → not bypassed.
		expect(shouldBypassProxy(new URL("https://api.sakana.ai/v1"))).toBe(false);
		expect(shouldBypassProxy(new URL("http://api.sakana.ai:8080/v1"))).toBe(true);
	});
});

describe("wrapFetchForProxy", () => {
	function makeCapture(): { fetch: FetchImpl; calls: Array<{ url: string; proxy: unknown }> } {
		const calls: Array<{ url: string; proxy: unknown }> = [];
		const fetch: FetchImpl = async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();
			calls.push({ url, proxy: (init as { proxy?: unknown } | undefined)?.proxy });
			return new Response("ok");
		};
		return { fetch, calls };
	}

	it("injects init.proxy for a proxied host when configured", async () => {
		Bun.env.PI_PROXY_WRAP_INJECT = PROXY;
		const { fetch, calls } = makeCapture();
		await wrapFetchForProxy(fetch, "wrap-inject")("https://api.sakana.ai/v1/responses");
		expect(calls).toHaveLength(1);
		expect(calls[0].proxy).toBe(PROXY);
	});

	it("does not inject a proxy for a bypassed (loopback) host", async () => {
		Bun.env.PI_PROXY_WRAP_BYPASS = PROXY;
		const { fetch, calls } = makeCapture();
		await wrapFetchForProxy(fetch, "wrap-bypass")("http://127.0.0.1:11434/api/chat");
		expect(calls[0].proxy).toBeUndefined();
	});

	it("does not inject a proxy when none is configured for the provider", async () => {
		const { fetch, calls } = makeCapture();
		await wrapFetchForProxy(fetch, "wrap-none")("https://api.sakana.ai/v1/responses");
		expect(calls[0].proxy).toBeUndefined();
	});

	it("does not route one provider's request through another provider's proxy", async () => {
		Bun.env.PI_PROXY_SAKANA = PROXY;
		const { fetch, calls } = makeCapture();
		await wrapFetchForProxy(fetch, "wrap-other")("https://api.openai.com/v1");
		expect(calls[0].proxy).toBeUndefined();
	});

	it("passes through an unparseable URL without throwing", async () => {
		Bun.env.PI_PROXY_WRAP_BADURL = PROXY;
		const { fetch, calls } = makeCapture();
		await wrapFetchForProxy(fetch, "wrap-badurl")("not a url");
		expect(calls).toHaveLength(1);
		expect(calls[0].proxy).toBeUndefined();
	});
});
