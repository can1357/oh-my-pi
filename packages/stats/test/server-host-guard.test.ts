import { afterEach, describe, expect, it } from "bun:test";
import { STATS_ALLOWED_HOSTS_ENV, type StatsServerHandle, startServer } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-host-guard-");

let server: StatsServerHandle | undefined;
afterEach(() => {
	server?.stop();
	server = undefined;
});

/** Status for a request carrying `host` as its Host header, as a browser on that origin would send it. */
async function statusFor(host: string): Promise<number> {
	if (!server) throw new Error("server not started");
	const response = await fetch(`http://127.0.0.1:${server.port}/`, {
		method: "OPTIONS",
		headers: { Host: `${host}:${server.port}` },
	});
	await response.body?.cancel();
	return response.status;
}

describe("dashboard Host guard", () => {
	it("refuses public names a rebinding page would send and serves names public DNS cannot hand out", async () => {
		const previous = process.env[STATS_ALLOWED_HOSTS_ENV];
		process.env[STATS_ALLOWED_HOSTS_ENV] = " Stats.Example.com ,";
		try {
			server = await startServer(0);
		} finally {
			if (previous === undefined) delete process.env[STATS_ALLOWED_HOSTS_ENV];
			else process.env[STATS_ALLOWED_HOSTS_ENV] = previous;
		}

		// Rebinding: attacker-controlled public names, including look-alikes of the private suffixes.
		expect(await statusFor("evil.example")).toBe(403);
		expect(await statusFor("localhost.evil.example")).toBe(403);
		expect(await statusFor("evil-ts.net")).toBe(403);

		expect(await statusFor("127.0.0.1")).toBe(200);
		expect(await statusFor("[::1]")).toBe(200);
		expect(await statusFor("localhost")).toBe(200);
		// MagicDNS short name and Tailscale Serve's forwarded Host.
		expect(await statusFor("mybox")).toBe(200);
		expect(await statusFor("mybox.tail1234.ts.net")).toBe(200);
		// Reverse proxy under a real domain, opted in through the environment.
		expect(await statusFor("stats.example.com")).toBe(200);
		expect(await statusFor("stats.example.com.")).toBe(200);
	});
});
