import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildMemoryToolDeveloperInstructions,
	pendingMemorySnapshotCommit,
	recordMemorySnapshotOnCurrentBranch,
	saveLearnedLesson,
	stagedMemorySnapshot,
} from "@oh-my-pi/pi-coding-agent/memories";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionTools, type SessionToolsHost } from "@oh-my-pi/pi-coding-agent/session/session-tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const MEMORY_SNAPSHOT_TYPE = "memory-snapshot";

function snapshotCount(sessionManager: SessionManager): number {
	let count = 0;
	for (const entry of sessionManager.getBranchView()) {
		if (entry.type === "custom" && entry.customType === MEMORY_SNAPSHOT_TYPE) count++;
	}
	return count;
}

describe("memory snapshot with a replaced system prompt", () => {
	/**
	 * Build a session whose prompt is replaced by the given function.
	 *
	 * `created` counts the snapshots the transcript holds once the session
	 * exists, `dispatched` after the prompt's recorder runs — the two differ
	 * because a snapshot belongs to a request, not to a session.
	 */
	async function countSnapshots(
		systemPrompt?: (defaultPrompt: string[]) => string[],
		options?: { memory?: boolean },
	): Promise<{ created: number; dispatched: number }> {
		const tempDir = TempDir.createSync("@omp-memory-snapshot-override-");
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const settings = Settings.isolated({ "memory.backend": "local" });
		await settings.reloadForCwd(tempDir.path());
		if (options?.memory !== false) {
			await saveLearnedLesson(tempDir.path(), tempDir.path(), { content: "Override lesson" });
		}

		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			agentRegistry: new AgentRegistry(),
			authStorage,
			modelRegistry,
			settings,
			model,
			...(systemPrompt ? { systemPrompt } : {}),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		const created = snapshotCount(sessionManager);
		// The prompt is now dispatched: the block it carries is recorded, the
		// block a replacement dropped is not.
		pendingMemorySnapshotCommit(sessionManager)?.();
		const dispatched = snapshotCount(sessionManager);
		await session.dispose();
		authStorage.close();
		await tempDir.remove();
		return { created, dispatched };
	}

	it("records no snapshot until the replacement prompt is dispatched", async () => {
		// Creating a session builds a prompt but sends nothing: recording the
		// block then would make a later resume restore memory this session never
		// used, and a replacement that dropped the block never carries it.
		expect(await countSnapshots(() => ["custom prompt"])).toEqual({ created: 0, dispatched: 0 });
	}, 30_000);

	it("records the snapshot once the replacement prompt that keeps the block is dispatched", async () => {
		expect(await countSnapshots(defaultPrompt => defaultPrompt)).toEqual({ created: 0, dispatched: 1 });
	}, 30_000);

	it("records the snapshot once a base prompt that keeps the block is dispatched", async () => {
		expect(await countSnapshots()).toEqual({ created: 0, dispatched: 1 });
	}, 30_000);

	it("records the snapshot when the replacement prompt splits the memory block across parts", async () => {
		// The provider receives the whole block either way, so the snapshot is
		// recorded: the parts are joined before the block is looked for.
		expect(await countSnapshots(defaultPrompt => defaultPrompt.flatMap(part => part.split("\n")))).toEqual({
			created: 0,
			dispatched: 1,
		});
	}, 30_000);

	it("records the snapshot when the replacement prompt splits the block mid-word", async () => {
		// A callback may chunk at any boundary; the provider receives the parts
		// as one text and the block is intact there, so it is carried. Splitting
		// inside the lesson's own word keeps the split off existing whitespace.
		expect(
			await countSnapshots(defaultPrompt =>
				defaultPrompt.flatMap(part => {
					const at = part.indexOf("Overr");
					return at < 0 ? [part] : [part.slice(0, at + 3), part.slice(at + 3)];
				}),
			),
		).toEqual({ created: 0, dispatched: 1 });
	}, 30_000);

	it("records no snapshot when the memory files hold nothing injectable", async () => {
		// An empty memory store injects no block, so there is nothing to record —
		// not even for a prompt that drops the block.
		expect(await countSnapshots(() => ["custom prompt"], { memory: false })).toEqual({
			created: 0,
			dispatched: 0,
		});
	}, 30_000);

	it("records the snapshot on the branch a turn continues after a navigation", async () => {
		// The base prompt carries the memory block and is not rebuilt when the
		// user navigates: the branch the turn continues on must record a
		// snapshot of its own, or its later resume rereads the memory files.
		const tempDir = TempDir.createSync("@omp-memory-snapshot-restage-");
		try {
			const settings = Settings.isolated({ "memory.backend": "local" });
			await settings.reloadForCwd(tempDir.path());
			await saveLearnedLesson(tempDir.path(), tempDir.path(), { content: "Restaged lesson" });

			const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
			const messageId = sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "hi" }],
				timestamp: Date.now(),
			});
			sessionManager.appendMessage(createAssistantMessage("hello"));
			await sessionManager.flush();

			const block = await buildMemoryToolDeveloperInstructions(
				tempDir.path(),
				tempDir.path(),
				settings,
				sessionManager,
			);
			if (!block) throw new Error("Expected a memory block");
			pendingMemorySnapshotCommit(sessionManager)?.();
			expect(snapshotCount(sessionManager)).toBe(1);

			// The user navigates back to the first user message: the branch
			// moves off the snapshot.
			sessionManager.branch(messageId);
			expect(snapshotCount(sessionManager)).toBe(0);

			const host = {
				agent: { state: { messages: [], tools: [] } },
				sessionManager,
				settings,
				evalPreludes: () => [],
				sessionAgents: () => [],
				model: () => undefined,
				agentKind: () => "main",
				isStreaming: () => false,
				isDisposed: () => false,
				queuedMessageCount: () => 0,
				planModeEnabled: () => false,
			} as unknown as SessionToolsHost;
			const tools = new SessionTools(host, { baseSystemPrompt: [block] });

			const preparation = await tools.buildSystemPromptForAgentStart("hi", () => true);
			expect(preparation.commit).toBeDefined();
			preparation.commit?.(tools.baseSystemPrompt);
			// Committing the preparation validates the prompt; the block is
			// recorded by the dispatch that sends it.
			expect(snapshotCount(sessionManager)).toBe(0);

			recordMemorySnapshotOnCurrentBranch(sessionManager, tools.effectiveSystemPrompt);
			expect(snapshotCount(sessionManager)).toBe(1);
		} finally {
			await tempDir.remove();
		}
	}, 30_000);

	it("records nothing when a rebuilt base prompt is applied while idle", async () => {
		// A tool, MCP or policy reconcile rebuilds the base prompt without a
		// request: publishing it must not leave a snapshot behind that a later
		// resume would restore instead of the current memory.
		const tempDir = TempDir.createSync("@omp-memory-snapshot-idle-rebuild-");
		try {
			const settings = Settings.isolated({ "memory.backend": "local" });
			await settings.reloadForCwd(tempDir.path());
			await saveLearnedLesson(tempDir.path(), tempDir.path(), { content: "Idle rebuild lesson" });

			const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
			const block = await buildMemoryToolDeveloperInstructions(
				tempDir.path(),
				tempDir.path(),
				settings,
				sessionManager,
			);
			if (!block) throw new Error("Expected a memory block");

			const host = {
				agent: { state: { messages: [], tools: [] }, setSystemPrompt: () => {} },
				sessionManager,
				settings,
				evalPreludes: () => [],
				sessionAgents: () => [],
				model: () => undefined,
				agentKind: () => "main",
				isStreaming: () => false,
				isDisposed: () => false,
				queuedMessageCount: () => 0,
				planModeEnabled: () => false,
				clearMemoryPromotionSnapshot: () => {},
				clearInheritedProviderPromptCacheKey: () => {},
			} as unknown as SessionToolsHost;
			const tools = new SessionTools(host, {
				baseSystemPrompt: ["base"],
				rebuildSystemPrompt: async () => ({
					systemPrompt: [block],
					commit: stagedMemorySnapshot(sessionManager)?.commit([block]),
				}),
			});

			await tools.refreshBaseSystemPrompt();
			expect(snapshotCount(sessionManager)).toBe(0);

			// The next dispatch carries the rebuilt base and records it.
			tools.commitPendingMemorySnapshot();
			expect(snapshotCount(sessionManager)).toBe(1);
		} finally {
			await tempDir.remove();
		}
	}, 30_000);

	it("records no snapshot when the prompt is empty", async () => {
		const previous = process.env.NULL_PROMPT;
		process.env.NULL_PROMPT = "true";
		try {
			// An empty prompt carries no memory block: recording the snapshot
			// would pin memory this session never sent.
			expect(await countSnapshots()).toEqual({ created: 0, dispatched: 0 });
		} finally {
			if (previous === undefined) delete process.env.NULL_PROMPT;
			else process.env.NULL_PROMPT = previous;
		}
	}, 30_000);

	it("records no snapshot when the prompt build throws", async () => {
		// A build that never produced a prompt must not leave the staged
		// block pending: the next build would reuse a block no prompt ever
		// sent, and a later resume would restore it as if it had.
		const tempDir = TempDir.createSync("@omp-memory-snapshot-override-");
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const settings = Settings.isolated({ "memory.backend": "local" });
		await settings.reloadForCwd(tempDir.path());
		await saveLearnedLesson(tempDir.path(), tempDir.path(), { content: "Override lesson" });

		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		try {
			await expect(
				createAgentSession({
					cwd: tempDir.path(),
					agentDir: tempDir.path(),
					sessionManager,
					agentRegistry: new AgentRegistry(),
					authStorage,
					modelRegistry,
					settings,
					model,
					systemPrompt: () => {
						throw new Error("the replacement prompt failed");
					},
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					workspaceTree: {
						rootPath: tempDir.path(),
						rendered: "",
						truncated: false,
						totalLines: 0,
						agentsMdFiles: [],
					},
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
				}),
			).rejects.toThrow("the replacement prompt failed");
			expect(snapshotCount(sessionManager)).toBe(0);
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	}, 30_000);
});
