/**
 * End-to-end coverage for speculative programmatic tool calling.
 *
 * The unit tests in `speculation.test.ts` cover the scanner, the store, and the
 * bridge claim in isolation. They cannot see the part that carries the feature:
 *
 *   Agent stream emits an `eval` tool call
 *     -> AgentSession's assistant-event interceptor
 *       -> streamedEvalCell reads toolCall.arguments mid-stream
 *         -> EvalSpeculationStore.observe launches completion("literal")
 *           -> EvalTool executes the cell for real
 *             -> prelude completion() -> __omp_call_tool__
 *               -> callSessionTool claims the parked result
 *
 * If any link breaks, speculation silently does nothing and every isolated test
 * still passes. That is the failure mode these tests exist to catch.
 *
 * The chain is driven with a scripted mock model, so it costs no provider calls.
 * One thing it deliberately cannot prove: that a real provider fills
 * `toolCall.arguments` progressively while the cell is still streaming. The mock
 * shares one array between `partial.content` and the emitted blocks, so args are
 * complete at the first delta. Only a live turn settles that, which is why
 * `EvalSpeculationStore` logs each launch and claim.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EvalSpeculationStore, registerEvalSpeculation } from "@oh-my-pi/pi-coding-agent/eval/speculation";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

/**
 * Prefix on every stubbed speculation result. The value is prompt-specific on
 * purpose: a single constant would prove a claim happened but could not tell a
 * correct claim from one prompt's answer leaking into another's call, which is
 * the expensive way for this feature to be wrong.
 */
const SPECULATED_PREFIX = "SPECULATED:";

/** Scripted assistant turn issuing one `eval` cell. */
function evalCall(code: string, callId: string): MockResponse {
	return {
		content: [{ type: "toolCall", id: callId, name: "eval", arguments: { language: "js", code } }],
		stopReason: "toolUse",
	};
}

function stopReply(text: string): MockResponse {
	return { content: [{ type: "text", text }], stopReason: "stop" };
}

function getToolResultText(messages: AgentMessage[], callId: string): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "toolResult" || message.toolCallId !== callId) continue;
		const textBlock = message.content.find((block): block is { type: "text"; text: string } => block.type === "text");
		return textBlock?.text;
	}
	return undefined;
}

describe("speculative tool calling through a real session", () => {
	let session: AgentSession;
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let scriptedResponses: MockResponse[];
	let speculated: Array<Record<string, unknown>>;

	/**
	 * Build a session whose eval tool shares one `ToolSession` with the
	 * speculation store, mirroring `sdk.ts`, which registers the store against the
	 * same object it hands to `createTools`.
	 *
	 * `registerTool` controls whether the agent can actually run the cell, which
	 * separates "did the stream launch it" from "did the cell claim it".
	 */
	async function build(registerTool: boolean): Promise<void> {
		tempDir = path.join(os.tmpdir(), `pi-sptc-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });

		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const settings = Settings.isolated({
			"eval.speculation.enabled": true,
			"eval.speculation.maxPerTurn": 4,
			"compaction.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"async.enabled": false,
			"eval.autoBackground.enabled": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir);

		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			settings,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			getSessionSpawns: () => "*",
		};

		speculated = [];
		const store = new EvalSpeculationStore({
			isEnabled: () => settings.get("eval.speculation.enabled"),
			maxPerTurn: () => settings.get("eval.speculation.maxPerTurn"),
			run: (_name, args) => {
				speculated.push(args);
				return Promise.resolve({ text: `${SPECULATED_PREFIX}${String(args.prompt)}` });
			},
		});
		registerEvalSpeculation(toolSession, store);

		const evalTool = new EvalTool(toolSession);
		scriptedResponses = [];
		const mock = createMockModel({ handler: () => scriptedResponses.shift() ?? stopReply("done") });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: registerTool ? [evalTool as unknown as AgentTool] : [],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			evalSpeculation: store,
			toolRegistry: new Map(registerTool ? [[evalTool.name, evalTool as unknown as AgentTool]] : []),
		});
	}

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	// Isolates the streaming half: with no eval tool registered the cell can never
	// run, so a launch here can only have come from the streamed arguments.
	it("launches a speculation from the streamed cell even when the tool never runs", async () => {
		await build(false);
		scriptedResponses = [evalCall('const a = await completion("haiku please");', "call_spec_1"), stopReply("ok")];

		await session.prompt("run a cell");

		expect(speculated).toEqual([{ prompt: "haiku please" }]);
	});

	// Covers the whole chain: interceptor, arg read, store, and WeakMap binding.
	it("serves the cell's completion() from the speculation instead of dispatching again", async () => {
		await build(true);
		const code = 'const a = await completion("haiku please"); display(a);';
		scriptedResponses = [evalCall(code, "call_spec_2"), stopReply("ok")];

		await session.prompt("run a cell");

		const resultText = getToolResultText(session.agent.state.messages, "call_spec_2");
		expect(resultText, "expected a toolResult for the eval cell").toBeDefined();
		expect(resultText, `cell output should carry the speculated value, saw: ${JSON.stringify(resultText)}`).toContain(
			`${SPECULATED_PREFIX}haiku please`,
		);
		// Exactly one dispatch total: the speculative launch. A claim miss would
		// show as a second entry here or as the marker missing above.
		expect(speculated).toHaveLength(1);
	});

	it("keys speculations per prompt rather than serving whichever is parked", async () => {
		await build(true);
		// Both literals are scanned and launched, including the unreachable one the
		// cell never calls. Only the executed prompt's own result may come back.
		const code = [
			'if (false) { await completion("never called"); }',
			'const a = await completion("actually called");',
			"display(a);",
		].join("\n");
		scriptedResponses = [evalCall(code, "call_spec_3"), stopReply("ok")];

		await session.prompt("run a cell");

		const resultText = getToolResultText(session.agent.state.messages, "call_spec_3");
		expect(resultText, `expected the executed prompt's own result: ${JSON.stringify(resultText)}`).toContain(
			`${SPECULATED_PREFIX}actually called`,
		);
		expect(resultText, `another prompt's answer leaked into the cell: ${JSON.stringify(resultText)}`).not.toContain(
			`${SPECULATED_PREFIX}never called`,
		);
		// Both were speculated; the unreachable one is abandoned at the turn end.
		expect(speculated.map(args => args.prompt).sort()).toEqual(["actually called", "never called"]);
	});

	it("lets a non-speculatable call fall through to the real bridge", async () => {
		await build(true);
		// A concatenation is not a single literal, so the scanner skips it while the
		// parked literal above stays unclaimed.
		const code = [
			'if (false) { await completion("parked but unused"); }',
			'const a = await completion("con" + "catenated").catch(e => "ERR:" + e);',
			"display(a);",
		].join("\n");
		scriptedResponses = [evalCall(code, "call_spec_4"), stopReply("ok")];

		await session.prompt("run a cell");

		const resultText = getToolResultText(session.agent.state.messages, "call_spec_4");
		// Only the cell's own catch can produce this, so it proves the call really
		// dispatched rather than the cell dying before reaching completion().
		expect(resultText, `expected a real dispatch attempt, saw: ${JSON.stringify(resultText)}`).toContain("ERR:");
		expect(resultText, `no speculated value may satisfy this call: ${JSON.stringify(resultText)}`).not.toContain(
			SPECULATED_PREFIX,
		);
		// Only the literal was speculated. The executed call never entered the store.
		expect(speculated.map(args => args.prompt)).toEqual(["parked but unused"]);
	});
});
