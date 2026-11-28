import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantRetryRecovery, ImageContent, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import {
	COLLAB_PROTO,
	type CollabFrame,
	parseCollabLink,
	TRANSCRIPT_READ_CAP,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { applyEntryPatches } from "@oh-my-pi/pi-coding-agent/session/entry-patches";
import type { FileEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadSessionMessagesReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriteOptions,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { collectSubSessions } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import { parseJsonlLenient, TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { entryPatchesOf, isEntryPatchRecord } from "@oh-my-pi/pi-utils/entry-patches";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./collab/helpers/in-memory-relay";
import { makeHostContext } from "./collab/helpers/throttled-host";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

/**
 * File storage that counts the bytes the session layer hands it, and how many
 * of its writes published the whole file.
 */
class InstrumentedFileSessionStorage extends FileSessionStorage {
	bytesWritten = 0;
	fullWrites = 0;

	override writeTextSync(filePath: string, content: string, options?: SessionStorageWriteOptions): void {
		this.fullWrites++;
		this.bytesWritten += Buffer.byteLength(content, "utf8");
		super.writeTextSync(filePath, content, options);
	}

	override writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.fullWrites++;
		this.bytesWritten += Buffer.byteLength(content, "utf8");
		return super.writeTextAtomic(filePath, content, options);
	}

	override openWriter(
		filePath: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		const writer = super.openWriter(filePath, options);
		const count = (line: string): void => {
			this.bytesWritten += Buffer.byteLength(line, "utf8");
		};
		return {
			append: line => {
				count(line);
				return writer.append(line);
			},
			appendSync: line => {
				count(line);
				if (!writer.appendSync) throw new Error("file writer lost appendSync");
				writer.appendSync(line);
			},
			flush: () => writer.flush(),
			flushSync: () => writer.flushSync?.(),
			isOpen: () => writer.isOpen(),
			close: () => writer.close(),
			getError: () => writer.getError(),
		};
	}

	/** Start counting a new write window. */
	resetCounts(): void {
		this.bytesWritten = 0;
		this.fullWrites = 0;
	}
}

const RETRIABLE_SERVER_ERROR = "503 service unavailable: overloaded_error";
/** Several MiB of history: a whole-file rewrite would write at least this much. */
const LONG_HISTORY = Array.from({ length: 6 }, (_, turn) => `history line ${turn}\n`.repeat(30_000));
const SHORT_HISTORY = ["history line\n"];

function usageWith(input: number): Usage {
	return {
		input,
		output: 8,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 8,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: usageWith(16),
		timestamp: Date.now(),
		...overrides,
	};
}

function messagesOf(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
}

function messageOf(manager: SessionManager, id: string): AgentMessage {
	const entry = manager.getEntry(id);
	if (entry?.type !== "message") throw new Error(`Expected message entry ${id}`);
	return entry.message;
}

/** The retry markers in `messages`, keyed by the message they mark. */
function retryMarks(
	messages: readonly AgentMessage[],
): Array<{ timestamp: number; retryRecovery: AssistantRetryRecovery }> {
	return messages.flatMap(message =>
		message.role === "assistant" && message.retryRecovery
			? [{ timestamp: message.timestamp, retryRecovery: message.retryRecovery }]
			: [],
	);
}

/** The display metadata of the latest compaction, as an entry or as its summary message carries it. */
function compactionStamp(source: { entries?: readonly SessionEntry[]; messages?: readonly AgentMessage[] }): {
	warning: string | undefined;
	tokensAfter: number | undefined;
} {
	if (source.entries) {
		const entry = source.entries.findLast(candidate => candidate.type === "compaction");
		if (entry?.type !== "compaction") throw new Error("Expected a compaction entry");
		return { warning: entry.warning, tokensAfter: entry.tokensAfter };
	}
	const summary = source.messages?.findLast(message => message.role === "compactionSummary");
	if (summary?.role !== "compactionSummary") throw new Error("Expected a compaction summary message");
	return { warning: summary.warning, tokensAfter: summary.tokensAfter };
}

/** `value` with every object and array inside it frozen, as a store's read-back hands it over. */
function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Write `text` into the first block of a tool result in place, as an elide pass writes into `content`. */
function writeFirstTextInPlace(message: AgentMessage, text: string): void {
	const block = message.role === "toolResult" ? message.content[0] : undefined;
	if (block?.type !== "text") throw new Error("Expected a tool result whose first block is text");
	block.text = text;
}

/** Run every step, each even when an earlier one throws; then throw what failed. */
async function runEach(steps: readonly (() => unknown)[]): Promise<void> {
	const failures: unknown[] = [];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Cleanup steps failed");
}

/**
 * What a collab guest's Agent Hub reads of the subagent transcript at `sessionFile`: replies of at most
 * {@link TRANSCRIPT_READ_CAP} bytes, the first from byte 0 and each next one from where the last ended, until
 * one comes back empty (the end of the file) or with an error.
 */
async function fetchAsCollabGuest(sessionFile: string): Promise<{ text: string; error: string | undefined }> {
	const agentId = `collab-fetch-${crypto.randomUUID()}`;
	const registry = AgentRegistry.global();
	// Each step is undone, newest first, whatever fails after it.
	const undo: (() => unknown)[] = [];
	try {
		installInMemoryRelay();
		undo.unshift(() => uninstallInMemoryRelay());
		const ref = registry.register({ id: agentId, displayName: agentId, kind: "sub", session: null, sessionFile });
		undo.unshift(() => registry.unregister(agentId, ref));
		const header = {
			type: "session" as const,
			id: "collab-fetch",
			timestamp: new Date(0).toISOString(),
			cwd: "/tmp",
		};
		const host = new CollabHost(makeHostContext({ header, entries: [] }, { notices: [], participantCounts: [] }));
		undo.unshift(() => host.stop("test done"));
		await withTimeout(host.start("ws://localhost:8788"), 10_000, "The collab host never reached the relay");
		const link = parseCollabLink(host.link);
		if ("error" in link) throw new Error(link.error);
		const guest = new CollabSocket({ wsUrl: link.wsUrl, role: "guest", key: await importRoomKey(link.key) });
		undo.unshift(() => guest.close());
		const queued: CollabFrame[] = [];
		const waiting: ((frame: CollabFrame) => void)[] = [];
		guest.onFrame = frame => {
			// The host's broadcasts and the snapshot after the welcome answer no request.
			if (frame.t !== "welcome" && frame.t !== "transcript" && frame.t !== "error") return;
			const wake = waiting.shift();
			if (wake) wake(frame);
			else queued.push(frame);
		};
		const nextReply = (what: string): Promise<CollabFrame> => {
			const frame = queued.shift();
			if (frame) return Promise.resolve(frame);
			const { promise, resolve } = Promise.withResolvers<CollabFrame>();
			waiting.push(resolve);
			return withTimeout(promise, 10_000, `The collab host sent no ${what}`);
		};
		guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "fetcher" });
		guest.connect();
		const welcome = await nextReply("welcome");
		if (welcome.t !== "welcome") throw new Error(`Expected a welcome, got ${welcome.t}`);
		let text = "";
		for (let reqId = 1, fromByte = 0; ; reqId++) {
			guest.send({ t: "fetch-transcript", reqId, agentId, fromByte });
			const reply = await nextReply(`transcript reply ${reqId}`);
			if (reply.t !== "transcript" || reply.reqId !== reqId) {
				throw new Error(`Expected transcript reply ${reqId}, got ${reply.t}`);
			}
			if (reply.error !== undefined) return { text, error: reply.error };
			if (reply.text === "") return { text, error: undefined };
			text += reply.text;
			fromByte = reply.newSize;
		}
	} finally {
		await runEach(undo);
	}
}

