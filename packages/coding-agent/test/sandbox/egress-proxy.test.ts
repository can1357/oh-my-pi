import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { EgressProxy, type EgressProxyOptions } from "@oh-my-pi/pi-coding-agent/sandbox/egress-proxy";
import type { Socket, TCPSocketListener } from "bun";

const cleanups: (() => void | Promise<void>)[] = [];
let dnsRecords: Record<string, string[]> = {};

/** Answers `Bun.dns.lookup` from `records`; any other name fails to resolve. */
function stubDns(records: Record<string, string[]>): void {
	dnsRecords = records;
}

beforeEach(() => {
	dnsRecords = {};
	vi.spyOn(Bun.dns, "lookup").mockImplementation(async (hostname: string) => {
		const addresses = dnsRecords[hostname];
		if (!addresses) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
		return addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4, ttl: 0 }));
	});
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function startProxy(options: EgressProxyOptions): Promise<EgressProxy> {
	const proxy = await EgressProxy.start(options);
	cleanups.push(() => proxy.close());
	return proxy;
}

/** Writes `data` fully, honouring partial writes. Call `drain` from the socket's drain handler. */
class Writer {
	#pending: Uint8Array[] = [];

	write(socket: Socket<unknown>, data: Uint8Array): void {
		this.#pending.push(data);
		this.drain(socket);
	}

	drain(socket: Socket<unknown>): void {
		while (this.#pending.length > 0) {
			const chunk = this.#pending[0];
			const written = Math.max(socket.write(chunk), 0);
			if (written < chunk.byteLength) {
				this.#pending[0] = chunk.subarray(written);
				return;
			}
			this.#pending.shift();
		}
	}
}

/** Raw TCP client of the proxy that records everything it receives. */
class RawClient {
	readonly closed: Promise<void>;
	#socket: Socket<undefined> | undefined;
	#received: Buffer[] = [];
	#receivedBytes = 0;
	#isClosed = false;
	#waiters: (() => void)[] = [];
	readonly #writer = new Writer();

	private constructor(closed: Promise<void>) {
		this.closed = closed;
	}

	static async connect(port: number): Promise<RawClient> {
		const closed = Promise.withResolvers<void>();
		const client = new RawClient(closed.promise);
		client.#socket = await Bun.connect({
			hostname: "127.0.0.1",
			port,
			socket: {
				data: (_socket, chunk) => {
					client.#received.push(Buffer.from(chunk));
					client.#receivedBytes += chunk.byteLength;
					client.#notify();
				},
				drain: socket => client.#writer.drain(socket),
				close: () => {
					client.#isClosed = true;
					closed.resolve();
					client.#notify();
				},
				error() {},
			},
		});
		cleanups.push(() => client.#socket?.terminate());
		return client;
	}

	terminate(): void {
		this.#socket?.terminate();
	}

	get bytes(): Buffer {
		return Buffer.concat(this.#received);
	}

	get text(): string {
		return this.bytes.toString("latin1");
	}

	write(data: string | Uint8Array): void {
		if (!this.#socket) throw new Error("not connected");
		this.#writer.write(this.#socket, typeof data === "string" ? Buffer.from(data, "latin1") : data);
	}

	/** Resolves once `predicate` holds for the received text, or rejects when the connection closes first. */
	async waitFor(predicate: (client: RawClient) => boolean): Promise<void> {
		while (!predicate(this)) {
			if (this.#isClosed) throw new Error(`connection closed; received: ${this.text.slice(0, 400)}`);
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.push(resolve);
			await promise;
		}
	}

	/** The full response of a refused or forwarded request (the proxy closes the connection afterwards). */
	async response(): Promise<string> {
		await this.closed;
		return this.text;
	}

	get receivedBytes(): number {
		return this.#receivedBytes;
	}

	#notify(): void {
		for (const waiter of this.#waiters.splice(0)) waiter();
	}
}

async function request(proxy: EgressProxy, head: string): Promise<string> {
	const client = await RawClient.connect(proxy.port);
	client.write(head);
	return client.response();
}

function connectHead(authority: string): string {
	return `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`;
}

function statusOf(response: string): number {
	return Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1]);
}

