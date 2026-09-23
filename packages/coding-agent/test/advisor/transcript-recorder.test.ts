/**
 * Contracts: AdvisorTranscriptRecorder persists the advisor agent's turns to a
 * subagent-style JSONL (`<session>/__advisor.jsonl`) so the advisor model's usage
 * is attributed in stats and its transcript shows in the Agent Hub.
 *
 * - Assistant turns land as `{type:"message", message:{role:"assistant", usage}}`
 *   entries — exactly the shape the stats parser reads for usage.
 * - User deltas are persisted but flagged `synthetic`/agent-attributed so stats'
 *   user-message metrics skip them.
 * - Non-conversational message kinds are not persisted.
 * - The target follows the session file: a switch routes later turns to the new
 *   session's `__advisor.jsonl`, leaving the prior file intact.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	ADVISOR_TRANSCRIPT_FILENAME,
	AdvisorTranscriptRecorder,
	advisorTranscriptFilename,
	loadAdvisorTranscriptCosts,
} from "@oh-my-pi/pi-coding-agent/advisor/transcript-recorder";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

interface AdvisorEntry {
	type?: string;
	id?: unknown;
	message?: {
		role?: string;
		model?: string;
		usage?: { input?: number };
		synthetic?: boolean;
		attribution?: string;
	};
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-recorder-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

/** Parse the message entries (skipping the session header) from an advisor JSONL. */
async function readMessageEntries(file: string): Promise<AdvisorEntry[]> {
	const text = await Bun.file(file).text();
	// JSON.parse returns `any`; assigning to the typed array narrows reads below.
	const entries: AdvisorEntry[] = text
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
	return entries.filter(entry => entry.type === "message");
}

function assistantMessage(text: string, inputTokens: number, cost = 0, provider = "anthropic"): AgentMessage {
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages",
		provider,
		model: "test-advisor-model",
		usage: {
			input: inputTokens,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 3,
			cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop" as const,
		timestamp: 1,
	};
	return message as unknown as AgentMessage;
}

function userMessage(text: string): AgentMessage {
	const message = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
	return message as unknown as AgentMessage;
}

