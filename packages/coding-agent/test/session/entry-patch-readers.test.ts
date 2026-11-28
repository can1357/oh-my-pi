import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantRetryRecovery } from "@oh-my-pi/pi-ai";
import { agentTranscriptSource } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { readRpcSubagentTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const SERVER_ERROR = "503 service unavailable: overloaded_error";
/** What an elide pass leaves in place of a heavy tool result. */
const PLACEHOLDER = "[elided: see artifact://1]";
/** One line, so a failure prints a short diff. */
const HEAVY_RESULT = "heavy tool output ".repeat(16);

/** How a retry saga marks the attempt its retry recovered. */
const RECOVERED: AssistantRetryRecovery = {
	kind: "auto-retry",
	status: "recovered",
	attempt: 1,
	recoveredAt: TIMESTAMP,
	recovery: "plain",
	note: "error; retried",
	supersededBy: { timestamp: 3, provider: "anthropic", model: "claude-sonnet-4-5" },
};

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		...overrides,
	};
}

/** An attempt that failed with partial output, which a retry then recovered. */
function failedAttempt(): AssistantMessage {
	return assistant("partial answer", { stopReason: "error", errorMessage: SERVER_ERROR });
}

function toolCall(id: string, command: string): AssistantMessage {
	return assistant("", {
		content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
		stopReason: "toolUse",
	});
}

function toolResult(toolCallId: string, text: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "bash",
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: 3,
	};
}

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 1 };
}

function sessionFileOf(manager: SessionManager): string {
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a persisted session file");
	return file;
}

function messagesOf(manager: SessionManager): AgentMessage[] {
	return manager.getEntries().flatMap(entry => (entry.type === "message" ? [entry.message] : []));
}

/** The marker on the failed attempt and the content of the tool result among `messages`. */
function patchedFields(messages: readonly AgentMessage[]): { retryRecovery: unknown; result: unknown } {
	const failed = messages.find(message => message.role === "assistant" && message.stopReason === "error");
	const result = messages.find(message => message.role === "toolResult");
	return {
		retryRecovery: failed?.role === "assistant" ? failed.retryRecovery : undefined,
		result: result?.role === "toolResult" ? result.content : undefined,
	};
}

/** Write `entries` under a session header as `dir`/session.jsonl. The session id is the directory's name. */
async function writeSession(dir: string, entries: readonly object[]): Promise<string> {
	const file = path.join(dir, "session.jsonl");
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: path.basename(dir),
		timestamp: TIMESTAMP,
		cwd: dir,
	};
	await Bun.write(file, [header, ...entries].map(entry => `${JSON.stringify(entry)}\n`).join(""));
	return file;
}

