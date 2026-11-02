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
import { restoreEnvValue } from "./helpers/settings-test-state";

// A skill that auto-learn creates mid-session reaches the model through a hidden notice appended to the
// transcript. The system prompt keeps the skill list it was built with, so the provider prompt cache (and a
// local server's prefix cache) survives the skill's creation and any later unrelated prompt rebuild.
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

interface WireMessage {
	role: string;
	content: unknown;
}

function wireMessages(body: string): WireMessage[] {
	return (JSON.parse(body) as { messages: WireMessage[] }).messages;
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
		const fetchStub = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => {
				const body = String(init?.body ?? "");
				if (body.includes('"messages"')) bodies.push(body);
				return sseDone();
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	async function startSession(sessionManager: SessionManager): Promise<AgentSession> {
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
		});
		sessions.push(session);
		return session;
	}

	async function createSkill(session: AgentSession): Promise<void> {
		const tool = session.getToolByName("manage_skill");
		if (!tool) throw new Error("manage_skill is not registered");
		await tool.execute("call-1", {
			action: "create",
			name: SKILL,
			description: "Poll Apple store pickup availability",
			body: "# Pickup watch\n\nPoll the endpoint.",
		});
	}

	it("keeps the system prompt byte-identical and announces the skill once in the transcript", async () => {
		const session = await startSession(SessionManager.inMemory(tempCwd));
		await session.sendUserMessage("first");
		await createSkill(session);
		await session.sendUserMessage("second");
		await session.sendUserMessage("third");

		expect(bodies).toHaveLength(3);
		const [first, second, third] = bodies as [string, string, string];
		expect(systemPrompt(first)).not.toContain(SKILL);
		expect(systemPrompt(second)).toBe(systemPrompt(first));
		expect(noticeCount(second)).toBe(1);
		// Delivered once: the third request replays that notice, it does not add another.
		expect(noticeCount(third)).toBe(1);
		// The registry sees the skill at once, so `skill://` and `/skill:` resolve it.
		expect(session.skills.some(skill => skill.name === SKILL)).toBe(true);
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
