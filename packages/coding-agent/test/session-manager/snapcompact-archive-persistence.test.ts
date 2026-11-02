import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

const TRUNCATION_NOTICE = "[Session persistence truncated large content]";
const NEWEST_SENTINEL = "NEWEST ARCHIVED TURN SENTINEL";

function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

function preparation(
	messages: Message[],
	previousPreserveData?: Record<string, unknown>,
): snapcompact.CompactionPreparation<Message> {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: messages,
		turnPrefixMessages: [],
		tokensBefore: 200_000,
		previousSummary: undefined,
		previousPreserveData,
		fileOps: snapcompact.createFileOps(),
	};
}

describe("snapcompact archive persistence", () => {
	const tempDirs: string[] = [];
	const originalAgentDir = getAgentDir();

	async function makeTempDir(): Promise<string> {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-archive-persist-"));
		tempDirs.push(dir);
		return dir;
	}

	beforeEach(async () => {
		setAgentDir(await makeTempDir());
	});

	afterEach(async () => {
		setAgentDir(originalAgentDir);
		await Promise.all(tempDirs.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })));
	});

	it("re-compacts a resumed session from the archive's full source text", async () => {
		const turns = Array.from({ length: 130 }, (_unused, index) =>
			userMessage(`Turn ${index}: ${"archived history that must survive a resume. ".repeat(110)}`),
		);
		turns.push(userMessage(NEWEST_SENTINEL));
		const first = await snapcompact.compact(preparation(turns));
		const firstArchive = snapcompact.getPreservedArchive(first.preserveData)!;
		expect(firstArchive.text!.length).toBeGreaterThan(600_000);

		const cwd = await makeTempDir();
		const sessionDir = path.join(cwd, "sessions");
		const session = SessionManager.create(cwd, sessionDir);
		const anchor = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const compactionId = session.appendCompaction(first.summary, undefined, anchor, first.tokensBefore, {
			preserveData: first.preserveData,
		});
		await session.flush();
		const sessionFile = session.getSessionFile()!;
		await session.close();

		const resumed = await SessionManager.open(sessionFile, sessionDir, undefined, { suppressBreadcrumb: true });
		const entry = resumed.getEntry(compactionId);
		if (entry?.type !== "compaction") throw new Error("Expected the reloaded compaction entry");
		const second = await snapcompact.compact(
			preparation([userMessage("A short follow-up turn.")], entry.preserveData),
		);
		await resumed.close();

		const secondArchive = snapcompact.getPreservedArchive(second.preserveData)!;
		const source = snapcompact.archiveSourceText(secondArchive)!;
		expect(source).not.toContain(TRUNCATION_NOTICE);
		expect(source).toContain(NEWEST_SENTINEL);
		expect(secondArchive.totalChars).toBeGreaterThanOrEqual(firstArchive.totalChars);
	}, 30_000);
});