interface WholeFileReads<T> {
	resume: T;
	fork: T;
	readOnly: T;
	htmlExport: T;
}

describe("AgentSession entry patch persistence", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];
	/** Managers {@link persistedManager} opened: a test that builds no session on one closes it here. */
	const managers: SessionManager[] = [];

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await runEach([
			...sessions
				.splice(0)
				.reverse()
				.map(session => () => session.dispose()),
			...managers.splice(0).map(manager => () => manager.close()),
			...tempDirs.splice(0).map(dir => () => dir.remove()),
			() => vi.restoreAllMocks(),
		]);
	});

	afterAll(() => {
		authStorage.close();
	});

	function model() {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		// Pinned so catalog regeneration cannot move the compaction threshold.
		return { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
	}

	/** A persisted session whose file already holds `history` (one user turn each), counting bytes from here on. */
	async function persistedManager(history: readonly string[]): Promise<{
		dir: string;
		storage: InstrumentedFileSessionStorage;
		manager: SessionManager;
	}> {
		const tempDir = TempDir.createSync("@pi-entry-patch-");
		tempDirs.push(tempDir);
		const storage = new InstrumentedFileSessionStorage();
		const manager = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		managers.push(manager);
		for (const text of history) {
			manager.appendMessage({ role: "user", content: text, timestamp: Date.now() - 1_000 });
			manager.appendMessage(assistant([{ type: "text", text: "Noted." }], { timestamp: Date.now() - 999 }));
		}
		await manager.flush();
		storage.resetCounts();
		return { dir: tempDir.path(), storage, manager };
	}

	function sessionFileOf(manager: SessionManager): string {
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		return sessionFile;
	}

	/**
	 * What each reader that loads the whole session file rebuilds: resume,
	 * `/fork`, `history://` for a parked agent, and the HTML export of the same
	 * file as a subagent transcript.
	 */
	async function readWholeFile<T>(
		manager: SessionManager,
		dir: string,
		fromEntries: (entries: readonly SessionEntry[]) => T,
		fromMessages: (messages: readonly AgentMessage[]) => T,
	): Promise<WholeFileReads<T>> {
		const sessionFile = sessionFileOf(manager);
		// Each reader closes as soon as it opened, whatever fails after it.
		const closes: (() => unknown)[] = [];
		try {
			const resumed = await SessionManager.open(sessionFile, dir);
			closes.push(() => resumed.close());
			const forked = await SessionManager.forkFrom(sessionFile, dir, path.join(dir, "fork"), undefined, {
				copyArtifacts: false,
				suppressBreadcrumb: true,
			});
			closes.push(() => forked.close());
			const parentFile = path.join(dir, "export", "parent.jsonl");
			await Bun.write(path.join(dir, "export", "parent", "Helper.jsonl"), Bun.file(sessionFile));
			const exported = (await collectSubSessions(parentFile)).Helper;
			if (!exported) throw new Error("Expected the copied session as an exported subagent transcript");
			return {
				resume: fromEntries(resumed.getEntries()),
				fork: fromEntries(forked.getEntries()),
				readOnly: fromMessages(await loadSessionMessagesReadOnly(sessionFile)),
				htmlExport: fromEntries(exported.entries),
			};
		} finally {
			await runEach(closes);
		}
	}

	describe("a recovered retry", () => {
		async function recoverRetry(history: readonly string[]) {
			const { dir, storage, manager } = await persistedManager(history);
			const mock = createMockModel({
				responses: [{ throw: RETRIABLE_SERVER_ERROR }, { content: ["Recovered after retry."], stopReason: "stop" }],
			});
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model: model(), systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
			});
			const session = new AgentSession({
				agent,
				sessionManager: manager,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"retry.enabled": true,
					"retry.baseDelayMs": 5,
					"retry.maxDelayMs": 100,
					"retry.maxRetries": 1,
					"retry.modelFallback": false,
					"features.unexpectedStopDetection": "none",
				}),
				modelRegistry,
			});
			sessions.push(session);
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			const transcriptBytes = (await fs.stat(sessionFileOf(manager))).size;
			storage.resetCounts();

			await session.prompt("Recover from the transient failure.");
			await session.waitForIdle();
			await manager.flush();
			return { dir, manager, transcriptBytes, bytesWritten: storage.bytesWritten, fullWrites: storage.fullWrites };
		}

		it("marks the same entries for every whole-file reader in bytes that do not grow with the transcript", async () => {
			mockSchedulerWaitWithClock();
			const short = await recoverRetry(SHORT_HISTORY);
			const long = await recoverRetry(LONG_HISTORY);
			expect(long.transcriptBytes - short.transcriptBytes).toBeGreaterThan(2 * 1024 * 1024);

			// Marking the recovered attempt never rewrites the whole session file:
			// the turn writes its own entries and one small record, so a recovered
			// retry on a long session does not write the transcript again.
			expect([short.fullWrites, long.fullWrites]).toEqual([0, 0]);
			expect(Math.abs(long.bytesWritten - short.bytesWritten)).toBeLessThan(1024);

			const live = retryMarks(messagesOf(long.manager.getEntries()));
			expect(live.map(mark => mark.retryRecovery.status)).toEqual(["recovered"]);
			// A reader that loses the marker shows the superseded error as a live failure.
			expect(
				await readWholeFile(long.manager, long.dir, entries => retryMarks(messagesOf(entries)), retryMarks),
			).toEqual({
				resume: live,
				fork: live,
				readOnly: live,
				htmlExport: live,
			});
		});

		it("appends one entry_patch record and leaves the failed attempt's line as first written", async () => {
			mockSchedulerWaitWithClock();
			const { manager } = await recoverRetry(SHORT_HISTORY);

			const lines = Bun.JSONL.parse(await Bun.file(sessionFileOf(manager)).text()) as FileEntry[];
			const records = lines.flatMap(line =>
				line.type === "custom" && line.customType === "entry_patch" ? [line.data] : [],
			);
			const failedLine = lines.find(
				line => line.type === "message" && line.message.role === "assistant" && line.message.stopReason === "error",
			);
			// A rewrite of the file would write the marker into the failed attempt's own line.
			expect({
				failedLineHasMarker:
					failedLine?.type === "message" && failedLine.message.role === "assistant"
						? failedLine.message.retryRecovery !== undefined
						: undefined,
				records: records.map(data => JSON.stringify(data).includes('"status":"recovered"')),
			}).toEqual({ failedLineHasMarker: false, records: [true] });
		});
	});

	describe("a compaction dead-end stamp", () => {
		async function stampDeadEnd(history: readonly string[]) {
			const { dir, storage, manager } = await persistedManager(history);
			// The hook supplies the summary, so the pass needs no model; the guard
			// then finds no headroom and stamps the dead-end on the entry.
			const extensionRunner = {
				initialize: () => {},
				onError: () => {},
				hasHandlers: (type: string) => type === "session_before_compact",
				emit: async (event: { type: string; preparation?: { firstKeptEntryId: string; tokensBefore: number } }) => {
					if (event.type !== "session_before_compact" || !event.preparation) return undefined;
					return {
						compaction: {
							summary: "compacted",
							shortSummary: undefined,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				},
				emitBeforeAgentStart: async () => undefined,
			};
			const session = new AgentSession({
				agent: new Agent({ initialState: { model: model(), systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.autoContinue": true }),
				modelRegistry,
				extensionRunner: extensionRunner as never,
			});
			sessions.push(session);
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
			vi.spyOn(session.agent, "continue").mockResolvedValue();
			vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190_000, contextWindow: 200_000, percent: 95 });
			// The oversized tail holds nothing a rescue can elide.
			vi.spyOn(session, "shake").mockResolvedValue({
				mode: "elide",
				toolResultsDropped: 0,
				blocksDropped: 0,
				tokensFreed: 0,
			});
			const compactionDone = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end") compactionDone.resolve();
			});
			const transcriptBytes = (await fs.stat(sessionFileOf(manager))).size;
			storage.resetCounts();

			const turn = assistant([{ type: "text", text: "Done." }], { usage: usageWith(190_000) });
			session.agent.emitExternalEvent({ type: "message_end", message: turn });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [turn] });
			// Below the test's timeout, so a missing end event fails here and names itself.
			await withTimeout(compactionDone.promise, 10_000, "auto_compaction_end never arrived");
			await session.waitForIdle();
			await manager.flush();
			return { dir, manager, transcriptBytes, bytesWritten: storage.bytesWritten, fullWrites: storage.fullWrites };
		}

		it("lands the warning on every whole-file reader in bytes that do not grow with the transcript", async () => {
			const short = await stampDeadEnd(SHORT_HISTORY);
			const long = await stampDeadEnd(LONG_HISTORY);
			expect(long.transcriptBytes - short.transcriptBytes).toBeGreaterThan(2 * 1024 * 1024);

			// The stamp never rewrites the whole session file, so a compaction that
			// dead-ends does not write the transcript again.
			expect([short.fullWrites, long.fullWrites]).toEqual([0, 0]);
			expect(Math.abs(long.bytesWritten - short.bytesWritten)).toBeLessThan(1024);

			const live = compactionStamp({ entries: long.manager.getEntries() });
			expect(live.warning).toContain("Compaction freed too little context");
			// The divider badges the pause from this stamp; a reader without it
			// shows the paused session as healthy.
			expect(
				await readWholeFile(
					long.manager,
					long.dir,
					entries => compactionStamp({ entries }),
					messages => compactionStamp({ messages }),
				),
			).toEqual({ resume: live, fork: live, readOnly: live, htmlExport: live });
		}, 30_000);
	});

	describe("an elide pass", () => {
		const IMAGE: ImageContent = { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" };

		/**
		 * Appends a tool result holding `toolResultContent`, a fenced block in a reply, and a usage anchor after
		 * both; returns their ids.
		 */
		function appendElidable(manager: SessionManager, toolResultContent: ToolResultMessage["content"]): string[] {
			const callId = "call_heavy";
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "do it" }], timestamp: Date.now() });
			manager.appendMessage(
				assistant([{ type: "toolCall", id: callId, name: "bash", arguments: { command: "ls" } }], {
					stopReason: "toolUse",
				}),
			);
			const toolResultId = manager.appendMessage({
				role: "toolResult",
				toolCallId: callId,
				toolName: "bash",
				content: toolResultContent,
				isError: false,
				timestamp: Date.now(),
			});
			const fence = `\`\`\`ts\n${"const value = compute(a, b, c, d, e);\n".repeat(200)}\`\`\``;
			const fencedReplyId = manager.appendMessage(
				assistant([{ type: "text", text: `Here it is:\n${fence}\nDone.` }]),
			);
			manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `newer context\n${"tail ".repeat(4_000)}` }],
				timestamp: Date.now(),
			});
			const anchorId = manager.appendMessage(
				assistant([{ type: "text", text: "Latest reply." }], { usage: usageWith(20_000) }),
			);
			return [toolResultId, fencedReplyId, anchorId];
		}

		/** A live session over `manager`'s entries. */
		function sessionOver(manager: SessionManager): AgentSession {
			const session = new AgentSession({
				agent: new Agent({ initialState: { model: model(), systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
				modelRegistry,
			});
			sessions.push(session);
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			return session;
		}

		/** A session with a heavy tool result, a fenced block in a reply, and a usage anchor after both. */
		async function elidableSession(
			history: readonly string[],
			toolResultContent: ToolResultMessage["content"] = [{ type: "text", text: "X".repeat(20_000) }, IMAGE],
		) {
			const persisted = await persistedManager(history);
			const elidedIds = appendElidable(persisted.manager, toolResultContent);
			const session = sessionOver(persisted.manager);
			await persisted.manager.flush();
			return { ...persisted, session, elidedIds };
		}

		/** {@link elidableSession}, its file then resumed by a new manager. */
		async function resumedElidableSession(
			history: readonly string[],
			toolResultContent: ToolResultMessage["content"],
		) {
			const { dir, storage, manager: writer } = await persistedManager(history);
			const elidedIds = appendElidable(writer, toolResultContent);
			await writer.close();
			const manager = await SessionManager.open(sessionFileOf(writer), dir, storage);
			managers.push(manager);
			const session = sessionOver(manager);
			await manager.flush();
			return { dir, storage, manager, session, elidedIds };
		}

		async function resumedMessages(manager: SessionManager, dir: string, ids: readonly string[]) {
			const resumed = await SessionManager.open(sessionFileOf(manager), dir);
			try {
				return ids.map(id => structuredClone(messageOf(resumed, id)));
			} finally {
				await resumed.close();
			}
		}

		it("resumes each elided entry as the live session holds it, in bytes that do not grow with the transcript", async () => {
			const runs = [];
			for (const history of [SHORT_HISTORY, LONG_HISTORY]) {
				const run = await elidableSession(history);
				const transcriptBytes = (await fs.stat(sessionFileOf(run.manager))).size;
				run.storage.resetCounts();
				const result = await run.session.shake("elide");
				await run.manager.flush();
				expect(result.toolResultsDropped + result.blocksDropped).toBe(2);
				runs.push({
					...run,
					transcriptBytes,
					bytesWritten: run.storage.bytesWritten,
					fullWrites: run.storage.fullWrites,
				});
			}
			const [short, long] = runs;
			expect(long.transcriptBytes - short.transcriptBytes).toBeGreaterThan(2 * 1024 * 1024);

			// An elide pass, which runs on its own after compactions, never rewrites
			// the whole session file.
			expect([short.fullWrites, long.fullWrites]).toEqual([0, 0]);
			expect(Math.abs(long.bytesWritten - short.bytesWritten)).toBeLessThan(1024);

			const [toolResult, fencedReply, anchor] = long.elidedIds.map(id => messageOf(long.manager, id));
			// The pass shortened the result and the reply, and credited the removed
			// tokens to the usage anchor; a resume that drops any of it re-sends the
			// elided text or misreports the context meter.
			expect(toolResult.role === "toolResult" ? toolResult.prunedAt : undefined).toBeGreaterThan(0);
			expect(fencedReply.role === "assistant" ? fencedReply.elidedOutputTokens : undefined).toBeGreaterThan(0);
			expect(
				anchor.role === "assistant" ? anchor.contextSnapshot?.historyRewriteTokensRemoved : undefined,
			).toBeGreaterThan(0);
			expect(await resumedMessages(long.manager, long.dir, long.elidedIds)).toEqual(
				[toolResult, fencedReply, anchor].map(message => structuredClone(message)),
			);
		});

		it("keeps images a later image drop removed from an elided result out of the resumed session", async () => {
			const { dir, manager, session, elidedIds } = await elidableSession(SHORT_HISTORY);
			const [toolResultId] = elidedIds;
			await session.shake("elide");
			// Elision keeps the image; the image drop then rewrites the whole file.
			expect(messageOf(manager, toolResultId)).toMatchObject({ content: [{ type: "text" }, IMAGE] });
			expect((await session.shake("images")).imagesDropped).toBe(1);
			await manager.flush();

			const live = structuredClone(messageOf(manager, toolResultId));
			expect(live).toMatchObject({ content: [{ type: "text" }] });
			// Replaying the elide record's older content would put the dropped image
			// back into every resumed request.
			expect(await resumedMessages(manager, dir, [toolResultId])).toEqual([live]);
		});

		// A collab guest reads a subagent's file in replies of at most `TRANSCRIPT_READ_CAP` bytes, each cut after
		// its last line break, so it never reads a line of the cap or more. A record leaves the elided result's line
		// as first written; a rewrite writes it shortened.
		const TEXT_BLOCK = "X".repeat(450_000);
		/** Text blocks of 450,000 bytes each: a block persists at most 500,000 characters. */
		function textBlocks(count: number): ToolResultMessage["content"] {
			return Array.from({ length: count }, () => ({ type: "text" as const, text: TEXT_BLOCK }));
		}

		/** UTF-8 bytes of the line of `sessionFile` that holds entry `id`, as written. */
		async function storedLineBytes(sessionFile: string, id: string): Promise<number> {
			// Raw lines, not parsed entries: the measure is the line.
			const line = (await Bun.file(sessionFile).text()).split("\n").find(text => text.includes(`"id":"${id}"`));
			if (line === undefined) throw new Error(`Expected a line for entry ${id}`);
			return Buffer.byteLength(line, "utf8");
		}

		/**
		 * The message of entry `id` in fetched `text`, with the text's records applied as a guest applies them,
		 * cloned as `live` is (a record that sets `content` marks the message's token estimate stale).
		 */
		function fetchedMessage(text: string, id: string): AgentMessage | undefined {
			const entries = parseJsonlLenient<FileEntry>(text);
			applyEntryPatches(entries);
			const entry = entries.find(candidate => candidate.type === "message" && candidate.id === id);
			return entry?.type === "message" ? structuredClone(entry.message) : undefined;
		}

		for (const opened of ["live", "resumed"] as const) {
			it(`rewrites the file when an elided result's line reaches the collab fetch cap, in a ${opened} session`, async () => {
				const { manager, session, elidedIds } =
					opened === "live"
						? await elidableSession(SHORT_HISTORY, textBlocks(10))
						: await resumedElidableSession(SHORT_HISTORY, textBlocks(10));
				const [toolResultId] = elidedIds;
				const file = sessionFileOf(manager);
				expect(await storedLineBytes(file, toolResultId)).toBeGreaterThanOrEqual(TRANSCRIPT_READ_CAP);
				expect((await session.shake("elide")).toolResultsDropped).toBe(1);
				await manager.flush();

				const live = structuredClone(messageOf(manager, toolResultId));
				const fetched = await fetchAsCollabGuest(file);
				expect({
					error: fetched.error,
					toolResult: fetchedMessage(fetched.text, toolResultId),
					lineUnderCap: (await storedLineBytes(file, toolResultId)) < TRANSCRIPT_READ_CAP,
				}).toEqual({ error: undefined, toolResult: live, lineUnderCap: true });
			}, 60_000);
		}

		it("appends a record when the elided result's line is under the collab fetch cap", async () => {
			const { manager, session, storage, elidedIds } = await elidableSession(SHORT_HISTORY, textBlocks(9));
			const [toolResultId] = elidedIds;
			const file = sessionFileOf(manager);
			const lineBytes = await storedLineBytes(file, toolResultId);
			expect(lineBytes).toBeGreaterThan(TRANSCRIPT_READ_CAP - 256 * 1024);
			expect(lineBytes).toBeLessThan(TRANSCRIPT_READ_CAP);
			storage.resetCounts();
			expect((await session.shake("elide")).toolResultsDropped).toBe(1);
			await manager.flush();

			const live = structuredClone(messageOf(manager, toolResultId));
			const record = parseJsonlLenient<FileEntry>(await Bun.file(file).text()).at(-1);
			const fetched = await fetchAsCollabGuest(file);
			expect({
				fullWrites: storage.fullWrites,
				lineBytes: await storedLineBytes(file, toolResultId),
				recordTargets:
					record && isEntryPatchRecord(record) ? entryPatchesOf(record)?.map(patch => patch.entryId) : undefined,
				error: fetched.error,
				toolResult: fetchedMessage(fetched.text, toolResultId),
			}).toEqual({ fullWrites: 0, lineBytes, recordTargets: elidedIds, error: undefined, toolResult: live });
		}, 60_000);
	});

	// Built from records written as a file holds them (no `patchEntries` call), so
	// the case fails for the replay it names on a tree without it.
	it("loads a session past a malformed entry patch record and still applies the valid ones", async () => {
		const { dir, manager } = await persistedManager(SHORT_HISTORY);
		const errorId = manager.appendMessage(
			assistant([{ type: "text", text: "partial" }], {
				stopReason: "error",
				errorMessage: RETRIABLE_SERVER_ERROR,
				usage: usageWith(0),
			}),
		);
		manager.appendCustomEntry("entry_patch", { patches: "not a list" });
		const retryRecovery: AssistantRetryRecovery = {
			kind: "auto-retry",
			status: "superseded",
			attempt: 1,
			recovery: "plain",
			note: "error; retried",
		};
		manager.appendCustomEntry("entry_patch", { patches: [{ entryId: errorId, message: { retryRecovery } }] });
		await manager.flush();
		const resumed = await SessionManager.open(sessionFileOf(manager), dir);
		try {
			expect(retryMarks(messagesOf(resumed.getEntries()))).toEqual([
				{ timestamp: messageOf(resumed, errorId).timestamp, retryRecovery },
			]);
		} finally {
			await resumed.close();
		}
		expect(retryMarks(await loadSessionMessagesReadOnly(sessionFileOf(manager)))).toHaveLength(1);
	});

	// Building a turn's context reads every block's payload (`block.thinking.trim()`): a record that set a thinking
	// block without its thinking would leave a session that opens but whose next turn throws. Built from records
	// written as a file holds them.
	it("skips a record that sets a thinking block without its thinking, and the resumed session's next turn runs", async () => {
		const { dir, manager } = await persistedManager(SHORT_HISTORY);
		const replyId = manager.appendMessage(assistant([{ type: "text", text: "first answer" }]));
		manager.appendCustomEntry("entry_patch", {
			patches: [{ entryId: replyId, message: { content: [{ type: "thinking" }] } }],
		});
		await manager.flush();
		const resumed = await SessionManager.open(sessionFileOf(manager), dir);
		const mock = createMockModel({ responses: [{ content: ["Second answer."], stopReason: "stop" }] });
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: model(), systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
			}),
			sessionManager: resumed,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"features.unexpectedStopDetection": "none",
			}),
			modelRegistry,
		});
		sessions.push(session);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await session.prompt("Continue.");
		await session.waitForIdle();

		const replies = messagesOf(resumed.getEntries()).flatMap(message =>
			message.role === "assistant"
				? [message.content.map(block => (block.type === "text" ? block.text : "")).join("")]
				: [],
		);
		expect(replies).toEqual(["Noted.", "first answer", "Second answer."]);
	});

	// A record's values must not be shared with the entry they patch: a later
	// in-place write to the entry (an elide or prune pass) would otherwise change
	// the record too.
	it("appends a record that shares no object with the entry patchEntries patched", async () => {
		const placeholder = () => [{ type: "text" as const, text: "[elided: see artifact://1]" }];
		const { manager } = await persistedManager(SHORT_HISTORY);
		manager.appendMessage(
			assistant([{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }], {
				stopReason: "toolUse",
			}),
		);
		const resultId = manager.appendMessage({
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "bash",
			content: [{ type: "text", text: "listing" }],
			isError: false,
			timestamp: Date.now(),
		});
		await manager.patchEntries([{ entryId: resultId, message: { content: placeholder() } }]);
		writeFirstTextInPlace(messageOf(manager, resultId), "written in place");
		const record = manager
			.getEntries()
			.findLast(entry => entry.type === "custom" && entry.customType === "entry_patch");
		expect(record?.type === "custom" ? record.data : undefined).toEqual({
			patches: [{ entryId: resultId, message: { content: placeholder() } }],
		});
	});

	// Every reader skips a record whose data fails its check, valid patches included. `NaN` is a TypeScript
	// `number`, but the record's line holds it as `null`: written, the live session would show the warning beside
	// it, and a resume would lose that warning too.
	it("rejects patches whose record its line cannot hold, before changing the file or any entry", async () => {
		const { dir, manager } = await persistedManager(SHORT_HISTORY);
		const firstKept = manager.getEntries().at(-1);
		if (!firstKept) throw new Error("Expected the history's entries");
		const compactionId = manager.appendCompaction("summary", undefined, firstKept.id, 100);
		await manager.flush();
		const file = sessionFileOf(manager);
		const fileBefore = await Bun.file(file).text();
		const entriesBefore = JSON.stringify(manager.getEntries());
		const warning = "Compaction freed too little context";

		await expect(
			manager.patchEntries([
				{ entryId: compactionId, entry: { warning } },
				{ entryId: compactionId, entry: { tokensAfter: Number.NaN } },
			]),
		).rejects.toThrow("Entry patch holds a value its session line cannot hold");
		await manager.flush();
		expect({
			fileUnchanged: (await Bun.file(file).text()) === fileBefore,
			entriesUnchanged: JSON.stringify(manager.getEntries()) === entriesBefore,
		}).toEqual({ fileUnchanged: true, entriesUnchanged: true });

		// Control: the valid patch alone lands, live and on resume.
		await manager.patchEntries([{ entryId: compactionId, entry: { warning } }]);
		const resumed = await SessionManager.open(file, dir);
		try {
			expect({
				live: compactionStamp({ entries: manager.getEntries() }),
				resumed: compactionStamp({ entries: resumed.getEntries() }),
			}).toEqual({
				live: { warning, tokensAfter: undefined },
				resumed: { warning, tokensAfter: undefined },
			});
		} finally {
			await resumed.close();
		}
	});

	// A store can hand a record's data back frozen. Each field a load sets from
	// it (`retryRecovery`, `contextSnapshot`, `preserveData`, a custom message's
	// and a message's `content`) must be the entry's own copy, so a later
	// in-place write to the entry succeeds instead of throwing on the frozen record.
	it("gives each patched entry its own copy of a frozen record's values", () => {
		const timestamp = new Date().toISOString();
		const retryRecovery: AssistantRetryRecovery = {
			kind: "auto-retry",
			status: "superseded",
			attempt: 1,
			recovery: "plain",
			note: "error; retried",
		};
		const contextSnapshot = { promptTokens: 1_000, nonMessageTokens: 200, historyRewriteTokensRemoved: 40 };
		const loaded: FileEntry[] = [
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp,
				message: assistant([{ type: "text", text: "partial" }], { stopReason: "error", usage: usageWith(0) }),
			},
			{
				type: "message",
				id: "t1",
				parentId: "a1",
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "bash",
					content: [{ type: "text", text: "listing" }],
					isError: false,
					timestamp: Date.now(),
				},
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "t1",
				timestamp,
				summary: "summary",
				firstKeptEntryId: "t1",
				tokensBefore: 100,
				preserveData: { archive: { frames: 1 } },
			},
			{
				type: "custom_message",
				id: "m1",
				parentId: "c1",
				timestamp,
				customType: "notice",
				content: [{ type: "text", text: "heavy notice" }],
				display: true,
			},
			deepFreeze({
				type: "custom",
				customType: "entry_patch",
				id: "p1",
				parentId: "m1",
				timestamp,
				data: {
					patches: [
						{ entryId: "a1", message: { retryRecovery, contextSnapshot } },
						{ entryId: "t1", message: { content: [{ type: "text", text: "[elided]" }] } },
						{ entryId: "c1", entry: { preserveData: { archive: { frames: 2 } } } },
						{ entryId: "m1", entry: { content: [{ type: "text", text: "[elided notice]" }] } },
					],
				},
			}),
		];
		applyEntryPatches(loaded);
		const [failed, result, compaction, notice] = loaded;
		if (failed?.type !== "message" || failed.message.role !== "assistant") throw new Error("Expected the attempt");
		if (result?.type !== "message") throw new Error("Expected the tool result");
		if (compaction?.type !== "compaction" || notice?.type !== "custom_message") throw new Error("Expected entries");
		const recovery = failed.message.retryRecovery;
		const snapshot = failed.message.contextSnapshot;
		const archive = compaction.preserveData?.archive as { frames: number } | undefined;
		const noticeBlock = typeof notice.content === "string" ? undefined : notice.content[0];
		if (!recovery || !snapshot || !archive || noticeBlock?.type !== "text")
			throw new Error("Expected patched fields");
		// Every patch applied: the in-place writes below test the copies, not the originals.
		expect({
			retryRecovery: failed.message.retryRecovery,
			contextSnapshot: failed.message.contextSnapshot,
			result: result.message.role === "toolResult" ? result.message.content : undefined,
			preserveData: compaction.preserveData,
			notice: notice.content,
		}).toEqual({
			retryRecovery,
			contextSnapshot,
			result: [{ type: "text", text: "[elided]" }],
			preserveData: { archive: { frames: 2 } },
			notice: [{ type: "text", text: "[elided notice]" }],
		});
		// As an elide, prune or recovery pass writes into the fields it patched.
		recovery.note = "written in place";
		snapshot.historyRewriteTokensRemoved = 80;
		archive.frames = 3;
		noticeBlock.text = "written in place";
		writeFirstTextInPlace(result.message, "written in place");
		expect({
			note: failed.message.retryRecovery?.note,
			removed: failed.message.contextSnapshot?.historyRewriteTokensRemoved,
			frames: archive.frames,
			notice: noticeBlock.text,
			result: result.message.role === "toolResult" ? result.message.content : undefined,
		}).toEqual({
			note: "written in place",
			removed: 80,
			frames: 3,
			notice: "written in place",
			result: [{ type: "text", text: "written in place" }],
		});
	});
});
