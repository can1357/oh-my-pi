import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel, type MockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { shouldRenderAbortReason } from "@oh-my-pi/pi-tui/chat/messages";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * An interrupt with no run to stop (cancelling a `/tree` ask re-answer while
 * idle, or Esc between turns) must not mark a later, unrelated provider abort as
 * the user's, and must not drop a message the session already accepted.
 */
interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	dir: TempDir;
	settings: Settings;
}

const resources: Array<{ session: AgentSession; auth: AuthStorage; dir: TempDir }> = [];

beforeAll(async () => {
	setThemeInstance((await getThemeByName("dark"))!);
});

afterEach(async () => {
	for (const { session, auth, dir } of resources.splice(0)) {
		await session.dispose();
		auth.close();
		await dir.remove();
	}
});

async function createSession(responses: MockResponseSource): Promise<Harness> {
	const dir = TempDir.createSync("@idle-interrupt-");
	const mock = createMockModel({ responses, handler: { content: ["finished"] } });
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "ask.notify": "off" });
	const sessionManager = SessionManager.create(dir.path(), dir.join("sessions"));
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			convertToLlm,
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		}),
		sessionManager,
		settings,
		modelRegistry: new ModelRegistry(auth, dir.join("models.yml")),
		toolRegistry: new Map(),
	});
	resources.push({ session, auth, dir });
	return { session, sessionManager, mock, dir, settings };
}

/** Cancel a `/tree` ask re-answer through the real `AskTool` and the session's re-answer context. */
async function cancelAskReanswer(h: Harness, afterAbort?: () => void): Promise<void> {
	const context = h.session.buildAskReanswerContext({
		askDialog: async () => undefined,
	} as unknown as ExtensionUIContext);
	if (afterAbort) {
		const abort = context.abort;
		context.abort = () => {
			abort();
			afterAbort();
		};
	}
	const tool = new AskTool({
		cwd: h.dir.path(),
		settings: h.settings,
		hasUI: true,
		getSessionFile: () => h.sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => null,
	});
	const questions = [{ id: "target", question: "Which target?", options: [{ label: "one" }, { label: "two" }] }];
	await expect(tool.execute("tree-reanswer", { questions }, undefined, undefined, context)).rejects.toThrow(
		"Ask tool was cancelled by the user",
	);
	await h.session.waitForIdle();
}

describe("interrupt with no run to stop", () => {
	it("does not mark a later provider abort as the user's", async () => {
		const h = await createSession([
			{
				content: ["partial response"],
				stopReason: "aborted",
				errorMessage: "provider transport closed unexpectedly",
			},
		]);
		await cancelAskReanswer(h);

		await h.session.prompt("new request");
		await h.session.waitForIdle();

		const aborted = h.session.messages.find(m => m.role === "assistant" && m.stopReason === "aborted");
		expect(aborted).toBeDefined();
		expect(AIError.is(aborted?.role === "assistant" ? aborted.errorId : undefined, AIError.Flag.UserInterrupt)).toBe(
			false,
		);
		expect(shouldRenderAbortReason(aborted as never)).toBe(true);
	});

	it("keeps a scheduled message the interrupt stopped during prompt setup", async () => {
		const streamStarted = Promise.withResolvers<void>();
		const finishStream = Promise.withResolvers<void>();
		const h = await createSession([
			async () => {
				streamStarted.resolve();
				await finishStream.promise;
				return { content: ["first answer"] };
			},
		]);
		const first = h.session.prompt("first");
		await streamStarted.promise;
		await h.session.sendCustomMessage(
			{ customType: "review-context", content: "scheduled context must survive", display: false },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
		// Hold the scheduled turn's setup at its credential lookup.
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const registry = h.session.modelRegistry;
		const getKey = registry.getApiKey.bind(registry);
		registry.getApiKey = async (...args) => {
			registry.getApiKey = getKey;
			reached.resolve();
			await release.promise;
			return getKey(...args);
		};
		finishStream.resolve();
		await reached.promise;
		await h.session.agent.waitForIdle();
		await cancelAskReanswer(h, () => release.resolve());
		await first;

		await h.session.prompt("resume after cancel");
		await h.session.waitForIdle();

		expect(JSON.stringify(h.mock.calls.map(c => c.context.messages))).toContain("scheduled context must survive");
		expect(JSON.stringify(h.sessionManager.getEntries())).toContain("scheduled context must survive");
	});

	it("keeps a next-turn message a user prompt drained when an interrupt stops that prompt's setup", async () => {
		const streamStarted = Promise.withResolvers<void>();
		const finishStream = Promise.withResolvers<void>();
		const h = await createSession([
			async () => {
				streamStarted.resolve();
				await finishStream.promise;
				return { content: ["first answer"] };
			},
			{ content: ["third answer"] },
		]);
		// Sent while a turn streams, the aside waits in the next-turn queue for the next user prompt.
		const first = h.session.prompt("first request");
		await streamStarted.promise;
		await h.session.sendCustomMessage(
			{ customType: "review-context", content: "queued aside must survive", display: false },
			{ deliverAs: "nextTurn" },
		);
		finishStream.resolve();
		await first;
		await h.session.waitForIdle();
		// Hold the prompt in its pre-prompt maintenance, after it took the queued aside.
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const maintenance = SessionMaintenance.prototype.runPrePromptCompactionIfNeeded;
		const hold = spyOn(SessionMaintenance.prototype, "runPrePromptCompactionIfNeeded").mockImplementationOnce(
			async function (this: SessionMaintenance, ...args) {
				reached.resolve();
				await release.promise;
				return maintenance.apply(this, args);
			},
		);
		const second = h.session.prompt("second request");
		await reached.promise;
		const abort = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		release.resolve();
		await abort;
		await second;
		hold.mockRestore();
		expect(h.mock.calls).toHaveLength(1);
		expect(JSON.stringify(h.mock.calls[0]?.context.messages)).not.toContain("queued aside must survive");

		await h.session.prompt("third request");
		await h.session.waitForIdle();

		expect(h.mock.calls).toHaveLength(2);
		expect(JSON.stringify(h.mock.calls[1]?.context.messages)).toContain("queued aside must survive");
	});
});