function expectBlocked(response: string): void {
	expect(statusOf(response)).toBe(403);
	expect(response).toMatch(/\r\nX-Omp-Sandbox: blocked\r\n/i);
}

/** Local TCP server that greets, then echoes each chunk back prefixed with `echo:`. */
function startEchoServer(): { port: number; sockets: Set<Socket<undefined>>; firstClose: Promise<void> } {
	const sockets = new Set<Socket<undefined>>();
	const firstClose = Promise.withResolvers<void>();
	const listener: TCPSocketListener<undefined> = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				sockets.add(socket);
				socket.write("hello\n");
			},
			data(socket, chunk) {
				socket.write(`echo:${chunk.toString("latin1")}`);
			},
			close(socket) {
				sockets.delete(socket);
				firstClose.resolve();
			},
		},
	});
	cleanups.push(() => listener.stop(true));
	return { port: listener.port, sockets, firstClose: firstClose.promise };
}

function pattern(length: number, seed: number): Uint8Array {
	const data = new Uint8Array(length);
	for (let i = 0; i < length; i++) data[i] = (i * 31 + seed) % 251;
	return data;
}

const TUNNEL_ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";

describe("EgressProxy", () => {
	it("advertises its loopback URL", async () => {
		const proxy = await startProxy({ allowedHosts: () => [] });
		expect(proxy.url).toBe(`http://127.0.0.1:${proxy.port}`);
	});

	it("tunnels CONNECT bytes both ways to an allowed host", async () => {
		const server = startEchoServer();
		const proxy = await startProxy({ allowedHosts: () => ["127.0.0.1"] });
		const client = await RawClient.connect(proxy.port);
		client.write(connectHead(`127.0.0.1:${server.port}`));
		await client.waitFor(c => c.text === `${TUNNEL_ESTABLISHED}hello\n`);
		client.write("ping");
		await client.waitFor(c => c.text.endsWith("echo:ping"));
		expect(client.text).toBe(`${TUNNEL_ESTABLISHED}hello\necho:ping`);
	});

	it("relays large payloads in both directions without loss", async () => {
		const size = 8 * 1024 * 1024;
		const upload = pattern(size, 7);
		const download = pattern(size, 13);
		const received: Buffer[] = [];
		let receivedBytes = 0;
		const serverDone = Promise.withResolvers<Buffer>();
		const writer = new Writer();
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, chunk) {
					received.push(Buffer.from(chunk));
					receivedBytes += chunk.byteLength;
					if (receivedBytes === size) {
						serverDone.resolve(Buffer.concat(received));
						writer.write(socket, download);
					}
				},
				drain(socket) {
					writer.drain(socket);
				},
			},
		});
		cleanups.push(() => listener.stop(true));
		const proxy = await startProxy({ allowedHosts: () => ["127.0.0.1"] });
		const client = await RawClient.connect(proxy.port);
		client.write(connectHead(`127.0.0.1:${listener.port}`));
		await client.waitFor(c => c.text === TUNNEL_ESTABLISHED);
		client.write(upload);

		expect((await serverDone.promise).equals(upload)).toBe(true);
		await client.waitFor(c => c.receivedBytes === TUNNEL_ESTABLISHED.length + size);
		expect(client.bytes.subarray(TUNNEL_ESTABLISHED.length).equals(download)).toBe(true);
	}, 30_000);

	it("refuses a host that is not allowed with 403 and reports it", async () => {
		const blocked: [string, number][] = [];
		const proxy = await startProxy({
			allowedHosts: () => ["github.com"],
			onBlocked: (host, port) => blocked.push([host, port]),
		});
		const response = await request(proxy, connectHead("Blocked.Example:443"));
		expectBlocked(response);
		expect(blocked).toEqual([["blocked.example", 443]]);
	});

	it("applies wildcard patterns to subdomains only", async () => {
		const blocked: string[] = [];
		const asked: string[] = [];
		const proxy = await startProxy({
			allowedHosts: () => ["*.Example.Test."],
			decide: async host => {
				asked.push(host);
				return false;
			},
			onBlocked: host => blocked.push(host),
		});
		expectBlocked(await request(proxy, connectHead("example.test:443")));
		// The subdomain passes the allowlist; it does not resolve, so the proxy answers 502, not a block.
		const allowed = await request(proxy, connectHead("api.example.test:443"));
		expect(statusOf(allowed)).toBe(502);
		expect(allowed).not.toMatch(/X-Omp-Sandbox/i);
		expect(blocked).toEqual(["example.test"]);
		expect(asked).toEqual(["example.test"]);
	});

	it("refuses wildcard-matched names that resolve to non-public addresses", async () => {
		const server = startEchoServer();
		const blocked: string[] = [];
		stubDns({
			"loopback.corp.test": ["127.0.0.1"],
			"private.corp.test": ["10.0.0.5"],
			"metadata.corp.test": ["169.254.169.254"],
			"v6loopback.corp.test": ["::1"],
			"mapped.corp.test": ["::ffff:127.0.0.1"],
			"mixed.corp.test": ["93.184.215.14", "10.0.0.1"],
			"registry.corp.test": ["127.0.0.1"],
		});
		const proxy = await startProxy({
			allowedHosts: () => ["*.corp.test", "registry.corp.test"],
			onBlocked: host => blocked.push(host),
		});
		const refused = ["loopback", "private", "metadata", "v6loopback", "mapped", "mixed"].map(
			name => `${name}.corp.test`,
		);
		for (const host of refused) expectBlocked(await request(proxy, connectHead(`${host}:${server.port}`)));
		expect(blocked).toEqual(refused);

		// Listed exactly: the private answer is allowed and the tunnel goes to the resolved address.
		const client = await RawClient.connect(proxy.port);
		client.write(connectHead(`registry.corp.test:${server.port}`));
		await client.waitFor(c => c.text === `${TUNNEL_ESTABLISHED}hello\n`);
	});

	it("lets a decide-approved name reach a private range on the first request", async () => {
		const blocked: string[] = [];
		const asked: string[] = [];
		const attempts: string[] = [];
		stubDns({ "artifactory.corp": ["10.0.0.5"] });
		// Record the proxy's upstream attempt instead of dialling a real private address.
		const realConnect = Bun.connect.bind(Bun);
		vi.spyOn(Bun, "connect").mockImplementation(options => {
			if ("hostname" in options && options.hostname === "10.0.0.5") {
				attempts.push(`${options.hostname}:${options.port}`);
				return Promise.reject(new Error("connect ECONNREFUSED"));
			}
			// Narrowed per branch so each call resolves to its own `Bun.connect` overload.
			return "unix" in options ? realConnect(options) : realConnect(options);
		});
		const proxy = await startProxy({
			allowedHosts: () => [],
			decide: async host => {
				asked.push(host);
				return true;
			},
			onBlocked: host => blocked.push(host),
		});
		const response = await request(proxy, connectHead("artifactory.corp:443"));
		expect(statusOf(response)).toBe(502);
		expect(response).not.toMatch(/X-Omp-Sandbox/i);
		expect(attempts).toEqual(["10.0.0.5:443"]);
		expect(asked).toEqual(["artifactory.corp"]);
		expect(blocked).toEqual([]);
	});

	it("refuses decide-approved names that resolve to loopback or link-local addresses", async () => {
		const blocked: string[] = [];
		stubDns({ "loopback.example": ["127.0.0.1"], "metadata.example": ["169.254.169.254"] });
		const proxy = await startProxy({
			allowedHosts: () => [],
			decide: async () => true,
			onBlocked: host => blocked.push(host),
		});
		expectBlocked(await request(proxy, connectHead("loopback.example:443")));
		expectBlocked(await request(proxy, connectHead("metadata.example:80")));
		expect(blocked).toEqual(["loopback.example", "metadata.example"]);
	});

	it("refuses IP literals and loopback names unless listed literally, without asking", async () => {
		const server = startEchoServer();
		let asked = 0;
		const blocked: string[] = [];
		const hosts: string[] = ["*.0.0.1", "*.localhost"];
		const proxy = await startProxy({
			allowedHosts: () => hosts,
			decide: async () => {
				asked++;
				return true;
			},
			onBlocked: host => blocked.push(host),
		});
		for (const authority of [
			`127.0.0.1:${server.port}`,
			`2130706433:${server.port}`,
			`localhost:${server.port}`,
			`app.localhost:${server.port}`,
			`[::1]:${server.port}`,
			"10.1.2.3:443",
			"169.254.169.254:80",
			"8.8.8.8:443",
		]) {
			expectBlocked(await request(proxy, connectHead(authority)));
		}
		expectBlocked(await request(proxy, `GET http://127.0.0.1:${server.port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`));
		expect(asked).toBe(0);
		expect(blocked).toEqual([
			"127.0.0.1",
			"127.0.0.1",
			"localhost",
			"app.localhost",
			"::1",
			"10.1.2.3",
			"169.254.169.254",
			"8.8.8.8",
			"127.0.0.1",
		]);

		hosts.push("LOCALHOST.");
		stubDns({ localhost: ["127.0.0.1"] });
		const client = await RawClient.connect(proxy.port);
		client.write(connectHead(`localhost:${server.port}`));
		await client.waitFor(c => c.text === `${TUNNEL_ESTABLISHED}hello\n`);
	});

	it("reads the allowlist live on every request", async () => {
		const server = startEchoServer();
		const hosts: string[] = [];
		const proxy = await startProxy({ allowedHosts: () => hosts });
		expectBlocked(await request(proxy, connectHead(`127.0.0.1:${server.port}`)));
		hosts.push("127.0.0.1");
		const client = await RawClient.connect(proxy.port);
		client.write(connectHead(`127.0.0.1:${server.port}`));
		await client.waitFor(c => c.text === `${TUNNEL_ESTABLISHED}hello\n`);
	});

	it("shares one decide call between concurrent requests for the same host", async () => {
		const calls: [string, number][] = [];
		const release = Promise.withResolvers<boolean>();
		// Each request reads the allowlist right before it joins the pending decision.
		const allArrived = Promise.withResolvers<void>();
		let reads = 0;
		const blocked: string[] = [];
		const proxy = await startProxy({
			allowedHosts: () => {
				if (++reads === 3) allArrived.resolve();
				return [];
			},
			decide: (host, port) => {
				calls.push([host, port]);
				return release.promise;
			},
			onBlocked: host => blocked.push(host),
		});
		const responses = Promise.all([
			request(proxy, connectHead("ask.example:443")),
			request(proxy, connectHead("ASK.example.:8443")),
			request(proxy, "GET http://ask.example/x HTTP/1.1\r\nHost: ask.example\r\n\r\n"),
		]);
		await allArrived.promise;
		release.resolve(false);
		for (const response of await responses) expectBlocked(response);
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toBe("ask.example");
		expect(blocked).toEqual(["ask.example", "ask.example", "ask.example"]);

		// A settled decision is not cached: the next request asks again.
		expectBlocked(await request(proxy, connectHead("ask.example:443")));
		expect(calls).toHaveLength(2);
	});

	it("refuses when decide is absent or throws", async () => {
		const withoutDecide = await startProxy({ allowedHosts: () => [] });
		expectBlocked(await request(withoutDecide, connectHead("unknown.example:443")));
		const throwing = await startProxy({
			allowedHosts: () => [],
			decide: () => Promise.reject(new Error("no ui")),
		});
		expectBlocked(await request(throwing, connectHead("unknown.example:443")));
	});

	it("forwards absolute-URI plain HTTP requests in origin form", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				return Response.json({
					method: req.method,
					path: `${url.pathname}${url.search}`,
					host: req.headers.get("host"),
					proxyConnection: req.headers.get("proxy-connection"),
					custom: req.headers.get("x-custom"),
					body: await req.text(),
				});
			},
		});
		cleanups.push(() => server.stop(true));
		const proxy = await startProxy({ allowedHosts: () => ["127.0.0.1"] });

		const viaFetch = await fetch(`http://127.0.0.1:${server.port}/echo?q=1`, {
			method: "POST",
			body: "payload",
			headers: { "x-custom": "yes" },
			proxy: proxy.url,
		});
		expect(viaFetch.status).toBe(200);
		expect(await viaFetch.json()).toEqual({
			method: "POST",
			path: "/echo?q=1",
			host: `127.0.0.1:${server.port}`,
			proxyConnection: null,
			custom: "yes",
			body: "payload",
		});

		const raw = await request(
			proxy,
			`GET http://127.0.0.1:${server.port}/raw HTTP/1.1\r\nHost: elsewhere.example\r\nProxy-Connection: keep-alive\r\n\r\n`,
		);
		expect(statusOf(raw)).toBe(200);
		const body = JSON.parse(raw.slice(raw.indexOf("\r\n\r\n") + 4)) as Record<string, unknown>;
		expect(body.path).toBe("/raw");
		expect(body.host).toBe(`127.0.0.1:${server.port}`);
		expect(body.proxyConnection).toBeNull();
	});

	it("refuses blocked plain HTTP requests made through fetch", async () => {
		const proxy = await startProxy({ allowedHosts: () => [] });
		const response = await fetch("http://blocked.example/", { proxy: proxy.url });
		expect(response.status).toBe(403);
		expect(response.headers.get("x-omp-sandbox")).toBe("blocked");
	});

	it("rejects malformed and oversized request heads", async () => {
		const proxy = await startProxy({ allowedHosts: () => ["127.0.0.1"] });
		expect(statusOf(await request(proxy, "GET / HTTP/1.1\r\nHost: x\r\n\r\n"))).toBe(400);
		expect(statusOf(await request(proxy, "CONNECT example.com HTTP/1.1\r\n\r\n"))).toBe(400);
		expect(statusOf(await request(proxy, "garbage\r\n\r\n"))).toBe(400);
		const huge = `GET http://127.0.0.1/ HTTP/1.1\r\nX-Big: ${"a".repeat(80 * 1024)}\r\n\r\n`;
		expect(statusOf(await request(proxy, huge))).toBe(431);
	});

	it("drops clients that never finish their request head", async () => {
		const proxy = await startProxy({ allowedHosts: () => [], headTimeoutMs: 50 });
		const client = await RawClient.connect(proxy.port);
		client.write("CONNECT 127.0.0.1:1 HTTP/1.1\r\n");
		await client.closed;
		expect(client.text).toBe("");
	});

	it("keeps an established tunnel open past the head timeout", async () => {
		const server = startEchoServer();
		const proxy = await startProxy({ allowedHosts: () => ["127.0.0.1"], headTimeoutMs: 50 });
		const tunnel = await RawClient.connect(proxy.port);
		tunnel.write(connectHead(`127.0.0.1:${server.port}`));
		await tunnel.waitFor(c => c.text === `${TUNNEL_ESTABLISHED}hello\n`);

		// A probe opened after the tunnel was established is dropped by its own head timeout,
		// so by the time it closes the idle tunnel has outlived a full timeout.
		const probe = await RawClient.connect(proxy.port);
		await probe.closed;

		tunnel.write("still-there");
		await tunnel.waitFor(c => c.text.endsWith("echo:still-there"));
		expect(server.sockets.size).toBe(1);
	});

	it("tunnels a request head that arrives in pieces", async () => {
		const server = startEchoServer();
		const proxy = await startProxy({ allowedHosts: () => ["127.0.0.1"] });
		const client = await RawClient.connect(proxy.port);
		const head = connectHead(`127.0.0.1:${server.port}`);
		// Split inside the terminator; a full round trip on another connection keeps the halves apart.
		client.write(head.slice(0, -1));
		await request(proxy, "garbage\r\n\r\n");
		client.write(head.slice(-1));
		await client.waitFor(c => c.text === `${TUNNEL_ESTABLISHED}hello\n`);
	});

	it("answers 502 without the blocked marker when the upstream refuses the connection", async () => {
		const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		const proxy = await startProxy({ allowedHosts: () => ["127.0.0.1"] });
		const port = closed.port;
		closed.stop(true);
		const response = await request(proxy, connectHead(`127.0.0.1:${port}`));
		expect(statusOf(response)).toBe(502);
		expect(response).not.toMatch(/X-Omp-Sandbox/i);
	});

	it("answers 502 when the allowlist throws and keeps serving", async () => {
		const server = startEchoServer();
		let reads = 0;
		const proxy = await startProxy({
			allowedHosts: () => {
				if (++reads === 1) throw new Error("settings unavailable");
				return ["127.0.0.1"];
			},
		});
		const failed = await request(proxy, connectHead(`127.0.0.1:${server.port}`));
		expect(statusOf(failed)).toBe(502);
		expect(failed).not.toMatch(/X-Omp-Sandbox/i);
		const client = await RawClient.connect(proxy.port);
		client.write(connectHead(`127.0.0.1:${server.port}`));
		await client.waitFor(c => c.text === `${TUNNEL_ESTABLISHED}hello\n`);
	});

	it("terminates the upstream when the client goes away", async () => {
		const upstreamClosed = Promise.withResolvers<void>();
		const opened = Promise.withResolvers<void>();
		let gracefulEnd = false;
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			allowHalfOpen: true,
			socket: {
				open: () => opened.resolve(),
				data() {},
				// A FIN means the proxy half-closed and would keep draining the response.
				end: () => {
					gracefulEnd = true;
				},
				close: () => upstreamClosed.resolve(),
			},
		});
		cleanups.push(() => listener.stop(true));
		const proxy = await startProxy({ allowedHosts: () => ["127.0.0.1"] });
		const client = await RawClient.connect(proxy.port);
		client.write(connectHead(`127.0.0.1:${listener.port}`));
		await client.waitFor(c => c.text === TUNNEL_ESTABLISHED);
		await opened.promise;
		client.terminate();
		await upstreamClosed.promise;
		expect(gracefulEnd).toBe(false);
	});

	it("blocks unknown hosts without asking once too many decisions are pending", async () => {
		const calls: string[] = [];
		const eightAsked = Promise.withResolvers<void>();
		const release = Promise.withResolvers<boolean>();
		const blocked: string[] = [];
		const proxy = await startProxy({
			allowedHosts: () => [],
			decide: host => {
				calls.push(host);
				if (calls.length === 8) eightAsked.resolve();
				return release.promise;
			},
			onBlocked: host => blocked.push(host),
		});
		const pending = Promise.all(
			Array.from({ length: 8 }, (_, i) => request(proxy, connectHead(`pending${i}.example:443`))),
		);
		await eightAsked.promise;
		expectBlocked(await request(proxy, connectHead("ninth.example:443")));
		expect(calls).toHaveLength(8);
		expect(blocked).toEqual(["ninth.example"]);
		release.resolve(false);
		for (const response of await pending) expectBlocked(response);
	});

	it("ends live tunnels on close", async () => {
		const server = startEchoServer();
		const proxy = await startProxy({ allowedHosts: () => ["127.0.0.1"] });
		const client = await RawClient.connect(proxy.port);
		client.write(connectHead(`127.0.0.1:${server.port}`));
		await client.waitFor(c => c.text === `${TUNNEL_ESTABLISHED}hello\n`);
		expect(server.sockets.size).toBe(1);

		await proxy.close();
		await client.closed;
		await server.firstClose;
		expect(server.sockets.size).toBe(0);
		await expect(RawClient.connect(proxy.port)).rejects.toThrow();
	});
});
