import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgStartupScratchDir } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import {
	BUILTIN_SLASH_COMMANDS,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import * as piUtils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("/scratch slash command", () => {
	let tempDir: TempDir;
	let cwd: string;
	let agentDir: string;
	let settings: Settings;
	let output: string[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-scratch-command-");
		cwd = tempDir.join("project");
		agentDir = tempDir.join("agent");
		await fs.mkdir(cwd);
		await fs.mkdir(agentDir);
		settings = await Settings.loadIsolated({ cwd, agentDir });
		output = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		settings?.cancelPendingSaves();
		AgentStorage.close();
		await tempDir?.remove();
	});

	const run = (text: string) =>
		Reflect.apply(executeAcpBuiltinSlashCommand, undefined, [
			text,
			{ settings, cwd, output: (message: string) => output.push(message) },
		]);
	const readConfig = async () => YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text());

	it("resolves a quoted relative directory and persists it before returning", async () => {
		const target = path.join(cwd, "My Scratch");
		await fs.mkdir(target);

		expect(await run('/scratch   "./My Scratch"   ')).toEqual({ consumed: true });

		expect(cfgStartupScratchDir.get(settings)).toBe(target);
		expect(await readConfig()).toHaveProperty("startup.scratchDir", target);
		expect(output).toEqual([`Scratch directory set to ${target}; omp will start there when launched from ~.`]);
		expect(await Bun.file(path.join(cwd, ".omp", "config.yml")).exists()).toBe(false);
	});

	it("saves the session cwd when no argument is supplied", async () => {
		await run("/scratch   ");

		expect(cfgStartupScratchDir.get(settings)).toBe(cwd);
		expect(await readConfig()).toHaveProperty("startup.scratchDir", cwd);
	});

	it("rejects a missing directory without changing the saved setting", async () => {
		await run("/scratch");
		output.length = 0;
		const missing = path.join(cwd, "missing");

		expect(await run("/scratch missing")).toEqual({ consumed: true });

		expect(output).toEqual([`Directory does not exist: ${missing}`]);
		expect(cfgStartupScratchDir.get(settings)).toBe(cwd);
		expect(await readConfig()).toHaveProperty("startup.scratchDir", cwd);
		expect(await Bun.file(missing).exists()).toBe(false);
	});

	it("rejects a file without configuring a scratch directory", async () => {
		const file = path.join(cwd, "file.txt");
		await Bun.write(file, "not a directory");

		await run("/scratch file.txt");

		expect(output).toEqual([`Not a directory: ${file}`]);
		expect(cfgStartupScratchDir.get(settings)).toBeUndefined();
	});

	it("clears the setting and persists the removal before returning", async () => {
		await run("/scratch");
		output.length = 0;

		await run("/scratch off");

		expect(cfgStartupScratchDir.get(settings)).toBeUndefined();
		expect(await readConfig()).not.toHaveProperty("startup.scratchDir");
		expect(output).toEqual(["Scratch directory cleared; launches from ~ use the default temp directory."]);
	});

	it("reports configured and unset status without changing the setting", async () => {
		await run("/scratch status");
		expect(output).toEqual(["Scratch directory not set; launches from ~ use the default temp directory."]);
		expect(cfgStartupScratchDir.get(settings)).toBeUndefined();

		await run("/scratch");
		output.length = 0;
		await run("/scratch status");

		expect(output).toEqual([`Scratch directory: ${cwd}`]);
		expect(cfgStartupScratchDir.get(settings)).toBe(cwd);
		expect(await readConfig()).toHaveProperty("startup.scratchDir", cwd);
	});

	it("uses the TUI session cwd and displays validation failures as errors", async () => {
		const sessionCwd = tempDir.join("session-project");
		await fs.mkdir(sessionCwd);
		const addToHistory = vi.fn();
		const setText = vi.fn();
		const showStatus = vi.fn();
		const showError = vi.fn();
		const ctx = {
			settings,
			sessionManager: { getCwd: () => sessionCwd },
			editor: { addToHistory, setText },
			showStatus,
			showError,
		} as unknown as InteractiveModeContext;

		expect(await executeBuiltinSlashCommand("/scratch", { ctx })).toBe(true);
		expect(cfgStartupScratchDir.get(settings)).toBe(sessionCwd);
		expect(await readConfig()).toHaveProperty("startup.scratchDir", sessionCwd);
		expect(showStatus).toHaveBeenCalledWith(
			`Scratch directory set to ${sessionCwd}; omp will start there when launched from ~.`,
		);
		expect(showError).not.toHaveBeenCalled();

		await executeBuiltinSlashCommand("/scratch missing", { ctx });

		expect(showError).toHaveBeenCalledWith(`Directory does not exist: ${path.join(sessionCwd, "missing")}`);
		expect(cfgStartupScratchDir.get(settings)).toBe(sessionCwd);
		expect(addToHistory.mock.calls).toEqual([["/scratch"], ["/scratch missing"]]);
		expect(setText.mock.calls).toEqual([[""], [""]]);
	});

	it("offers directory completions and the scratch inline hint in the TUI", async () => {
		await fs.mkdir(path.join(cwd, "scratch-area"));
		await Bun.write(path.join(cwd, "scratch-file.txt"), "");
		vi.spyOn(piUtils, "getProjectDir").mockReturnValue(cwd);
		const scratch = BUILTIN_SLASH_COMMANDS.find(command => command.name === "scratch");

		expect(scratch?.getArgumentCompletions).toBeDefined();
		const completions = await scratch!.getArgumentCompletions!("scratch-");

		expect(completions?.map(item => item.value)).toEqual(["scratch-area/"]);
		expect(scratch!.getInlineHint!("")).toBe("[<path>|off|status]");
	});
});
