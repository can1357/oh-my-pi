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

describe("startup.scratchDir", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	async function prepareHomeLaunch() {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-startup-scratch-"));
		tempDirs.push(root);
		const agentDir = path.join(root, "agent");
		const home = path.join(root, "home");
		const scratchDir = path.join(root, "scratch");
		const fallback = path.join(root, "temp");
		for (const dir of [agentDir, home, scratchDir, fallback]) {
			await fs.promises.mkdir(dir);
		}
		if (!platformDescriptor) throw new Error("process.platform descriptor is unavailable");
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
		vi.spyOn(utils, "getAgentDir").mockReturnValue(agentDir);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		vi.spyOn(os, "tmpdir").mockReturnValue(fallback);
		vi.spyOn(utils, "getProjectDir").mockReturnValue(home);
		const setProjectDir = vi.spyOn(utils, "setProjectDir").mockImplementation(() => {});
		return { agentDir, home, scratchDir, fallback, setProjectDir };
	}

	it("uses an existing scratch directory instead of the home-launch fallback", async () => {
		const { agentDir, scratchDir, setProjectDir } = await prepareHomeLaunch();
		await Bun.write(path.join(agentDir, "config.yml"), `startup:\n  scratchDir: ${JSON.stringify(scratchDir)}\n`);

		const warning = await applyStartupCwd(parseArgs([]));

		expect(warning).toBeUndefined();
		expect(setProjectDir).toHaveBeenCalledTimes(1);
		expect(setProjectDir).toHaveBeenCalledWith(scratchDir);
	});

	it("warns and uses the default fallback when the scratch directory is missing", async () => {
		const { agentDir, home, fallback, setProjectDir } = await prepareHomeLaunch();
		const missingDir = path.join(home, "missing");
		await Bun.write(path.join(agentDir, "config.yml"), `startup:\n  scratchDir: ${JSON.stringify(missingDir)}\n`);

		const warning = await applyStartupCwd(parseArgs([]));

		expect(warning).toBe(
			`Scratch directory ${missingDir} (startup.scratchDir) is not an existing directory; using the default fallback.`,
		);
		expect(setProjectDir).toHaveBeenCalledTimes(1);
		expect(setProjectDir).toHaveBeenCalledWith(fallback);
	});

	it("lets --allow-home override an existing scratch directory", async () => {
		const { agentDir, scratchDir, setProjectDir } = await prepareHomeLaunch();
		await Bun.write(path.join(agentDir, "config.yml"), `startup:\n  scratchDir: ${JSON.stringify(scratchDir)}\n`);

		expect(await applyStartupCwd(parseArgs(["--allow-home"]))).toBeUndefined();
		expect(setProjectDir).not.toHaveBeenCalled();
	});

	it("ignores the scratch directory when launched outside home", async () => {
		const { agentDir, home, scratchDir, setProjectDir } = await prepareHomeLaunch();
		await Bun.write(path.join(agentDir, "config.yml"), `startup:\n  scratchDir: ${JSON.stringify(scratchDir)}\n`);
		vi.spyOn(utils, "getProjectDir").mockReturnValue(path.join(home, "project"));

		expect(await applyStartupCwd(parseArgs([]))).toBeUndefined();
		expect(setProjectDir).not.toHaveBeenCalled();
	});

	it("expands a scratch directory relative to the launcher's home", async () => {
		const { agentDir, home, setProjectDir } = await prepareHomeLaunch();
		const scratchDir = path.join(home, "x");
		await fs.promises.mkdir(scratchDir);
		await Bun.write(path.join(agentDir, "config.yml"), "startup:\n  scratchDir: ~/x\n");

		expect(await applyStartupCwd(parseArgs([]))).toBeUndefined();
		expect(setProjectDir).toHaveBeenCalledTimes(1);
		expect(setProjectDir).toHaveBeenCalledWith(scratchDir);
	});

	it("lets --cwd override both --allow-home and the scratch directory", async () => {
		const { agentDir, home, scratchDir, setProjectDir } = await prepareHomeLaunch();
		await Bun.write(path.join(agentDir, "config.yml"), `startup:\n  scratchDir: ${JSON.stringify(scratchDir)}\n`);
		const targetDir = path.join(home, "project");

		expect(await applyStartupCwd(parseArgs(["--cwd", targetDir, "--allow-home"]))).toBeUndefined();
		expect(setProjectDir).toHaveBeenCalledTimes(1);
		expect(setProjectDir).toHaveBeenCalledWith(targetDir);
	});

	it("uses the default fallback without a global config file", async () => {
		const { fallback, setProjectDir } = await prepareHomeLaunch();

		expect(await applyStartupCwd(parseArgs([]))).toBeUndefined();
		expect(setProjectDir).toHaveBeenCalledTimes(1);
		expect(setProjectDir).toHaveBeenCalledWith(fallback);
	});

	it("reads config.yaml and resolves a hand-written relative directory against home", async () => {
		const { agentDir, home, setProjectDir } = await prepareHomeLaunch();
		const scratchDir = path.join(home, "relative");
		await fs.promises.mkdir(scratchDir);
		await Bun.write(path.join(agentDir, "config.yaml"), "startup:\n  scratchDir: relative\n");

		expect(await applyStartupCwd(parseArgs([]))).toBeUndefined();
		expect(setProjectDir).toHaveBeenCalledTimes(1);
		expect(setProjectDir).toHaveBeenCalledWith(scratchDir);
	});

	it.each([
		["malformed YAML", "startup: [\n"],
		["a non-mapping config", "- startup\n"],
		["a non-mapping startup section", "startup: scratch\n"],
		["an empty value", 'startup:\n  scratchDir: ""\n'],
		["a whitespace-only value", 'startup:\n  scratchDir: "   "\n'],
		["a non-string value", "startup:\n  scratchDir: 42\n"],
	])("treats %s in the first config as unset instead of reading config.yaml", async (_name, content) => {
		const { agentDir, scratchDir, fallback, setProjectDir } = await prepareHomeLaunch();
		await Bun.write(path.join(agentDir, "config.yml"), content);
		await Bun.write(path.join(agentDir, "config.yaml"), `startup:\n  scratchDir: ${JSON.stringify(scratchDir)}\n`);

		expect(await applyStartupCwd(parseArgs([]))).toBeUndefined();
		expect(setProjectDir).toHaveBeenCalledTimes(1);
		expect(setProjectDir).toHaveBeenCalledWith(fallback);
	});

	it("warns and falls back when the configured scratch path is a file", async () => {
		const { agentDir, home, fallback, setProjectDir } = await prepareHomeLaunch();
		const scratchFile = path.join(home, "file");
		await Bun.write(scratchFile, "");
		await Bun.write(path.join(agentDir, "config.yml"), `startup:\n  scratchDir: ${JSON.stringify(scratchFile)}\n`);

		expect(await applyStartupCwd(parseArgs([]))).toBe(
			`Scratch directory ${scratchFile} (startup.scratchDir) is not an existing directory; using the default fallback.`,
		);
		expect(setProjectDir).toHaveBeenCalledTimes(1);
		expect(setProjectDir).toHaveBeenCalledWith(fallback);
	});

	it("warns and tries the existing home/tmp candidate when entering scratch fails", async () => {
		const { agentDir, home, scratchDir, setProjectDir } = await prepareHomeLaunch();
		const homeTmp = path.join(home, "tmp");
		await fs.promises.mkdir(homeTmp);
		await Bun.write(path.join(agentDir, "config.yml"), `startup:\n  scratchDir: ${JSON.stringify(scratchDir)}\n`);
		setProjectDir.mockImplementationOnce(() => {
			throw new Error("permission denied");
		});

		expect(await applyStartupCwd(parseArgs([]))).toBe(
			`Scratch directory ${scratchDir} (startup.scratchDir) is not an existing directory; using the default fallback.`,
		);
		expect(setProjectDir).toHaveBeenCalledTimes(2);
		expect(setProjectDir).toHaveBeenNthCalledWith(1, scratchDir);
		expect(setProjectDir).toHaveBeenNthCalledWith(2, homeTmp);
	});

	it("allows a bare tilde scratch directory to keep home launches in home", async () => {
		const { agentDir, home, setProjectDir } = await prepareHomeLaunch();
		await Bun.write(path.join(agentDir, "config.yml"), 'startup:\n  scratchDir: "~"\n');

		expect(await applyStartupCwd(parseArgs([]))).toBeUndefined();
		expect(setProjectDir).toHaveBeenCalledTimes(1);
		expect(setProjectDir).toHaveBeenCalledWith(home);
	});
});
