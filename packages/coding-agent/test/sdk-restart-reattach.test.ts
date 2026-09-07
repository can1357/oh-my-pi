/**
 * Reconstruction contract (host-owned): after a restart the embedder reopens the
 * durable session and rebuilds the replacement through the SAME factory, OMITTING
 * the discovery-backed preload fields (contextFiles / skills / promptTemplates /
 * slashCommands / preloadedExtensions) so `createAgentSession` re-runs disk
 * discovery and picks up host-staged changes — the whole point of restart.
 *
 * The in-process recycle shares OMP's process-global discovery/capability caches:
 * the first session's disk discovery warms them with the ORIGINAL bytes, so a
 * naive reopen re-reads the cache and serves stale content. `requestRestart()`
 * must invalidate those caches itself (inside `#doRequestRestart`, before the
 * host `onRestartRequested` callback) so a host following the callback contract
 * verbatim — reopen + rebuild, no manual cache reset — still sees disk. This
 * proves that boundary end to end: the host callback changes AGENTS.md on disk
 * and rebuilds, and the replacement's system prompt carries the CHANGED content,
 * with NO explicit resetDiscoveryCaches() anywhere in the reconstruction.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "restart-reattach-model",
		name: "Restart Reattach Model",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

describe("restart reconstruction reattach", () => {
	const authStorages: AuthStorage[] = [];

	afterEach(() => {
		for (const authStorage of authStorages.splice(0)) authStorage.close();
	});

	it("recycled session reloads on-disk-changed context without a manual cache reset", async () => {
		using tempDir = TempDir.createSync("@pi-restart-reattach-");
		const marker = Bun.nanoseconds().toString(36);
		const original = `ORIGINAL_RULES_${marker}`;
		const updated = `UPDATED_RULES_${marker}`;
		const agentsMd = path.join(tempDir.path(), "AGENTS.md");
		await fs.writeFile(agentsMd, original);

		const api = `restart-reattach-${marker}`;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		let replacement: AgentSession | undefined;
		let reopenedManager: SessionManager | undefined;

		// The host reconstruction, wired exactly as an embedder would: reopen the
		// durable session and rebuild through the SAME factory with the
		// discovery-backed preload OMITTED — and NO manual cache reset. The recycle
		// only picks up the on-disk edit if requestRestart() cleared the shared
		// discovery caches itself before this callback fired.
		const onRestartRequested = async ({ sessionFile }: { sessionId: string; sessionFile: string }) => {
			// The host stages its AGENTS.md edit for the recycle to pick up.
			await fs.writeFile(agentsMd, updated);
			reopenedManager = await SessionManager.open(sessionFile, tempDir.path());
			const rebuilt = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: reopenedManager,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({ "compaction.enabled": false }),
				model: buildLocalModel(api),
				disableExtensionDiscovery: true,
				// Discovery-backed preload intentionally omitted so restart reloads disk.
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			replacement = rebuilt.session;
		};

		// First session: OMIT contextFiles so its own disk discovery warms the
		// process-global capability cache with the ORIGINAL bytes — the stale
		// content the recycle must not serve.
		const firstManager = SessionManager.create(tempDir.path());
		const { session: first } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: firstManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(api),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			onRestartRequested,
		});
		await first.refreshBaseSystemPrompt();
		expect(first.systemPrompt.join("\n")).toContain(original);
		// Persist the transcript so the reopen inside the callback has a durable
		// file (requestRestart() runs flush + ensureOnDisk itself before dispose;
		// this mirrors it, since persistence is otherwise lazy until a turn writes).
		await firstManager.ensureOnDisk();
		await firstManager.flush();

		// Drive the real restart: waitForIdle -> durability barrier -> dispose ->
		// cache invalidation -> onRestartRequested. `ok` proves the callback ran.
		const result = await first.requestRestart();
		expect(result.ok).toBe(true);

		try {
			if (!replacement) throw new Error("Expected the restart callback to build a replacement session");
			await replacement.refreshBaseSystemPrompt();
			const rebuilt = replacement.systemPrompt.join("\n");
			expect(rebuilt).toContain(updated);
			expect(rebuilt).not.toContain(original);
		} finally {
			await replacement?.dispose();
			await reopenedManager?.close();
		}
	});

	it("preserves an empty moved session file across restart disposal so reattach can reopen it", async () => {
		using tempDir = TempDir.createSync("@pi-restart-empty-move-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		// The captured file the restart persists for reattachment: it must still
		// exist when onRestartRequested fires, even though it is an empty moved
		// session that generic dispose() would delete via cleanupEmptyMoveSession.
		let fileExistedInCallback: boolean | undefined;
		let openSucceeded: boolean | undefined;
		let reopenedManager: SessionManager | undefined;
		const onRestartRequested = async ({ sessionFile }: { sessionId: string; sessionFile: string }) => {
			fileExistedInCallback = await fs
				.access(sessionFile)
				.then(() => true)
				.catch(() => false);
			try {
				reopenedManager = await SessionManager.open(sessionFile, tempDir.path());
				openSucceeded = true;
			} catch {
				openSucceeded = false;
			}
		};

		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			onRestartRequested,
		});

		// Mark the current (message-free) session file as the destination of an
		// empty /move, exactly as the move path does. No user/assistant message is
		// ever recorded, so cleanupEmptyMoveSession considers it deletable.
		const sessionFile = session.sessionFile;
		if (sessionFile === undefined) throw new Error("Expected a session file");
		session.markMovedFromEmptySessionFile(sessionFile);

		// Drive the real restart: waitForIdle -> flush + ensureOnDisk -> dispose
		// (which must NOT run empty-move cleanup for the handoff) -> callback.
		const result = await session.requestRestart();
		expect(result.ok).toBe(true);

		try {
			// The captured file survived disposal, so the documented reattachment
			// (SessionManager.open) succeeds.
			expect(fileExistedInCallback).toBe(true);
			expect(openSucceeded).toBe(true);
		} finally {
			await reopenedManager?.close();
		}
	});
});
