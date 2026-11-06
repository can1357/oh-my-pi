import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { statsLive } from "../src/live";
import { buildAllowedHosts, STATS_ALLOWED_HOSTS_ENV, type StatsServerHandle, startServer } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-host-guard-");

const servers: StatsServerHandle[] = [];
const originalAllowedHosts = process.env[STATS_ALLOWED_HOSTS_ENV];

afterEach(() => {
	for (const server of servers) server.stop();
	servers.length = 0;
	if (originalAllowedHosts === undefined) delete process.env[STATS_ALLOWED_HOSTS_ENV];
	else process.env[STATS_ALLOWED_HOSTS_ENV] = originalAllowedHosts;
});

async function start(allowedHosts?: string[]): Promise<{ base: string; port: number }> {
	const server = await startServer(0, "127.0.0.1", { allowedHosts });
	servers.push(server);
	return { base: `http://127.0.0.1:${server.port}`, port: server.port };
}

async function status(url: string, init: RequestInit = {}): Promise<number> {
	const response = await fetch(url, init);
	await response.body?.cancel();
	return response.status;
}

const ACTION = { "X-Omp-Stats-Action": "1" };

describe("dashboard Host validation", () => {
	it("rejects a forged Host on API, static and event routes with 421", async () => {
		const { base } = await start();
		const headers = { Host: "attacker.example" };
		expect(await status(`${base}/api/stats/overview`, { headers })).toBe(421);
		expect(await status(`${base}/api/request/1`, { headers })).toBe(421);
		expect(await status(`${base}/api/events`, { headers })).toBe(421);
		expect(await status(`${base}/`, { headers })).toBe(421);
		expect(await status(`${base}/api/sync`, { method: "POST", headers: { ...headers, ...ACTION } })).toBe(421);
	});

	it("rejects look-alike and unlisted hosts even when a host is configured", async () => {
		const { base } = await start(["stats.example.ts.net"]);
		for (const host of [
			"stats.example.ts.net.evil.example",
			"evil.stats.example.ts.net",
			"other.ts.net",
			"127.0.0.1.evil.example",
		]) {
			expect(await status(`${base}/api/stats/models`, { headers: { Host: host } })).toBe(421);
		}
	});

	it("accepts loopback hosts with and without a port", async () => {
		const { base, port } = await start();
		for (const host of [
			"127.0.0.1",
			`127.0.0.1:${port}`,
			"localhost",
			`localhost:${port}`,
			`[::1]:${port}`,
			"LOCALHOST",
		]) {
			expect(await status(`${base}/api/stats/models`, { headers: { Host: host } })).toBe(200);
		}
	});

	it("accepts a configured host and a configured wildcard, with or without a port", async () => {
		const { base } = await start(["stats.example.ts.net", "*.wild.example"]);
		for (const host of ["stats.example.ts.net", "stats.example.ts.net:443", "a.wild.example", "a.b.wild.example"]) {
			expect(await status(`${base}/api/stats/models`, { headers: { Host: host } })).toBe(200);
		}
		expect(await status(`${base}/api/stats/models`, { headers: { Host: "wild.example" } })).toBe(421);
	});

	it("accepts hosts listed in the environment variable", async () => {
		process.env[STATS_ALLOWED_HOSTS_ENV] = "env.example, other.example";
		const { base } = await start();
		expect(await status(`${base}/api/stats/models`, { headers: { Host: "other.example" } })).toBe(200);
	});

	it("never trusts a *.ts.net host unless it was configured", async () => {
		const { base } = await start();
		expect(await status(`${base}/api/stats/models`, { headers: { Host: "somehost.tail0000.ts.net" } })).toBe(421);
	});
});

describe("dashboard state-changing endpoints", () => {
	it("rejects GET /api/sync", async () => {
		const { base } = await start();
		expect(await status(`${base}/api/sync`)).toBe(405);
		expect(await status(`${base}/api/sync`, { headers: ACTION })).toBe(405);
	});

	it("requires the action header on POST", async () => {
		const { base } = await start();
		expect(await status(`${base}/api/sync`, { method: "POST" })).toBe(403);
		expect(await status(`${base}/api/frustration/cancel`, { method: "POST" })).toBe(403);
		expect(await status(`${base}/api/close`, { method: "POST" })).toBe(403);
	});

	it("rejects cross-origin POSTs but accepts same-origin ones", async () => {
		const { base, port } = await start(["stats.example.ts.net"]);
		const post = (path: string, headers: Record<string, string>) =>
			status(`${base}${path}`, { method: "POST", headers: { ...ACTION, ...headers } });
		for (const path of ["/api/sync", "/api/frustration/cancel", "/api/frustration/judge"]) {
			expect(await post(path, { Origin: "https://attacker.example" })).toBe(403);
			expect(await post(path, { Origin: "null" })).toBe(403);
		}
		// Origin from another loopback port is still cross-origin.
		expect(await post("/api/sync", { Origin: `http://127.0.0.1:${port + 1}` })).toBe(403);
		expect(await post("/api/sync", { Origin: `http://127.0.0.1:${port}` })).toBe(202);
		expect(await post("/api/sync", { Host: "stats.example.ts.net", Origin: "https://stats.example.ts.net" })).toBe(
			202,
		);
		expect(await post("/api/sync", {})).toBe(202);
	});
});

