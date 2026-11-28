/**
 * The readers of a session file that project its entries without loading the
 * session: each must show what an `entry_patch` record sets, as it shows the
 * same field written inline on the entry's own line (what a full rewrite of the
 * file leaves). Each case reads a transcript holding the original line and a
 * record, and the same transcript with the field written inline, through one
 * reader. Every fixture is written by hand, so the cases run against a tree
 * without `patchEntries` too.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantRetryRecovery } from "@oh-my-pi/pi-ai";
import { AgentActivityIndex } from "../../src/activity";
import { applyStrip, planStrip } from "@oh-my-pi/pi-coding-agent/cli/gc-strip";
import { buildStage1RolloutItems } from "@oh-my-pi/pi-coding-agent/memories";
import { agentTranscriptSource } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import type { AgentHubRemote } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/agent-hub";
import { wordQuery } from "@oh-my-pi/pi-coding-agent/session/search-query";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadSessionMessagesReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	closeTranscriptIndex,
	syncTranscriptIndex,
	transcriptSessionIds,
} from "@oh-my-pi/pi-coding-agent/session/transcript-index";
import {
	AgentTranscriptViewerModel,
	type ViewerAgentRef,
} from "@oh-my-pi/pi-coding-agent/ui/overlays/panels/agent-transcript-viewer-model";
import { getConfigRootDir, getSessionsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** What an elide pass leaves in place of heavy content. */
const PLACEHOLDER = "ELIDEDMARK placeholder";
/** The heavy content an elide pass removes. */
const HEAVY = `HEAVYMARK ${"heavy output ".repeat(16)}`;
const AGENT_ID = "Worker";

function assistant(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
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

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 1 };
}

function bashResult(toolCallId: string, text: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "bash",
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: 3,
	};
}

function header(id: string) {
	return { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: TIMESTAMP, cwd: "/tmp" };
}

function message(id: string, parentId: string | null, body: object) {
	return { type: "message", id, parentId, timestamp: TIMESTAMP, message: body };
}

function patchRecord(id: string, parentId: string, patches: object[]) {
	return { type: "custom", customType: "entry_patch", id, parentId, timestamp: TIMESTAMP, data: { patches } };
}

function jsonl(entries: readonly object[]): string {
	return entries.map(entry => `${JSON.stringify(entry)}\n`).join("");
}

async function writeTranscript(file: string, entries: readonly object[]): Promise<string> {
	await Bun.write(file, jsonl(entries));
	return file;
}

