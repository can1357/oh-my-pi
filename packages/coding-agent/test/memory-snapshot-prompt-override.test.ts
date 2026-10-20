import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { saveLearnedLesson } from "@oh-my-pi/pi-coding-agent/memories";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

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
});
