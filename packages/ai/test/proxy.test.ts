import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { clearAwsCredentialCache, resolveAwsCredentials } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import type { FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import {
	__resetGlobalProxyFetch,
	__resetProxyCache,
	connectProxiedSocket,
	getProxyForProvider,
	getProxyForUrl,
	installGlobalProxyFetch,
	isLanHostname,
	isLocalOrMetadataHost,
	shouldBypassProxy,
	withProxyInit,
	wrapFetchForProxy,
} from "@oh-my-pi/pi-ai/utils/proxy";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { removeWithRetries } from "../../utils/src/temp";

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

interface RecordingProxyServer {
	url: string;
	/** Number of requests that reached the proxy. */
	readonly hits: number;
	close(): Promise<void>;
}

/**
 * Minimal HTTP proxy that counts every request it receives and answers `200`,
 * so a request that wrongly takes the proxy path is directly observable.
 */
async function createRecordingProxyServer(): Promise<RecordingProxyServer> {
	const sockets = new Set<net.Socket>();
	const state = { hits: 0 };
	const server = net.createServer(socket => {
		state.hits++;
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.on("data", () => {
			socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
			socket.end();
		});
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
		get hits() {
			return state.hits;
		},
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

/** Model whose endpoint is a LAN inference box reached over mDNS. */
function lanModel(): Model {
	return buildModel({
		id: "lan-model",
		name: "LAN Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "http://gpu-box.local:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec);
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
// leaves nothing behind for later files.
let saved: Record<string, string | undefined>;

beforeEach(() => {
	// The resolver memoizes per provider for the lifetime of the process;
	// earlier files (e.g. openai-responses-sampling-params) drain real
	// providers with no proxy env set, which would otherwise cache
	// `undefined` past the env writes below.
	__resetProxyCache();
	saved = {};
	for (const key of proxyEnvKeys()) {
		saved[key] = Bun.env[key];
		delete Bun.env[key];
	}
});

afterEach(() => {
	__resetProxyCache();
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

describe("LAN .local names", () => {
	it("bypasses the proxy for a LAN inference box on a .local name", () => {
		// A home-LAN inference endpoint (gpu-box.local:8080) is only reachable
		// directly; sending it through the remote egress proxy fails the request.
		expect(isLanHostname("gpu-box.local")).toBe(true);
		expect(shouldBypassProxy(new URL("http://gpu-box.local:8080/v1"))).toBe(true);
	});

	it("keeps .local names out of the shared local/metadata predicate", () => {
		// The shared predicate also gates the plain-HTTP credential endpoint guard:
		// a `.local` name is not a trusted local address (any LAN peer can answer
		// one), so widening the predicate would leak the container credential
		// token in plaintext to whoever answers that name.
		expect(isLocalOrMetadataHost("gpu-box.local")).toBe(false);
	});

	it("does not bypass a host that merely ends in 'local'", () => {
		expect(isLanHostname("notlocal")).toBe(false);
		expect(isLocalOrMetadataHost("notlocal")).toBe(false);
		expect(shouldBypassProxy(new URL("http://notlocal/v1"))).toBe(false);
	});

	it("bypasses the proxy for the absolute DNS spelling of a .local host", () => {
		// `new URL(...).hostname` keeps the DNS root label, so the suffix check
		// has to see through it — the catalog's local-endpoint check does.
		expect(new URL("http://gpu-box.local.:8080/v1").hostname).toBe("gpu-box.local.");
		expect(isLanHostname("gpu-box.local.")).toBe(true);
		expect(shouldBypassProxy(new URL("http://gpu-box.local.:8080/v1"))).toBe(true);
	});

	it("pins a bypassed host to a direct connection", () => {
		const init = withProxyInit("http://gpu-box.local:8080/v1", undefined, undefined) as
			| { proxy?: unknown }
			| undefined;
		expect(init?.proxy).toBe(false);
	});
});

describe("AWS container credential endpoint guard", () => {
	const AWS_ENV_KEYS = [
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_PROFILE",
		"AWS_SDK_LOAD_CONFIG",
		"AWS_REGION",
		"AWS_DEFAULT_REGION",
		"AWS_CONFIG_FILE",
		"AWS_SHARED_CREDENTIALS_FILE",
		"AWS_EC2_METADATA_DISABLED",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
		"AWS_ROLE_ARN",
		"AWS_ROLE_SESSION_NAME",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_CONTAINER_AUTHORIZATION_TOKEN",
		"AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
	] as const;

	let savedAws: Record<string, string | undefined>;
	let awsTmp: string;

	beforeEach(async () => {
		savedAws = {};
		for (const key of AWS_ENV_KEYS) {
			savedAws[key] = Bun.env[key];
			delete Bun.env[key];
		}
		awsTmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-aws-guard-"));
		// Empty profile files so static/profile resolution definitely misses and
		// the container endpoint is the only credential source under test.
		await Bun.write(path.join(awsTmp, "credentials"), "");
		await Bun.write(path.join(awsTmp, "config"), "");
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = path.join(awsTmp, "credentials");
		Bun.env.AWS_CONFIG_FILE = path.join(awsTmp, "config");
		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		clearAwsCredentialCache();
	});

	afterEach(async () => {
		for (const key of AWS_ENV_KEYS) {
			const value = savedAws[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		clearAwsCredentialCache();
		await removeWithRetries(awsTmp);
	});

	it("rejects a plain-http .local credential endpoint and never sends the token", async () => {
		Bun.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = "http://gpu-box.local/creds";
		Bun.env.AWS_CONTAINER_AUTHORIZATION_TOKEN = "container-secret";
		const requests: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requests.push(String(input));
			return Response.json({
				AccessKeyId: "AKIA",
				SecretAccessKey: "secret",
				Expiration: "2099-01-01T00:00:00Z",
			});
		};

		await expect(resolveAwsCredentials({ fetch: fetchImpl })).rejects.toThrow(
			/must use HTTPS or a local metadata host/,
		);
		expect(requests).toHaveLength(0);
	});
});

describe("native proxy environment", () => {
	it("keeps a .local inference request off the HTTP_PROXY egress", async () => {
		const proxy = await createRecordingProxyServer();
		try {
			Bun.env.HTTP_PROXY = proxy.url;
			__resetProxyCache();

			await transportFetch(lanModel(), undefined)("http://gpu-box.local:8080/v1", {
				signal: AbortSignal.timeout(2_000),
			}).catch(() => undefined);

			expect(proxy.hits).toBe(0);
		} finally {
			await proxy.close();
		}
	});

	it("keeps the absolute DNS spelling off the HTTP_PROXY egress", async () => {
		const proxy = await createRecordingProxyServer();
		try {
			Bun.env.HTTP_PROXY = proxy.url;
			__resetProxyCache();

			await transportFetch(lanModel(), undefined)("http://gpu-box.local.:8080/v1", {
				signal: AbortSignal.timeout(2_000),
			}).catch(() => undefined);

			expect(proxy.hits).toBe(0);
		} finally {
			await proxy.close();
		}
	});

	it("still routes a remote host through the native proxy", async () => {
		const proxy = await createRecordingProxyServer();
		try {
			Bun.env.HTTP_PROXY = proxy.url;
			__resetProxyCache();

			await transportFetch(lanModel(), undefined)("http://api.openai.com/v1", {
				signal: AbortSignal.timeout(2_000),
			}).catch(() => undefined);

			expect(proxy.hits).toBe(1);
		} finally {
			await proxy.close();
		}
	});
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

	it("pins a bypassed (loopback) host to a direct connection", async () => {
		Bun.env.PI_PROXY_WRAP_BYPASS = PROXY;
		const { fetch, calls } = makeCapture();
		await wrapFetchForProxy(fetch, "wrap-bypass")("http://127.0.0.1:11434/api/chat");
		expect(calls[0].proxy).toBe(false);
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
		expect(calls[0].proxy).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"reaches a Unix-socket service instead of sending it to PI_PROXY",
		async () => {
			const socket = path.join(os.tmpdir(), `omp-proxy-${process.pid}.sock`);
			const connections = new Set<net.Socket>();
			const server = net.createServer(connection => {
				connections.add(connection);
				connection.once("close", () => connections.delete(connection));
				connection.end("HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\nlocal broker");
			});
			const listening = Promise.withResolvers<void>();
			server.once("error", listening.reject);
			server.listen(socket, listening.resolve);
			await listening.promise;

			try {
				Bun.env.PI_PROXY = PROXY;
				globalThis.fetch = nativeFetch;
				installGlobalProxyFetch();
				const response = await fetch("http://blob-broker.local/info", {
					unix: socket,
					signal: AbortSignal.timeout(1_500),
				});
				expect(await response.text()).toBe("local broker");
			} finally {
				for (const connection of connections) connection.destroy();
				const closed = Promise.withResolvers<void>();
				server.close(error => {
					if (error) closed.reject(error);
					else closed.resolve();
				});
				await closed.promise;
			}
		},
	);

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
