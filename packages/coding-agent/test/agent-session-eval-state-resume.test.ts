import { afterEach, expect, it, spyOn } from "bun:test";
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
import { SessionMemory } from "@oh-my-pi/pi-coding-agent/session/session-memory";
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

interface Process {
	session: AgentSession;
	manager: SessionManager;
	/** Every provider request this process sent, oldest first. */
	requests: Message[][];
}

/** One omp process on the session file: reopen it and wire an eval-capable session. */
async function openProcess(file: string, sessionDir: string, registry: ModelRegistry, label: string): Promise<Process> {
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected bundled model");
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
		getEvalSessionId: () => `eval-resume-${label}`,
	};
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: registry,
		evalToolSession,
	});
	sessions.push(session);
	return { session, manager, requests };
}

async function promptOnce(proc: Process, text: string): Promise<Message[]> {
	await proc.session.prompt(text);
	await proc.session.waitForIdle();
	await proc.manager.flush();
	const last = proc.requests.at(-1);
	if (!last) throw new Error("Expected a provider request");
	return last;
}

async function createRegistry(): Promise<ModelRegistry> {
	auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	return new ModelRegistry(auth);
}

const prefix = (messages: Message[]) => messages.map(message => ({ role: message.role, content: message.content }));

/**
 * Regression for #15736: every process that resumes a session with `eval`
 * history must send the previous process's request as a prefix, or the
 * provider prompt cache misses from the eval-state-context slot onward. Eval
 * activity after the last snapshot still gets a fresh one, since a new process
 * has lost that runtime state.
 */
it("keeps the previous process's request as the resumed request prefix", async () => {
	const registry = await createRegistry();
	const sessionDir = path.join(temp.path(), "sessions");
	const seed = SessionManager.create(temp.path(), sessionDir);
	seed.appendMessage({ role: "user", content: "use eval", timestamp: Date.now() });
	appendEval(seed, "eval-1");
	await seed.flush();
	const file = seed.getSessionFile();
	if (!file) throw new Error("Expected a persisted session");

	/** One `omp -p --continue` process: prompt once, optionally record an eval call. */
	const runProcess = async (text: string, evalCallId?: string): Promise<Message[]> => {
		const proc = await openProcess(file, sessionDir, registry, text);
		const request = await promptOnce(proc, text);
		if (evalCallId) appendEval(proc.manager, evalCallId);
		await proc.manager.flush();
		return request;
	};

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

/**
 * A history rewrite inside a live process (an idle shake, a prune, dropping
 * images) rebuilds the agent's messages and appends a fresh snapshot when
 * eval ran since the last one. That snapshot must reach the session file, or
 * the next process rebuilds a history without it and its request diverges
 * from the live one at that slot, missing the prompt cache from there on.
 */
it("keeps a snapshot appended by an in-process history rewrite across resume", async () => {
	const registry = await createRegistry();
	const sessionDir = path.join(temp.path(), "sessions");
	const seed = SessionManager.create(temp.path(), sessionDir);
	seed.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: "use eval on this screenshot" },
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		],
		timestamp: Date.now(),
	});
	appendEval(seed, "eval-1");
	await seed.flush();
	const file = seed.getSessionFile();
	if (!file) throw new Error("Expected a persisted session");

	const live = await openProcess(file, sessionDir, registry, "live");
	await promptOnce(live, "Reply OK 1.");
	appendEval(live.manager, "eval-2");
	expect((await live.session.dropImages()).removed).toBe(1);
	const liveRequest = await promptOnce(live, "Reply OK 2.");
	const snapshot = liveRequest.findIndex(
		(message, index) => index > 0 && liveRequest[index - 1]?.role === "toolResult" && message.role === "developer",
	);
	expect(snapshot).toBeGreaterThan(0);

	const resumed = await openProcess(file, sessionDir, registry, "resumed");
	const resumedRequest = await promptOnce(resumed, "Reply OK 3.");
	expect(prefix(resumedRequest).slice(0, liveRequest.length)).toEqual(prefix(liveRequest));
});

/**
 * Tree navigation rebuilds the history at the selected node and persists the
 * snapshot that rebuild appends. Revisiting the node must reuse that entry, or
 * every visit adds another hidden sibling and moves the leaf onto it.
 */
it("adds no snapshot entries when the tree revisits a node", async () => {
	const registry = await createRegistry();
	const sessionDir = path.join(temp.path(), "sessions");
	const seed = SessionManager.create(temp.path(), sessionDir);
	seed.appendMessage({ role: "user", content: "use eval", timestamp: Date.now() });
	appendEval(seed, "eval-1");
	await seed.flush();
	const file = seed.getSessionFile();
	if (!file) throw new Error("Expected a persisted session");

	const live = await openProcess(file, sessionDir, registry, "tree");
	await promptOnce(live, "Reply OK 1.");
	const entries = live.manager.getEntries();
	const evalResult = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult");
	const prompt = entries.findLast(entry => entry.type === "message" && entry.message.role === "user");
	if (!evalResult || !prompt) throw new Error("Expected eval result and prompt entries");
	const snapshotEntries = () =>
		live.manager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === "eval-state-context");
	const before = snapshotEntries().length;

	for (let visit = 0; visit < 3; visit++) {
		await live.session.navigateTree(prompt.id);
		await live.session.navigateTree(evalResult.id);
	}
	expect(snapshotEntries()).toHaveLength(before);
	expect(snapshotEntries().map(entry => entry.id)).toContain(live.manager.getLeafId() ?? "");
});

/** A switch that rolls back must leave the target session's journal as it found it. */
it("writes no snapshot into the target of a failed session switch", async () => {
	const registry = await createRegistry();
	const sessionDir = path.join(temp.path(), "sessions");
	const target = SessionManager.create(temp.path(), sessionDir);
	target.appendMessage({ role: "user", content: "use eval", timestamp: Date.now() });
	appendEval(target, "eval-1");
	await target.flush();
	const targetFile = target.getSessionFile();
	const current = SessionManager.create(temp.path(), sessionDir);
	current.appendMessage({ role: "user", content: "other", timestamp: Date.now() });
	await current.flush();
	const currentFile = current.getSessionFile();
	if (!targetFile || !currentFile) throw new Error("Expected persisted sessions");
	const before = await Bun.file(targetFile).text();

	const live = await openProcess(currentFile, sessionDir, registry, "switch");
	const reset = spyOn(SessionMemory.prototype, "resetContextForNewTranscript").mockRejectedValueOnce(
		new Error("forced switch failure"),
	);
	try {
		const switching = live.session.switchSession(targetFile, { onCwdChange: async () => true });
		await expect(switching).rejects.toThrow("forced switch failure");
	} finally {
		reset.mockRestore();
	}
	expect(await Bun.file(targetFile).text()).toBe(before);
});