/** Raw HTTP/1.1 exchange, so request-line and Host bytes reach the server untouched. */
async function raw(port: number, host: string, head: string): Promise<{ status: number; body: string }> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const sock = net.connect(port, host);
	let data = "";
	sock.on("data", chunk => {
		data += chunk.toString("latin1");
	});
	sock.on("error", () => resolve());
	sock.on("close", () => resolve());
	sock.on("connect", () => sock.write(Buffer.from(head, "latin1")));
	// Every request carries `Connection: close`, so the server ends the exchange.
	await promise;
	sock.destroy();
	const match = /^HTTP\/1\.[01] (\d{3})/.exec(data);
	const split = data.indexOf("\r\n\r\n");
	return { status: match ? Number(match[1]) : 0, body: split >= 0 ? data.slice(split + 4) : "" };
}

describe("cross-site gate on API reads", () => {
	it("rejects cross-site event requests before they can start a sync", async () => {
		const { base, port } = await start();
		const spy = spyOn(statsLive(), "requestSync").mockImplementation(() => {});
		try {
			expect(await status(`${base}/api/events`, { headers: { "Sec-Fetch-Site": "cross-site" } })).toBe(403);
			expect(
				await status(`${base}/api/events`, { method: "POST", headers: { Origin: "http://attacker.example" } }),
			).toBe(403);
			expect(await status(`${base}/api/events`, { headers: { Origin: `http://127.0.0.1:${port + 1}` } })).toBe(403);
			expect(spy).not.toHaveBeenCalled();
			// A same-origin page still subscribes, and its first connection starts ingest.
			expect(await status(`${base}/api/events`, { headers: { "Sec-Fetch-Site": "same-origin" } })).toBe(200);
			expect(spy).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("rejects cross-site trace and entry reads before touching the disk", async () => {
		const { base, port } = await start();
		for (const path of ["/api/session/trace?file=/nope.jsonl", "/api/session/entry?file=/nope.jsonl&id=x"]) {
			expect(await status(`${base}${path}`, { headers: { "Sec-Fetch-Site": "cross-site" } })).toBe(403);
			expect(await status(`${base}${path}`, { headers: { Origin: "https://attacker.example" } })).toBe(403);
			expect(await status(`${base}${path}`, { headers: { Origin: `http://127.0.0.1:${port}` } })).not.toBe(403);
			expect(await status(`${base}${path}`)).not.toBe(403);
		}
	});
});

describe("server errors", () => {
	it("answers an unexpected failure with a generic 500 that names no paths", async () => {
		const { base } = await start();
		// A self-referencing link passes the path checks; resolving it fails with ELOOP, whose message names the path.
		const file = path.join(getSessionsDir(), "project", "loop.jsonl");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.symlink(file, file);
		const response = await fetch(`${base}/api/session/trace?file=${encodeURIComponent(file)}`);
		const body = await response.text();
		expect(response.status).toBe(500);
		expect(body).not.toContain("loop.jsonl");
		expect(body).not.toContain("ELOOP");
	});
});

describe("Host header hardening", () => {
	it("rejects Host values with userinfo, path or fragment characters without a 500", async () => {
		const { port } = await start();
		for (const host of [
			`evil.com@127.0.0.1:${port}`,
			`127.0.0.1:${port}#@evil.com`,
			`127.0.0.1:${port}?x`,
			`127.0.0.1:${port}/x`,
			`127.0.0.1:${port}\\x`,
			`evil.com\\@127.0.0.1:${port}`,
		]) {
			const response = await raw(
				port,
				"127.0.0.1",
				`GET /api/stats/models HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
			);
			expect({ host, status: response.status }).toEqual({ host, status: 421 });
			expect(response.body).not.toContain(".ts");
			expect(response.body).not.toContain("/home/");
		}
	});

	it("does not treat a wildcard entry as a literal host or accept empty labels", async () => {
		const { base } = await start(["*.example.net"]);
		for (const host of ["*.example.net", "a..example.net", ".example.net", "example.net"]) {
			expect({ host, status: await status(`${base}/api/stats/models`, { headers: { Host: host } }) }).toEqual({
				host,
				status: 421,
			});
		}
		expect(await status(`${base}/api/stats/models`, { headers: { Host: "a.example.net" } })).toBe(200);
	});

	it("only trusts loopback Host names from loopback peers when bound to a wildcard address", async () => {
		const lan = Object.values(os.networkInterfaces())
			.flat()
			.find(info => info && info.family === "IPv4" && !info.internal);
		const server = await startServer(0, "0.0.0.0");
		servers.push(server);
		// `0.0.0.0` is the URL printed for this bind; opened locally, it arrives over loopback.
		for (const host of ["127.0.0.1", "0.0.0.0"]) {
			const head = `GET /api/stats/models HTTP/1.1\r\nHost: ${host}:${server.port}\r\nConnection: close\r\n\r\n`;
			expect({ host, status: (await raw(server.port, "127.0.0.1", head)).status }).toEqual({ host, status: 200 });
			if (lan) {
				expect({ host, status: (await raw(server.port, lan.address, head)).status }).toEqual({ host, status: 421 });
			}
		}
	});
});

describe("dashboard reuse", () => {
	it("serves a caller asking for other allowed hosts on its own listener instead of reusing one", async () => {
		const first = await start();
		const second = await startServer(first.port, "127.0.0.1", { allowedHosts: ["review.example"] });
		servers.push(second);
		expect(second.port).not.toBe(first.port);
		const headers = { Host: "review.example" };
		expect(await status(`http://127.0.0.1:${second.port}/api/stats/models`, { headers })).toBe(200);
		expect(await status(`${first.base}/api/stats/models`, { headers })).toBe(421);
		// The same policy still reuses the running dashboard.
		expect((await startServer(first.port, "127.0.0.1")).port).toBe(first.port);
	});
});

describe("--allowed-host validation", () => {
	it("throws a clear error for URL-ish or malformed entries", () => {
		for (const entry of [
			"https://host.example",
			"host.example/path",
			"user@example.com",
			"host.example#x",
			"host.example?x",
			"host .example",
			"host.example:80:90",
			"host.example:http",
			// One listener, one port: a port would restrict nothing, so it is refused, not ignored.
			"other.example:8443",
			"*.wild.example:8443",
			"[2001:db8::1]:8443",
			"a..example",
			"*.",
			"*",
		]) {
			expect(() => buildAllowedHosts("127.0.0.1", [entry])).toThrow(/allowed host/i);
		}
		expect(() =>
			buildAllowedHosts("127.0.0.1", ["host.example", "*.wild.example", "[2001:db8::1]"]),
		).not.toThrow();
	});

	it("fails startServer before binding when an allowed host is invalid", async () => {
		await expect(startServer(0, "127.0.0.1", { allowedHosts: ["https://host.example"] })).rejects.toThrow(
			/allowed host/i,
		);
	});
});

describe("Origin comparison", () => {
	it("requires the full serialized origin to match", async () => {
		const allowed = "stats.example.ts.net";
		const { base, port } = await start([allowed]);
		const post = (headers: Record<string, string>) =>
			status(`${base}/api/sync`, { method: "POST", headers: { ...ACTION, ...headers } });
		const me = `127.0.0.1:${port}`;
		for (const origin of [
			`https://${me}`, // scheme mismatch on a plain-http listener
			`http://evil.com@${me}`, // userinfo
			`http://${me}/x`, // path
			`http://${me}/`, // trailing slash is not a serialized origin
			`http://${me}?q`, // query
			`http://${me}#@evil.com`, // fragment
			`ftp://${me}`,
		]) {
			expect({ origin, status: await post({ Origin: origin }) }).toEqual({ origin, status: 403 });
		}
		for (const origin of [
			"http://stats.example.ts.net/x",
			"https://stats.example.ts.net/",
			`https://evil.com@${allowed}`,
			"wss://stats.example.ts.net",
		]) {
			expect({ origin, status: await post({ Host: "stats.example.ts.net", Origin: origin }) }).toEqual({
				origin,
				status: 403,
			});
		}
		expect(await post({ Origin: `http://${me}` })).toBe(202);
		expect(await post({ Host: "stats.example.ts.net", Origin: "https://stats.example.ts.net" })).toBe(202);
		expect(await post({ Host: "stats.example.ts.net:443", Origin: "https://stats.example.ts.net" })).toBe(202);
	});
});