function textOf(message: AgentMessage | undefined): string {
	if (message?.role !== "assistant") return "";
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

function thinkingSignatureOf(message: AgentMessage | undefined): unknown {
	if (message?.role !== "assistant") return undefined;
	const thinking = message.content.find(block => block.type === "thinking");
	return thinking?.type === "thinking" ? thinking.thinkingSignature : undefined;
}

function signed(text: string, signature: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return assistant(
		[
			{ type: "thinking", thinking: "reasoning", thinkingSignature: signature },
			{ type: "text", text },
		],
		overrides,
	);
}

describe("entry patch records and the readers that project a session file", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Memory extraction sends a rollout to a model on every extraction: without the
	// record it sends the heavy content the elide pass removed, every time.
	it("sends the memory extraction model an elided tool result as its placeholder, as a rollout with it inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const call = assistant([{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls -R" } }], {
			stopReason: "toolUse",
		});
		// Over a 1 MiB read window, so the record lies in a later window than its target.
		const filler = Array.from({ length: 4 }, (_, n) =>
			message(`f${n}`, n === 0 ? "t1" : `f${n - 1}`, user(`${n}${"x".repeat(300_000)}`)),
		);
		const before = [header("memory"), message("u1", null, user("list the files")), message("a1", "u1", call)];
		const patched = await writeTranscript(path.join(dir.path(), "patched.jsonl"), [
			...before,
			message("t1", "a1", bashResult("call_1", HEAVY)),
			...filler,
			patchRecord("p1", "f3", [
				{ entryId: "t1", message: { content: [{ type: "text", text: PLACEHOLDER }], prunedAt: 5 } },
			]),
		]);
		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), [
			...before,
			message("t1", "a1", { ...bashResult("call_1", PLACEHOLDER), prunedAt: 5 }),
			...filler,
		]);
		const read = async (file: string, limit: number) => {
			const items = await buildStage1RolloutItems(file, limit);
			return { heavy: items.includes("HEAVYMARK"), placeholder: items.includes(PLACEHOLDER), items };
		};
		// A small budget reads the head and the back windows; a large one reads the whole rollout from the front.
		for (const limit of [1_000, 10_000_000]) {
			const fromPatched = await read(patched, limit);
			const fromInline = await read(inline, limit);
			expect({ limit, heavy: fromPatched.heavy, placeholder: fromPatched.placeholder }).toEqual({
				limit,
				heavy: false,
				placeholder: true,
			});
			expect(fromPatched.items).toBe(fromInline.items);
		}
	});

	// The picker previews and searches the first prompt: without the record it
	// shows the text an elide pass replaced, which a rewrite of the file would not.
	it("previews and searches a prompt an elide pass shortened as its placeholder, as a session with it inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		// Past the 4 KiB prefix the picker reads: the record lies only in its tail window.
		const replies = Array.from({ length: 3 }, (_, n) =>
			message(
				`a${n}`,
				n === 0 ? "u1" : `a${n - 1}`,
				assistant([{ type: "text", text: `reply ${n} ${"r".repeat(2_000)}` }]),
			),
		);
		const patchedDir = path.join(dir.path(), "patched");
		const inlineDir = path.join(dir.path(), "inline");
		await writeTranscript(path.join(patchedDir, "session.jsonl"), [
			header("picker-patched"),
			message("u1", null, user(HEAVY)),
			...replies,
			patchRecord("p1", "a2", [{ entryId: "u1", message: { content: PLACEHOLDER } }]),
		]);
		await writeTranscript(path.join(inlineDir, "session.jsonl"), [
			header("picker-inline"),
			message("u1", null, user(PLACEHOLDER)),
			...replies,
		]);
		const storage = new FileSessionStorage();
		const [fromPatched] = await listSessions(patchedDir, storage);
		const [fromInline] = await listSessions(inlineDir, storage);
		const shown = (info: typeof fromPatched) => ({
			firstMessage: info?.firstMessage,
			searchHasHeavy: info?.allMessagesText.includes("HEAVYMARK"),
		});
		expect(shown(fromPatched)).toEqual({ firstMessage: PLACEHOLDER, searchHasHeavy: false });
		expect(shown(fromPatched)).toEqual(shown(fromInline));
	});

	// A first prompt behind a large leading entry is found by the picker's line
	// scan; the record that shortened it lies far past the prompt and past any
	// window after it, and in neither the prefix nor the tail window: only a scan
	// that reads on to the end of the file finds it.
	it("previews a prompt past the prefix window as the placeholder a record far after it set", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const recall = { type: "custom", customType: "memory-recall", id: "r0", parentId: null, timestamp: TIMESTAMP };
		const leading = { ...recall, data: { text: "m".repeat(6_000) } };
		const replies = (prefix: string, count: number, parentId: string) =>
			Array.from({ length: count }, (_, n) =>
				message(
					`${prefix}${n}`,
					n === 0 ? parentId : `${prefix}${n - 1}`,
					assistant([{ type: "text", text: `reply ${prefix}${n} ${"r".repeat(2_000)}` }]),
				),
			);
		// About 80 KiB between the prompt and the record, then about 40 KiB, past the 32 KiB tail window.
		const between = replies("b", 40, "u1");
		const after = replies("a", 20, "p1");
		const patchedDir = path.join(dir.path(), "patched");
		const inlineDir = path.join(dir.path(), "inline");
		await writeTranscript(path.join(patchedDir, "session.jsonl"), [
			header("fallback-patched"),
			leading,
			message("u1", "r0", user(HEAVY)),
			...between,
			patchRecord("p1", "b39", [{ entryId: "u1", message: { content: PLACEHOLDER } }]),
			...after,
		]);
		await writeTranscript(path.join(inlineDir, "session.jsonl"), [
			header("fallback-inline"),
			leading,
			message("u1", "r0", user(PLACEHOLDER)),
			...between,
			...after,
		]);
		const storage = new FileSessionStorage();
		const [fromPatched] = await listSessions(patchedDir, storage);
		const [fromInline] = await listSessions(inlineDir, storage);
		expect(fromPatched?.firstMessage).toBe(PLACEHOLDER);
		expect(fromPatched?.firstMessage).toBe(fromInline?.firstMessage);
	});

	// The picker's status reads the last message's content (a trailing tool call
	// reads as an interrupted turn): it must read the content a record set.
	it("derives a session's status from the last message's content as a record set it", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const call = [{ type: "toolCall" as const, id: "call_1", name: "bash", arguments: { command: "ls" } }];
		const patchedDir = path.join(dir.path(), "patched");
		const inlineDir = path.join(dir.path(), "inline");
		await writeTranscript(path.join(patchedDir, "session.jsonl"), [
			header("status-patched"),
			message("u1", null, user("go")),
			message("a1", "u1", assistant(call)),
			patchRecord("p1", "a1", [{ entryId: "a1", message: { content: [{ type: "text", text: PLACEHOLDER }] } }]),
		]);
		await writeTranscript(path.join(inlineDir, "session.jsonl"), [
			header("status-inline"),
			message("u1", null, user("go")),
			message("a1", "u1", assistant([{ type: "text", text: PLACEHOLDER }])),
		]);
		const storage = new FileSessionStorage();
		const [fromPatched] = await listSessions(patchedDir, storage);
		const [fromInline] = await listSessions(inlineDir, storage);
		expect(fromPatched?.status).toBe("complete");
		expect(fromPatched?.status).toBe(fromInline?.status);
	});

	// Agent Activity reads a growing transcript in windows: a record appended after
	// it showed a response must replace the text that response showed.
	it("shows a response an elide pass shortened after it was read as its placeholder, as a transcript with it inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const patched = await writeTranscript(path.join(dir.path(), "patched.jsonl"), [
			message("a1", null, assistant([{ type: "text", text: HEAVY }])),
		]);
		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), [
			message("a1", null, assistant([{ type: "text", text: PLACEHOLDER }])),
		]);
		const patchedActivity = new AgentActivityIndex();
		await patchedActivity.sync(AGENT_ID, patched);
		await fs.appendFile(
			patched,
			jsonl([
				patchRecord("p1", "a1", [{ entryId: "a1", message: { content: [{ type: "text", text: PLACEHOLDER }] } }]),
			]),
		);
		await patchedActivity.sync(AGENT_ID, patched);
		const inlineActivity = new AgentActivityIndex();
		await inlineActivity.sync(AGENT_ID, inline);
		const summaries = (activity: AgentActivityIndex) => activity.query().map(row => row.summary);
		expect(summaries(patchedActivity)).toEqual([PLACEHOLDER]);
		expect(summaries(patchedActivity)).toEqual(summaries(inlineActivity));
	});

	// A tool row shows its call's intent: a record that set the call after Agent
	// Activity read it must replace the summary that row showed.
	it("summarizes a tool call a record set after it was read by its new intent, as a transcript with it inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const call = (intent: string) =>
			assistant([{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls", i: intent } }], {
				stopReason: "toolUse",
			});
		const patched = await writeTranscript(path.join(dir.path(), "patched.jsonl"), [message("a1", null, call(HEAVY))]);
		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), [
			message("a1", null, call(PLACEHOLDER)),
		]);
		const patchedActivity = new AgentActivityIndex();
		await patchedActivity.sync(AGENT_ID, patched);
		await fs.appendFile(
			patched,
			jsonl([patchRecord("p1", "a1", [{ entryId: "a1", message: { content: call(PLACEHOLDER).content } }])]),
		);
		await patchedActivity.sync(AGENT_ID, patched);
		const inlineActivity = new AgentActivityIndex();
		await inlineActivity.sync(AGENT_ID, inline);
		const rows = (activity: AgentActivityIndex) => activity.query().map(row => [row.kind, row.summary]);
		expect(rows(patchedActivity)).toEqual([["tool", PLACEHOLDER]]);
		expect(rows(patchedActivity)).toEqual(rows(inlineActivity));
	});

	// A record that leaves a response no text removes its row. The next read
	// starts at a line boundary with no rows shown, and its first line is the
	// next response, which Agent Activity must show, locally or from a host.
	it("shows the response after a record removed the only row, as a transcript with that content inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const first = [message("a1", null, assistant([{ type: "text", text: HEAVY }]))];
		const reasoning = [{ type: "thinking" as const, thinking: "reasoning" }];
		const record = patchRecord("p1", "a1", [{ entryId: "a1", message: { content: reasoning } }]);
		const next = message("a2", "p1", assistant([{ type: "text", text: "next answer" }]));

		const file = await writeTranscript(path.join(dir.path(), "patched.jsonl"), first);
		const local = new AgentActivityIndex();
		await local.sync(AGENT_ID, file);
		await fs.appendFile(file, jsonl([record]));
		await local.sync(AGENT_ID, file);
		await fs.appendFile(file, jsonl([next]));
		await local.sync(AGENT_ID, file);

		let hosted = jsonl(first);
		const remote = new AgentActivityIndex({
			remote: {
				readTranscript: async (_agentId, fromByte) => {
					const bytes = Buffer.from(hosted);
					const text = bytes.subarray(Math.min(fromByte, bytes.byteLength)).toString("utf-8");
					return { text, newSize: bytes.byteLength };
				},
			},
		});
		await remote.sync(AGENT_ID);
		hosted += jsonl([record]);
		await remote.sync(AGENT_ID);
		hosted += jsonl([next]);
		await remote.sync(AGENT_ID);

		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), [
			message("a1", null, assistant(reasoning)),
			next,
		]);
		const inlineActivity = new AgentActivityIndex();
		await inlineActivity.sync(AGENT_ID, inline);
		const summaries = (activity: AgentActivityIndex) => activity.query().map(row => row.summary);
		expect({ local: summaries(local), remote: summaries(remote) }).toEqual({
			local: ["next answer"],
			remote: ["next answer"],
		});
		expect(summaries(inlineActivity)).toEqual(["next answer"]);
	});

	// A record can come before the turn it names, as the Agent Hub's history of a parked agent reads it.
	// Agent Activity reads a growing transcript in windows: when the record is in an earlier window than
	// its turn, without holding it until the turn is read it shows the rows of the content the turn was
	// written with.
	it("shows the rows of a turn's content a record read before the turn set, as a transcript with it inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const written = assistant(
			[
				{ type: "text", text: HEAVY },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
			],
			{ stopReason: "toolUse" },
		);
		const patchedContent = [
			{ type: "text", text: PLACEHOLDER },
			{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "pwd" } },
		];
		const before = [
			message("u1", null, user("do the task")),
			message("a0", "u1", assistant([{ type: "text", text: "On it" }])),
		];
		const record = patchRecord("p1", "a0", [{ entryId: "a1", message: { content: patchedContent } }]);
		const results = [
			message("t1", "a1", bashResult("call_1", "out")),
			message("t2", "t1", bashResult("call_2", "out")),
		];
		const patched = await writeTranscript(path.join(dir.path(), "patched.jsonl"), [...before, record]);
		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), [
			...before,
			message("a1", "a0", { ...written, content: patchedContent }),
			...results,
		]);
		const patchedActivity = new AgentActivityIndex();
		await patchedActivity.sync(AGENT_ID, patched);
		await Bun.write(patched, jsonl([...before, record, message("a1", "p1", written), ...results]));
		await patchedActivity.sync(AGENT_ID, patched);
		const inlineActivity = new AgentActivityIndex();
		await inlineActivity.sync(AGENT_ID, inline);
		const rows = (activity: AgentActivityIndex) =>
			activity.query().map(row => ({ kind: row.kind, title: row.title, summary: row.summary, status: row.status }));
		expect(rows(patchedActivity)).toEqual([
			{ kind: "response", title: "Response", summary: "On it", status: "success" },
			{ kind: "response", title: "Response", summary: PLACEHOLDER, status: "success" },
			{ kind: "tool", title: "bash", summary: "pwd", status: "success" },
		]);
		expect(rows(patchedActivity)).toEqual(rows(inlineActivity));
	});

	// `omp gc --strip` removes replay data from old turns. A record that sets an old
	// turn's content keeps the signature the strip removed from its line, and a
	// resume sets that content again: the strip must reach the record too.
	it("strips the replay data of a record's content for an old turn, as it strips the turn written inline", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const tail = [message("u2", "a1", user("and now")), message("a2", "u2", signed("latest answer", "sig-latest"))];
		const patched = await writeTranscript(path.join(dir.path(), "patched.jsonl"), [
			header("strip-patched"),
			message("u1", null, user("go")),
			message("a1", "u1", signed(HEAVY, "sig-old")),
			...tail,
			patchRecord("p1", "a2", [
				{
					entryId: "a1",
					message: {
						content: [
							{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig-old" },
							{ type: "text", text: PLACEHOLDER },
						],
					},
				},
			]),
		]);
		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), [
			header("strip-inline"),
			message("u1", null, user("go")),
			message("a1", "u1", signed(PLACEHOLDER, "sig-old")),
			...tail,
		]);
		const storage = new FileSessionStorage();
		const oldTurnAfterStrip = async (file: string) => {
			const plan = await planStrip(file, Date.now() + 60_000);
			if (plan) await applyStrip(plan, storage);
			const messages = await loadSessionMessagesReadOnly(file);
			const old = messages.find(entry => textOf(entry).includes("MARK"));
			return { text: textOf(old), signature: thinkingSignatureOf(old) };
		};
		const fromPatched = await oldTurnAfterStrip(patched);
		expect(fromPatched).toEqual({ text: PLACEHOLDER, signature: undefined });
		expect(fromPatched).toEqual(await oldTurnAfterStrip(inline));
	});

	// A failed attempt a retry saga recovered (`retryRecovery`) leaves model
	// context, so the turn a resume replays is the one before it: the strip must
	// keep that turn's signature and may strip the recovered attempt's.
	it("keeps the replay data of the turn a resume replays when a record marks the last attempt recovered", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const recovery: AssistantRetryRecovery = {
			kind: "auto-retry",
			status: "superseded",
			attempt: 1,
			recovery: "plain",
			note: "retried",
		};
		const failed = { stopReason: "error", errorMessage: "503 service unavailable" } as const;
		const before = [
			header("strip-plan"),
			message("u1", null, user("go")),
			message("a1", "u1", signed("first answer", "sig-first")),
			message("u2", "a1", user("again")),
		];
		const patched = await writeTranscript(path.join(dir.path(), "patched.jsonl"), [
			...before,
			message("a2", "u2", signed("partial", "sig-failed", failed)),
			patchRecord("p1", "a2", [{ entryId: "a2", message: { retryRecovery: recovery } }]),
		]);
		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), [
			...before,
			message("a2", "u2", signed("partial", "sig-failed", { ...failed, retryRecovery: recovery })),
		]);
		const storage = new FileSessionStorage();
		const replayedSignature = async (file: string) => {
			const plan = await planStrip(file, Date.now() + 60_000);
			if (plan) await applyStrip(plan, storage);
			const messages = await loadSessionMessagesReadOnly(file);
			return thinkingSignatureOf(messages.find(entry => textOf(entry) === "first answer"));
		};
		const fromPatched = await replayedSignature(patched);
		expect(fromPatched).toBe("sig-first");
		expect(fromPatched).toBe(await replayedSignature(inline));
	});

	// Every reader skips a record with a block that lacks its payload (a redacted thinking block without its
	// `data`), its valid patches with it. The strip must leave that record as written: without the bad block the
	// record is valid, and the next resume would apply its patches for the first time.
	it("leaves a record every reader skips as written, so its patches stay unapplied after the strip", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const record = patchRecord("p1", "a2", [
			{ entryId: "u1", message: { content: PLACEHOLDER } },
			{
				entryId: "a1",
				message: { content: [{ type: "redactedThinking" }, { type: "text", text: PLACEHOLDER }] },
			},
		]);
		const file = await writeTranscript(path.join(dir.path(), "rejected.jsonl"), [
			header("strip-rejected"),
			message("u1", null, user(HEAVY)),
			message("a1", "u1", signed("old answer", "sig-old")),
			message("u2", "a1", user("and now")),
			message("a2", "u2", signed("latest answer", "sig-latest")),
			record,
		]);
		const plan = await planStrip(file, Date.now() + 60_000);
		if (!plan) throw new Error("Expected the old turn's signature to strip");
		expect(await applyStrip(plan, new FileSessionStorage())).toBe(true);
		const messages = await loadSessionMessagesReadOnly(file);
		const old = messages.find(entry => textOf(entry) === "old answer");
		const prompt = messages.find(entry => entry.role === "user");
		expect({
			recordAsWritten: (await Bun.file(file).text()).split("\n").includes(JSON.stringify(record)),
			oldTurn: old ? (thinkingSignatureOf(old) ?? "stripped") : "patched",
			prompt: prompt?.role === "user" ? prompt.content : undefined,
		}).toEqual({ recordAsWritten: true, oldTurn: "stripped", prompt: HEAVY });
	});
});

