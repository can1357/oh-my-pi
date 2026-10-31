import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { dispatchRpcSkillPrompt } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import {
	RpcExtensionUserMessageTracker,
	RpcPromptResults,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-prompt-results";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { expandModelMentionTags } from "@oh-my-pi/pi-tui/prompt/model-mention-syntax";
import {
	MODEL_MENTION_ENTRY_TYPE,
	ModelMentionRegistry,
	readModelMentions,
} from "@oh-my-pi/pi-coding-agent/session/model-mentions";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function model(provider: string, id: string, name: string): Model {
	return buildModel({
		provider,
		id,
		name,
		api: "openai-completions",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
}

async function createTaggedSkill() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-model-mention-skill-"));
	const filePath = path.join(dir, "SKILL.md");
	await Bun.write(filePath, "Skill body: ^c/w");
	return { dir, skill: { name: "test", filePath, baseDir: dir } };
}

const models = [model("a", "x", "X One"), model("b", "y", "Y"), model("c", "w", 'W "Three"')];
let auth: AuthStorage;
let registry: ModelRegistry;
let session: SessionManager;
let mentions: ModelMentionRegistry;
let scoped: Model[];

beforeEach(async () => {
	auth = await AuthStorage.create(":memory:");
	registry = new ModelRegistry(auth, "/nonexistent/model-mentions/models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	session = SessionManager.inMemory();
	scoped = [];
	mentions = new ModelMentionRegistry({
		sessionManager: session,
		modelRegistry: registry,
		scopedModels: () => scoped,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	auth.close();
});

describe("model mentions", () => {
	test("only user prompts authorize model agents before dispatch", async () => {
		vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: models[0], systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Synthetic done"] }, { content: ["User done"] }] }).stream,
		});
		const agentSession = new AgentSession({
			agent,
			sessionManager: session,
			modelRegistry: registry,
			settings: Settings.isolated({ "compaction.enabled": false }),
		});
		try {
			await agentSession.prompt("ask ^a/x", { synthetic: true });
			expect(agentSession.getSessionAgents()).toEqual([]);
			await agentSession.prompt("ask ^b/y");
			expect(agentSession.modelMentions).toEqual([{ agent: "m1", selector: "b/y", name: "Y" }]);
			const promptText = agent.state.messages
				.filter(message => message.role === "user" || message.role === "developer")
				.map(message =>
					typeof message.content === "string"
						? message.content
						: message.content
								.filter(part => part.type === "text")
								.map(part => part.text)
								.join(""),
				);
			expect(promptText).toEqual(["ask ^a/x", 'ask <model agent="m1" name="Y"/>']);
		} finally {
			await agentSession.dispose();
		}
	});

	test("child sessions retain parent model agents and reserve their pseudonyms", async () => {
		vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
		const task = getBundledAgent("task");
		if (!task) throw new Error("Missing bundled task agent");
		const inheritedAgent = { ...task, name: "m1", model: ["b/y"] };
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: models[0], systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Child done"] }] }).stream,
		});
		const childSession = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: registry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			inheritedSessionAgents: [inheritedAgent],
		});
		try {
			await childSession.prompt("ask ^a/x");
			expect(childSession.getSessionAgents().map(candidate => [candidate.name, candidate.model])).toEqual([
				["m1", ["b/y"]],
				["m2", ["a/x"]],
			]);
		} finally {
			await childSession.dispose();
		}
	});

	test("mid-session tags ride a hidden notice instead of the task description", async () => {
		vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: models[0], systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Synthetic done"] }, { content: ["User done"] }] }).stream,
		});
		const agentSession = new AgentSession({
			agent,
			sessionManager: session,
			modelRegistry: registry,
			settings: Settings.isolated({ "compaction.enabled": false }),
		});
		try {
			expect(agentSession.getAdvertisedSessionAgents()).toEqual([]);
			await agentSession.prompt("ask ^b/y");
			// The description surface only absorbs tags at a base-prompt rebuild, so
			// the new pseudonym must arrive as a notice carrying its selector.
			expect(agentSession.getAdvertisedSessionAgents()).toEqual([]);
			const notice = agent.state.messages.find(
				(message): message is CustomMessage =>
					message.role === "custom" && message.customType === "session-agent-notice",
			);
			if (!notice || typeof notice.content !== "string") throw new Error("Missing session agent notice");
			expect(notice.content).toContain("`m1`");
			expect(notice.content).toContain("b/y");
			expect(notice.display).toBe(false);

			// The notice is not re-emitted: the model already knows m1.
			await agentSession.prompt("continue");
			const notices = agent.state.messages.filter(
				message => message.role === "custom" && message.customType === "session-agent-notice",
			);
			expect(notices).toHaveLength(1);
		} finally {
			await agentSession.dispose();
		}
	});

	test("user-invoked skill arguments authorize model agents in the same turn", async () => {
		vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
		const mock = createMockModel({ responses: [{ content: ["Done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: models[0], systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const agentSession = new AgentSession({
			agent,
			sessionManager: session,
			modelRegistry: registry,
			settings: Settings.isolated({ "compaction.enabled": false }),
		});
		const { dir, skill } = await createTaggedSkill();
		try {
			const built = await agentSession.buildUserSkillPrompt(skill, { args: "ask ^b/y to help" });
			await agentSession.promptCustomMessage({
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: built.message,
				display: true,
				details: built.details,
				attribution: "user",
			});

			expect(readModelMentions(session.getBranch())).toEqual([{ agent: "m1", selector: "b/y", name: "Y" }]);
			expect(agentSession.getSessionAgents().map(candidate => [candidate.name, candidate.model])).toEqual([
				["m1", ["b/y"]],
			]);
			const turn = JSON.stringify(agent.state.messages);
			expect(turn).toContain('User: ask <model agent=\\"m1\\" name=\\"Y\\"/> to help');
			expect(turn).toContain("Skill body: ^c/w");
			expect(turn).toContain("Now available:");
		} finally {
			await agentSession.dispose();
			await removeWithRetries(dir);
		}
	});

	test("queued skill image prompts carry expanded arguments and their agent notice", async () => {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: models[0], systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [] }).stream,
		});
		const agentSession = new AgentSession({
			agent,
			sessionManager: session,
			modelRegistry: registry,
			settings: Settings.isolated({ "compaction.enabled": false }),
		});
		const { dir, skill: taggedSkill } = await createTaggedSkill();
		const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
		try {
			const built = await agentSession.buildUserSkillPrompt(taggedSkill, { args: "ask ^b/y to help" });
			await agentSession.promptCustomMessage(
				{
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: [{ type: "text", text: built.message }, image],
					display: true,
					details: built.details,
					attribution: "user",
				},
				{ streamingBehavior: "steer", queueOnly: true },
			);

			expect(readModelMentions(session.getBranch())).toEqual([{ agent: "m1", selector: "b/y", name: "Y" }]);
			const queued = agent.peekSteeringQueue();
			const skill = queued.find(
				(message): message is CustomMessage =>
					message.role === "custom" && message.customType === SKILL_PROMPT_MESSAGE_TYPE,
			);
			expect(skill?.content).toEqual([{ type: "text", text: built.message }, image]);
			expect(built.message).toContain('User: ask <model agent="m1" name="Y"/> to help');
			expect(built.message).toContain("Skill body: ^c/w");
			expect(
				queued.some(message => message.role === "custom" && message.customType === "session-agent-notice"),
			).toBe(true);
		} finally {
			await agentSession.dispose();
			await removeWithRetries(dir);
		}
	});

	test("a canceled RPC skill never authorizes its tagged model", async () => {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: models[0], systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [] }).stream,
		});
		const agentSession = new AgentSession({
			agent,
			sessionManager: session,
			modelRegistry: registry,
			settings: Settings.isolated({ "compaction.enabled": false }),
		});
		const { dir, skill } = await createTaggedSkill();
		const results = new RpcPromptResults(
			{ isStreaming: false, hasAdmittedSubmission: false, queuedMessageCount: 0, hasPendingAsyncWork: () => false },
			() => {},
		);
		try {
			const outcome = await dispatchRpcSkillPrompt({
				ticket: results.begin("cancelled-skill"),
				results,
				session: {
					skillsSettings: { enableSkillCommands: true },
					skills: [{ ...skill, description: "Tagged skill", source: "test" }],
					buildUserSkillPrompt: agentSession.buildUserSkillPrompt.bind(agentSession),
					renderUserSkillPrompt: agentSession.renderUserSkillPrompt.bind(agentSession),
					promptCustomMessage: agentSession.promptCustomMessage.bind(agentSession),
				},
				message: "/skill:test ask ^b/y to help",
				streamingBehavior: "steer",
				onError: () => {},
				extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
				isCurrent: () => false,
			});

			expect(outcome).toBe("cancelled");
			expect(readModelMentions(session.getBranch())).toEqual([]);
			expect(agentSession.getSessionAgents()).toEqual([]);
		} finally {
			await agentSession.dispose();
			await removeWithRetries(dir);
		}
	});

	test("registers only exact available selectors and reuses their pseudonyms", () => {
		expect(mentions.expandMentions("ask ^a/x and ^b/y ignore ^nope/z")).toBe(
			'ask <model agent="m1" name="X One"/> and <model agent="m2" name="Y"/> ignore ^nope/z',
		);
		expect(mentions.expandMentions("^a/x")).toBe('<model agent="m1" name="X One"/>');
		expect(readModelMentions(session.getBranch())).toEqual([
			{ agent: "m1", selector: "a/x", name: "X One" },
			{ agent: "m2", selector: "b/y", name: "Y" },
		]);
		expect(session.getBranch()).toHaveLength(2);
		const agents = mentions.sessionAgents();
		expect(agents.map(agent => [agent.name, agent.model])).toEqual([
			["m1", ["a/x"]],
			["m2", ["b/y"]],
		]);
		const task = getBundledAgent("task");
		if (!task) throw new Error("Missing bundled task agent");
		expect(agents[0].systemPrompt).toBe(task.systemPrompt);
	});

	test("replays first valid entries and frees discarded branch numbers", () => {
		const first = session.appendCustomEntry(MODEL_MENTION_ENTRY_TYPE, {
			agent: "m1",
			selector: "a/x",
			name: "X One",
		});
		for (const data of [
			null,
			{ agent: "wrong", selector: "b/y", name: "Y" },
			{ agent: "m9", selector: 3, name: "Y" },
			{ agent: "m1", selector: "c/w", name: "W" },
			{ agent: "m8", selector: "a/x", name: "X" },
		]) {
			session.appendCustomEntry(MODEL_MENTION_ENTRY_TYPE, data);
		}
		session.appendCustomEntry(MODEL_MENTION_ENTRY_TYPE, { agent: "m2", selector: "b/y", name: "Y" });
		mentions.syncFromBranch();
		expect(mentions.expandMentions("^c/w")).toBe('<model agent="m3" name="W Three"/>');
		expect(mentions.mentions.map(mention => mention.agent)).toEqual(["m1", "m2", "m3"]);
		session.branch(first);
		mentions.syncFromBranch();
		expect(mentions.expandMentions("^c/w")).toBe('<model agent="m2" name="W Three"/>');
		session.resetLeaf();
		mentions.syncFromBranch();
		expect(mentions.expandMentions("^b/y")).toBe('<model agent="m1" name="Y"/>');
	});

	test("honors picker scope and restores only known tags", () => {
		scoped = [models[1]];
		expect(mentions.expandMentions("^a/x ^b/y a^b/y")).toBe('^a/x <model agent="m1" name="Y"/> a^b/y');
		expect(
			expandModelMentionTags(
				'<model agent="m1" name="Y"/> <model agent="m9" name="Unknown"/>',
				agent => mentions.mentions.find(mention => mention.agent === agent)?.selector,
			),
		).toBe('^b/y <model agent="m9" name="Unknown"/>');
	});

	test("removeQueuedMessage matches raw text expanded with an already-authorized model mention", async () => {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: models[0], systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [] }).stream,
		});
		const agentSession = new AgentSession({
			agent,
			sessionManager: session,
			modelRegistry: registry,
			settings: Settings.isolated({ "compaction.enabled": false }),
		});
		try {
			// Force queueing instead of an actual turn: prompt() while streaming
			// applies mention expansion before it queues the message.
			agentSession.agent.state.isStreaming = true;
			const raw = "ask ^b/y to help";
			const queued = await agentSession.prompt(raw, { streamingBehavior: "steer" });
			expect(queued).toBe(true);
			expect(agentSession.getQueuedMessages().steering).toEqual(['ask <model agent="m1" name="Y"/> to help']);

			// The RPC client that submitted `raw` only ever holds that raw text;
			// removal must still find the mention-expanded queued chip.
			expect(agentSession.removeQueuedMessage(raw, "steering")).toBe(true);
			expect(agentSession.getQueuedMessages().steering).toEqual([]);
		} finally {
			agentSession.agent.state.isStreaming = false;
			await agentSession.dispose();
		}
	});
});