describe("entry patch records and the readers of a session", () => {
	it("clears a replayed patch payload and keeps the patched field after a rewrite and reopen", async () => {
		using dir = TempDir.createSync("@omp-entry-patch-");
		const file = await writeSession(dir.path(), [
			{ type: "message", id: "u1", parentId: null, timestamp: TIMESTAMP, message: user("go") },
			{ type: "message", id: "a1", parentId: "u1", timestamp: TIMESTAMP, message: failedAttempt() },
			{
				type: "custom",
				customType: "entry_patch",
				id: "p1",
				parentId: "a1",
				timestamp: TIMESTAMP,
				data: { patches: [{ entryId: "a1", message: { retryRecovery: RECOVERED } }] },
			},
		]);
		const manager = await SessionManager.open(file, dir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		try {
			expect(manager.getEntry("p1")).toHaveProperty("data", { patches: [] });
			expect(patchedFields(messagesOf(manager)).retryRecovery).toEqual(RECOVERED);
			await manager.rewriteEntries();
		} finally {
			await manager.close();
		}

		const { entries } = await loadSessionFile(file);
		expect(entries.find(entry => entry.id === "p1")).toHaveProperty("data", { patches: [] });

		const reopened = await SessionManager.open(file, dir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		try {
			expect(reopened.getEntry("p1")).toHaveProperty("data", { patches: [] });
			expect(patchedFields(messagesOf(reopened)).retryRecovery).toEqual(RECOVERED);
		} finally {
			await reopened.close();
		}
	});

	// A session's previous process, or any other writer of the journal, can append
	// a record after this manager loaded the file; a full rewrite keeps such
	// entries. Without the patch the live session shows the recovered attempt as a
	// failure, and the rewrite writes the record with no patches, which erases the
	// marker for every later resume.
	it("applies a patch record another writer appended, and keeps the patched field through the rewrite that keeps it", async () => {
		using dir = TempDir.createSync("@omp-entry-patch-");
		const manager = SessionManager.create(dir.path(), dir.path(), new FileSessionStorage());
		try {
			manager.appendMessage(user("go"));
			const failedId = manager.appendMessage(failedAttempt());
			const leafId = manager.appendMessage(assistant("Recovered after retry."));
			await manager.flush();
			const file = sessionFileOf(manager);

			const record = {
				type: "custom",
				customType: "entry_patch",
				id: "otherwriter",
				parentId: leafId,
				timestamp: TIMESTAMP,
				data: { patches: [{ entryId: failedId, message: { retryRecovery: RECOVERED } }] },
			};
			await fs.appendFile(file, `${JSON.stringify(record)}\n`);
			// This manager's rewrite finds the record past what it wrote and keeps it.
			await manager.rewriteEntries();
			await manager.flush();
			const live = patchedFields(messagesOf(manager)).retryRecovery;

			const written = Bun.JSONL.parse(await Bun.file(file).text()) as { id?: string; message?: AgentMessage }[];
			const inline = written.find(entry => entry.id === failedId)?.message;
			const resumed = await SessionManager.open(file, dir.path(), new FileSessionStorage(), {
				suppressBreadcrumb: true,
			});
			try {
				expect({
					live,
					inline: inline?.role === "assistant" ? inline.retryRecovery : undefined,
					resumedAfterRewrite: patchedFields(messagesOf(resumed)).retryRecovery,
				}).toEqual({ live: RECOVERED, inline: RECOVERED, resumedAfterRewrite: RECOVERED });
			} finally {
				await resumed.close();
			}
		} finally {
			await manager.close();
		}
	});

	// A client that reads a subagent's transcript must see what the subagent's
	// session holds: otherwise a recovered attempt reads as a failed run and an
	// elided result comes back in full. The records are written as a file holds
	// them (no `patchEntries` call), so the case fails for the replay on a tree
	// without it.
	it("shows a recovered attempt and an elided result to the RPC subagent transcript and the agent hub transcript", async () => {
		using dir = TempDir.createSync("@omp-entry-patch-");
		const manager = SessionManager.create(dir.path(), dir.path(), new FileSessionStorage());
		try {
			manager.appendMessage(user("do the task"));
			const failedId = manager.appendMessage(failedAttempt());
			manager.appendMessage(toolCall("call_1", "ls -R"));
			const resultId = manager.appendMessage(toolResult("call_1", HEAVY_RESULT));
			manager.appendMessage(assistant("Recovered after retry."));
			// What the end of a retry saga and an elide pass record.
			manager.appendCustomEntry("entry_patch", {
				patches: [{ entryId: failedId, message: { retryRecovery: RECOVERED } }],
			});
			manager.appendCustomEntry("entry_patch", {
				patches: [{ entryId: resultId, message: { content: [{ type: "text", text: PLACEHOLDER }], prunedAt: 5 } }],
			});
			await manager.flush();
			const file = sessionFileOf(manager);

			const resumed = await SessionManager.open(file, dir.path(), new FileSessionStorage(), {
				suppressBreadcrumb: true,
			});
			try {
				const rpc = await readRpcSubagentTranscript(file, 0);
				const hub = agentTranscriptSource.parseEntries(await Bun.file(file).text());
				const held = { retryRecovery: RECOVERED, result: [{ type: "text", text: PLACEHOLDER }] };
				expect({
					session: patchedFields(messagesOf(resumed)),
					rpcTranscript: patchedFields(rpc.messages),
					agentHubTranscript: patchedFields(
						hub.flatMap(entry => (entry.type === "message" ? [entry.message] : [])),
					),
				}).toEqual({ session: held, rpcTranscript: held, agentHubTranscript: held });
			} finally {
				await resumed.close();
			}
		} finally {
			await manager.close();
		}
	});

	// A tool result's content is a list of blocks. A record that sets a string
	// there is malformed: applied, it makes every later request of the session
	// throw while the session still appears to load.
	it("skips a patch record whose content has the wrong shape for its target's role", async () => {
		using dir = TempDir.createSync("@omp-entry-patch-");
		const resultText = "files listed here";
		const file = await writeSession(dir.path(), [
			{ type: "message", id: "u1", parentId: null, timestamp: TIMESTAMP, message: user("list the files") },
			{ type: "message", id: "a1", parentId: "u1", timestamp: TIMESTAMP, message: toolCall("call_1", "ls") },
			{ type: "message", id: "t1", parentId: "a1", timestamp: TIMESTAMP, message: toolResult("call_1", resultText) },
			{
				type: "custom",
				customType: "entry_patch",
				id: "p1",
				parentId: "t1",
				timestamp: TIMESTAMP,
				data: { patches: [{ entryId: "t1", message: { content: "a string" } }] },
			},
			{ type: "message", id: "u2", parentId: "p1", timestamp: TIMESTAMP, message: user("next") },
		]);
		const manager = await SessionManager.open(file, dir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		try {
			let modelContext: string;
			try {
				const request = JSON.stringify(convertToLlm(manager.buildSessionContext().messages));
				modelContext = request.includes(resultText) ? "holds the result" : "lacks the result";
			} catch (error) {
				modelContext = `threw: ${error instanceof Error ? error.message : String(error)}`;
			}
			expect({
				result: patchedFields(messagesOf(manager)).result,
				modelContext,
			}).toEqual({
				result: [{ type: "text", text: resultText }],
				modelContext: "holds the result",
			});
		} finally {
			await manager.close();
		}
	});
});
