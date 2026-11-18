import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { VERSION } from "@oh-my-pi/pi-utils";
import { daemonBuildId } from "../../src/daemon/build";
import { compareDaemonBuilds, parseDaemonBuild } from "../../src/daemon/protocol";

describe("daemon build identity", () => {
	it("orders by semver before the stamp, so a newer release wins over a freshly rebuilt older one", () => {
		expect(compareDaemonBuilds("1.10.0+1", "1.9.0+999999999")).toBe(1);
		expect(compareDaemonBuilds("1.9.0+999999999", "1.10.0+1")).toBe(-1);
		// A prerelease is older than its release whatever the stamps say.
		expect(compareDaemonBuilds("2.0.0-beta.1+900", "2.0.0+100")).toBe(-1);
	});

	it("orders equal versions by stamp and treats identical builds as equal", () => {
		expect(compareDaemonBuilds("3.1.0+2000", "3.1.0+1000")).toBe(1);
		expect(compareDaemonBuilds("3.1.0+1000", "3.1.0+2000")).toBe(-1);
		expect(compareDaemonBuilds("3.1.0+1000", "3.1.0+1000")).toBe(0);
	});

	it("reads a missing or malformed stamp as 0, which loses to any real stamp of the same version", () => {
		expect(parseDaemonBuild("3.1.0")).toEqual({ version: "3.1.0", stamp: 0 });
		expect(parseDaemonBuild("3.1.0+")).toEqual({ version: "3.1.0", stamp: 0 });
		expect(parseDaemonBuild("3.1.0+abc")).toEqual({ version: "3.1.0", stamp: 0 });
		expect(parseDaemonBuild("3.1.0+-5")).toEqual({ version: "3.1.0", stamp: 0 });
		expect(parseDaemonBuild("3.1.0+1.5")).toEqual({ version: "3.1.0", stamp: 0 });
		expect(parseDaemonBuild("3.1.0+99999999999999999999")).toEqual({ version: "3.1.0", stamp: 0 });
		expect(compareDaemonBuilds("3.1.0+abc", "3.1.0+1")).toBe(-1);
		// Malformed stamps never make two different strings look newer than each other.
		expect(compareDaemonBuilds("3.1.0", "3.1.0+garbage")).toBe(0);
	});

	it("gives every process of one install the same build id, so client and daemon never ping-pong upgrades", async () => {
		const own = daemonBuildId();
		expect(parseDaemonBuild(own).version).toBe(VERSION);
		expect(parseDaemonBuild(own).stamp).toBeGreaterThan(0);

		const buildModule = path.join(import.meta.dir, "..", "..", "src", "daemon", "build.ts");
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`const { daemonBuildId } = await import(${JSON.stringify(buildModule)}); process.stdout.write(daemonBuildId());`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0) throw new Error(`build id probe failed (${exitCode}): ${stderr}`);
		expect(compareDaemonBuilds(stdout, own)).toBe(0);
	}, 30_000);
});
