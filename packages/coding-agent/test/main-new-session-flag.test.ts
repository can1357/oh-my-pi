import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager, SessionResolutionError } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "./session-manager/helpers";

function buildArgs(overrides: Partial<Args> = {}): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		...overrides,
	};
}

const autoResumeSettings = {
	get: (key: string) => (key === "autoResume" ? true : undefined),
} as unknown as Settings;

describe("createSessionManager — --new versus the autoResume setting", () => {
	let agentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalTmuxPane = process.env.TMUX_PANE;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		process.env.TMUX_PANE = "%new-session-flag-test";
		agentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-new-flag-"));
		setAgentDir(agentDir);
		cwd = path.join(agentDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(async () => {
		if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalTmuxPane;
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(agentDir, { recursive: true, force: true });
	});

	async function seedPriorSession(): Promise<string> {
		const prior = SessionManager.create(cwd);
		prior.appendMessage({ role: "user", content: "prior turn", timestamp: 1 });
		prior.appendMessage(makeAssistantMessage());
		await prior.flush();
		const file = prior.getSessionFile();
		if (!file) throw new Error("Expected the seeded session to persist");
		await prior.close();
		return file;
	}

	it("resumes the most recent session and marks the launch as a continuation", async () => {
		const priorFile = await seedPriorSession();
		const parsed = buildArgs();

		const manager = await createSessionManager(parsed, cwd, autoResumeSettings);
		if (!manager) throw new Error("Expected autoResume to return a session manager");
		try {
			expect(manager.getSessionFile()).toBe(priorFile);
			expect(parsed.continue).toBe(true);
		} finally {
			await manager.close();
		}
	});

	it("leaves session creation to the caller when --new is given", async () => {
		await seedPriorSession();
		const parsed = buildArgs({ newSession: true });

		expect(await createSessionManager(parsed, cwd, autoResumeSettings)).toBeUndefined();
		expect(parsed.continue).toBeUndefined();
	});

	it("rejects --new combined with another session source", async () => {
		for (const overrides of [
			{ continue: true },
			{ resume: "019ea530-0000-7000-0000-000000000000" },
			{ resume: true as const },
			{ fork: "019ea530-0000-7000-0000-000000000000" },
		]) {
			const caught = await createSessionManager(
				buildArgs({ newSession: true, ...overrides }),
				cwd,
				autoResumeSettings,
			).catch((error: unknown) => error);
			expect(caught).toBeInstanceOf(SessionResolutionError);
			expect((caught as SessionResolutionError).message).toBe(
				"--new cannot be combined with --continue, --resume, or --fork",
			);
		}
	});
});

describe("parseArgs — --new flag", () => {
	it("sets newSession for both spellings", () => {
		expect(parseArgs(["--new"]).newSession).toBe(true);
		expect(parseArgs(["--new-session"]).newSession).toBe(true);
		expect(parseArgs([]).newSession).toBeUndefined();
	});

	it("consumes no value, so a following flag still parses", () => {
		const result = parseArgs(["--new", "--profile", "work", "hello"]);
		expect(result.newSession).toBe(true);
		expect(result.profile).toBe("work");
		expect(result.messages).toEqual(["hello"]);
	});
});
