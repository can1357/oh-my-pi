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
	ADVISOR_CONTEXT_MAINTENANCE_CUSTOM_TYPE,
	ADVISOR_CONTEXT_MAINTENANCE_VERSION,
	type AdvisorMaintenanceEvent,
	advisorMaintenanceSafeError,
} from "@oh-my-pi/pi-coding-agent/advisor/maintenance-types";
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
	customType?: string;
	data?: AdvisorMaintenanceEvent;
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

async function readEntries(file: string): Promise<AdvisorEntry[]> {
	const text = await Bun.file(file).text();
	const entries: AdvisorEntry[] = text
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
	return entries.filter(entry => entry.type === "message" || entry.type === "custom");
}

function maintenanceEvent(
	kind: AdvisorMaintenanceEvent["kind"],
	status: AdvisorMaintenanceEvent["status"],
	runId: string,
): AdvisorMaintenanceEvent {
	return {
		version: ADVISOR_CONTEXT_MAINTENANCE_VERSION,
		kind,
		status,
		runId,
		attemptId: kind === "attempt" ? `${runId}-attempt` : null,
		advisorId: "default",
		advisorGeneration: 3,
		phase: "mid_turn",
		trigger: "threshold",
		method: kind === "start" ? null : "soft",
		candidateModel: null,
		ownerModel: { provider: "anthropic", id: "test-advisor-model" },
		ownerContextWindow: 200_000,
		ownerThreshold: 100_000,
		before: { value: 95_000, source: "provider" },
		after: kind === "commit" ? { value: 42_000, source: "estimated" } : { value: null, source: "unknown" },
		historyChanged: kind === "commit",
		continuation: { decision: "none", mode: null },
		workingJournalBoundaryEntryId: kind === "commit" ? "working-entry-7" : null,
		workingJournalCheckpointId: "checkpoint-2",
		reason: null,
		error: null,
	};
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

	it("keeps late maintenance outcomes on the run-start transcript target", async () => {
		await withTempDir(async dir => {
			let sessionFile = path.join(dir, "first.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			const runSink = recorder.captureMaintenanceSink();
			expect(runSink).toBeDefined();
			if (!runSink) throw new Error("expected a maintenance sink");
			runSink(maintenanceEvent("start", "started", "run-old"));

			sessionFile = path.join(dir, "second.jsonl");
			runSink(maintenanceEvent("completion", "cancelled", "run-old"));
			recorder.recordMaintenance(maintenanceEvent("reset", "applied", "run-new"));
			await recorder.close();
			runSink(maintenanceEvent("discard", "discarded", "run-old"));

			const first = await readEntries(path.join(dir, "first", ADVISOR_TRANSCRIPT_FILENAME));
			const second = await readEntries(path.join(dir, "second", ADVISOR_TRANSCRIPT_FILENAME));
			expect(first.map(entry => entry.data?.kind)).toEqual(["start", "completion"]);
			expect(first.map(entry => entry.data?.runId)).toEqual(["run-old", "run-old"]);
			expect(second.map(entry => entry.data?.kind)).toEqual(["reset"]);
			expect(second[0].customType).toBe(ADVISOR_CONTEXT_MAINTENANCE_CUSTOM_TYPE);
		});
	});

	it("resumes new diagnostics after a preserving transition without reviving retained sinks", async () => {
		await withTempDir(async dir => {
			let sessionFile = path.join(dir, "old.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			const oldSink = recorder.captureMaintenanceSink();
			oldSink?.(maintenanceEvent("start", "started", "old-run"));
			await recorder.close();
			sessionFile = path.join(dir, "new.jsonl");
			recorder.resume();
			oldSink?.(maintenanceEvent("completion", "cancelled", "old-run"));
			recorder.captureMaintenanceSink()?.(maintenanceEvent("start", "started", "new-run"));
			recorder.record(assistantMessage("resumed work", 7, 0.25));
			await recorder.close();
			const oldEntries = await readEntries(path.join(dir, "old", ADVISOR_TRANSCRIPT_FILENAME));
			const newEntries = await readEntries(path.join(dir, "new", ADVISOR_TRANSCRIPT_FILENAME));
			expect(oldEntries.map(entry => entry.data?.kind)).toEqual(["start"]);
			expect(newEntries.map(entry => entry.data?.runId ?? entry.message?.role)).toEqual(["new-run", "assistant"]);
			expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBeCloseTo(0.25, 8);
		});
	});

	it("redacts and bounds durable maintenance errors", () => {
		const error = advisorMaintenanceSafeError(
			new Error(
				`Bearer top-secret api_key=also-secret {"api_key":"json-secret"} https://example.test/?token=query-secret ${"x".repeat(700)}`,
			),
		);
		expect(error.message).not.toContain("top-secret");
		expect(error.message).not.toContain("also-secret");
		expect(error.message).not.toContain("json-secret");
		expect(error.message).not.toContain("query-secret");
		expect(error.message.length).toBeLessThanOrEqual(512);
	});

	it("serializes maintenance with messages without changing billing", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("before", 1, 0.25));
			recorder.recordMaintenance(maintenanceEvent("attempt", "prepared-only", "run-1"));
			recorder.record(assistantMessage("after", 1, 0.5));
			recorder.recordMaintenance(maintenanceEvent("commit", "applied", "run-1"));
			await recorder.close();

			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const entries = await readEntries(transcript);
			expect(entries.map(entry => (entry.type === "custom" ? entry.data?.kind : entry.message?.role))).toEqual([
				"assistant",
				"attempt",
				"assistant",
				"commit",
			]);
			expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBeCloseTo(0.75, 8);
		});
	});

	it("isolates a diagnostic write failure from later billed messages", async () => {
		await withTempDir(async dir => {
			const blockedTarget = path.join(dir, "blocked");
			await fs.writeFile(blockedTarget, "not a directory");
			let sessionFile = `${blockedTarget}.jsonl`;
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.recordMaintenance(maintenanceEvent("start", "started", "failed-write"));

			sessionFile = path.join(dir, "healthy.jsonl");
			recorder.record(assistantMessage("still persisted", 7, 0.25));
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "healthy", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.map(entry => entry.message?.usage?.input)).toEqual([7]);
			expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBeCloseTo(0.25, 8);
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
