import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as net from "node:net";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	__resetGlobalProxyFetch,
	connectProxiedSocket,
	getProxyForProvider,
	getProxyForUrl,
	installGlobalProxyFetch,
	isLocalOrMetadataHost,
	shouldBypassProxy,
	wrapFetchForProxy,
} from "@oh-my-pi/pi-ai/utils/proxy";

const PROXY = "http://127.0.0.1:24560";

interface SilentProxyServer {
	url: string;
	accepted: Promise<net.Socket>;
	close(): Promise<void>;
}

async function createSilentProxyServer(): Promise<SilentProxyServer> {
	const sockets = new Set<net.Socket>();
	const accepted = Promise.withResolvers<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.resume();
		socket.on("end", () => socket.destroy());
		socket.once("close", () => sockets.delete(socket));
		accepted.resolve(socket);
	});

	const listening = Promise.withResolvers<void>();
	const onError = (error: Error): void => listening.reject(error);
	server.once("error", onError);
	server.listen(0, "127.0.0.1", () => {
		server.off("error", onError);
		listening.resolve();
	});
	await listening.promise;

	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected TCP listener address");

	return {
		url: `http://127.0.0.1:${address.port}`,
		accepted: accepted.promise,
		async close() {
			for (const socket of sockets) socket.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(error => {
				if (error) closed.reject(error);
				else closed.resolve();
			});
			await closed.promise;
		},
	};
}

async function waitForSocketClose(socket: net.Socket): Promise<void> {
	if (socket.destroyed) return;
	const closed = Promise.withResolvers<void>();
	socket.once("close", () => closed.resolve());
	await closed.promise;
}
const isProxyEnvKey = (k: string): boolean =>
	k.startsWith("PI_PROXY") ||
	k === "HTTP_PROXY" ||
	k === "http_proxy" ||
	k === "HTTPS_PROXY" ||
	k === "https_proxy" ||
	k === "ALL_PROXY" ||
	k === "all_proxy" ||
	k === "NO_PROXY" ||
	k === "no_proxy";

// Standard proxy variables set at runtime can be readable but hidden from Bun.env
// enumeration, so the sweep must name them explicitly instead of relying on for..in.
const HIDDEN_PROXY_KEYS = [
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
];

function proxyEnvKeys(): Set<string> {
	const keys = new Set(HIDDEN_PROXY_KEYS);
	for (const key in Bun.env) {
		if (isProxyEnvKey(key)) keys.add(key);
	}
	return keys;
}

// Snapshot + clear every proxy-related env var so each test starts clean and
// leaves nothing behind for later files. Provider-specific tests use unique
// provider ids so the module-level resolver cache can never cross-contaminate.
let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = {};
	for (const key of proxyEnvKeys()) {
		saved[key] = Bun.env[key];
		delete Bun.env[key];
	}
});

afterEach(() => {
	for (const key of proxyEnvKeys()) delete Bun.env[key];
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

describe("getProxyForUrl", () => {
	it("uses protocol-specific standard proxy variables", () => {
		Bun.env.HTTPS_PROXY = "http://secure-proxy:8080";
		Bun.env.HTTP_PROXY = "http://plain-proxy:8080";

		expect(getProxyForUrl("standard-secure-proxy", new URL("wss://api.openai.com/v1/live"))).toBe(
			"http://secure-proxy:8080",
		);
		expect(getProxyForUrl("standard-plain-proxy", new URL("ws://api.openai.com/v1/live"))).toBe(
			"http://plain-proxy:8080",
		);
	});

	it("falls back to ALL_PROXY", () => {
		Bun.env.ALL_PROXY = PROXY;

		expect(getProxyForUrl("standard-all-proxy", new URL("wss://api.openai.com/v1/live"))).toBe(PROXY);
	});

	it("bypasses configured proxies for NO_PROXY targets", () => {
		Bun.env.PI_PROXY_NO_PROXY_TEST = PROXY;
		Bun.env.NO_PROXY = "api.openai.com";

		expect(getProxyForUrl("no-proxy-test", new URL("wss://api.openai.com/v1/live"))).toBeUndefined();
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

	it("uses port 443 for secure websocket targets", () => {
		Bun.env.NO_PROXY = "api.sakana.ai:443";
		expect(shouldBypassProxy(new URL("wss://api.sakana.ai/v1"))).toBe(true);
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

describe("installGlobalProxyFetch", () => {
	const nativeFetch = globalThis.fetch;
	let calls: Array<{ url: string; proxy: unknown }>;

	beforeEach(() => {
		calls = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: input instanceof Request ? input.url : String(input),
				proxy: (init as { proxy?: unknown } | undefined)?.proxy,
			});
			return new Response("ok");
		}) as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = nativeFetch;
		__resetGlobalProxyFetch();
	});

	it("routes bare global fetch through PI_PROXY", async () => {
		Bun.env.PI_PROXY = PROXY;
		installGlobalProxyFetch();
		await fetch("https://api.anthropic.com/v1/oauth/token", { method: "POST" });
		expect(calls[0].proxy).toBe(PROXY);
	});

	it("leaves global fetch untouched when PI_PROXY is unset", async () => {
		const before = globalThis.fetch;
		installGlobalProxyFetch();
		expect(globalThis.fetch).toBe(before);
		await fetch("https://api.anthropic.com/v1/oauth/token");
		expect(calls[0].proxy).toBeUndefined();
	});

	it("keeps a caller-supplied proxy so PI_PROXY_<PROVIDER> still wins", async () => {
		Bun.env.PI_PROXY = PROXY;
		Bun.env.PI_PROXY_GLOBAL_PREC = "http://127.0.0.1:24561";
		installGlobalProxyFetch();
		await wrapFetchForProxy(globalThis.fetch, "global-prec")("https://api.anthropic.com/v1/messages");
		expect(calls[0].proxy).toBe("http://127.0.0.1:24561");
	});

	it("bypasses loopback targets so local model servers stay direct", async () => {
		Bun.env.PI_PROXY = PROXY;
		installGlobalProxyFetch();
		await fetch("http://127.0.0.1:11434/api/chat");
		expect(calls[0].proxy).toBeUndefined();
	});

	it("installs once", async () => {
		Bun.env.PI_PROXY = PROXY;
		installGlobalProxyFetch();
		const wrapped = globalThis.fetch;
		installGlobalProxyFetch();
		expect(globalThis.fetch).toBe(wrapped);
	});
});

describe("connectProxiedSocket", () => {
	it("times out and closes a proxy tunnel that never sends a CONNECT response", async () => {
		const proxy = await createSilentProxyServer();
		try {
			const result = await connectProxiedSocket(proxy.url, "https://cursor.example", { timeoutMs: 20 }).then(
				() => "resolved",
				error => error,
			);

			expect(result).toBeInstanceOf(AIError.StreamTimeoutError);
			const socket = await proxy.accepted;
			await waitForSocketClose(socket);
			expect(socket.destroyed).toBe(true);
		} finally {
			await proxy.close();
		}
	});

	it("aborts and closes an in-progress proxy tunnel when the caller aborts", async () => {
		const proxy = await createSilentProxyServer();
		try {
			const controller = new AbortController();
			const pending = connectProxiedSocket(proxy.url, "https://cursor.example", {
				signal: controller.signal,
				timeoutMs: 1_000,
			}).then(
				() => "resolved",
				error => error,
			);
			const socket = await proxy.accepted;

			controller.abort();
			const result = await pending;

			expect(result).toBeInstanceOf(AIError.AbortError);
			await waitForSocketClose(socket);
			expect(socket.destroyed).toBe(true);
		} finally {
			await proxy.close();
		}
	});
});
