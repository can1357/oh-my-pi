import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	expandModelMentionTags,
	MODEL_MENTION_ENTRY_TYPE,
	ModelMentionRegistry,
	readModelMentions,
} from "@oh-my-pi/pi-coding-agent/session/model-mentions";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";

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
});
