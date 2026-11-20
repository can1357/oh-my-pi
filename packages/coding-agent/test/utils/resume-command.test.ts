import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resumeCommand } from "@oh-my-pi/pi-coding-agent/utils/resume-command";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import {
	__resetDirsFromEnvForTests,
	APP_NAME,
	getActiveProfile,
	getSessionsDir,
	setAgentDir,
	setProfile,
} from "@oh-my-pi/pi-utils/dirs";

describe("resumeCommand", () => {
	const originalProfile = getActiveProfile();

	afterEach(() => {
		setProfile(originalProfile);
	});

	it("omits the profile flag in the default profile", () => {
		setProfile(undefined);
		expect(resumeCommand("abc123")).toBe(`${APP_NAME} --resume abc123`);
	});

	it("carries the active profile so the emitted hint is runnable verbatim", () => {
		// Profile sessions live in ~/.omp/profiles/<name>/agent, so a resume hint
		// without --profile fails with "Session not found" (issue #9018).
		setProfile("personal");
		expect(resumeCommand("abc123")).toBe(`${APP_NAME} --profile personal --resume abc123`);
	});
});

describe("resumeCommand for a session file", () => {
	const SESSION_ID = "0198abcd-ef01-2345-6789-abcdef012345";
	// setAgentDir rewrites process env and the dirs snapshot; restore both so the
	// next test file starts from the environment it found.
	const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
	const originalEnv: Record<string, string | undefined> = {};
	let tempDir: string;

	beforeEach(() => {
		for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-resume-hint-"));
		setAgentDir(path.join(tempDir, "omp-agent"));
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		removeSyncWithRetries(tempDir);
	});

	it("keeps the compact --resume <id> form for a session inside the managed sessions root", () => {
		const managed = path.join(
			getSessionsDir(),
			"--home-user-project--",
			`2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`,
		);
		expect(resumeCommand(SESSION_ID, managed)).toBe(`${APP_NAME} --resume ${SESSION_ID}`);
	});

	it("prints the shell-quoted file path for a path-resumed session that id-resolution cannot find", async () => {
		// A pi transcript opened by path stays in its foreign directory, outside the
		// managed sessions root, so `--resume <id>` never matches it (#9544).
		const foreignDir = path.join(tempDir, "pi sessions", "--home-user-project--");
		fs.mkdirSync(foreignDir, { recursive: true });
		const file = path.join(foreignDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
		fs.writeFileSync(
			file,
			`${JSON.stringify({ type: "session", id: SESSION_ID, timestamp: "2026-01-01T00:00:00Z", cwd: "/home/user/project" })}\n`,
		);
		const session = await SessionManager.open(file);
		expect(await resolveResumableSession(session.getSessionId(), "/home/user/project")).toBeUndefined();
		expect(resumeCommand(session.getSessionId(), file)).toBe(`${APP_NAME} --resume '${file}'`);
	});
});