describe("entry patch records and the archive transcript index", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	afterEach(() => {
		try {
			closeTranscriptIndex();
		} finally {
			if (originalAgentDir) {
				setAgentDir(originalAgentDir);
			} else {
				setAgentDir(path.join(getConfigRootDir(), "agent"));
				delete process.env.PI_CODING_AGENT_DIR;
			}
		}
	});

	function sessionsMatching(query: string): string[] {
		const words = wordQuery(query);
		if (!words) throw new Error(`no words in ${query}`);
		return [...transcriptSessionIds(words, undefined)].sort();
	}

	// `archive.search` finds a session by what was said in it: after an elide
	// pass it must find the placeholder, not the text the pass removed.
	it("indexes a message a later record shortened as its placeholder, also when the record arrives in a later sync", async () => {
		using dir = TempDir.createSync("@omp-patch-index-");
		setAgentDir(path.join(dir.path(), "agent"));
		closeTranscriptIndex();
		// The index is a database under `dir`: it closes before `dir` is removed.
		try {
			const bucket = path.join(getSessionsDir(), "--proj--");
			const patched = path.join(bucket, "2026-01-01T00-00-00-000Z_patched.jsonl");
			await writeTranscript(patched, [header("index-patched"), message("u1", null, user(HEAVY))]);
			await writeTranscript(path.join(bucket, "2026-01-02T00-00-00-000Z_inline.jsonl"), [
				header("index-inline"),
				message("u1", null, user(PLACEHOLDER)),
			]);
			expect((await syncTranscriptIndex()).outcome).toBe("synced");
			expect(sessionsMatching("heavymark")).toEqual(["index-patched"]);

			await fs.appendFile(
				patched,
				jsonl([patchRecord("p1", "u1", [{ entryId: "u1", message: { content: PLACEHOLDER } }])]),
			);
			await syncTranscriptIndex();
			expect({ heavy: sessionsMatching("heavymark"), placeholder: sessionsMatching("elidedmark") }).toEqual({
				heavy: [],
				placeholder: ["index-inline", "index-patched"],
			});
		} finally {
			closeTranscriptIndex();
		}
	}, 30_000);

	// A record can clear a response and a later one set text on it again: search must find the text the last
	// record set, as it finds that text written inline, whether the records arrive in two syncs or one.
	it("finds the text a later record set on a message an earlier record cleared, as with that text inline", async () => {
		using dir = TempDir.createSync("@omp-patch-index-");
		setAgentDir(path.join(dir.path(), "agent"));
		closeTranscriptIndex();
		// The index is a database under `dir`: it closes before `dir` is removed.
		try {
			const bucket = path.join(getSessionsDir(), "--proj--");
			const answer = (text: string) => message("a1", "u1", assistant([{ type: "text", text }]));
			const clear = patchRecord("p1", "a1", [{ entryId: "a1", message: { content: [] } }]);
			const restore = patchRecord("p2", "p1", [
				{ entryId: "a1", message: { content: [{ type: "text", text: PLACEHOLDER }] } },
			]);
			const twoSyncs = path.join(bucket, "2026-01-01T00-00-00-000Z_two-syncs.jsonl");
			const oneSync = path.join(bucket, "2026-01-02T00-00-00-000Z_one-sync.jsonl");
			await writeTranscript(twoSyncs, [header("index-two-syncs"), message("u1", null, user("go")), answer(HEAVY)]);
			await writeTranscript(oneSync, [header("index-one-sync"), message("u1", null, user("go")), answer(HEAVY)]);
			await writeTranscript(path.join(bucket, "2026-01-03T00-00-00-000Z_inline.jsonl"), [
				header("index-inline"),
				message("u1", null, user("go")),
				answer(PLACEHOLDER),
			]);
			expect((await syncTranscriptIndex()).outcome).toBe("synced");

			await fs.appendFile(twoSyncs, jsonl([clear]));
			await syncTranscriptIndex();
			const cleared = sessionsMatching("heavymark");
			await fs.appendFile(twoSyncs, jsonl([restore]));
			await fs.appendFile(oneSync, jsonl([clear, restore]));
			await syncTranscriptIndex();
			expect({ cleared, heavy: sessionsMatching("heavymark"), restored: sessionsMatching("elidedmark") }).toEqual({
				cleared: ["index-one-sync"],
				heavy: [],
				restored: ["index-inline", "index-one-sync", "index-two-syncs"],
			});
		} finally {
			closeTranscriptIndex();
		}
	}, 30_000);

	/** The duplicate-id fixture every reader of a session file reads, and the first word of each text it holds. */
	async function duplicateIdFixture() {
		const fixture = path.join(import.meta.dir, "../../../../crates/natives/fixtures/entry-patch-duplicate-id.json");
		const { lines, reads }: { lines: Record<string, unknown>[]; reads: string[] } = await Bun.file(fixture).json();
		const later = lines[3] as { message: { content: { text: string }[] } } & Record<string, unknown>;
		const word = (text: string) => text.split(" ")[0]!;
		return {
			/** The fixture's lines under a header with session id `id`, the later message replaced by `last`. */
			linesOf: (id: string, last: object = later) => [{ ...lines[0], id }, ...lines.slice(1, 3), last],
			later,
			/** The earlier message's own text, the record's, and the later message's own. */
			words: { first: word(reads[0]!), patched: word(reads[1]!), second: word(later.message.content[0]!.text) },
		};
	}

	// The duplicate-id fixture every reader of a session file reads: the record between two messages that share an id
	// sets its text on the later only. Search must find the earlier message's own text and the record's, and not the
	// later message's own, whether the later message arrives in the sync that read the record or in a later one.
	it("sets a record's text on the last message with its id in the duplicate-id fixture, in one sync or two", async () => {
		using dir = TempDir.createSync("@omp-patch-index-");
		setAgentDir(path.join(dir.path(), "agent"));
		closeTranscriptIndex();
		// The index is a database under `dir`: it closes before `dir` is removed.
		try {
			const { linesOf, words } = await duplicateIdFixture();
			const bucket = path.join(getSessionsDir(), "--proj--");
			await writeTranscript(path.join(bucket, "2026-01-01T00-00-00-000Z_one-sync.jsonl"), linesOf("dup-one"));
			const twoSyncs = path.join(bucket, "2026-01-02T00-00-00-000Z_two-syncs.jsonl");
			const split = linesOf("dup-two");
			// The first sync reads the earlier message and the record; the second, the later message.
			await writeTranscript(twoSyncs, split.slice(0, 3));
			expect((await syncTranscriptIndex()).outcome).toBe("synced");
			await fs.appendFile(twoSyncs, jsonl(split.slice(3)));
			await syncTranscriptIndex();
			expect({
				first: sessionsMatching(words.first),
				patched: sessionsMatching(words.patched),
				second: sessionsMatching(words.second),
			}).toEqual({ first: ["dup-one", "dup-two"], patched: ["dup-one", "dup-two"], second: [] });
		} finally {
			closeTranscriptIndex();
		}
	}, 30_000);

	// The fixture's later message as a line the index holds no row for: a message without text, or a tool result.
	// Every other reader sets the record's text on that line and leaves the earlier message its own: search must
	// find the earlier message's text, and the record's text on no message.
	it("sets no message's text when the last line with a record's id has no row, in one sync or two", async () => {
		using dir = TempDir.createSync("@omp-patch-index-");
		setAgentDir(path.join(dir.path(), "agent"));
		closeTranscriptIndex();
		// The index is a database under `dir`: it closes before `dir` is removed.
		try {
			const { linesOf, later, words } = await duplicateIdFixture();
			const rowless = {
				empty: { ...later, message: { ...later.message, content: [] } },
				result: {
					...later,
					message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: later.message.content },
				},
			};
			const bucket = path.join(getSessionsDir(), "--proj--");
			const twoSyncs: [string, object[]][] = [];
			for (const [kind, last] of Object.entries(rowless)) {
				await writeTranscript(
					path.join(bucket, `2026-01-01T00-00-00-000Z_${kind}-one.jsonl`),
					linesOf(`${kind}-one`, last),
				);
				const file = path.join(bucket, `2026-01-02T00-00-00-000Z_${kind}-two.jsonl`);
				const split = linesOf(`${kind}-two`, last);
				await writeTranscript(file, split.slice(0, 3));
				twoSyncs.push([file, split.slice(3)]);
			}
			expect((await syncTranscriptIndex()).outcome).toBe("synced");
			for (const [file, rest] of twoSyncs) await fs.appendFile(file, jsonl(rest));
			await syncTranscriptIndex();
			expect({ first: sessionsMatching(words.first), patched: sessionsMatching(words.patched) }).toEqual({
				first: ["empty-one", "empty-two", "result-one", "result-two"],
				patched: [],
			});
		} finally {
			closeTranscriptIndex();
		}
	}, 30_000);

	// A torn line (a writer killed mid-line) that repeats an earlier message's id does not parse, so every other
	// reader skips it: the record after it sets its text on the earlier message. Search must find the record's
	// text and not the earlier message's own, whether the record arrives in the sync that read the torn line or later.
	it("sets a record's text past a torn line that repeats its id, in one sync or two", async () => {
		using dir = TempDir.createSync("@omp-patch-index-");
		setAgentDir(path.join(dir.path(), "agent"));
		closeTranscriptIndex();
		// The index is a database under `dir`: it closes before `dir` is removed.
		try {
			const { linesOf, later, words } = await duplicateIdFixture();
			const laterLine = JSON.stringify(later);
			const torn = `${laterLine.slice(0, laterLine.indexOf(`"${words.second}`) + 4)}\n`;
			const bucket = path.join(getSessionsDir(), "--proj--");
			const [oneHeader, oneFirst, oneRecord] = linesOf("torn-one");
			await Bun.write(
				path.join(bucket, "2026-01-01T00-00-00-000Z_torn-one.jsonl"),
				jsonl([oneHeader!, oneFirst!]) + torn + jsonl([oneRecord!]),
			);
			const [twoHeader, twoFirst, twoRecord] = linesOf("torn-two");
			const twoSyncs = path.join(bucket, "2026-01-02T00-00-00-000Z_torn-two.jsonl");
			// The first sync reads the earlier message and the torn line; the second, the record.
			await Bun.write(twoSyncs, jsonl([twoHeader!, twoFirst!]) + torn);
			expect((await syncTranscriptIndex()).outcome).toBe("synced");
			await fs.appendFile(twoSyncs, jsonl([twoRecord!]));
			await syncTranscriptIndex();
			expect({ first: sessionsMatching(words.first), patched: sessionsMatching(words.patched) }).toEqual({
				first: [],
				patched: ["torn-one", "torn-two"],
			});
		} finally {
			closeTranscriptIndex();
		}
	}, 30_000);
});

