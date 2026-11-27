/**
 * Resume restores advisor spend from the advisor transcripts the recorder
 * wrote next to the session (`<session>/__advisor*.jsonl`). The recorder
 * writes through the session storage, so under `session.storage: sql` those
 * transcripts are rows and nothing is on disk: the cost scan must list and
 * read them through the same storage, or a resumed session restarts its
 * advisor budget at zero.
 */
import { SQL } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	AdvisorTranscriptRecorder,
	advisorTranscriptFilename,
	loadAdvisorTranscriptCosts,
} from "@oh-my-pi/pi-coding-agent/advisor/transcript-recorder";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const previous = defaultSessionStorage();
const clients: SQL[] = [];

afterEach(async () => {
	setDefaultSessionStorage(previous);
	for (const client of clients.splice(0)) await client.end();
});

const backends: Array<[string, () => Promise<SessionStorage>]> = [
	["file", async () => new FileSessionStorage()],
	[
		"sql",
		async () => {
			const client = new SQL("sqlite::memory:");
			clients.push(client);
			return SqlSessionStorage.create({ client });
		},
	],
];

function assistantMessage(cost: number): AgentMessage {
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "review" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-advisor-model",
		usage: {
			input: 1,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 4,
			cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop" as const,
		timestamp: 1,
	};
	return message as unknown as AgentMessage;
}

describe("loadAdvisorTranscriptCosts", () => {
	it.each(backends)("restores the session's advisor spend from the %s storage", async (_name, open) => {
		using tmp = TempDir.createSync("@omp-advisor-costs-storage-");
		setDefaultSessionStorage(await open());
		const sessionFile = tmp.join("sess.jsonl");
		const primary = new AdvisorTranscriptRecorder(
			() => sessionFile,
			() => tmp.path(),
		);
		const security = new AdvisorTranscriptRecorder(
			() => sessionFile,
			() => tmp.path(),
			advisorTranscriptFilename("security"),
		);
		// A subagent's advisor bills the subagent, not this session.
		const subagent = new AdvisorTranscriptRecorder(
			() => path.join(tmp.join("sess"), "Sub.jsonl"),
			() => tmp.path(),
		);
		primary.record(assistantMessage(0.25));
		security.record(assistantMessage(0.25));
		security.record(assistantMessage(0.5));
		subagent.record(assistantMessage(4));
		await Promise.all([primary.close(), security.close(), subagent.close()]);

		expect(Object.fromEntries(await loadAdvisorTranscriptCosts(sessionFile))).toEqual({
			"": 0.25,
			security: 0.75,
		});
	});

	it("writes and restores advisor spend through its parent manager's SQL storage", async () => {
		using tmp = TempDir.createSync("@omp-advisor-costs-parent-storage-");
		const client = new SQL("sqlite::memory:");
		clients.push(client);
		const storage = await SqlSessionStorage.create({ client });
		setDefaultSessionStorage(new FileSessionStorage());
		const parent = SessionManager.create(tmp.path(), tmp.path(), storage);
		const sessionFile = parent.getSessionFile();
		if (!sessionFile) throw new Error("Expected the parent session file");
		const filename = advisorTranscriptFilename("");
		const advisorFile = path.join(sessionFile.slice(0, -".jsonl".length), filename);
		const recorder = new AdvisorTranscriptRecorder(
			() => sessionFile,
			() => parent.getCwd(),
			filename,
			undefined,
			parent.getStorage(),
		);

		recorder.record(assistantMessage(0.75));
		await recorder.close();

		expect(storage.existsSync(advisorFile)).toBe(true);
		expect(await Bun.file(advisorFile).exists()).toBe(false);
		expect(
			Object.fromEntries(await loadAdvisorTranscriptCosts(sessionFile, { storage: parent.getStorage() })),
		).toEqual({
			"": 0.75,
		});
		await parent.close();
	});
});
