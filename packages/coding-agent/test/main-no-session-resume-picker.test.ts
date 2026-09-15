/**
 * Regression for #12008 review: `omp --no-session --resume` (bare, native) must
 * fail with `--resume requires session persistence` instead of falling through
 * to the startup session picker. The picker branch runs before the deferred
 * (extension-flag-aware) persistence validation, so it has to be skipped under
 * `--no-session`.
 */
import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "ProcessExitSignal";
	}
}

describe("runRootCommand — --no-session --resume", () => {
	it("rejects a bare native --resume without invoking the picker", async () => {
		using tempDir = TempDir.createSync("@omp-no-session-resume-");
		const sessionDir = tempDir.path();
		// A valid session exists, so a picker fall-through would open the picker
		// (not the "No sessions found" probe) — proving the guard, not empty state.
		await Bun.write(
			path.join(sessionDir, "existing.jsonl"),
			`${JSON.stringify({ type: "session", id: "existing-session", cwd: sessionDir, timestamp: new Date().toISOString() })}\n`,
		);

		const authStorage = await AuthStorage.create(path.join(sessionDir, "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });

		const rawArgs = ["--no-session", "--resume", "--print"];
		const parsed = parseArgs(rawArgs);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = sessionDir;

		const exitCodes: number[] = [];
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
			throw new ProcessExitSignal(code ?? 0);
		}) as typeof process.exit);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		let stderr = "";
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array): boolean => {
			stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stderr.write);

		let pickerCalled = false;
		let thrown: unknown;
		try {
			await runRootCommand(parsed, rawArgs, {
				discoverAuthStorage: async () => authStorage,
				settings,
				selectSession: async () => {
					pickerCalled = true;
					return null;
				},
			});
		} catch (err) {
			thrown = err;
		} finally {
			vi.restoreAllMocks();
			authStorage.close();
		}

		expect(pickerCalled).toBe(false);
		expect(thrown).toBeInstanceOf(ProcessExitSignal);
		expect(exitCodes).toEqual([1]);
		expect(stderr).toContain("--resume requires session persistence");
	}, 15_000);
});
