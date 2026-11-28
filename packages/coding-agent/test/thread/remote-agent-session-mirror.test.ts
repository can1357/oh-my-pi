/**
 * How a worker-homed session's mirror on main (`RemoteAgentSession`) pairs the messages of its message list with
 * those of its entry list, fed the deltas its worker's publisher sends: one object for a message both lists hold,
 * found without reading either list.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { deobfuscateAssistantContent } from "../../src/secrets/message-transform";
import { SecretObfuscator } from "../../src/secrets/obfuscator";
import type { SessionEntry, SessionMessageEntry } from "../../src/session/session-entries";
import {
	emptyMirrorState,
	emptyViewState,
	RemoteAgentSession,
	SessionHostClient,
} from "../../src/thread/remote-agent-session";
import type { RemoteObject } from "../../src/thread/rpc";
import type { SessionHostProtocol } from "../../src/thread/session-mirror";
import { createAssistantMessage } from "../helpers/agent-session-setup";

/** Messages the history tests append before they measure. */
const HISTORY = 400;
const BASE = 1_700_000_000_000;

/** A publisher no test here calls: every delta below is applied by hand, as the bridge applies the worker's notes. */
const host: RemoteObject<SessionHostProtocol> = {
	id: 1,
	call: () => Promise.reject(new Error("no worker behind this mirror")),
	callSync: () => {
		throw new Error("no worker behind this mirror");
	},
	notify: () => {},
};

function openMirror(messages: AgentMessage[] = []): RemoteAgentSession {
	return new RemoteAgentSession({
		key: "mirror-test",
		home: "w1",
		agentId: "Mirrored",
		host: new SessionHostClient(host),
		state: emptyMirrorState(),
		messages,
	});
}

/** What main receives of `value` in one note: every note is its own structured clone. */
function note<T>(value: T): T {
	return structuredClone(value);
}

