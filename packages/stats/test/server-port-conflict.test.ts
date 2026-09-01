import { afterEach, describe, expect, it } from "bun:test";
import { networkInterfaces } from "node:os";
import { connect, type Subprocess } from "bun";
import {
	STATS_DASHBOARD_HEADER,
	STATS_DASHBOARD_HOSTNAME,
	STATS_DASHBOARD_HOSTNAME_HEADER,
	STATS_DASHBOARD_SECURITY_VERSION,
} from "../src/port-conflict";
import { startServer } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-port-conflict-");

/**
 * Directly probe a TCP endpoint, bypassing any configured HTTP proxy so the
 * loopback-only bind is asserted against the real listener rather than a proxy
 * response. Resolves true when the connection is accepted, false when refused.
 */
async function tcpConnects(hostname: string, port: number): Promise<boolean> {
	try {
		const socket = await connect({ hostname, port, socket: { data() {}, open() {}, close() {}, error() {} } });
		socket.end();
		return true;
	} catch {
		return false;
	}
}
function getNonLoopbackHostname(): string | undefined {
	const interfaces = networkInterfaces();
	for (const name in interfaces) {
		for (const address of interfaces[name] ?? []) {
			if (address.family === "IPv4" && !address.internal) return address.address;
		}
	}
	return undefined;
}

const holderProcesses: Array<Subprocess<"ignore", "pipe", "pipe">> = [];

