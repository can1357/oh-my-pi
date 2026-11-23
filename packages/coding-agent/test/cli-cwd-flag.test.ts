import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { applyStartupCwd } from "@oh-my-pi/pi-coding-agent/cli/startup-cwd";
import * as utils from "@oh-my-pi/pi-utils";

const originalProjectDir = utils.getProjectDir();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
	vi.restoreAllMocks();
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	utils.setProjectDir(originalProjectDir);
});
describe("parseArgs — --cwd flag", () => {
	it("parses --cwd with a space-separated directory", () => {
		const result = parseArgs(["--cwd", "/work/project", "hello"]);

		expect(result.cwd).toBe("/work/project");
		expect(result.messages).toEqual(["hello"]);
	});

	it("parses --cwd=value without leaking the value into messages", () => {
		const result = parseArgs(["--cwd=/work/project", "hello"]);

		expect(result.cwd).toBe("/work/project");
		expect(result.messages).toEqual(["hello"]);
	});

	it("parses repeated --config overlays", () => {
		const result = parseArgs(["--config", "base.yml", "--config=team.yml", "hello"]);

		expect(result.config).toEqual(["base.yml", "team.yml"]);
		expect(result.messages).toEqual(["hello"]);
	});
	it("applies --cwd before session lookup callers read the project directory", async () => {
		const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cwd-launch-"));
		const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cwd-target-"));
		utils.setProjectDir(launchDir);

		const parsed = parseArgs(["--cwd", targetDir, "--continue"]);
		await applyStartupCwd(parsed);

		expect(parsed.continue).toBe(true);
		expect(utils.getProjectDir()).toBe(targetDir);
		expect(utils.normalizePathForComparison(process.cwd())).toBe(utils.normalizePathForComparison(targetDir));
	});

	it("normalizes a relative --cwd target to the resolved absolute path", async () => {
		const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cwd-rel-"));
		const childName = "repo";
		const childDir = path.join(launchDir, childName);
		fs.mkdirSync(childDir);
		utils.setProjectDir(launchDir);

		const parsed = parseArgs(["--cwd", childName]);
		await applyStartupCwd(parsed);

		// parsed.cwd must be the resolved absolute target, not the raw relative
		// string that would re-resolve against the new cwd (e.g. repo/repo).
		expect(path.isAbsolute(parsed.cwd ?? "")).toBe(true);
		expect(parsed.cwd).toBe(utils.getProjectDir());
		expect(utils.getProjectDir()).toBe(childDir);
		// Re-resolving the normalized value against the (now changed) process cwd
		// is idempotent — no doubled "repo/repo" segment.
		expect(path.resolve(parsed.cwd ?? "")).toBe(utils.getProjectDir());
		expect(parsed.cwd?.endsWith(`${childName}${path.sep}${childName}`)).toBe(false);
	});

	it("reports a clean error when the cwd change is denied", async () => {
		const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cwd-denied-launch-"));
		utils.setProjectDir(launchDir);
		const targetDir = path.join(launchDir, "blocked");
		const parsed = parseArgs(["--cwd", targetDir]);
		const chdir = vi.spyOn(process, "chdir").mockImplementation(() => {
			throw new Error("operation not permitted");
		});

		try {
			await expect(applyStartupCwd(parsed)).rejects.toThrow(
				`Cannot change working directory to ${targetDir}: operation not permitted`,
			);
		} finally {
			chdir.mockRestore();
		}
		expect(utils.getProjectDir()).toBe(launchDir);
	});

	it("appends the macOS permission hint only for permission errors", async () => {
		const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cwd-hint-launch-"));
		utils.setProjectDir(launchDir);
		const targetDir = path.join(launchDir, "blocked");
		const parsed = parseArgs(["--cwd", targetDir]);
		const chdir = vi.spyOn(process, "chdir").mockImplementation(() => {
			throw Object.assign(new Error("operation not permitted"), { code: "EACCES" });
		});

		try {
			await expect(applyStartupCwd(parsed)).rejects.toThrow(
				/operation not permitted\. On macOS, grant omp Files & Folders/,
			);
		} finally {
			chdir.mockRestore();
		}
	});

	it("uses the system temporary directory for Windows home launches", async () => {
		const home = String.raw`C:\Users\reporter`;
		const fallback = String.raw`C:\Users\reporter\AppData\Local\Temp`;
		if (!platformDescriptor) throw new Error("process.platform descriptor is unavailable");
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
		vi.spyOn(os, "homedir").mockReturnValue(home);
		vi.spyOn(os, "tmpdir").mockReturnValue(fallback);
		vi.spyOn(utils, "getProjectDir").mockReturnValue(home);
		vi.spyOn(utils, "directoryExists").mockImplementation(async candidate => {
			return candidate === "/tmp" || candidate === fallback;
		});
		const setProjectDir = vi.spyOn(utils, "setProjectDir").mockImplementation(() => {});

		await applyStartupCwd(parseArgs([]));

		expect(setProjectDir).toHaveBeenCalledTimes(1);
		expect(setProjectDir).toHaveBeenCalledWith(fallback);
	});
});
