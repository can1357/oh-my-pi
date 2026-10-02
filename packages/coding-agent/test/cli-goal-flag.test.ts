import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, validateGoalLaunch, validateGoalStartup } from "@oh-my-pi/pi-coding-agent/cli/args";
import { CliUsageError } from "@oh-my-pi/pi-coding-agent/cli/usage-error";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setInteractiveHost, TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");

async function launch(args: string[], cwd?: string): Promise<{ exitCode: number; stderr: string }> {
	using dir = TempDir.createSync("@omp-goal-flag-");
	const sessionArgs = cwd === undefined ? ["--no-session"] : [];
	const proc = Bun.spawn([process.execPath, cliEntry, ...sessionArgs, ...args], {
		cwd: cwd ?? dir.path(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	return { exitCode, stderr };
}

/** Write a minimal persisted session a launch can fork or resume. */
function writeSourceSession(dir: string): string {
	const file = path.join(dir, "src.jsonl");
	const header = { type: "session", version: 3, id: "goal-src", cwd: dir, timestamp: new Date().toISOString() };
	fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
	return file;
}

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
	}
}

/**
 * Run the root command as an interactive terminal launch, observing the
 * session-resolution side channels: the session picker, the foreign-transcript
 * store, and session construction.
 */
async function launchInteractive(rawArgs: string[]): Promise<{ thrown: unknown; touched: string[] }> {
	using authDir = TempDir.createSync("@omp-goal-auth-");
	const authStorage = await AuthStorage.create(path.join(authDir.path(), "auth.db"));
	const touched: string[] = [];
	const parsed = parseArgs(rawArgs);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noLsp = true;
	const previousHost = setInteractiveHost(false);
	const originalIsTTY = process.stdin.isTTY;
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ProcessExitSignal(code ?? 0);
	}) as typeof process.exit);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		await runRootCommand(parsed, rawArgs, {
			settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
			discoverAuthStorage: async () => authStorage,
			selectSession: async () => {
				touched.push("picker");
				return null;
			},
			createForeignSessionStore: () => {
				touched.push("import");
				throw new Error("foreign store opened");
			},
			createAgentSession: async () => {
				touched.push("session");
				throw new Error("session constructed");
			},
		});
		return { thrown: undefined, touched };
	} catch (error) {
		return { thrown: error, touched };
	} finally {
		vi.restoreAllMocks();
		Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		setInteractiveHost(previousHost);
		authStorage.close();
	}
}

describe("--goal launch option", () => {
	it("parses a quoted objective as one value, not a positional prompt", () => {
		const args = parseArgs(["--goal=Inspect the importer"]);
		expect(args.goal).toBe("Inspect the importer");
		expect(args.messages).toEqual([]);
	});

	it("accepts a leading hyphen with equals syntax and preserves internal newlines", () => {
		expect(parseArgs(["--goal=-inspect"]).goal).toBe("-inspect");
		expect(parseArgs(["--goal", "Inspect\nthen fix"]).goal).toBe("Inspect\nthen fix");
	});

	it("rejects a flag-looking objective without letting that flag act", () => {
		const args = parseArgs(["--goal", "-p", "hello"]);
		expect(args.invalidFlagValues).toContain("--goal requires an objective.");
		// Like every string flag, `--goal` takes the next token as its value (here rejected):
		// `-p` never switches to print mode behind the error.
		expect(args.print).toBeFalsy();
	});

	it("rejects print mode with a usage exit before a model request", async () => {
		const result = await launch(["-p", "--goal", "Inspect the importer"]);
		expect(result.exitCode, result.stderr).toBe(2);
		expect(result.stderr).toContain("--goal requires an interactive terminal");
	}, 30_000);

	it("rejects a non-interactive fork before writing the forked session", async () => {
		using dir = TempDir.createSync("@omp-goal-fork-print-");
		const source = writeSourceSession(dir.path());
		const result = await launch(
			["--no-extensions", "--session-dir", dir.path(), "--fork", source, "-p", "--goal", "do thing"],
			dir.path(),
		);
		expect(result.exitCode, result.stderr).toBe(2);
		expect(result.stderr).toContain("--goal requires an interactive terminal");
		expect(fs.readdirSync(dir.path())).toEqual(["src.jsonl"]);
	}, 30_000);

	it("rejects resume, fork, and import shapes before session resolution acts on them", async () => {
		using dir = TempDir.createSync("@omp-goal-fork-tty-");
		const source = writeSourceSession(dir.path());
		for (const shape of [
			["--fork", source],
			["--resume"],
			["--resume", source],
			["--continue"],
			["--from-claude"],
			["--from-codex"],
		]) {
			const rawArgs = ["--session-dir", dir.path(), ...shape, "--goal", "do thing"];
			const { thrown, touched } = await launchInteractive(rawArgs);
			expect(thrown, shape.join(" ")).toBeInstanceOf(CliUsageError);
			expect((thrown as Error).message).toContain("--goal requires a fresh session");
			expect(touched, shape.join(" ")).toEqual([]);
			expect(fs.readdirSync(dir.path()), shape.join(" ")).toEqual(["src.jsonl"]);
		}
	}, 30_000);

	it("rejects positional input instead of sending a second prompt after activation", () => {
		expect(() => validateGoalStartup(parseArgs(["--goal", "Inspect the importer", "hello"]), true)).toThrow(
			"--goal cannot be combined with a positional message",
		);
	});

	it("rejects plan startup, resumed sessions, and disabled goal mode", () => {
		expect(() => validateGoalStartup(parseArgs(["--goal", "x", "--plan-yolo"]), true)).toThrow("--plan-yolo");
		expect(() => validateGoalLaunch(parseArgs(["--goal", "x", "--continue"]), true)).toThrow(
			"requires a fresh session",
		);
		expect(() => validateGoalLaunch(parseArgs(["--goal", "x"]), false)).toThrow("requires an interactive terminal");
		expect(() => validateGoalStartup(parseArgs(["--goal", "x"]), false)).toThrow("goal.enabled");
		expect(() => validateGoalStartup(parseArgs(["--goal", "x"]), true, undefined, true)).toThrow(
			"plan.defaultOnStartup",
		);
	});

	it("starts a fresh goal instead of implicitly resuming a previous transcript", async () => {
		using dir = TempDir.createSync("@omp-goal-resume-");
		const previous = SessionManager.inMemory();
		previous.appendMessage({ role: "user", content: "Earlier conversation", timestamp: Date.now() });
		const resume = vi.spyOn(SessionManager, "continueRecent").mockResolvedValue(previous);
		const settings = Settings.isolated({ autoResume: true });
		try {
			const ordinaryArgs = parseArgs([]);
			const ordinary = await createSessionManager(ordinaryArgs, dir.path(), settings);
			expect(ordinary?.getEntries()).toHaveLength(1);
			expect(ordinaryArgs.continue).toBe(true);

			const goalArgs = parseArgs(["--goal", "New objective"]);
			const fresh = await createSessionManager(goalArgs, dir.path(), settings);
			expect(fresh).toBeUndefined();
			expect(goalArgs.continue).toBeUndefined();
			expect(resume).toHaveBeenCalledTimes(1);
		} finally {
			resume.mockRestore();
			await previous.close();
		}
	});
});
