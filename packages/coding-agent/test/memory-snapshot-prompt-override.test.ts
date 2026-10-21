import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildMemoryToolDeveloperInstructions,
	pendingMemorySnapshotCommit,
	saveLearnedLesson,
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
	/** Build a session whose prompt is replaced by the given function. */
	async function countSnapshots(
		systemPrompt?: (defaultPrompt: string[]) => string[],
		options?: { memory?: boolean },
	): Promise<number> {
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
		const count = snapshotCount(sessionManager);
		await session.dispose();
		authStorage.close();
		await tempDir.remove();
		return count;
	}

	it("records no snapshot when the replacement prompt drops the memory block", async () => {
		expect(await countSnapshots(() => ["custom prompt"])).toBe(0);
	}, 30_000);

	it("records the snapshot when the replacement prompt keeps the memory block", async () => {
		expect(await countSnapshots(defaultPrompt => defaultPrompt)).toBe(1);
	}, 30_000);

	it("records the snapshot when the base prompt keeps the memory block", async () => {
		expect(await countSnapshots()).toBe(1);
	}, 30_000);

	it("records the snapshot when the replacement prompt splits the memory block across parts", async () => {
		// The provider receives the whole block either way, so the snapshot is
		// recorded: the parts are joined before the block is looked for.
		expect(await countSnapshots(defaultPrompt => defaultPrompt.flatMap(part => part.split("\n")))).toBe(1);
	}, 30_000);

	it("records no snapshot when the memory files hold nothing injectable", async () => {
		// An empty memory store injects no block, so there is nothing to record —
		// not even for a prompt that drops the block.
		expect(await countSnapshots(() => ["custom prompt"], { memory: false })).toBe(0);
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
			preparation.commit?.();

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
			expect(await countSnapshots()).toBe(0);
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
