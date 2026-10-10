import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

// Three ~1.6 MB base64 frames (~4.8 MB): only the newest fits the 3 MB default frame-byte budget.
const FRAME_DATA = [7, 8, 9].map(fill => Buffer.alloc(1_200_000, fill).toString("base64"));

interface PersistedSession {
	cwd: string;
	agentDir: string;
	sessionDir: string;
	sessionFile: string;
}

describe("snapcompact.frameBytesBudget on a resumed session", () => {
	const tempDirs: string[] = [];
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
	});

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) removeSyncWithRetries(tempDir);
	});

	/** Persist a session whose latest compaction carries a snapcompact archive over the default byte budget. */
	async function persistArchivedSession(): Promise<PersistedSession> {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-snapcompact-frame-budget-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const sessionDir = path.join(tempDir, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const keptId = manager.appendMessage({ role: "user", content: "continue the refactor", timestamp: 1 });
		// A session reaches disk only once it holds an assistant message.
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Continuing." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 2,
		});
		const archive: snapcompact.Archive = {
			frames: FRAME_DATA.map(data => ({
				data,
				mimeType: "image/png",
				cols: 175,
				rows: 120,
				chars: 21_000,
				font: "8x13",
				variant: "bw",
			})),
			totalChars: 63_000,
			truncatedChars: 0,
			text: "archived source text",
		};
		manager.appendCompaction("Resume the prior conversation.", undefined, keptId, 200_000, {
			method: "snapcompact",
			preserveData: { [snapcompact.PRESERVE_KEY]: archive },
		});
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		await manager.close();
		return { cwd, agentDir: path.join(tempDir, "agent"), sessionDir, sessionFile };
	}

	/** Frame payloads the resumed agent will send with its compaction summary. */
	async function resumedFrames(persisted: PersistedSession, settings: Settings): Promise<string[]> {
		const { session } = await createAgentSession({
			cwd: persisted.cwd,
			agentDir: persisted.agentDir,
			modelRegistry,
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			settings,
			sessionManager: await SessionManager.open(persisted.sessionFile, persisted.sessionDir),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
		});
		try {
			const summary = session.agent.state.messages.find(message => message.role === "compactionSummary");
			if (summary?.role !== "compactionSummary") throw new Error("Expected a compaction summary in resumed context");
			return (summary.blocks ?? [])
				.filter((block): block is ImageContent => block.type === "image")
				.map(block => block.data);
		} finally {
			await session.dispose();
		}
	}

	it("drops the oldest frames past the default 3 MB budget", async () => {
		const persisted = await persistArchivedSession();
		expect(await resumedFrames(persisted, Settings.isolated())).toEqual([FRAME_DATA[2]]);
	});

	it("attaches every archived frame when the configured budget covers them", async () => {
		const persisted = await persistArchivedSession();
		const settings = Settings.isolated({ "snapcompact.frameBytesBudget": 8_000_000 });
		expect(await resumedFrames(persisted, settings)).toEqual(FRAME_DATA);
	});
});
