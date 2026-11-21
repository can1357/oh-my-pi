import { describe, expect, it } from "bun:test";
import { resolveDaemonSpawnOptions } from "../../src/launch/spawn-options";

describe("resolveDaemonSpawnOptions", () => {
	it("detaches Windows daemons so they outlive the host process", () => {
		expect(resolveDaemonSpawnOptions({ platform: "win32" })).toEqual({ detached: true, windowsHide: true });
	});

	it("keeps POSIX daemons in their own session", () => {
		expect(resolveDaemonSpawnOptions({ platform: "linux" })).toEqual({ detached: true });
	});
});
