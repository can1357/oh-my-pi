import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { ptree } from "@oh-my-pi/pi-utils";
import {
	copyDesktopPath,
	copyUrlTarget,
	createCopyDesktopEntry,
	isCopyUrlHandlerRegistered,
	registerCopyUrlHandler,
	supportsCopyUrlHandler,
} from "@oh-my-pi/pi-coding-agent/utils/copy-store";

afterEach(() => vi.restoreAllMocks());
describe("copy URL handler", () => {
	it("does not advertise a client-local copy link in remote or unsupported sessions", () => {
		expect(supportsCopyUrlHandler("linux", { SSH_CONNECTION: "client server" }, "/usr/bin/xdg-mime")).toBe(false);
		expect(supportsCopyUrlHandler("linux", { MOSH_IP: "203.0.113.7" }, "/usr/bin/xdg-mime")).toBe(false);
		expect(supportsCopyUrlHandler("linux", { WSL_DISTRO_NAME: "Ubuntu" }, "/usr/bin/xdg-mime")).toBe(false);
		expect(supportsCopyUrlHandler("linux", { CODESPACES: "true" }, "/usr/bin/xdg-mime")).toBe(false);
		expect(supportsCopyUrlHandler("linux", { REMOTE_CONTAINERS_IPC: "1" }, "/usr/bin/xdg-mime")).toBe(false);
		expect(supportsCopyUrlHandler("linux", { SUDO_USER: "desktop-user" }, "/usr/bin/xdg-mime")).toBe(false);
		expect(supportsCopyUrlHandler("linux", {}, null)).toBe(false);
		expect(supportsCopyUrlHandler("darwin", {}, "/usr/bin/xdg-mime")).toBe(false);
		expect(supportsCopyUrlHandler("linux", {}, "/usr/bin/xdg-mime", () => false)).toBe(true);
	});

	it("does not advertise a client-local copy link inside generic containers", () => {
		const noMarkers = () => false;
		expect(supportsCopyUrlHandler("linux", { container: "podman" }, "/usr/bin/xdg-mime", noMarkers)).toBe(false);
		expect(supportsCopyUrlHandler("linux", {}, "/usr/bin/xdg-mime", path => path === "/.dockerenv")).toBe(false);
		expect(supportsCopyUrlHandler("linux", {}, "/usr/bin/xdg-mime", path => path === "/run/.containerenv")).toBe(
			false,
		);
		expect(supportsCopyUrlHandler("linux", {}, "/usr/bin/xdg-mime", noMarkers)).toBe(true);
	});

	it("emits a self-contained OSC target only after handler readiness", () => {
		expect(copyUrlTarget("echo ready", false)).toBeUndefined();
		expect(copyUrlTarget("echo ready", true)).toMatch(/^omp-copy:/);
	});

	it("does not advertise copy targets beyond the portable OSC URI boundary", () => {
		const accepted = copyUrlTarget("x".repeat(1551), true);
		expect(Buffer.byteLength(accepted!)).toBe(2082);
		expect(copyUrlTarget("x".repeat(1552), true)).toBeUndefined();
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

	it.skipIf(process.platform !== "linux")(
		"fails closed and reaps timed-out query and registration helpers",
		async () => {
			vi.spyOn(Bun, "which").mockReturnValue("/test/xdg-mime");
			vi.spyOn(fs, "existsSync").mockReturnValue(false);
			vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
			vi.spyOn(Bun, "write").mockResolvedValue(0);
			const exec = ptree.exec;
			let timeouts = 0;
			vi.spyOn(ptree, "exec").mockImplementation(async (_command, options) => {
				try {
					return await exec([process.execPath, "-e", "await Bun.sleep(60_000)"], options);
				} catch (error) {
					timeouts++;
					throw error;
				}
			});
			expect(await isCopyUrlHandlerRegistered()).toBe(false);
			expect((await registerCopyUrlHandler()).ok).toBe(false);
			expect(timeouts).toBe(2);
		},
		10_000,
	);
});
