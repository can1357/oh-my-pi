/**
 * Regression for #13928: `--resume <path>` must fail closed when the file does
 * not exist. The path branch handed the argument straight to
 * `SessionManager.open` without `throwIfMissing`, so a typo'd path minted a
 * brand new session at that path and the CLI exited 0 with a "resumed" session
 * that inherited nothing. The id branch two lines below already threw, and
 * `--fork <path>` already throws, so path-shaped flags were the odd one out.
 *
 * Asserted at the CLI boundary: exit status, the stderr line naming the path,
 * and that no session file is materialized for a missing path.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "ProcessExitSignal";
	}
}

async function makeSessionFile(cwd: string, id: string): Promise<string> {
	const file = path.join(cwd, `${id}.jsonl`);
	await Bun.write(
		file,
		[
			JSON.stringify({
				type: "session",
				id,
				cwd,
				timestamp: new Date().toISOString(),
			}),
			JSON.stringify({
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "assistant", content: "prior work" },
			}),
			"",
		].join("\n"),
	);
	return file;
}

describe("--resume <path> — missing path (#13928)", () => {
	it("exits non-zero naming the path and does not create a session there", async () => {
		using tempDir = TempDir.createSync("@omp-resume-missing-path-");
		const sessionDir = tempDir.path();
		const missingPath = path.join(sessionDir, "ghost-zz9q.jsonl");
		const authStorage = await AuthStorage.create(path.join(sessionDir, "auth.db"));

		const rawArgs = ["--resume", missingPath, "--print"];
		const parsed = parseArgs(rawArgs);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = sessionDir;

		let stderr = "";
		const exitCodes: number[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array): boolean => {
			stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stderr.write);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
			throw new ProcessExitSignal(code ?? 0);
		}) as typeof process.exit);

		let thrown: unknown;
		try {
			await runRootCommand(parsed, rawArgs, {
				discoverAuthStorage: async () => authStorage,
				settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
			});
		} catch (err) {
			thrown = err;
		} finally {
			vi.restoreAllMocks();
			authStorage.close();
		}

		expect(thrown).toBeInstanceOf(ProcessExitSignal);
		expect(exitCodes).toEqual([1]);
		expect(stderr).toContain(missingPath);
		expect(stderr).toContain("not found");
		// The defect's real damage: a session file materializing at a path the
		// user believed was being read.
		await expect(fsp.stat(missingPath)).rejects.toThrow();
	}, 20_000);
});

describe("--resume <path> — existing path (#13928)", () => {
	it("still resumes the session file at that path", async () => {
		using tempDir = TempDir.createSync("@omp-resume-existing-path-");
		const sessionDir = tempDir.path();
		const existingPath = await makeSessionFile(sessionDir, "019ea530-0000-7000-0000-000000000000");

		const manager = await createSessionManager(
			{
				resume: existingPath,
				sessionDir,
				messages: [],
				fileArgs: [],
				unknownFlags: new Map(),
				unrecognizedFlags: [],
				invalidFlagValues: [],
			},
			sessionDir,
			Settings.isolated({ "marketplace.autoUpdate": "off" }),
		);

		if (!manager) throw new Error("Expected a resumed session manager");
		try {
			expect(manager.getSessionFile()).toBe(path.resolve(existingPath));
			// The prior turn came back, so this resumed rather than minted a new session.
			expect(manager.getEntries().map(entry => entry.type)).toEqual(["message"]);
		} finally {
			await manager.close();
		}
	});
});
