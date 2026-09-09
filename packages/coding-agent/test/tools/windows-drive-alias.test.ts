import { describe, expect, it } from "bun:test";
import { normalizeWindowsDriveAliasPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

describe("Windows drive alias paths", () => {
	it("maps MSYS drive roots to native Windows paths", () => {
		expect(normalizeWindowsDriveAliasPath("/c", "win32")).toBe("C:\\");
		expect(normalizeWindowsDriveAliasPath("/d/project/app", "win32")).toBe("D:\\project\\app");
		expect(normalizeWindowsDriveAliasPath("/D/project", "win32")).toBe("D:\\project");
	});

	it("maps WSL mount roots to native Windows paths", () => {
		expect(normalizeWindowsDriveAliasPath("/mnt/d/project", "win32")).toBe("D:\\project");
		expect(normalizeWindowsDriveAliasPath("/MNT/c", "win32")).toBe("C:\\");
	});

	it("leaves non-drive absolute paths and non-Windows platforms unchanged", () => {
		expect(normalizeWindowsDriveAliasPath("/", "win32")).toBe("/");
		expect(normalizeWindowsDriveAliasPath("/dev/null", "win32")).toBe("/dev/null");
		expect(normalizeWindowsDriveAliasPath("/mnt/data", "win32")).toBe("/mnt/data");
		expect(normalizeWindowsDriveAliasPath("/d/project", "linux")).toBe("/d/project");
		expect(normalizeWindowsDriveAliasPath("\\d\\logs", "win32")).toBe("\\d\\logs");
		expect(normalizeWindowsDriveAliasPath("\\mnt\\d\\logs", "win32")).toBe("\\mnt\\d\\logs");
	});

	it("maps Windows drive paths to their /mnt mount under WSL (#10426)", () => {
		const wsl = { WSL_DISTRO_NAME: "Ubuntu" } as NodeJS.ProcessEnv;
		expect(normalizeWindowsDriveAliasPath("C:\\Users\\MyUser\\Pictures\\MyPic.jpg", "linux", wsl)).toBe(
			"/mnt/c/Users/MyUser/Pictures/MyPic.jpg",
		);
		expect(normalizeWindowsDriveAliasPath("D:/data/report.png", "linux", wsl)).toBe("/mnt/d/data/report.png");
		expect(normalizeWindowsDriveAliasPath("C:\\", "linux", wsl)).toBe("/mnt/c");
	});

	it("leaves paths untranslated on plain linux without WSL interop vars", () => {
		const plain = {} as NodeJS.ProcessEnv;
		expect(normalizeWindowsDriveAliasPath("C:\\Users\\me\\pic.png", "linux", plain)).toBe("C:\\Users\\me\\pic.png");
		expect(
			normalizeWindowsDriveAliasPath("/home/me/pic.png", "linux", { WSL_INTEROP: "/run/x" } as NodeJS.ProcessEnv),
		).toBe("/home/me/pic.png");
	});
});
