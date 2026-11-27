import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { USELESS_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AdvisorOutputQuarantinedError, AdvisorRuntime } from "@oh-my-pi/pi-coding-agent/advisor/runtime";
import { runAnonymizeCommand } from "@oh-my-pi/pi-coding-agent/cli/anonymize-cli";
import { TRANSCRIPT_READ_CAP } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { loadSessionMessagesReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriteOptions,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { collectSubSessions } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

/**
 * File storage that counts the bytes the session layer hands it — whole-body
 * publishes plus appended lines — and can fail one append, the way a full or
 * read-only disk refuses a write.
 */
class InstrumentedFileSessionStorage extends FileSessionStorage {
	bytesWritten = 0;
	/** The next appended line containing this text throws instead of landing. */
	failNextAppendContaining: string | undefined;

	override writeTextSync(filePath: string, content: string, options?: SessionStorageWriteOptions): void {
		this.bytesWritten += Buffer.byteLength(content, "utf8");
		super.writeTextSync(filePath, content, options);
	}

	override writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.bytesWritten += Buffer.byteLength(content, "utf8");
		return super.writeTextAtomic(filePath, content, options);
	}

	override openWriter(
		filePath: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		const writer = super.openWriter(filePath, options);
		const admit = (line: string): void => {
			const marker = this.failNextAppendContaining;
			if (marker !== undefined && line.includes(marker)) {
				this.failNextAppendContaining = undefined;
				throw new Error("injected append failure");
			}
			this.bytesWritten += Buffer.byteLength(line, "utf8");
		};
		return {
			append: line => {
				admit(line);
				return writer.append(line);
			},
			appendSync: line => {
				admit(line);
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
}

/**
 * Regression: the per-turn supersede/useless prune pass rewrote the LIVE agent
 * context but never persisted the rewrite, so the session file kept the
 * original (un-pruned) history. Anything that rebuilds from the file — `/tan`
 * and `/fork` clones, session resume — then produced a divergent, larger
 * prefix and cold-missed the provider prompt cache the parent had populated.
 *
 * Contract: after the prune fires, rebuilding the session from disk yields the
 * same message content as the live agent state.
 */
describe("AgentSession per-turn prune persistence", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let storage: InstrumentedFileSessionStorage;
	let authStorage: AuthStorage;

	const BIG_CALL_ID = "call-big-useless";
	const BIG_RESULT_TEXT = "match line\n".repeat(20000);
	const ADVISOR_REPLY = "ADVISOR_REPLY_SENTINEL";
	let advisorRequests: Context[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-prune-persistence-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		storage = new InstrumentedFileSessionStorage();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path(), storage);

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const now = Date.now();
		const usageZero = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		sessionManager.appendMessage({
			role: "user",
			content: "Investigate every module of the project.",
			timestamp: now - 200,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: BIG_CALL_ID, name: "grep", arguments: { pattern: "TODO" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: usageZero,
			timestamp: now - 180,
		});
		// The only prune candidate: a big result flagged useless whose suffix
		// stays inside the cache-warm window, so the pass rewrites it.
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: BIG_CALL_ID,
			toolName: "grep",
			content: [{ type: "text", text: BIG_RESULT_TEXT }],
			isError: false,
			useless: true,
			timestamp: now - 170,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Nothing relevant found; moving on." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: usageZero,
			timestamp: now - 160,
		});

		const primary = createMockModel({ provider: "anthropic", handler: { content: ["Primary step done."] } });
		const advisorModel = createMockModel({ provider: "anthropic", handler: { content: [ADVISOR_REPLY] } });
		advisorRequests = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: primary.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.dropUseless": true,
				"compaction.supersedeReads": true,
			}),
			modelRegistry,
			advisorStreamFn: (streamModel, context, options) => {
				advisorRequests.push({
					systemPrompt: context.systemPrompt?.slice(),
					messages: structuredClone(context.messages),
				});
				return advisorModel.stream(streamModel, context, options);
			},
			// Enough for `#withEvalStateContext` to append its synthetic message
			// once the history holds an `eval` call.
			evalToolSession: {
				cwd: tempDir.path(),
				getEvalSessionId: () => "prune-persistence-eval",
			} as unknown as ToolSession,
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
	});

	function liveResultText(toolCallId = BIG_CALL_ID): string {
		const message = session.agent.state.messages.find(
			candidate => candidate.role === "toolResult" && candidate.toolCallId === toolCallId,
		);
		if (message?.role !== "toolResult" || !Array.isArray(message.content)) {
			throw new Error("Expected the seeded tool result in live agent state");
		}
		const text = message.content.find(block => block.type === "text");
		if (text?.type !== "text") throw new Error("Expected text content on the seeded tool result");
		return text.text;
	}

	/** Text content of the tool result answering `toolCallId` among `messages`. */
	function resultTextIn(messages: readonly AgentMessage[], toolCallId: string): string | undefined {
		const result = messages.find(candidate => candidate.role === "toolResult" && candidate.toolCallId === toolCallId);
		if (result?.role !== "toolResult" || !Array.isArray(result.content)) {
			throw new Error(`Expected tool result ${toolCallId} in the rebuilt messages`);
		}
		const text = result.content.find(block => block.type === "text");
		return text?.type === "text" ? text.text : undefined;
	}

	function persistedSessionFile(): string {
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		return sessionFile;
	}

	/** Text of a tool result in a fresh session rebuilt from the file, as resume sees it. */
	async function rebuiltResultText(toolCallId = BIG_CALL_ID): Promise<string | undefined> {
		const reloaded = await SessionManager.open(persistedSessionFile(), tempDir.path());
		return resultTextIn(reloaded.buildSessionContext().messages, toolCallId);
	}

	/**
	 * Text of the seeded tool result as each reader that loads the whole
	 * session file sees it: resume, `/fork`/`/tan`, `history://` for a parked
	 * agent, the subagent transcript collector (HTML export, `/dump`, subagent
	 * restore) reading the same file as a subagent transcript, and `omp
	 * anonymize`, whose redaction marker keeps only the text's length.
	 */
	async function wholeFileReaderTexts(): Promise<Record<string, string | undefined>> {
		const sessionFile = persistedSessionFile();
		const forked = await SessionManager.forkFrom(
			sessionFile,
			tempDir.path(),
			path.join(tempDir.path(), "fork"),
			undefined,
			{ copyArtifacts: false, suppressBreadcrumb: true },
		);
		const parentFile = path.join(tempDir.path(), "export", "parent.jsonl");
		fs.mkdirSync(path.join(tempDir.path(), "export", "parent"), { recursive: true });
		fs.copyFileSync(sessionFile, path.join(tempDir.path(), "export", "parent", "Helper.jsonl"));
		const subSession = (await collectSubSessions(parentFile)).Helper;
		if (!subSession) throw new Error("Expected the copied session as an exported subagent transcript");
		const exported = subSession.entries.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
		// `omp anonymize` refuses an output directory inside the session's own directory.
		using anonymizeOut = TempDir.createSync("@pi-prune-anonymize-");
		await runAnonymizeCommand({ session: sessionFile, out: anonymizeOut.join("out") });
		const anonymized = fs.readFileSync(anonymizeOut.join("out", "session.jsonl"), "utf8");
		return {
			resume: await rebuiltResultText(),
			fork: resultTextIn(forked.buildSessionContext().messages, BIG_CALL_ID),
			readOnly: resultTextIn(await loadSessionMessagesReadOnly(sessionFile), BIG_CALL_ID),
			subSession: resultTextIn(exported, BIG_CALL_ID),
			anonymize: anonymized.includes(`: ${BIG_RESULT_TEXT.length} chars`)
				? BIG_RESULT_TEXT
				: anonymized.includes(`: ${USELESS_NOTICE.length} chars, 1 line]`)
					? USELESS_NOTICE
					: undefined,
		};
	}

	/** Ends a turn outside the agent loop; its agent end runs the per-turn prune pass. */
	async function endTurn(): Promise<void> {
		const finalAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Continuing." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });
		await session.waitForIdle();
	}

	it("persists the prune so every whole-file reader rebuilds the live context", async () => {
		const revisionBefore = sessionManager.bodyRevision;
		await endTurn();

		// The per-turn pass rewrote the live context…
		expect(liveResultText()).toBe(USELESS_NOTICE);
		// …announced the in-place update, so readers that mirror entries (a
		// thread's session publisher) resend them instead of appending only
		// the record…
		expect(sessionManager.bodyRevision).toBeGreaterThan(revisionBefore);

		// …and every reader of the persisted file must rebuild the SAME content:
		// a divergent fork/resume prefix cold-misses the provider cache, and a
		// parked agent's `history://` or its exported transcript would show the
		// stale output.
		await sessionManager.flush();
		expect(await wholeFileReaderTexts()).toEqual({
			resume: USELESS_NOTICE,
			fork: USELESS_NOTICE,
			readOnly: USELESS_NOTICE,
			subSession: USELESS_NOTICE,
			anonymize: USELESS_NOTICE,
		});
	});

	it("persists a prune in bytes that do not grow with the transcript", async () => {
		// Regression: the pass republished the whole session file for every
		// prune, so a small tool call on a long session wrote the entire
		// transcript again.
		const lateCallId = "call-late-useless";
		for (let i = 0; i < 4; i++) {
			sessionManager.appendMessage({
				role: "user",
				content: `history line ${i}\n`.repeat(50_000),
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `Noted part ${i}.` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
		}
		// The turn's only prune candidate sits in the cache-warm tail.
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: lateCallId, name: "grep", arguments: { pattern: "FIXME" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: lateCallId,
			toolName: "grep",
			content: [{ type: "text", text: "late match\n".repeat(20000) }],
			isError: false,
			useless: true,
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await sessionManager.flush();
		const sessionFile = persistedSessionFile();
		const transcriptBytes = fs.statSync(sessionFile).size;
		expect(transcriptBytes).toBeGreaterThan(2 * 1024 * 1024);

		storage.bytesWritten = 0;
		await endTurn();
		await sessionManager.flush();

		expect(liveResultText(lateCallId)).toBe(USELESS_NOTICE);
		// The turn wrote its own entries and the prune record. A whole-file
		// publish writes at least the file it publishes (the pre-turn transcript
		// is no bound: that publish drops the pruned body).
		expect(storage.bytesWritten).toBeGreaterThan(0);
		expect(storage.bytesWritten).toBeLessThan(fs.statSync(sessionFile).size);
		expect(await rebuiltResultText(lateCallId)).toBe(USELESS_NOTICE);
	});

	it("settles the run and lands the prune durably after its write fails", async () => {
		storage.failNextAppendContaining = "tool_result_prune";
		const persistenceErrors: string[] = [];
		const unsubscribePersistence = sessionManager.onPersistenceError(error => persistenceErrors.push(error.message));
		const runStates: string[] = [];
		const unsubscribeRunState = session.subscribeRunState(state => runStates.push(state));
		const settles: string[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_end" || event.type === "agent_pause") settles.push(event.type);
		});
		try {
			await endTurn();

			// The loop end opens the run it ends: the run reports idle and publishes one
			// agent_end, so the UI stops its working indicator instead of spinning forever,
			// and the failed write reaches the persistence-error surface.
			expect(runStates).toEqual(["running", "idle"]);
			expect(settles).toEqual(["agent_end"]);
			expect(persistenceErrors).toEqual(["injected append failure"]);
			expect(liveResultText()).toBe(USELESS_NOTICE);

			// The next entry recovers the store, and the file then rebuilds to
			// the live (pruned) context.
			sessionManager.appendCustomEntry("prune-persistence-probe");
			await sessionManager.flush();
			expect(await rebuiltResultText()).toBe(USELESS_NOTICE);
		} finally {
			unsubscribe();
			unsubscribeRunState();
			unsubscribePersistence();
		}
	});

	it("replays every prune record on resume, not only the first", async () => {
		await endTurn();
		const secondCallId = "call-second-useless";
		const usageZero = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: secondCallId, name: "grep", arguments: { pattern: "XXX" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: usageZero,
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: secondCallId,
			toolName: "grep",
			content: [{ type: "text", text: "second match\n".repeat(20000) }],
			isError: false,
			useless: true,
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await endTurn();
		await sessionManager.flush();

		const records = fs
			.readFileSync(persistedSessionFile(), "utf8")
			.split("\n")
			.filter(line => line.includes('"customType":"tool_result_prune"'));
		expect(records).toHaveLength(2);
		expect(await rebuiltResultText()).toBe(USELESS_NOTICE);
		expect(await rebuiltResultText(secondCallId)).toBe(USELESS_NOTICE);
	});

	it("writes a pruned result too long for the collab transcript fetch inline", async () => {
		// Regression: the record landed after the pruned result's original line.
		// A collab guest fetches the file in TRANSCRIPT_READ_CAP-byte windows and
		// stops at a longer line, so a cold guest never reached the record. Each
		// block stays under the per-string persistence limit; their number makes
		// the line long.
		const longCallId = "call-long-useless";
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: longCallId, name: "mcp_search", arguments: { query: "LONG" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: longCallId,
			toolName: "mcp_search",
			content: Array.from({ length: 11 }, (_, block) => ({
				type: "text" as const,
				text: `block ${block}\n${"long match\n".repeat(36_000)}`,
			})),
			isError: false,
			useless: true,
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await sessionManager.flush();
		const longestLineBytes = (): number =>
			Math.max(
				...fs
					.readFileSync(persistedSessionFile(), "utf8")
					.split("\n")
					.map(line => Buffer.byteLength(line, "utf8") + 1),
			);
		expect(longestLineBytes()).toBeGreaterThan(TRANSCRIPT_READ_CAP);

		await endTurn();
		await sessionManager.flush();

		expect(liveResultText(longCallId)).toBe(USELESS_NOTICE);
		expect(longestLineBytes()).toBeLessThanOrEqual(TRANSCRIPT_READ_CAP);
		expect(await rebuiltResultText(longCallId)).toBe(USELESS_NOTICE);
	});

	describe("advisor across the per-turn prune", () => {
		const usage = {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		function assistant(content: Array<Record<string, unknown>>): AgentMessage {
			return {
				role: "assistant",
				content,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
				usage,
				timestamp: Date.now(),
			} as unknown as AgentMessage;
		}

		function toolResult(toolCallId: string, toolName: string, text: string, useless = false): AgentMessage {
			return {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text }],
				isError: false,
				useless,
				timestamp: Date.now(),
			} as unknown as AgentMessage;
		}

		/** Commits a turn outside the agent loop (no advisor review); its agent end runs the prune pass. */
		async function commitUnreviewedTurn(messages: AgentMessage[]): Promise<void> {
			for (const message of messages) session.agent.emitExternalEvent({ type: "message_end", message });
			session.agent.emitExternalEvent({ type: "agent_end", messages });
			await session.waitForIdle();
		}

		/** A real primary turn: its turn end renders the next advisor delta, its agent end runs the prune pass. */
		async function reviewedTurn(text: string): Promise<void> {
			await session.agent.prompt(text);
			await session.waitForIdle();
			expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		}

		function enableAdvisor(): void {
			session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
			expect(session.setAdvisorEnabled(true)).toBe(true);
		}

		async function withPrefixResetCount(run: () => Promise<void>): Promise<number> {
			const debug = vi.spyOn(logger, "debug");
			try {
				await run();
				return debug.mock.calls.filter(
					([message, details]) =>
						message === "advisor context reset" &&
						(details as { reason?: string } | undefined)?.reason === "delivered-prefix-changed",
				).length;
			} finally {
				debug.mockRestore();
			}
		}

		/** The advisor kept its own history and was not re-sent the transcript it never needed. */
		function expectLastReviewIncremental(): void {
			const request = JSON.stringify(advisorRequests.at(-1)?.messages);
			expect(request).toContain(ADVISOR_REPLY);
			expect(request).not.toContain("Investigate every module of the project.");
		}

		it("reviews the step after a prune without re-priming or replaying the transcript", async () => {
			enableAdvisor();
			await reviewedTurn("turn one");
			// The prune elided a result the advisor was seeded past.
			expect(liveResultText()).toBe(USELESS_NOTICE);

			const resets = await withPrefixResetCount(() => reviewedTurn("turn two"));

			expect(resets).toBe(0);
			expectLastReviewIncremental();
		});

		it("treats a later equal clone of a pruned result as unchanged", async () => {
			enableAdvisor();
			await reviewedTurn("turn one");
			expect(liveResultText()).toBe(USELESS_NOTICE);
			// Context rebuilds (secret deobfuscation, display-context rebuilds) hand
			// the advisor equal clones instead of the objects it last saw, so the
			// comparison falls through to the fingerprint of the pruned content.
			session.agent.replaceMessages(structuredClone(session.agent.state.messages));

			const resets = await withPrefixResetCount(() => reviewedTurn("turn two"));

			expect(resets).toBe(0);
			expectLastReviewIncremental();
		});

		it("keeps the advisor's context across two prunes while the eval state message keeps its slot", async () => {
			enableAdvisor();
			// An `eval` call in history makes the next display-context rebuild append
			// an `eval-state-context` snapshot at the tail and persist it there.
			await commitUnreviewedTurn([
				assistant([{ type: "toolCall", id: "call-eval", name: "eval", arguments: { code: "1 + 1" } }]),
				toolResult("call-eval", "eval", "2"),
				assistant([{ type: "text", text: "Evaluated." }]),
			]);
			const tail = session.agent.state.messages.at(-1);
			expect(tail?.role === "custom" ? tail.customType : undefined).toBe("eval-state-context");
			const slot = session.agent.state.messages.length - 1;
			// Delivers the eval-state message at its current slot.
			await reviewedTurn("turn one");

			// Second prune: the persisted snapshot stays where it was sent; no copy moves to the tail.
			await commitUnreviewedTurn([
				assistant([{ type: "toolCall", id: "call-big-2", name: "grep", arguments: { pattern: "FIXME" } }]),
				toolResult("call-big-2", "grep", "other line\n".repeat(20000), true),
				assistant([{ type: "text", text: "Nothing there either." }]),
			]);
			const snapshots = session.agent.state.messages.flatMap((message, index) =>
				message.role === "custom" && message.customType === "eval-state-context" ? [index] : [],
			);
			expect(snapshots).toEqual([slot]);

			const resets = await withPrefixResetCount(() => reviewedTurn("turn two"));

			expect(resets).toBe(0);
			expectLastReviewIncremental();
		});

		it("still resets when a delivered message the prune did not elide was replaced", async () => {
			const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: Date.now() });
			const messages: AgentMessage[] = [
				user("delivered one"),
				toolResult("call-a", "read", "file body"),
				user("delivered two"),
			];
			const runtime = new AdvisorRuntime(
				{ prompt: async () => {}, abort: () => {}, reset: () => {}, state: { messages: [] } },
				{ snapshotMessages: () => messages },
			);
			runtime.onTurnEnd(messages);
			await runtime.waitForCatchup(1_000, 1);
			// The prune elides the result (a fresh object after the rebuild) while
			// an unrelated rewrite replaced another delivered message.
			messages[1] = {
				...messages[1],
				content: [{ type: "text", text: USELESS_NOTICE }],
				prunedAt: Date.now(),
			} as AgentMessage;
			messages[2] = user("delivered two, edited");
			runtime.rebaseDeliveredPrefix("prune-tool-outputs");
			messages.push(user("next step"));

			const resets = await withPrefixResetCount(async () => {
				runtime.onTurnEnd(messages);
				await runtime.waitForCatchup(1_000, 1);
			});

			expect(resets).toBe(1);
			runtime.dispose();
		});

		it("re-primes a quarantined review from the pruned transcript, not the pre-prune snapshot", async () => {
			const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: Date.now() });
			const firstPrompt = Promise.withResolvers<void>();
			const firstPromptStarted = Promise.withResolvers<void>();
			const replay = Promise.withResolvers<string>();
			let promptCalls = 0;
			let current: AgentMessage[] = [
				user("delivered one"),
				assistant([{ type: "toolCall", id: "call-big", name: "grep", arguments: { pattern: "TODO" } }]),
				toolResult("call-big", "grep", "match line\n".repeat(30).trimEnd()),
			];
			const runtime = new AdvisorRuntime(
				{
					prompt: input => {
						promptCalls++;
						if (promptCalls === 1) {
							firstPromptStarted.resolve();
							return firstPrompt.promise;
						}
						replay.resolve(JSON.stringify(input));
						return Promise.resolve();
					},
					abort: () => {},
					reset: () => {},
					state: { messages: [] },
				},
				// The live session swaps in a new array on every rebuild; mirror that.
				{ snapshotMessages: () => current },
				0,
			);
			runtime.onTurnEnd(current);
			await firstPromptStarted.promise;
			// Queued while the first review is still running, so the quarantine re-primes.
			current = [...current, user("delivered two")];
			runtime.onTurnEnd(current);
			// The prune rebuilds the transcript into a fresh array with the result elided.
			current = current.map(message =>
				message.role === "toolResult"
					? ({
							...message,
							content: [{ type: "text", text: USELESS_NOTICE }],
							prunedAt: Date.now(),
						} as AgentMessage)
					: message,
			);
			runtime.rebaseDeliveredPrefix("prune-tool-outputs");

			firstPrompt.reject(new AdvisorOutputQuarantinedError("quarantined"));
			const replayed = await replay.promise;

			expect(replayed).toContain("⇒ ok · 1 line");
			expect(replayed).not.toContain("30 lines");
			runtime.dispose();
		});
	});
});
