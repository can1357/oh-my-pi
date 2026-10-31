// The Codex websocket prewarm is a detached task started at session creation that parks on the
// API-key resolution. A session disposed while the key is still held must not let it open a
// connection afterwards: `#closeAllProviderSessions("dispose")` has already drained the provider
// session map, so a socket created after it is never closed.
import { afterEach, expect, it, vi } from "bun:test";
import * as codexResponses from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const sessions: AgentSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) {
		if (!session.isDisposed) await session.dispose();
	}
	vi.restoreAllMocks();
});

/**
 * Start a session on a Codex model that prefers websockets, holding the API key the prewarm
 * awaits. Records whether each prewarm call happened on a disposed session.
 */
async function startPrewarmSession(tempDir: TempDir) {
	const model = getBundledModel("openai-codex", "gpt-6-astra");
	if (!model || model.api !== "openai-codex-responses" || model.preferWebsockets !== true) {
		throw new Error("Expected a bundled openai-codex model that prefers websockets");
	}
	const prewarmCalls: Array<{ disposed: boolean }> = [];
	const current: { session?: AgentSession } = {};
	vi.spyOn(codexResponses, "prewarmOpenAICodexResponses").mockImplementation(async () => {
		prewarmCalls.push({ disposed: current.session?.isDisposed === true });
	});
	const apiKey = Promise.withResolvers<string>();
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	const created = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		settings: Settings.isolated({ "compaction.enabled": false }),
		model,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		bindProcessState: false,
		getApiKey: () => apiKey.promise,
	});
	const session = created.session;
	current.session = session;
	sessions.push(session);
	// The prewarm is parked on the held key, so nothing has run yet.
	expect(prewarmCalls).toEqual([]);
	return { session, prewarmCalls, releaseApiKey: () => apiKey.resolve("sk-test"), close: () => authStorage.close() };
}

/** Let the detached prewarm task resume past its awaits. */
async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

it("prewarms the Codex connection on a live session", async () => {
	using tempDir = TempDir.createSync("@pi-dispose-codex-prewarm-live-");
	const { prewarmCalls, releaseApiKey, close } = await startPrewarmSession(tempDir);
	try {
		releaseApiKey();
		await drainMicrotasks();
		expect(prewarmCalls).toEqual([{ disposed: false }]);
	} finally {
		close();
	}
}, 20_000);

it("does not prewarm a Codex connection once disposal has begun", async () => {
	using tempDir = TempDir.createSync("@pi-dispose-codex-prewarm-gap-");
	const { session, prewarmCalls, releaseApiKey, close } = await startPrewarmSession(tempDir);
	try {
		await session.dispose();
		expect(session.isDisposed).toBe(true);
		releaseApiKey();
		await drainMicrotasks();
		expect(prewarmCalls).toEqual([]);
	} finally {
		close();
	}
}, 20_000);
