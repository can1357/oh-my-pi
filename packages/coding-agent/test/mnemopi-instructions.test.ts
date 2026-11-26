/**
 * The Mnemopi memory instructions tell the model whether its completed turns are
 * retained automatically. That is true only when `mnemopi.autoRetain` is on and the
 * session is top-level: a subagent aliases its parent's banks and retains nothing of
 * its own. A session renders its first system prompt before its Mnemopi state exists,
 * so these tests read the line in the system prompt each real request carries.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as settingsStream from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { TempDir } from "@oh-my-pi/pi-utils";

const model = getBundledModel("muse-code", "muse-spark-1.3-contributor");

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

/** What one request's system prompt says about automatic retention. */
function retentionClaim(systemPrompt: readonly string[]): "retained" | "not retained" | "silent" {
	const text = systemPrompt.join("\n");
	if (/\bnot retained automatically\b/.test(text)) return "not retained";
	if (/\bretained automatically\b/.test(text)) return "retained";
	return "silent";
}

/**
 * Real SDK sessions on one Mnemopi store, every model request's system prompt captured.
 * Each session starts Mnemopi in the background, as in production; `started(n)` settles
 * when the n-th start has finished.
 */
async function sdkHarness(dir: TempDir, overrides: Record<string, unknown>) {
	const auth = await AuthStorage.create(dir.join("auth.db"));
	auth.keys.setRuntime("muse-code", "test-key");
	const systemPrompts: string[][] = [];
	const mock = createMockModel({ handler: { content: [{ type: "text", text: "ok" }] } });
	const realStreamFactory = settingsStream.createSettingsAwareStreamFn;
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
	vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slow) =>
		realStreamFactory(
			settings,
			(streamModel, context, options) => {
				systemPrompts.push([...(context.systemPrompt ?? [])]);
				return mock.stream(streamModel, context, options);
			},
			slow,
		),
	);
	const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const pending = [...starts];
	const realStart = mnemopiBackend.start;
	vi.spyOn(mnemopiBackend, "start").mockImplementation(async options => {
		await realStart.call(mnemopiBackend, options);
		pending.shift()?.resolve();
	});
	const settings = Settings.isolated({
		"async.enabled": true,
		"marketplace.autoUpdate": "off",
		"compaction.enabled": false,
		"task.enableLsp": false,
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
		"mnemopi.dbPath": dir.join("mnemopi.db"),
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": "none",
		"mnemopi.recallRelevance": "off",
		// Every turn is a retain turn, so a test sees the first turn retained or not.
		"mnemopi.retainEveryNTurns": 1,
		...overrides,
	});
	const sessions: AgentSession[] = [];
	const open = async (name: string, subagentOf?: AgentSession): Promise<AgentSession> => {
		const parentState = subagentOf ? getMnemopiSessionState(subagentOf) : undefined;
		if (subagentOf && !parentState) throw new Error("the parent session has no Mnemopi state");
		const { session } = await sdk.createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage: auth,
			model,
			settings,
			sessionManager: SessionManager.create(dir.path(), dir.join(name)),
			toolNames: [],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			...(subagentOf ? { taskDepth: 1, parentMnemopiSessionState: parentState } : {}),
		});
		sessions.push(session);
		return session;
	};
	return {
		systemPrompts,
		open,
		started: (n: number) => starts[n]!.promise,
		async close() {
			for (const session of sessions.reverse()) await session.dispose();
			auth.close();
		},
	};
}

/** Sends one prompt and waits for the turn's auto-retain, so `lastRetainedTurn` shows whether it ran. */
async function promptAndRetain(session: AgentSession, text: string): Promise<void> {
	const state = getMnemopiSessionState(session);
	if (!state) throw new Error("the session has no Mnemopi state");
	const retains: Promise<void>[] = [];
	const realRetain = state.maybeRetainOnAgentEnd.bind(state);
	state.maybeRetainOnAgentEnd = messages => {
		const retain = realRetain(messages);
		retains.push(retain);
		return retain;
	};
	await session.prompt(text);
	await Promise.all(retains);
}

describe("Mnemopi memory instructions in the system prompt a real session sends", () => {
	it("say turns are retained automatically in a top-level session with the default settings", async () => {
		using dir = TempDir.createSync("@mnemopi-instructions-");
		const harness = await sdkHarness(dir, {});
		try {
			const session = await harness.open("main");
			await harness.started(0);
			await promptAndRetain(session, "Say ok.");
			expect(getMnemopiSessionState(session)?.lastRetainedTurn).toBe(1);
			// Rebuild the prompt with the Mnemopi state installed, as a recall or a settings edit does.
			await session.refreshBaseSystemPrompt();
			await promptAndRetain(session, "Say ok again.");
			// The first request's prompt was built before the Mnemopi state existed, the second after it.
			expect(harness.systemPrompts.map(retentionClaim)).toEqual(["retained", "retained"]);
		} finally {
			await harness.close();
		}
	}, 60_000);

	it("say turns are not retained automatically with autoRetain off", async () => {
		using dir = TempDir.createSync("@mnemopi-instructions-");
		const harness = await sdkHarness(dir, { "mnemopi.autoRetain": false });
		try {
			const session = await harness.open("main");
			await harness.started(0);
			await promptAndRetain(session, "Say ok.");
			expect(getMnemopiSessionState(session)?.lastRetainedTurn).toBe(0);
			expect(harness.systemPrompts.map(retentionClaim)).toEqual(["not retained"]);
		} finally {
			await harness.close();
		}
	}, 60_000);

	it("say a subagent's turns are not retained automatically", async () => {
		using dir = TempDir.createSync("@mnemopi-instructions-");
		const harness = await sdkHarness(dir, {});
		try {
			const parent = await harness.open("main");
			await harness.started(0);
			const child = await harness.open("child", parent);
			await harness.started(1);
			expect(getMnemopiSessionState(child)?.aliasOf).toBe(getMnemopiSessionState(parent));
			await child.prompt("Say ok.");
			expect(harness.systemPrompts.map(retentionClaim)).toEqual(["not retained"]);
		} finally {
			await harness.close();
		}
	}, 60_000);
});
