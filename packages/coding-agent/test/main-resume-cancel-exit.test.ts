/**
 * Regression: cancelling the startup `--resume` session picker (e.g. pressing
 * Esc) must terminate the process cleanly. Startup arms long-lived handles
 * (theme/appearance listeners via initTheme, settings save timer, model
 * registry), so the previous bare `return` left the event loop with live
 * handles and the process hung after the picker left the alternate screen.
 *
 * The fix exits via `process.exit(0)` — matching the `--version`/`--export`
 * early-exit convention in the same function. Only this startup call site
 * exits; the in-session `/resume` picker (selector-controller.ts) keeps its own
 * onCancel that just closes the overlay.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { TempDir } from "@oh-my-pi/pi-utils";

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "ProcessExitSignal";
	}
}
type StartupRecoveryDependencies = NonNullable<Parameters<typeof runRootCommand>[2]> & {
	selectDirectory?: (cwd: string) => Promise<string | undefined>;
};

// `runRootCommand` registers the CLI's extension roots (`--no-extensions` → explicit-only) process-wide.
afterEach(() => {
	clearOmpExtensionCliRoots();
});

describe("runRootCommand — startup --resume picker cancellation", () => {
	it("exits cleanly (process.exit 0) when the picker is cancelled instead of returning and hanging", async () => {
		using tempDir = TempDir.createSync("@omp-resume-cancel-");
		const sessionDir = tempDir.path();
		// One answered session so folderSessions is non-empty and the picker (not the
		// "No sessions found" probe) is the path under test.
		await Bun.write(
			path.join(sessionDir, "existing.jsonl"),
			[
				JSON.stringify({
					type: "session",
					id: "existing-session",
					cwd: sessionDir,
					timestamp: new Date().toISOString(),
				}),
				JSON.stringify({
					type: "message",
					id: "e1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "assistant", content: "prior work" },
				}),
			].join("\n"),
		);

		const authStorage = await AuthStorage.create(path.join(sessionDir, "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });

		// --print keeps initTheme non-interactive so no global appearance/SIGWINCH
		// listeners leak into the rest of the suite; the picker branch is gated on
		// `resume === true`, not on interactivity, so it still runs.
		const parsed = parseArgs(["--resume", "--print"]);
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

		let pickerCalled = false;
		let thrown: unknown;
		try {
			await runRootCommand(parsed, ["--resume", "--print"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				selectSession: async () => {
					pickerCalled = true;
					return null; // user cancelled (Esc)
				},
			});
		} catch (err) {
			thrown = err;
		} finally {
			vi.restoreAllMocks();
			authStorage.close();
		}

		expect(pickerCalled).toBe(true);
		expect(thrown).toBeInstanceOf(ProcessExitSignal);
		// Exactly one clean exit — proves the cancel branch terminates instead of
		// falling through to session creation or returning into a hang.
		expect(exitCodes).toEqual([0]);
	}, 15_000);
	it("exits cleanly when fallback directory selection is cancelled without creating a session", async () => {
		using tempDir = TempDir.createSync("@omp-resume-recovery-cancel-");
		const sessionDir = tempDir.path();
		const missingCwd = path.join(sessionDir, "deleted-worktree");
		const sessionPath = path.join(sessionDir, "existing.jsonl");
		const selected: SessionInfo = {
			path: sessionPath,
			id: "existing-session",
			cwd: missingCwd,
			title: "existing",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 1,
			size: 0,
			firstMessage: "prior work",
			allMessagesText: "prior work",
		};
		await Bun.write(
			sessionPath,
			[
				JSON.stringify({
					type: "session",
					id: selected.id,
					cwd: selected.cwd,
					timestamp: new Date(0).toISOString(),
				}),
				JSON.stringify({
					type: "message",
					id: "e1",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					message: { role: "assistant", content: "prior work" },
				}),
				"",
			].join("\n"),
		);

		const authStorage = await AuthStorage.create(path.join(sessionDir, "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const parsed = parseArgs(["--resume"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = sessionDir;
		const exitCodes: number[] = [];
		const originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
			throw new ProcessExitSignal(code ?? 0);
		}) as typeof process.exit);
		let directoryPickerCalled = false;
		let createAgentSessionCalled = false;
		let thrown: unknown;
		try {
			await runRootCommand(parsed, ["--resume"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				selectSession: async () => selected,
				selectDirectory: async () => {
					directoryPickerCalled = true;
					return undefined;
				},
				createAgentSession: async () => {
					createAgentSessionCalled = true;
					throw new Error("startup must exit before creating a replacement session");
				},
			} as StartupRecoveryDependencies);
		} catch (error) {
			thrown = error;
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
			vi.restoreAllMocks();
			authStorage.close();
		}

		expect(directoryPickerCalled).toBe(true);
		expect(thrown).toBeInstanceOf(ProcessExitSignal);
		expect(exitCodes).toEqual([0]);
		expect(createAgentSessionCalled).toBe(false);
		await expect(fsp.stat(sessionPath)).resolves.toBeTruthy();
	});
});
