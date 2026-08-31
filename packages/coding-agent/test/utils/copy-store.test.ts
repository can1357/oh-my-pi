import { describe, expect, it } from "bun:test";
import {
	copyDesktopPath,
	copyUrlTarget,
	createCopyDesktopEntry,
	supportsCopyUrlHandler,
} from "@oh-my-pi/pi-coding-agent/utils/copy-store";

describe("copy URL handler", () => {
	it("does not advertise a client-local copy link in remote or unsupported sessions", () => {
		expect(supportsCopyUrlHandler("linux", { SSH_CONNECTION: "client server" }, "/usr/bin/xdg-mime")).toBe(false);
		expect(supportsCopyUrlHandler("linux", { MOSH_IP: "203.0.113.7" }, "/usr/bin/xdg-mime")).toBe(false);
		expect(supportsCopyUrlHandler("linux", { WSL_DISTRO_NAME: "Ubuntu" }, "/usr/bin/xdg-mime")).toBe(false);
		expect(supportsCopyUrlHandler("linux", {}, null)).toBe(false);
		expect(supportsCopyUrlHandler("darwin", {}, "/usr/bin/xdg-mime")).toBe(false);
		expect(supportsCopyUrlHandler("linux", {}, "/usr/bin/xdg-mime")).toBe(true);
	});

	it("emits a self-contained OSC target only after handler readiness", () => {
		expect(copyUrlTarget("echo ready", false)).toBeUndefined();
		expect(copyUrlTarget("echo ready", true)).toMatch(/^omp-copy:/);
	});

	it("does not advertise a copy target that exceeds Linux's argument limit", () => {
		expect(copyUrlTarget("x".repeat(100 * 1024), true)).toBeUndefined();
	});

	it("installs the handler beneath XDG_DATA_HOME when configured", () => {
		expect(copyDesktopPath({ XDG_DATA_HOME: "/tmp/xdg-data" }, "/home/test")).toBe(
			"/tmp/xdg-data/applications/omp-copy.desktop",
		);
		expect(copyDesktopPath({}, "/home/test")).toBe("/home/test/.local/share/applications/omp-copy.desktop");
	});

	it("quotes and escapes the executable as one desktop Exec argument", () => {
		const entry = createCopyDesktopEntry('/opt/Oh My $Pi/omp"dev');
		expect(entry).toContain('Exec="/opt/Oh My \\$Pi/omp\\"dev" copy %u');
	});
});
