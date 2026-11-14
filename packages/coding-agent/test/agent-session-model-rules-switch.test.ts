import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

// Contract: the `<model-rules>` block of a running turn follows a mid-turn model switch (`/switch`, `/model`,
// retry fallback), and switching back to a model restores its exact prompt bytes so its prompt cache survives.

const SONNET_RULE = "SONNET-ONLY-RULE";
const GPT_RULE = "GPT-ONLY-RULE";

function bundled(provider: string, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

const sonnet = bundled("anthropic", "claude-sonnet-4-5");
const gpt = bundled("openai", "gpt-4o-mini");
const gpt4o = bundled("openai", "gpt-4o");

interface Request {
	model: string;
	systemPrompt: string[];
}

describe("AgentSession model rules across mid-turn model switches", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-model-rules-switch-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const rulesDir = path.join(tempDir.path(), "agent", "model-rules");
		await fs.mkdir(rulesDir, { recursive: true });
		await Bun.write(path.join(rulesDir, "00-sonnet.md"), `---\nmodels: anthropic/*sonnet*\n---\n${SONNET_RULE}`);
		await Bun.write(path.join(rulesDir, "10-gpt.md"), `---\nmodels: openai/gpt-4o*\n---\n${GPT_RULE}`);
		setAgentDir(path.join(tempDir.path(), "agent"));
	});

	afterAll(() => {
		authStorage.close();
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDir);
		__resetDirsFromEnvForTests();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		modelRegistry.clearSuppressedSelectors();
		vi.restoreAllMocks();
	});

	function createSession(
		respond: (model: Model, call: number) => MockResponse,
		settings: Settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		initialModel: Model = sonnet,
	): { session: AgentSession; agent: Agent; requests: Request[] } {
		const mock = createMockModel();
		const requests: Request[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: initialModel, systemPrompt: ["BASE"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (model, context, options) => {
				requests.push({ model: `${model.provider}/${model.id}`, systemPrompt: [...(context.systemPrompt ?? [])] });
				mock.push(respond(model, requests.length));
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
		});
		return { session, agent, requests };
	}

	/** Two tool round trips, then a final answer: three requests in one turn. */
	const threeCalls = (_model: Model, call: number): MockResponse =>
		call < 3 ? { content: [{ type: "toolCall", name: "missing_tool", arguments: {} }] } : { content: ["Done"] };

	function switchBeforeCalls(agent: Agent, switches: Record<number, () => Promise<unknown>>): void {
		let call = 0;
		agent.addBeforeModelCallHook(async () => {
			call++;
			await switches[call]?.();
		});
	}

	it("swaps the block when /switch changes the model mid-turn", async () => {
		const { session, agent, requests } = createSession(threeCalls);
		switchBeforeCalls(agent, { 2: () => session.setModelTemporary(gpt) });

		await session.prompt("hello");
		await session.waitForIdle();

		expect(requests.map(request => request.model)).toEqual([
			"anthropic/claude-sonnet-4-5",
			"openai/gpt-4o-mini",
			"openai/gpt-4o-mini",
		]);
		expect(requests[0]!.systemPrompt.join("\n")).toContain(SONNET_RULE);
		for (const request of requests.slice(1)) {
			const prompt = request.systemPrompt.join("\n");
			expect(prompt).toContain(GPT_RULE);
			expect(prompt).not.toContain(SONNET_RULE);
			expect(prompt).toContain("<model-rules>");
		}
	});

	it("leaves the system prompt untouched when the new model selects the same rules", async () => {
		const { session, agent, requests } = createSession(
			threeCalls,
			Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			gpt,
		);
		switchBeforeCalls(agent, { 2: () => session.setModelTemporary(gpt4o) });

		await session.prompt("hello");
		await session.waitForIdle();

		expect(requests.map(request => request.model)).toEqual(["openai/gpt-4o-mini", "openai/gpt-4o", "openai/gpt-4o"]);
		expect(requests[0]!.systemPrompt.join("\n")).toContain(GPT_RULE);
		expect(requests[1]!.systemPrompt).toEqual(requests[0]!.systemPrompt);
	});

	it("swaps the block when /model changes the model mid-turn", async () => {
		const { session, agent, requests } = createSession(threeCalls);
		switchBeforeCalls(agent, { 2: () => session.setModel(gpt) });

		await session.prompt("hello");
		await session.waitForIdle();

		const after = requests[1]!.systemPrompt.join("\n");
		expect(after).toContain(GPT_RULE);
		expect(after).not.toContain(SONNET_RULE);
	});

	it("restores the first model's exact prompt bytes when the turn switches back to it", async () => {
		const { session, agent, requests } = createSession(threeCalls);
		switchBeforeCalls(agent, {
			2: () => session.setModelTemporary(gpt),
			3: () => session.setModelTemporary(sonnet),
		});

		await session.prompt("hello");
		await session.waitForIdle();

		expect(requests.map(request => request.model)).toEqual([
			"anthropic/claude-sonnet-4-5",
			"openai/gpt-4o-mini",
			"anthropic/claude-sonnet-4-5",
		]);
		expect(requests[1]!.systemPrompt.join("\n")).not.toContain(SONNET_RULE);
		expect(requests[2]!.systemPrompt).toEqual(requests[0]!.systemPrompt);
	});

	it("swaps the block when a retry fallback switches the model", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { default: [`${gpt.provider}/${gpt.id}`] },
		});
		settings.setModelRole("default", `${sonnet.provider}/${sonnet.id}`);
		const { session, requests } = createSession(
			model =>
				model.id === sonnet.id
					? { throw: "overloaded_error: provider returned error 503" }
					: { content: ["Recovered"] },
			settings,
		);

		await session.prompt("hello");
		await session.waitForIdle();

		const fallback = requests.find(request => request.model === "openai/gpt-4o-mini");
		expect(requests[0]!.systemPrompt.join("\n")).toContain(SONNET_RULE);
		expect(fallback).toBeDefined();
		expect(fallback!.systemPrompt.join("\n")).toContain(GPT_RULE);
		expect(fallback!.systemPrompt.join("\n")).not.toContain(SONNET_RULE);
	});
});
