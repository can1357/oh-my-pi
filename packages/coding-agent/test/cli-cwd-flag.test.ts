import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { applyStartupCwd } from "@oh-my-pi/pi-coding-agent/cli/startup-cwd";
import { getProjectDir, normalizePathForComparison, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();

afterEach(() => {
	setProjectDir(originalProjectDir);
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
		setProjectDir(launchDir);

		const parsed = parseArgs(["--cwd", targetDir, "--continue"]);
		await applyStartupCwd(parsed);

		expect(parsed.continue).toBe(true);
		expect(getProjectDir()).toBe(targetDir);
		expect(normalizePathForComparison(process.cwd())).toBe(normalizePathForComparison(targetDir));
	});

	it("normalizes a relative --cwd target to the resolved absolute path", async () => {
		const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cwd-rel-"));
		const childName = "repo";
		const childDir = path.join(launchDir, childName);
		fs.mkdirSync(childDir);
		setProjectDir(launchDir);

		const parsed = parseArgs(["--cwd", childName]);
		await applyStartupCwd(parsed);

		// parsed.cwd must be the resolved absolute target, not the raw relative
		// string that would re-resolve against the new cwd (e.g. repo/repo).
		expect(path.isAbsolute(parsed.cwd ?? "")).toBe(true);
		expect(parsed.cwd).toBe(getProjectDir());
		expect(getProjectDir()).toBe(childDir);
		// Re-resolving the normalized value against the (now changed) process cwd
		// is idempotent — no doubled "repo/repo" segment.
		expect(path.resolve(parsed.cwd ?? "")).toBe(getProjectDir());
		expect(parsed.cwd?.endsWith(`${childName}${path.sep}${childName}`)).toBe(false);
	});

	it("reports a clean error when the cwd change is denied", async () => {
		const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cwd-denied-launch-"));
		setProjectDir(launchDir);
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
		expect(getProjectDir()).toBe(launchDir);
	});

	it("appends the macOS permission hint only for permission errors", async () => {
		const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cwd-hint-launch-"));
		setProjectDir(launchDir);
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
});