function toolResult(index: number, text = `output ${index}`): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${index}`,
		toolName: "bash",
		content: [{ type: "text", text }],
		details: { exitCode: 0 },
		isError: false,
		timestamp: BASE + index,
	};
}

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
}

function textOf(message: AgentMessage | undefined): string {
	if (!message || !("content" in message)) return "";
	const content: unknown = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part.type === "text" ? part.text : "")).join("");
}

/** The messages of the mirror's message entries, in entry order. */
function entryMessages(remote: RemoteAgentSession): AgentMessage[] {
	return remote.sessionManager.getEntries().flatMap(entry => (entry.type === "message" ? [entry.message] : []));
}

/** For each message of the mirror's list, whether the entry at the same place holds that very object. */
function sharedAt(remote: RemoteAgentSession): boolean[] {
	const held = entryMessages(remote);
	return remote.messages.map((message, index) => held[index] === message);
}

/** Reads the mirror made of armed {@link CountedEntry}s. */
interface ReadCounter {
	reads: number;
}

/** A message entry that counts the mirror's reads of its `type` and `message` once armed (after it was applied). */
class CountedEntry implements SessionMessageEntry {
	readonly timestamp: string;
	armed = false;
	#message: AgentMessage;

	constructor(
		readonly id: string,
		readonly parentId: string | null,
		message: AgentMessage,
		readonly counter: ReadCounter,
	) {
		this.timestamp = new Date(message.timestamp).toISOString();
		this.#message = message;
	}

	get type(): "message" {
		if (this.armed) this.counter.reads++;
		return "message";
	}

	get message(): AgentMessage {
		if (this.armed) this.counter.reads++;
		return this.#message;
	}

	set message(message: AgentMessage) {
		this.#message = message;
	}
}

/**
 * Feed `remote` {@link HISTORY} tool results as a publisher flush sends them, the `messages` note ahead of the
 * `entries` note, with counted entries; returns the reads of earlier entries each pair cost.
 */
function appendHistory(remote: RemoteAgentSession, counter: ReadCounter): { entries: CountedEntry[]; reads: number[] } {
	const entries: CountedEntry[] = [];
	const reads: number[] = [];
	for (let index = 0; index < HISTORY; index++) {
		const sent = toolResult(index);
		const entry = new CountedEntry(`e${index}`, index === 0 ? null : `e${index - 1}`, note(sent), counter);
		const before = counter.reads;
		remote.applyMessages({ kind: "append", messages: [note(sent)] });
		remote.applyEntries({ kind: "append", entries: [entry] });
		reads.push(counter.reads - before);
		entry.armed = true;
		entries.push(entry);
	}
	return { entries, reads };
}

describe("worker session mirror: one object for a message both lists hold", () => {
	it("pairs each message sent ahead of its entry with that entry without reading any earlier entry", () => {
		// If this regresses, every message a watched worker subagent appends makes main's UI thread read the
		// whole entry list it mirrors (a flush sends its messages before its entries, so each lookup misses),
		// and a long run costs main time quadratic in its length; or main keeps each message twice.
		const remote = openMirror();
		const counter: ReadCounter = { reads: 0 };
		const { reads } = appendHistory(remote, counter);
		const shared = sharedAt(remote);
		expect({
			pairsReadingEarlierEntries: reads.filter(count => count > 0).length,
			mostEarlierEntryReads: Math.max(...reads),
			unshared: shared.filter(isShared => !isShared).length,
		}).toEqual({ pairsReadingEarlierEntries: 0, mostEarlierEntryReads: 0, unshared: 0 });
	});

	it("reads none of the entries an unwatched history rewrite left for each message appended after it", () => {
		// If this regresses, once a worker subagent's history is rewritten while main does not watch it, every
		// message it appends after makes main read every entry left from the earlier watch.
		const remote = openMirror();
		const counter: ReadCounter = { reads: 0 };
		appendHistory(remote, counter);

		// The rewrite changes one interior result; the entries main kept stay as they were.
		const rewritten = Array.from({ length: HISTORY }, (_, index) =>
			index === 1 ? toolResult(index, "pruned") : toolResult(index),
		);
		remote.applyMessages({ kind: "replace", messages: note(rewritten) });
		const afterReplace = counter.reads;
		for (let index = HISTORY; index < 2 * HISTORY; index++) {
			remote.applyMessages({ kind: "append", messages: [note(toolResult(index))] });
		}
		const appendReads = counter.reads - afterReplace;
		const shared = sharedAt(remote);
		expect({
			appendReads,
			prunedShared: shared[1],
			unchangedUnshared: shared.slice(0, HISTORY).filter((isShared, index) => index !== 1 && !isShared).length,
			appended: remote.messages.length,
		}).toEqual({ appendReads: 0, prunedShared: false, unchangedUnshared: 0, appended: 2 * HISTORY });
	});

	it("shares a watch's catch-up and an entry replace with the messages main holds", () => {
		// If this regresses, a worker subagent main starts watching after it ran holds every message twice on
		// main, once in its message list and once in its entry list, or an entry replace does.
		const remote = openMirror([note(toolResult(0))]);
		for (let index = 1; index < 4; index++)
			remote.applyMessages({ kind: "append", messages: [note(toolResult(index))] });
		const sent = Array.from({ length: 6 }, (_, index) =>
			messageEntry(`e${index}`, index === 0 ? null : `e${index - 1}`, toolResult(index)),
		);

		// The first watch catches up with every entry; messages appended unwatched pair with the next one's.
		remote.applyView({ ...emptyViewState(), leafId: "e3" }, { kind: "append", entries: note(sent.slice(0, 4)) });
		const firstWatch = sharedAt(remote);
		for (let index = 4; index < 6; index++)
			remote.applyMessages({ kind: "append", messages: [note(toolResult(index))] });
		remote.applyView({ ...emptyViewState(), leafId: "e5" }, { kind: "append", entries: note(sent.slice(4)) });
		const secondWatch = sharedAt(remote);

		const before = [...remote.messages];
		remote.applyEntries({ kind: "replace", entries: note(sent) });
		const replaced = sharedAt(remote);
		expect({
			firstWatch,
			secondWatch,
			replaced,
			messagesKept: remote.messages.every((message, index) => message === before[index]),
		}).toEqual({
			firstWatch: [true, true, true, true],
			secondWatch: [true, true, true, true, true, true],
			replaced: [true, true, true, true, true, true],
			messagesKept: true,
		});
	});

	it("keeps an entry shown with its secret restored apart from its message, and pairs equal messages one to one", () => {
		// If this regresses, main's message list of a worker subagent shows a secret the worker restored only
		// for display, or two equal messages share one entry's object while the other entry keeps a copy.
		const remote = openMirror();
		const secret = "sk-mirror-secret-0042";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const masked: AssistantMessage = {
			...createAssistantMessage(`the key is ${obfuscator.obfuscate(secret)}`),
			timestamp: BASE,
		};
		const shown: AssistantMessage = { ...masked, content: deobfuscateAssistantContent(obfuscator, masked.content) };
		remote.applyMessages({ kind: "append", messages: [note(masked)] });
		remote.applyEntries({ kind: "append", entries: [messageEntry("e0", null, note(shown))] });

		// The `entries` note first, as when the entry was recorded before its message reached the published list.
		remote.applyEntries({ kind: "append", entries: [messageEntry("e1", "e0", note(toolResult(1)))] });
		remote.applyMessages({ kind: "append", messages: [note(toolResult(1))] });

		// Two equal messages (same persistence key, same content), then their two entries.
		const twice: UserMessage = { role: "user", content: "again", timestamp: BASE + 2 };
		remote.applyMessages({ kind: "append", messages: [note(twice)] });
		remote.applyMessages({ kind: "append", messages: [note(twice)] });
		remote.applyEntries({ kind: "append", entries: [messageEntry("e2", "e1", note(twice))] });
		remote.applyEntries({ kind: "append", entries: [messageEntry("e3", "e2", note(twice))] });

		const held = entryMessages(remote);
		const messages = remote.messages;
		expect({
			secretShared: held[0] === messages[0],
			entryShowsSecret: textOf(held[0]).includes(secret),
			messageShowsSecret: textOf(messages[0]).includes(secret),
			entryFirstShared: held[1] === messages[1],
			equalEntriesDistinct: held[2] !== held[3],
			equalEntriesHoldMessages: [held[2], held[3]].map(
				message => message !== undefined && messages.includes(message),
			),
		}).toEqual({
			secretShared: false,
			entryShowsSecret: true,
			messageShowsSecret: false,
			entryFirstShared: true,
			equalEntriesDistinct: true,
			equalEntriesHoldMessages: [true, true],
		});
	});

	it("deduplicates equal 50,000-deep messages and keeps unequal ones separate without overflowing the stack", () => {
		// If this regresses, mirroring a worker subagent whose tool result holds deeply nested JSON throws
		// RangeError: Maximum call stack size exceeded inside mirrored-message deduplication.
		const DEPTH = 50_000;
		const buildDeep = (leaf: string, kind: "object" | "array"): unknown => {
			let node: unknown = { leaf };
			for (let i = 0; i < DEPTH; i++) {
				node = kind === "array" ? [node] : { nested: node };
			}
			return node;
		};
		const deepMessage = (index: number, leaf: string, kind: "object" | "array"): ToolResultMessage => ({
			...toolResult(index),
			details: { exitCode: 0, payload: buildDeep(leaf, kind) },
		});

		const remote = openMirror();
		const eqObjMsg = deepMessage(0, "same", "object");
		const eqObjEntry = deepMessage(0, "same", "object");
		const neqObjMsg = deepMessage(1, "left", "object");
		const neqObjEntry = deepMessage(1, "right", "object");
		const eqArrMsg = deepMessage(2, "same", "array");
		const eqArrEntry = deepMessage(2, "same", "array");
		const neqArrMsg = deepMessage(3, "left", "array");
		const neqArrEntry = deepMessage(3, "right", "array");

		// Strict equality: an explicit `undefined` property must stay distinct from a missing key.
		const undefKeyMsg: ToolResultMessage = { ...toolResult(4), details: { exitCode: 0, extra: undefined } };
		const missingKeyEntry: ToolResultMessage = { ...toolResult(4), details: { exitCode: 0 } };

		remote.applyMessages({
			kind: "append",
			messages: [eqObjMsg, neqObjMsg, eqArrMsg, neqArrMsg, undefKeyMsg],
		});
		remote.applyEntries({
			kind: "append",
			entries: [
				messageEntry("e0", null, eqObjEntry),
				messageEntry("e1", "e0", neqObjEntry),
				messageEntry("e2", "e1", eqArrEntry),
				messageEntry("e3", "e2", neqArrEntry),
				messageEntry("e4", "e3", missingKeyEntry),
			],
		});

		expect(sharedAt(remote)).toEqual([true, false, true, false, false]);
	}, 30_000);
});
