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
 * response. Resolves true when the connection is accepted, false when refused or
 * unanswered: a firewall in stealth mode drops the SYN to a closed port instead of
 * refusing it, and an unanswered SYN raises no event to await or fake clock to
 * advance, so a real one-second bound keeps the probe inside the test timeout.
 */
async function tcpConnects(hostname: string, port: number): Promise<boolean> {
	const attempt = connect({ hostname, port, socket: { data() {}, open() {}, close() {}, error() {} } }).then(
		socket => {
			socket.end();
			return true;
		},
		() => false,
	);
	return Promise.race([attempt, Bun.sleep(1_000).then(() => false)]);
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

/** Assert that a current, same-origin-only dashboard answers on `port`. */
async function expectCurrentDashboard(port: number): Promise<void> {
	const response = await fetch(`http://${STATS_DASHBOARD_HOSTNAME}:${port}/api/stats/models`);
	expect(response.headers.get(STATS_DASHBOARD_HEADER)).toBe(STATS_DASHBOARD_SECURITY_VERSION);
	expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
	await response.body?.cancel();
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
	it("returns the live in-process handle when started twice on the same port", async () => {
		// Reserve an ephemeral port, then start on it explicitly so the memo applies.
		const reservation = Bun.serve({ port: 0, hostname: STATS_DASHBOARD_HOSTNAME, fetch: () => new Response("") });
		const port = reservation.port;
		reservation.stop(true);

		const first = await startServer(port);
		try {
			// Regression: the second start used to probe our own port and could
			// dead-end in "Port X is held by the current process".
			const second = await startServer(port);
			expect(second.port).toBe(first.port);
			expect(second).toBe(first);
		} finally {
			first.stop();
		}
	});

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

	it("reuses a live dashboard that answers slowly while it ingests", async () => {
		// Regression: a dashboard stalled by ingest missed the probe deadline and
		// `/stats` failed with "not identifiable as an omp stats dashboard". The
		// holder is a separate process probed over real sockets, so its stall has
		// to be a real delay; fake timers here cannot slow another process down.
		const headers = `{ "${STATS_DASHBOARD_HEADER}": "${STATS_DASHBOARD_SECURITY_VERSION}", "${STATS_DASHBOARD_HOSTNAME_HEADER}": "${STATS_DASHBOARD_HOSTNAME}" }`;
		const holder = await startBunHolder(`Bun.sleep(1_000).then(() => Response.json([], { headers: ${headers} }))`);

		const server = await startServer(holder.port);
		expect(server.port).toBe(holder.port);
		expect(holder.child.exitCode).toBeNull();
	});

	for (const fixture of [
		{
			name: "reclaims a version 1 dashboard without command identity",
			response: `Response.json([], { headers: { "${STATS_DASHBOARD_HEADER}": "1", "Access-Control-Allow-Origin": "*" } })`,
			hostname: "0.0.0.0",
			statsOwned: false,
		},
		{
			name: "reclaims a headerless legacy dashboard",
			response: "Response.json([])",
			hostname: STATS_DASHBOARD_HOSTNAME,
			statsOwned: true,
		},
	]) {
		it(fixture.name, async () => {
			const holder = await startBunHolder(fixture.response, {
				hostname: fixture.hostname,
				statsOwned: fixture.statsOwned,
			});
			const server = await startServer(holder.port);

			try {
				expect(await holder.child.exited).not.toBe(0);
				await expectCurrentDashboard(server.port);
			} finally {
				server.stop();
			}
		});
	}

	for (const fixture of [
		{
			name: "a newer dashboard without command identity",
			response: `Response.json([], { headers: { "${STATS_DASHBOARD_HEADER}": "${Number(STATS_DASHBOARD_SECURITY_VERSION) + 1}" } })`,
			statsOwned: false,
		},
		{ name: "a foreign 200 responder", response: 'Response.json({ app: "spa" })', statsOwned: false },
		{
			name: "an unrelated Bun listener that fails the probe",
			response: 'new Response("foreign", { status: 404 })',
			statsOwned: false,
		},
		// Never answering is what a dashboard stalled mid-ingest looks like; stopping it would kill a live `omp stats`.
		{ name: "a stats listener that never answers", response: "Promise.withResolvers().promise", statsOwned: true },
	]) {
		it(`serves on an ephemeral port beside ${fixture.name}`, async () => {
			const holder = await startBunHolder(fixture.response, { statsOwned: fixture.statsOwned });
			const server = await startServer(holder.port);

			try {
				expect(server.port).not.toBe(holder.port);
				expect(holder.child.exitCode).toBeNull();
				await expectCurrentDashboard(server.port);
			} finally {
				server.stop();
			}
		}, 10_000);
	}

	it("reclaims a confirmed stats listener that fails the probe", async () => {
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
