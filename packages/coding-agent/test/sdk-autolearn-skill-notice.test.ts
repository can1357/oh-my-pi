import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { asGlobalFetch } from "./helpers/fetch-mock";
import { restoreEnvValue } from "./helpers/settings-test-state";

const SKILL = "pickup-watch";

function sseDone(): Response {
	const chunk = {
		id: "gen-1",
		object: "chat.completion.chunk",
		created: 0,
		model: "deepseek-v4-1-flash",
		choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function wireMessages(body: string): Array<{ role: string; content: unknown }> {
	return JSON.parse(body).messages;
}

function systemPrompt(body: string): string {
	return JSON.stringify(wireMessages(body).filter(message => message.role === "system"));
}

/** Non-system messages that mention the skill: the notice, and nothing else in these tests. */
function noticeCount(body: string): number {
	return wireMessages(body).filter(
		message => message.role !== "system" && JSON.stringify(message.content).includes(SKILL),
	).length;
}

describe("auto-learn skill notice", () => {
	const sessions: AgentSession[] = [];
	let tempHome: string;
	let tempCwd: string;
	let originalAgentDir: string;
	let originalClaudeConfigDir: string | undefined;
	let bodies: string[];

	beforeEach(async () => {
		// Keep the developer's own skills out of discovery: only the managed skill under the fake home exists.
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		delete Bun.env.CLAUDE_CONFIG_DIR;
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-notice-"));
		tempCwd = path.join(tempHome, "work");
		await fs.mkdir(tempCwd, { recursive: true });
		spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		bodies = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch((_input, init) => {
				const body = String(init?.body ?? "");
				if (body.includes('"messages"')) bodies.push(body);
				return sseDone();
			}),
		);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	async function startSession(sessionManager: SessionManager, toolNames?: string[]): Promise<AgentSession> {
		const model = getBundledModel("venice", "deepseek-v4-1-flash");
		const authStorage = await AuthStorage.create(path.join(tempHome, "auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const { session } = await createAgentSession({
			cwd: tempCwd,
			agentDir: getAgentDir(),
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempHome, "models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false, "autolearn.enabled": true }),
			model,
			disableExtensionDiscovery: true,
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			...(toolNames ? { toolNames } : {}),
		});
		sessions.push(session);
		return session;
	}

	async function createSkill(
		session: AgentSession,
		action: "create" | "update" = "create",
		description = "Poll Apple store pickup availability",
	): Promise<void> {
		const tool = session.getToolByName("manage_skill");
		if (!tool) throw new Error("manage_skill is not registered");
		await tool.execute(`call-${action}`, {
			action,
			name: SKILL,
			description,
			body: "# Pickup watch\n\nPoll the endpoint.",
		});
	}

	it("announces a changed description of a skill the model already knows", async () => {
		const session = await startSession(SessionManager.inMemory(tempCwd));
		await session.sendUserMessage("first");
		await createSkill(session);
		await session.sendUserMessage("second");
		await createSkill(session, "update", "Watch Apple store stock and file a deploy ticket");
		await session.sendUserMessage("third");

		const third = bodies[2] as string;
		expect(noticeCount(third)).toBe(2);
		expect(JSON.stringify(wireMessages(third).at(-2)?.content)).toContain("file a deploy ticket");
	});

	it("sends no notice when no active tool can read skill://", async () => {
		const session = await startSession(SessionManager.inMemory(tempCwd), ["edit"]);
		expect(session.getActiveToolNames()).toContain("manage_skill");
		await session.sendUserMessage("first");
		await createSkill(session);
		await session.sendUserMessage("second");

		expect(noticeCount(bodies[1] as string)).toBe(0);
	});

	it("keeps the system prompt byte-identical and announces the skill once in the transcript", async () => {
		const session = await startSession(SessionManager.inMemory(tempCwd));
		await session.sendUserMessage("first");
		await createSkill(session);
		await session.sendUserMessage("second");
		await session.sendUserMessage("third");

		const [first, second, third] = bodies as [string, string, string];
		expect(systemPrompt(first)).not.toContain(SKILL);
		expect(systemPrompt(second)).toBe(systemPrompt(first));
		expect(noticeCount(second)).toBe(1);
		// Delivered once: the third request replays that notice, it does not add another.
		expect(noticeCount(third)).toBe(1);
	});

	it("keeps the announced skill out of the system prompt across an unrelated rebuild", async () => {
		const session = await startSession(SessionManager.inMemory(tempCwd));
		await session.sendUserMessage("first");
		await createSkill(session);
		await session.sendUserMessage("second");
		await session.refreshBaseSystemPrompt();
		await session.sendUserMessage("third");

		const [first, , third] = bodies as [string, string, string];
		expect(systemPrompt(third)).toBe(systemPrompt(first));
		expect(noticeCount(third)).toBe(1);
	});

	it("does not announce the skill again after a resume", async () => {
		const sessionManager = SessionManager.create(tempCwd, path.join(tempHome, "sessions"));
		const session = await startSession(sessionManager);
		await session.sendUserMessage("first");
		await createSkill(session);
		await session.sendUserMessage("second");
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		await session.dispose();
		sessions.splice(sessions.indexOf(session), 1);

		const resumed = await startSession(await SessionManager.open(sessionFile));
		await resumed.sendUserMessage("third");

		const third = bodies[2] as string;
		// A resume rebuilds the prompt from disk, so the skill is listed there now (one cache miss, by design).
		expect(systemPrompt(third)).toContain(SKILL);
		expect(noticeCount(third)).toBe(1);
	});
});