async function startBunHolder(responseExpr: string, options?: { hostname?: string; statsOwned?: boolean }) {
	const hostname = options?.hostname ?? STATS_DASHBOARD_HOSTNAME;
	const reservation = Bun.serve({
		port: 0,
		hostname: STATS_DASHBOARD_HOSTNAME,
		fetch: () => new Response("reserved"),
	});
	const port = reservation.port;
	reservation.stop(true);

	const source = `Bun.serve({ port: ${port}, hostname: "${hostname}", fetch: () => ${responseExpr} }); process.stdout.write("ready"); await Promise.withResolvers().promise;`;
	const args = [process.execPath, "-e", source];
	if (options?.statsOwned) args.push("omp-stats");
	const child = Bun.spawn(args, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	holderProcesses.push(child);

	const reader = child.stdout.getReader();
	const ready = await reader.read();
	reader.releaseLock();
	if (!ready.done && new TextDecoder().decode(ready.value) === "ready") {
		return { child, port };
	}

	await child.exited;
	const stderr = await new Response(child.stderr).text();
	throw new Error(`Holder failed to listen on port ${port}: ${stderr}`);
}

afterEach(async () => {
	for (const child of holderProcesses) {
		child.kill();
		await child.exited;
	}
	holderProcesses.length = 0;
});

describe("startServer access", () => {
	it("only serves loopback requests without cross-origin access", async () => {
		const server = await startServer(0);

		try {
			expect(server.hostname).toBe(STATS_DASHBOARD_HOSTNAME);
			const response = await fetch(`http://${server.hostname}:${server.port}/api/stats/models`);
			expect(response.status).toBe(200);
			expect(response.headers.get(STATS_DASHBOARD_HEADER)).toBe(STATS_DASHBOARD_SECURITY_VERSION);
			expect(response.headers.get(STATS_DASHBOARD_HOSTNAME_HEADER)).toBe(STATS_DASHBOARD_HOSTNAME);
			expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
			await response.body?.cancel();

			const nonLoopbackHostname = getNonLoopbackHostname();
			expect(await tcpConnects(server.hostname, server.port)).toBe(true);
			if (nonLoopbackHostname) expect(await tcpConnects(nonLoopbackHostname, server.port)).toBe(false);
		} finally {
			server.stop();
		}
	});

	it("serves non-loopback requests only when explicitly requested", async () => {
		const nonLoopbackHostname = getNonLoopbackHostname();
		if (!nonLoopbackHostname) return;

		const server = await startServer(0, "0.0.0.0");

		try {
			expect(server.hostname).toBe("0.0.0.0");
			expect(await tcpConnects(nonLoopbackHostname, server.port)).toBe(true);

			const response = await fetch(`http://${STATS_DASHBOARD_HOSTNAME}:${server.port}/api/stats/models`);
			expect(response.status).toBe(200);
			expect(response.headers.get(STATS_DASHBOARD_HEADER)).toBe(STATS_DASHBOARD_SECURITY_VERSION);
			expect(response.headers.get(STATS_DASHBOARD_HOSTNAME_HEADER)).toBe("0.0.0.0");
			expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
			await response.body?.cancel();
		} finally {
			server.stop();
		}
	});
});

describe("startServer port conflicts", () => {
	it("reuses a live stats dashboard identified by its header", async () => {
		const existing = Bun.serve({
			port: 0,
			hostname: STATS_DASHBOARD_HOSTNAME,
			fetch: request =>
				new URL(request.url).pathname === "/api/stats/models"
					? Response.json([], {
							headers: {
								[STATS_DASHBOARD_HEADER]: STATS_DASHBOARD_SECURITY_VERSION,
								[STATS_DASHBOARD_HOSTNAME_HEADER]: STATS_DASHBOARD_HOSTNAME,
							},
						})
					: new Response("dashboard"),
		});

		try {
			const server = await startServer(existing.port);
			expect(server.port).toBe(existing.port);
			server.stop();

			// The existing dashboard is untouched: it still answers on the port.
			const response = await fetch(`http://${STATS_DASHBOARD_HOSTNAME}:${existing.port}/api/stats/models`);
			expect(response.status).toBe(200);
			expect(response.headers.get(STATS_DASHBOARD_HEADER)).toBe(STATS_DASHBOARD_SECURITY_VERSION);
			await response.body?.cancel();
		} finally {
			existing.stop(true);
		}
	});

	for (const fixture of [
		{
			name: "reclaims a version 1 dashboard with wildcard CORS",
			response: `Response.json([], { headers: { "${STATS_DASHBOARD_HEADER}": "1", "Access-Control-Allow-Origin": "*" } })`,
			hostname: "0.0.0.0",
		},
		{
			name: "reclaims a headerless legacy dashboard",
			response: "Response.json([])",
			hostname: STATS_DASHBOARD_HOSTNAME,
		},
	]) {
		it(fixture.name, async () => {
			const holder = await startBunHolder(fixture.response, {
				hostname: fixture.hostname,
				statsOwned: true,
			});
			const server = await startServer(holder.port);

			try {
				expect(await holder.child.exited).not.toBe(0);
				const response = await fetch(`http://${STATS_DASHBOARD_HOSTNAME}:${server.port}/api/stats/models`);
				expect(response.headers.get(STATS_DASHBOARD_HEADER)).toBe(STATS_DASHBOARD_SECURITY_VERSION);
				expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
				await response.body?.cancel();
			} finally {
				server.stop();
			}
		});
	}

	it("refuses to stop a foreign 200 responder", async () => {
		const holder = await startBunHolder('Response.json({ app: "spa" })');

		await expect(startServer(holder.port)).rejects.toThrow("not identifiable as an omp stats dashboard");
		expect(holder.child.exitCode).toBeNull();
		const response = await fetch(`http://${STATS_DASHBOARD_HOSTNAME}:${holder.port}/api/stats/models`);
		expect(await response.json()).toEqual({ app: "spa" });
	});

	it("refuses to stop an unrelated Bun listener that fails the probe", async () => {
		const holder = await startBunHolder('new Response("foreign", { status: 404 })');

		await expect(startServer(holder.port)).rejects.toThrow("not identifiable as an omp stats dashboard");
		expect(holder.child.exitCode).toBeNull();
	});

	it("reclaims an unresponsive confirmed stats listener", async () => {
		const holder = await startBunHolder('new Response("holder", { status: 404 })', { statsOwned: true });
		const server = await startServer(holder.port);

		try {
			expect(server.port).toBe(holder.port);
			expect(await holder.child.exited).not.toBe(0);
		} finally {
			server.stop();
		}
	});
});
