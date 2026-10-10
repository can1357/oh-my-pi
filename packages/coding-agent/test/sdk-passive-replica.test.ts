/**
 * A passive replica (a hosted TUI client's local session) adopts the id of a session another process runs. Through the
 * SDK it must neither start nor read a memory backend (no state, no memory prompt, no database), and disposing it must
 * not stop the process-wide workers (Mnemopi embedding, tiny title model) that ordinary sessions of the process use.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiEmbedClient } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/** Opens the memory block the Mnemopi backend appends to a session's system prompt. */
const MEMORY_PROMPT_MARKER = "local Mnemopi long-term memory";

describe("createAgentSession passiveReplica", () => {
	const tempDirs: string[] = [];
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-passive-replica-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `pi-sdk-passive-replica-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetMemoryForTests();
		for (const tempDir of tempDirs.splice(0)) removeSyncWithRetries(tempDir);
	});

	afterAll(() => {
		removeSyncWithRetries(registryAuthDir);
	});

	/**
	 * A top-level session with the Mnemopi backend selected and auto-learn on: the configuration that makes an ordinary
	 * session open its memory database and install its memory state before `createAgentSession` returns.
	 */
	const options = (tempDir: string, passiveReplica: boolean): CreateAgentSessionOptions => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({
			"memory.backend": "mnemopi",
			"autolearn.enabled": true,
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
		}),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		passiveReplica,
	});

	/** Files a Mnemopi backend created under the agent directory (its database and bank databases). */
	const memoryFiles = (agentDir: string): string[] =>
		fs
			.readdirSync(agentDir, { recursive: true, encoding: "utf8" })
			.filter(file => file.split(path.sep).includes("mnemopi"));

	it("gives an ordinary session its memory and a passive replica of the same configuration none", async () => {
		const ordinaryDir = makeTempDir();
		const passiveDir = makeTempDir();

		const { session: ordinary } = await createAgentSession(options(ordinaryDir, false));
		try {
			expect(ordinary.memoryEnabled).toBe(true);
			expect(ordinary.getMnemopiSessionState()).toBeDefined();
			expect(ordinary.systemPrompt.join("\n")).toContain(MEMORY_PROMPT_MARKER);
			expect(memoryFiles(ordinaryDir)).not.toHaveLength(0);
		} finally {
			await ordinary.dispose();
		}

		const { session: passive } = await createAgentSession(options(passiveDir, true));
		try {
			expect(passive.passiveReplica).toBe(true);
			expect(passive.memoryEnabled).toBe(false);
			expect(passive.getMnemopiSessionState()).toBeUndefined();
			expect(passive.getHindsightSessionState()).toBeUndefined();
			expect(passive.systemPrompt.join("\n")).not.toContain(MEMORY_PROMPT_MARKER);
			expect(memoryFiles(passiveDir)).toEqual([]);
		} finally {
			await passive.dispose();
		}
		// Disposing it consolidated and retained nothing either.
		expect(memoryFiles(passiveDir)).toEqual([]);
	});

	it("leaves the process-wide workers to the ordinary sessions that use them when a passive replica is disposed", async () => {
		// Call-through: the real teardown runs, the spies only observe whether a session asked for it.
		const stopEmbedding = vi.spyOn(mnemopiEmbedClient, "terminate");
		const stopTitles = vi.spyOn(tinyTitleClient, "terminate");

		const { session: ordinary } = await createAgentSession(options(makeTempDir(), false));
		const { session: passive } = await createAgentSession(options(makeTempDir(), true));
		try {
			await passive.dispose();
			expect(stopEmbedding).not.toHaveBeenCalled();
			expect(stopTitles).not.toHaveBeenCalled();
			// The ordinary session's memory is still installed and open.
			expect(ordinary.getMnemopiSessionState()).toBeDefined();
		} finally {
			await ordinary.dispose();
		}
		// Control: an ordinary session's disposal does stop them, so the silence above is the passive guard.
		expect(stopEmbedding).toHaveBeenCalled();
		expect(stopTitles).toHaveBeenCalled();
	});
});