describe("entry patch records and the Agent Hub transcript viewer", () => {
	/** A transcript whose answer `a1` ends the first read and whose second read holds the rest. */
	function transcript(answer: string, rest: readonly object[]): { first: string; second: string } {
		return {
			first: jsonl([
				header(AGENT_ID),
				message("u1", null, user("do the task")),
				message("a1", "u1", assistant([{ type: "text", text: answer }])),
			]),
			second: jsonl(rest),
		};
	}

	const record = patchRecord("p1", "a1", [
		{ entryId: "a1", message: { content: [{ type: "text", text: PLACEHOLDER }] } },
	]);
	const reply = message("u2", "p1", user("next step"));

	function modelOver(sessionFile: string | null, remote?: AgentHubRemote): AgentTranscriptViewerModel {
		const ref: ViewerAgentRef = { kind: "sub", status: "parked", parentId: "Main", sessionFile };
		return new AgentTranscriptViewerModel({
			agentId: AGENT_ID,
			transcript: agentTranscriptSource,
			registry: { get: () => ref },
			remote,
			terminalRows: () => 40,
			expandKeys: [],
			hubKeys: [],
			onClose: () => {},
			onHubClose: () => {},
			// Reads run when the test polls, not on a timer.
			pollMs: 1_000_000,
		});
	}

	/** The text of every user and assistant block the viewer shows. */
	function shown(model: AgentTranscriptViewerModel): string[] {
		return model
			.blocks()
			.flatMap(block =>
				block.kind === "user" ? [block.text] : block.kind === "assistant" ? [textOf(block.message)] : [],
			);
	}

	// A transcript that grows while the viewer is open: the record arrives after
	// the viewer showed its target, which kept the heavy text an elide pass removed.
	it("shows an answer a record in a later local read shortened as its placeholder, as a transcript with it inline does", async () => {
		const renderLocal = async ({ first, second }: { first: string; second: string }, name: string) => {
			using dir = TempDir.createSync("@omp-patch-viewer-");
			const file = path.join(dir.path(), `${name}.jsonl`);
			await Bun.write(file, first);
			const model = modelOver(file);
			try {
				await fs.appendFile(file, second);
				model.poll();
				return shown(model);
			} finally {
				model.dispose();
			}
		};
		const fromPatched = await renderLocal(transcript(HEAVY, [record, reply]), "patched");
		expect(fromPatched).toEqual(["do the task", PLACEHOLDER, "next step"]);
		expect(fromPatched).toEqual(await renderLocal(transcript(PLACEHOLDER, [reply]), "inline"));
	});

	// A collab guest reads the host's transcript in replies of at most 4 MiB: a
	// record in a later reply must reach the answer an earlier reply showed.
	it("shows an answer a record in a later host reply shortened as its placeholder, as a transcript with it inline does", async () => {
		const renderRemote = async ({ first, second }: { first: string; second: string }) => {
			const content = Buffer.from(first + second);
			const cut = Buffer.byteLength(first);
			let read: Promise<unknown> = Promise.resolve();
			const remote: AgentHubRemote = {
				chat: () => {},
				kill: () => {},
				revive: () => {},
				readTranscript: (_id, fromByte) => {
					const end = fromByte === 0 ? cut : content.byteLength;
					const result = Promise.resolve({
						text: content.subarray(fromByte, end).toString("utf-8"),
						newSize: end,
					});
					read = result;
					return result;
				},
			};
			const model = modelOver(null, remote);
			try {
				// The viewer's handler was attached to each reply before this await, so it has run when the await resumes.
				await read;
				model.poll();
				await read;
				return shown(model);
			} finally {
				model.dispose();
			}
		};
		const fromPatched = await renderRemote(transcript(HEAVY, [record, reply]));
		expect(fromPatched).toEqual(["do the task", PLACEHOLDER, "next step"]);
		expect(fromPatched).toEqual(await renderRemote(transcript(PLACEHOLDER, [reply])));
	});
});
