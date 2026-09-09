import { describe, expect, it } from "bun:test";
import { resolveCmuxKind } from "@oh-my-pi/pi-coding-agent/tools/browser";

describe("resolveCmuxKind", () => {
	it("returns a cmux kind from environment socket settings", () => {
		expect(
			resolveCmuxKind(null, {
				CMUX_SOCKET_PATH: "/tmp/cmux.sock",
				CMUX_SOCKET_PASSWORD: "pw",
			}),
		).toEqual({
			kind: "cmux",
			socketPath: "/tmp/cmux.sock",
			password: "pw",
			surface: undefined,
		});
	});

	it("includes the requested surface UUID", () => {
		expect(resolveCmuxKind({ surface: "surface-uuid" }, { CMUX_SOCKET_PATH: "/tmp/cmux.sock" })).toEqual({
			kind: "cmux",
			socketPath: "/tmp/cmux.sock",
			password: undefined,
			surface: "surface-uuid",
		});
	});

	it("returns null when cmux environment is absent", () => {
		expect(resolveCmuxKind(null, {})).toBeNull();
	});

	it("PI_BROWSER_CMUX=0 disables cmux even when the socket environment is present", () => {
		expect(resolveCmuxKind(null, { CMUX_SOCKET_PATH: "/tmp/cmux.sock", PI_BROWSER_CMUX: "0" })).toBeNull();
	});

	it("PI_BROWSER_CMUX=1 enables cmux over a disabled setting", () => {
		expect(
			resolveCmuxKind({ settingEnabled: false }, { CMUX_SOCKET_PATH: "/tmp/cmux.sock", PI_BROWSER_CMUX: "1" }),
		).toEqual({
			kind: "cmux",
			socketPath: "/tmp/cmux.sock",
			password: undefined,
			surface: undefined,
		});
	});

	it("settings can disable cmux when the env override is unset", () => {
		expect(resolveCmuxKind({ settingEnabled: false }, { CMUX_SOCKET_PATH: "/tmp/cmux.sock" })).toBeNull();
	});
});
