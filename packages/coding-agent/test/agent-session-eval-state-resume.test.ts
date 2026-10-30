import { afterEach, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { TempDir } from "@oh-my-pi/pi-utils";

const temp = TempDir.createSync("@pi-eval-resume-");
const sessions: AgentSession[] = [];
let auth: AuthStorage | undefined;

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	auth?.close();
	temp.removeSync();
});

/** Records one `eval` call and its result, as a process that ran eval would persist them. */
function appendEval(manager: SessionManager, id: string): void {
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id, name: "eval", arguments: { code: "print(6*7)" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: id,
		toolName: "eval",
		content: [{ type: "text", text: "42" }],
		isError: false,
		timestamp: Date.now(),
	});
}

/**
 * Regression for #15736: every process that resumes a session with `eval`
 * history must send the previous process's request as a prefix, or the
 * provider prompt cache misses from the eval-state-context slot onward. Eval
 * activity after the last snapshot still gets a fresh one, since a new process
 * has lost that runtime state.
 */
it("keeps the previous process's request as the resumed request prefix", async () => {
	auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const registry = new ModelRegistry(auth);
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected bundled model");
	const sessionDir = path.join(temp.path(), "sessions");
	const seed = SessionManager.create(temp.path(), sessionDir);
	seed.appendMessage({ role: "user", content: "use eval", timestamp: Date.now() });
	appendEval(seed, "eval-1");
	await seed.flush();
	const file = seed.getSessionFile();
	if (!file) throw new Error("Expected a persisted session");
	await seed.close();

	/**
	 * One `omp -p --continue` process: reopen the file, prompt once, optionally
	 * record an eval call, and return the last provider request.
	 */
	const runProcess = async (text: string, evalCallId?: string): Promise<Message[]> => {
		const manager = await SessionManager.open(file, sessionDir);
		const requests: Message[][] = [];
		const mock = createMockModel({ provider: "anthropic", handler: { content: ["OK"] } });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: bundled,
				systemPrompt: ["Test"],
				tools: [],
				messages: manager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requests.push(structuredClone(context.messages));
				return mock.stream(model, context, options);
			},
		});
		const evalToolSession: ToolSession = {
			cwd: temp.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => file,
			getSessionSpawns: () => null,
			getEvalSessionId: () => `eval-resume-${text}`,
		};
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: registry,
			evalToolSession,
		});
		sessions.push(session);
		await session.prompt(text);
		await session.waitForIdle();
		if (evalCallId) appendEval(manager, evalCallId);
		await manager.flush();
		// The process ends here; the next one resumes the file from scratch.
		await manager.close();
		const last = requests.at(-1);
		if (!last) throw new Error("Expected a provider request");
		return last;
	};

	const prefix = (messages: Message[]) => messages.map(message => ({ role: message.role, content: message.content }));
	const second = await runProcess("Reply OK 2.");
	const third = await runProcess("Reply OK 3.", "eval-2");
	const fourth = await runProcess("Reply OK 4.");
	const fifth = await runProcess("Reply OK 5.");
	expect(prefix(third).slice(0, second.length)).toEqual(prefix(second));
	expect(prefix(fourth).slice(0, third.length)).toEqual(prefix(third));
	expect(prefix(fifth).slice(0, fourth.length)).toEqual(prefix(fourth));
	const evalResult = fourth.findIndex(message => message.role === "toolResult" && message.toolCallId === "eval-2");
	expect(fourth[evalResult + 1]?.role).toBe("developer");
});
