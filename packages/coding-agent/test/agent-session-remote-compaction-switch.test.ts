/**
 * An OpenAI remote compaction stores the compacted history in an opaque,
 * provider-bound payload and only a placeholder summary. A model that cannot
 * replay that payload must read the history behind it instead of the
 * placeholder, from the first request after the switch, and a target too small
 * for that history must compact it before sending.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

const FACT = "COMPACTED-FACT";
const PLACEHOLDER = "Remote compaction preserved provider-native history for this session.";
const NATIVE_STATE = "opaque-native-state";

function bundled(provider: GeneratedProvider, modelId: string): Model {
	const model = getBundledModel(provider, modelId);
	if (!model) throw new Error(`Expected bundled ${provider}/${modelId}`);
	return model;
}

const gpt = bundled("openai", "gpt-5.4");
const claude = bundled("anthropic", "claude-opus-5-5");

function assistant(model: Model, text: string, input = 0): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

/**
 * `turns` GPT turns behind an OpenAI remote compaction, then one kept reply.
 * The last usage report is the small post-compaction request.
 */
function seedRemoteCompaction(sessionManager: SessionManager, turns: number): void {
	const filler = "the quick brown fox jumps over the lazy dog. ".repeat(20);
	let lastId = "";
	for (let i = 0; i < turns; i++) {
		sessionManager.appendMessage({ role: "user", content: `${FACT} ${i}: ${filler}`, timestamp: Date.now() });
		lastId = sessionManager.appendMessage(assistant(gpt, `reply ${i}: ${filler}`, 1_000 + i * 400));
	}
	const compactionItem = { type: "compaction", encrypted_content: NATIVE_STATE };
	sessionManager.appendCompaction(PLACEHOLDER, "Remote compaction", lastId, turns * 400, {
		method: "remote",
		preserveData: {
			openaiRemoteCompaction: {
				provider: gpt.provider,
				replacementHistory: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "retained request" }] },
					compactionItem,
				],
				compactionItem,
			},
		},
	});
	sessionManager.appendMessage({ role: "user", content: "After compaction.", timestamp: Date.now() });
	sessionManager.appendMessage(assistant(gpt, "Post-compaction reply.", 2_000));
}

function requestText(context: Context | undefined): string {
	return JSON.stringify(context?.messages ?? []);
}

function countFacts(text: string): number {
	return text.match(new RegExp(`${FACT} \\d+`, "g"))?.length ?? 0;
}

describe("switch after an OpenAI remote compaction", () => {
	const originalAgentDir = getAgentDir();
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-remote-compaction-switch-"));
		setAgentDir(path.join(tempDir, "agent"));
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(sessions.splice(0).map(session => session.dispose()));
	});

	afterAll(async () => {
		authStorage.close();
		setAgentDir(originalAgentDir);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function startSession(
		sessionManager: SessionManager,
		model: Model,
		settings: Settings,
	): { session: AgentSession; mock: MockModel } {
		const mock = createMockModel({ handler: { content: ["ok"] } });
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		sessions.push(session);
		return { session, mock };
	}

	it("sends the history behind the compaction to Claude, and the native payload after a switch back", async () => {
		const sessionManager = SessionManager.inMemory();
		seedRemoteCompaction(sessionManager, 6);
		const { session, mock } = startSession(sessionManager, gpt, Settings.isolated({ "compaction.enabled": false }));

		await session.setModel(claude);
		await session.prompt("What came before the compaction?");
		const toClaude = requestText(mock.calls[0]?.context);
		expect(countFacts(toClaude)).toBe(6);
		expect(toClaude).not.toContain(PLACEHOLDER);
		expect(toClaude).not.toContain(NATIVE_STATE);
		expect(toClaude).toContain("Post-compaction reply.");

		await session.setModel(gpt);
		await session.prompt("Continue.");
		const toGpt = requestText(mock.calls[1]?.context);
		expect(countFacts(toGpt)).toBe(0);
		expect(toGpt).toContain(PLACEHOLDER);
	});

	it("compacts the history before the first request to a target whose window cannot hold it", async () => {
		const sessionManager = SessionManager.inMemory();
		seedRemoteCompaction(sessionManager, 160);
		const smallClaude: Model = { ...claude, contextWindow: 64_000, maxTokens: 8_000 };
		const { session, mock } = startSession(
			sessionManager,
			gpt,
			Settings.isolated({ "compaction.methodOrder": ["soft"] }),
		);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: `TARGET-SUMMARY by ${model.provider}`,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));

		await session.setModel(smallClaude);
		await session.prompt("What came before the compaction?");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		const [preparation, compactionModel] = compactSpy.mock.calls[0]!;
		expect(compactionModel.provider).toBe("anthropic");
		expect(countFacts(JSON.stringify(preparation.messagesToSummarize))).toBeGreaterThan(80);
		expect(preparation.previousSummary).toBeUndefined();

		const sent = requestText(mock.calls[0]?.context);
		expect(sent).toContain("TARGET-SUMMARY by anthropic");
		expect(sent).not.toContain(PLACEHOLDER);
		expect(countFacts(sent)).toBeLessThan(80);
	});

	// Native lanes run before a configured endpoint, so an endpoint does not make the remote method portable.
	it.each([
		["no remote endpoint", {}],
		["a remote endpoint", { "compaction.remoteEndpoint": "https://compactor.invalid/summarize" }],
	])("skips the OpenAI remote method for a reader that cannot replay it, with %s", async (_label, extra) => {
		const sessionManager = SessionManager.inMemory();
		seedRemoteCompaction(sessionManager, 160);
		const { session } = startSession(
			sessionManager,
			gpt,
			Settings.isolated({ "compaction.methodOrder": ["remote", "soft"], ...extra }),
		);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: `portable summary by ${model.provider}`,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));

		const result = await session.compact(undefined, { readerModel: claude });

		expect(result.summary).toBe("portable summary by openai");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		// Soft summarization re-expands the history behind the remote boundary.
		expect(countFacts(JSON.stringify(compactSpy.mock.calls[0]![0].messagesToSummarize))).toBeGreaterThan(0);
		const latest = sessionManager.getBranch().findLast(entry => entry.type === "compaction");
		expect(latest?.type === "compaction" && latest.method).toBe("soft");
	});
});