function developerMessage(text: string): AgentMessage {
	const message = { role: "developer" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
	return message as unknown as AgentMessage;
}

describe("AdvisorTranscriptRecorder", () => {
	it("persists assistant turns with usage to <session>/__advisor.jsonl", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("reviewing", 42));
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages).toHaveLength(1);
			expect(messages[0].message?.role).toBe("assistant");
			expect(messages[0].message?.model).toBe("test-advisor-model");
			expect(messages[0].message?.usage?.input).toBe(42);
			// Stats keys on a non-empty entry id; SessionManager must assign one.
			expect(typeof messages[0].id).toBe("string");
			expect(String(messages[0].id).length).toBeGreaterThan(0);
		});
	});

	it("marks advisor user deltas synthetic and agent-attributed", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(userMessage("### Session update"));
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages).toHaveLength(1);
			expect(messages[0].message?.role).toBe("user");
			expect(messages[0].message?.synthetic).toBe(true);
			expect(messages[0].message?.attribution).toBe("agent");
		});
	});

	it("skips non-conversational message kinds", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(developerMessage("noise"));
			recorder.record(assistantMessage("kept", 1));
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.map(m => m.message?.role)).toEqual(["assistant"]);
		});
	});

	it("routes later turns to the new session file after a switch", async () => {
		await withTempDir(async dir => {
			let sessionFile = path.join(dir, "first.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("before switch", 1));
			sessionFile = path.join(dir, "second.jsonl");
			recorder.record(assistantMessage("after switch", 2));
			await recorder.close();

			const first = await readMessageEntries(path.join(dir, "first", ADVISOR_TRANSCRIPT_FILENAME));
			const second = await readMessageEntries(path.join(dir, "second", ADVISOR_TRANSCRIPT_FILENAME));
			expect(first).toHaveLength(1);
			expect(first[0].message?.usage?.input).toBe(1);
			expect(second).toHaveLength(1);
			expect(second[0].message?.usage?.input).toBe(2);
		});
	});

	it("skips a retried batch but keeps every billed assistant turn", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			// A failing advisor re-sends the identical batch each attempt; the turn
			// only commits once it finally succeeds (issue #9553).
			for (let attempt = 0; attempt < 5; attempt++) {
				recorder.beginTurn();
				recorder.record({ ...userMessage("### Session update"), timestamp: attempt + 1 } as AgentMessage);
				recorder.record(assistantMessage(`attempt ${attempt}`, 1, 0.1));
			}
			recorder.commitTurn();
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.filter(m => m.message?.role === "user")).toHaveLength(1);
			expect(messages.filter(m => m.message?.role === "assistant")).toHaveLength(5);
			expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBeCloseTo(0.5, 8);
		});
	});

	it("keeps identical deltas that belong to distinct committed turns", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			// The user re-submits the same prompt across three separate turns: each
			// renders an identical "Session update" yet is genuinely new content.
			for (let turn = 0; turn < 3; turn++) {
				recorder.beginTurn();
				recorder.record(userMessage("### Session update"));
				recorder.record(assistantMessage(`review ${turn}`, 1, 0.1));
				recorder.commitTurn();
			}
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.filter(m => m.message?.role === "user")).toHaveLength(3);
		});
	});

	it("keeps a repeated delta after the prior batch is abandoned", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.beginTurn();
			recorder.record(userMessage("### Session update"));
			recorder.abandonTurn();
			recorder.beginTurn();
			recorder.record(userMessage("### Session update"));
			recorder.commitTurn();
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.filter(m => m.message?.role === "user")).toHaveLength(2);
		});
	});

	it("holds post-snapshot records behind a byte boundary", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("before", 1, 0.25));
			const gate = Promise.withResolvers<void>();
			const ready = recorder.blockWritesUntil(gate.promise);
			recorder.record(assistantMessage("after", 1, 0.5));
			await ready;

			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const beforeRelease = await readMessageEntries(transcript);
			expect(beforeRelease.filter(m => m.message?.role === "assistant")).toHaveLength(1);

			gate.resolve();
			await recorder.close();
			const afterRelease = await readMessageEntries(transcript);
			expect(afterRelease.filter(m => m.message?.role === "assistant")).toHaveLength(2);
		});
	});

	it("keeps identical deltas delivered within one turn", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			// Two tool runs with byte-identical output render two identical chunks in
			// one delivery; both must persist (they are distinct positions, not a replay).
			recorder.beginTurn();
			recorder.record(userMessage("### Session update"));
			recorder.record(userMessage("### Session update"));
			recorder.record(assistantMessage("review", 1, 0.1));
			recorder.commitTurn();
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.filter(m => m.message?.role === "user")).toHaveLength(2);
		});
	});

	it("loads cumulative costs by advisor slug", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const primary = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			const security = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
				advisorTranscriptFilename("security"),
			);
			primary.record(assistantMessage("primary", 1, 0.25));
			security.record(assistantMessage("first", 1, 0.25));
			security.record(assistantMessage("second", 1, 0.5));
			await Promise.all([primary.close(), security.close()]);

			expect(Object.fromEntries(await loadAdvisorTranscriptCosts(sessionFile))).toEqual({
				"": 0.25,
				security: 0.75,
			});
		});
	});

	it("captures billing providers per advisor slug for subscription attribution", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("primary", 1, 0.25));
			await recorder.close();

			const providersBySlug = new Map<string, Set<string>>();
			await loadAdvisorTranscriptCosts(sessionFile, { providersBySlug });
			expect([...(providersBySlug.get("") ?? [])]).toEqual(["anthropic"]);
		});
	});

	it("excludes providers that only produced zero-cost turns from subscription attribution", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("paid", 1, 0.25, "openai"));
			recorder.record(assistantMessage("failed subscription fallback", 1, 0, "anthropic"));
			await recorder.close();

			const providersBySlug = new Map<string, Set<string>>();
			await loadAdvisorTranscriptCosts(sessionFile, { providersBySlug });
			expect([...(providersBySlug.get("") ?? [])]).toEqual(["openai"]);
		});
	});

	it("yields before snapshotting transcript metadata", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("persisted", 1, 0.25));
			await recorder.close();

			let snapshotTaken = false;
			const costs = loadAdvisorTranscriptCosts(sessionFile, {
				onSnapshot: () => {
					snapshotTaken = true;
				},
			});
			expect(snapshotTaken).toBe(false);
			expect((await costs).get("")).toBeCloseTo(0.25, 8);
			expect(snapshotTaken).toBe(true);
		});
	});

	it("excludes transcript entries appended after the cost snapshot", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("persisted before snapshot", 1, 0.25));
			await recorder.close();

			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const appended = Promise.withResolvers<void>();
			const costs = loadAdvisorTranscriptCosts(sessionFile, {
				onSnapshot: () => {
					const entry = JSON.stringify({
						type: "message",
						message: assistantMessage("billed after snapshot", 1, 0.5),
					});
					void fs.appendFile(transcript, `${entry}\n`).then(appended.resolve, appended.reject);
				},
			});
			await appended.promise;

			expect((await costs).get("")).toBeCloseTo(0.25, 8);
			expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBeCloseTo(0.75, 8);
		});
	});

	it("keeps valid costs when persisted entries are malformed", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("valid", 1, 0.25));
			await recorder.close();
			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const lines = (await fs.readFile(transcript, "utf8")).trimEnd().split("\n");
			lines.splice(
				-1,
				0,
				JSON.stringify({ type: "message", message: { role: "assistant" } }),
				"{ this is not valid json",
				JSON.stringify({ type: "message" }),
				"null",
			);
			await fs.writeFile(transcript, `${lines.join("\n")}\n`);

			expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBe(0.25);
		});
	});
});
