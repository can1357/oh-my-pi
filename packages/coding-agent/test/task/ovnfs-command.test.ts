import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ovnfsCommand } from "@oh-my-pi/pi-coding-agent/task/settings";

describe("ovnfsCommand", () => {
	// Bash strips backslashes: `C:\Users\…\ovnfs.exe` pasted into a command runs as `C:Users…ovnfs.exe`.
	it.skipIf(process.platform !== "win32")("returns a Windows ovnfs.path with forward slashes", () => {
		const configured = process.execPath.replaceAll("/", "\\");
		const command = ovnfsCommand(Settings.isolated({ "ovnfs.path": configured }));
		expect(command).toBe(configured.replaceAll("\\", "/"));
	});
});
