/**
 * Regression: `autoResume` is an interactive startup convenience, so a run that
 * does not own a terminal must not adopt the prior conversation.
 *
 * The failure this guards: `SessionManager.continueRecent` falls back to the
 * most recently modified session file when the terminal breadcrumb names no
 * session for this cwd, so a headless `omp -p` issued while a conversation was
 * still live in another process resumed *that* conversation. Two processes then
 * wrote one transcript, and the resume replayed the pending tool calls it
 * carried in. Explicit `--continue`/`--resume` stay valid in every mode.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

describe("createSessionManager — autoResume is interactive-only", () => {
	let tempHome: string;
	let cwd: string;
	let originalAgentDir: string;
	let priorSessionFile: string;

	const autoResumeSettings = (): Settings => Settings.isolated({ autoResume: true });

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auto-resume-home-"));
		// The session directory, the terminal breadcrumb store and every other
		// agent-root path resolve under this home, so the fixture cannot see (or
		// be seen by) a real installation.
		spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		cwd = path.join(tempHome, "project");
		await fs.mkdir(cwd, { recursive: true });

		const prior = SessionManager.create(cwd);
		prior.appendMessage({ role: "user", content: "the live conversation", timestamp: Date.now() });
		await prior.rewriteEntries();
		priorSessionFile = prior.getSessionFile() ?? "";
		expect(priorSessionFile).not.toBe("");
	});

	afterEach(async () => {
		spyOn(os, "homedir").mockRestore();
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	it("resumes the prior session for an interactive run", async () => {
		const parsed = parseArgs([]);
		const manager = await createSessionManager(parsed, cwd, autoResumeSettings());
		expect(manager?.getSessionFile()).toBe(priorSessionFile);
		// buildSessionOptions reads this to restore the session's model/thinking.
		expect(parsed.continue).toBe(true);
	});

	it("starts a new session for a --print run instead of adopting the prior one", async () => {
		const parsed = parseArgs(["-p", "summarize the repository"]);
		const manager = await createSessionManager(parsed, cwd, autoResumeSettings());
		expect(manager).toBeUndefined();
		expect(parsed.continue).toBeUndefined();
	});

	it("starts a new session when the prompt arrived on piped stdin", async () => {
		const parsed = parseArgs(["explain this diff"]);
		const manager = await createSessionManager(parsed, cwd, autoResumeSettings(), undefined, {
			interactive: false,
		});
		expect(manager).toBeUndefined();
		expect(parsed.continue).toBeUndefined();
	});

	it("still honors an explicit --continue in a --print run", async () => {
		const parsed = parseArgs(["-p", "--continue", "keep going"]);
		const manager = await createSessionManager(parsed, cwd, autoResumeSettings());
		expect(manager?.getSessionFile()).toBe(priorSessionFile);
	});

	it("still honors an explicit --resume in a --print run", async () => {
		const parsed = parseArgs(["-p", "--resume", priorSessionFile, "keep going"]);
		const manager = await createSessionManager(parsed, cwd, autoResumeSettings());
		expect(manager?.getSessionFile()).toBe(priorSessionFile);
	});
});
