import { describe, expect, it } from "bun:test";
import { Tokenizer, type AgentMessage, type AgentToolCall } from "@oh-my-pi/pi-agent-core";
import { type Judge, tokenUsage, TypeSafeJudge, type ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	collectJevCandidates,
	fitJevState,
	getJevBoosterUnavailableReason,
	type JevCandidate,
	scoreJevCandidates,
} from "@oh-my-pi/pi-coding-agent/session/jev-compaction";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const usage = tokenUsage(1, 1);

function user(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function assistant(call: AgentToolCall, timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content: [call],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp,
	};
}

function result(call: AgentToolCall, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
}

function fakeJudge(
	handler: (state: unknown, questions: Record<string, { type: string }>) => Promise<Record<string, unknown>>,
): Judge {
	return {
		label: "test/jev",
		async judge(request) {
			const answers = await handler(request.state, request.questions);
			return { api: "typesafe", provider: "typesafe", model: "jev-test", answers, usage } as never;
		},
	};
}

function directCandidate(
	id: string,
	call: AgentToolCall,
	toolResult: ToolResultMessage,
	callIndex: number,
	resultIndex: number,
): JevCandidate {
	return {
		id,
		callEntry: messageEntry(`call-${id}`, null, assistant(call, callIndex)),
		resultEntry: messageEntry(`result-${id}`, `call-${id}`, toolResult),
		call,
		result: toolResult,
		callIndex,
		resultIndex,
	};
}

function appendFillers(messages: AgentMessage[], count = 7): void {
	for (let index = 0; index < count; index++) messages.push(user(`recent-${index}`, 10_000 + index));
}

describe("getJevBoosterUnavailableReason", () => {
	it("reports missing credentials before an LLM-only judgment setting", () => {
		const settings = { get: () => "llm" } as never;
		const registry = { authStorage: { hasAuth: () => false } } as never;
		expect(getJevBoosterUnavailableReason(settings, registry)).toBe(
			"Connect TypeSafe with /login typesafe to enable",
		);
	});

	it("rejects LLM-only judging after credentials are present and admits Auto", () => {
		const registry = { authStorage: { hasAuth: () => true } } as never;
		expect(getJevBoosterUnavailableReason({ get: () => "llm" } as never, registry)).toBe(
			"Set Judgment Provider to Auto or TypeSafe to enable",
		);
		expect(getJevBoosterUnavailableReason({ get: () => "auto" } as never, registry)).toBeUndefined();
	});
});

describe("collectJevCandidates", () => {
	it("keeps a materialized old pair eligible while ignoring metadata-only side chains", () => {
		const call: AgentToolCall = { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src/a.ts" } };
		const toolResult = result(call, "old output", 3);
		const messages: AgentMessage[] = [user("goal", 1), assistant(call, 2), toolResult];
		appendFillers(messages);
		const entries: SessionEntry[] = [];
		let parentId: string | null = null;
		messages.forEach((message, index) => {
			const entry = messageEntry(`m${index}`, parentId, message);
			entries.push(entry);
			parentId = entry.id;
		});
		const metadataSideChain = {
			type: "model_usage",
			id: "usage-side",
			parentId: "m1",
			timestamp: new Date(4).toISOString(),
			purpose: "test",
			api: "typesafe",
			provider: "typesafe",
			model: "jev-test",
			usage,
			stopReason: "stop",
		} as SessionEntry;

		const candidates = collectJevCandidates({
			entries,
			allEntries: [...entries, metadataSideChain],
			messages,
			tokenizer: new Tokenizer(),
			protectTokens: 0,
		});
		expect(candidates.map(candidate => candidate.id)).toEqual(["t1"]);
		expect(candidates[0]?.call).toBe(call);
		expect(candidates[0]?.result).toBe(toolResult);

		const sideConversation = messageEntry("side-user", "m1", user("forked request", 5));
		expect(
			collectJevCandidates({
				entries,
				allEntries: [...entries, metadataSideChain, sideConversation],
				messages,
				tokenizer: new Tokenizer(),
				protectTokens: 0,
			}),
		).toEqual([]);
	});

	it("does not score provider-native replay coverage but keeps later materialized pairs", () => {
		const replayedCall: AgentToolCall = {
			type: "toolCall",
			id: "replayed",
			name: "read",
			arguments: { path: "old.ts" },
		};
		const liveCall: AgentToolCall = { type: "toolCall", id: "live", name: "read", arguments: { path: "live.ts" } };
		const replayedResult = result(replayedCall, "covered by provider replay", 3);
		const liveResult = result(liveCall, "materialized output", 6);
		const messages: AgentMessage[] = [
			user("goal", 1),
			assistant(replayedCall, 2),
			replayedResult,
			assistant(liveCall, 5),
			liveResult,
		];
		appendFillers(messages);
		const first = messageEntry("user", null, messages[0]!);
		const replayedCallEntry = messageEntry("replayed-call", first.id, messages[1]!);
		const replayedResultEntry = messageEntry("replayed-result", replayedCallEntry.id, messages[2]!);
		const compaction: SessionEntry = {
			type: "compaction",
			id: "compaction",
			parentId: replayedResultEntry.id,
			timestamp: new Date(4).toISOString(),
			summary: "native replay",
			firstKeptEntryId: replayedCallEntry.id,
			providerReplayThroughEntryId: replayedResultEntry.id,
			tokensBefore: 100,
		};
		const liveCallEntry = messageEntry("live-call", compaction.id, messages[3]!);
		const liveResultEntry = messageEntry("live-result", liveCallEntry.id, messages[4]!);
		const entries: SessionEntry[] = [
			first,
			replayedCallEntry,
			replayedResultEntry,
			compaction,
			liveCallEntry,
			liveResultEntry,
		];
		let parentId = liveResultEntry.id;
		for (let index = 5; index < messages.length; index++) {
			const entry = messageEntry(`recent-${index}`, parentId, messages[index]!);
			entries.push(entry);
			parentId = entry.id;
		}

		const candidates = collectJevCandidates({
			entries,
			allEntries: entries,
			messages,
			tokenizer: new Tokenizer(),
			protectTokens: 0,
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.call).toBe(liveCall);
	});

	it("pins a retained split-turn pair before the first rewrite anchor while keeping a later pair eligible", () => {
		const prefixCall: AgentToolCall = {
			type: "toolCall",
			id: "prefix-call",
			name: "read",
			arguments: { path: "prefix.ts" },
		};
		const safeCall: AgentToolCall = {
			type: "toolCall",
			id: "safe-call",
			name: "read",
			arguments: { path: "safe.ts" },
		};
		const summarizedUser = messageEntry("summarized-user", null, user("summarized request", 1));
		const prefixCallMessage = assistant(prefixCall, 2);
		const prefixCallEntry = messageEntry("prefix-call", summarizedUser.id, prefixCallMessage);
		const prefixResult = result(prefixCall, "retained prefix output", 3);
		const prefixResultEntry = messageEntry("prefix-result", prefixCallEntry.id, prefixResult);
		const signedAssistant: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Continue the retained turn.", thinkingSignature: "anthropic-signature" },
				{ type: "text", text: "The retained tool result is still part of this signed turn." },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage,
			stopReason: "stop",
			timestamp: 4,
		};
		const signedEntry = messageEntry("signed-assistant", prefixResultEntry.id, signedAssistant);
		const compaction: SessionEntry = {
			type: "compaction",
			id: "native-compaction",
			parentId: signedEntry.id,
			timestamp: new Date(5).toISOString(),
			summary: "native summary",
			firstKeptEntryId: prefixCallEntry.id,
			tokensBefore: 100,
			preserveData: {
				anthropicCompaction: {
					provider: "anthropic",
					content: "native summary",
					encryptedContent: "encrypted-native-summary",
				},
			},
		};
		const anchorMessage = user("first surviving request", 6);
		const anchorEntry = messageEntry("anchor-user", compaction.id, anchorMessage);
		const safeCallMessage = assistant(safeCall, 7);
		const safeCallEntry = messageEntry("safe-call", anchorEntry.id, safeCallMessage);
		const safeResult = result(safeCall, "safe output", 8);
		const safeResultEntry = messageEntry("safe-result", safeCallEntry.id, safeResult);
		const entries: SessionEntry[] = [
			summarizedUser,
			prefixCallEntry,
			prefixResultEntry,
			signedEntry,
			compaction,
			anchorEntry,
			safeCallEntry,
			safeResultEntry,
		];
		let parentId = safeResultEntry.id;
		for (let index = 0; index < 7; index++) {
			const entry = messageEntry(`recent-${index}`, parentId, user(`recent-${index}`, 100 + index));
			entries.push(entry);
			parentId = entry.id;
		}

		const messages = buildSessionContext(entries).messages;
		expect(messages.slice(0, 5).map(message => message.role)).toEqual([
			"compactionSummary",
			"assistant",
			"toolResult",
			"assistant",
			"user",
		]);
		const summaryMessage = messages[0];
		if (summaryMessage?.role !== "compactionSummary") throw new Error("Expected native compaction boundary");
		expect(summaryMessage.providerPayload?.type).toBe("anthropicCompaction");
		expect(messages[3]).toBe(signedAssistant);

		const candidates = collectJevCandidates({
			entries,
			allEntries: entries,
			messages,
			tokenizer: new Tokenizer(),
			protectTokens: 0,
		});
		expect(candidates.map(candidate => candidate.call)).toEqual([safeCall]);
		expect(candidates[0]?.result).toBe(safeResult);
	});

	it("pins opaque call metadata and assistant replay payloads while retaining an ordinary native pair", () => {
		const messages: AgentMessage[] = [user("goal", 1)];
		const entries: SessionEntry[] = [messageEntry("user", null, messages[0]!)];
		let parentId = "user";
		const addPair = (id: string, options?: { opaqueCall?: boolean; opaqueAssistant?: boolean }): AgentToolCall => {
			const call: AgentToolCall = { type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } };
			if (options?.opaqueCall) {
				call.providerMetadata = {
					type: "computer",
					providerItemId: "opaque-item",
					actions: [],
					pendingSafetyChecks: [],
				};
			}
			const callMessage = assistant(call, messages.length + 1);
			if (options?.opaqueAssistant && callMessage.role === "assistant") {
				callMessage.providerPayload = { type: "openaiResponsesHistory", items: [{ type: "opaque-call" }] };
			}
			const toolResult = result(call, `${id} output`, messages.length + 2);
			messages.push(callMessage, toolResult);
			const callEntry = messageEntry(`${id}-call`, parentId, callMessage);
			const resultEntry = messageEntry(`${id}-result`, callEntry.id, toolResult);
			entries.push(callEntry, resultEntry);
			parentId = resultEntry.id;
			return call;
		};
		addPair("opaque-call", { opaqueCall: true });
		addPair("opaque-assistant", { opaqueAssistant: true });
		const ordinary = addPair("ordinary");
		appendFillers(messages);
		for (let index = entries.length; index < messages.length; index++) {
			const entry = messageEntry(`opaque-filler-${index}`, parentId, messages[index]!);
			entries.push(entry);
			parentId = entry.id;
		}

		const candidates = collectJevCandidates({
			entries,
			allEntries: entries,
			messages,
			tokenizer: new Tokenizer(),
			protectTokens: 0,
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.call).toBe(ordinary);
	});

	it("pins protected, truncated, omitted, multimodal, duplicate, and mismatched pairs", () => {
		const messages: AgentMessage[] = [user("goal", 1)];
		const entries: SessionEntry[] = [messageEntry("u", null, messages[0]!)];
		let parentId = "u";
		const addPair = (id: string, name: string, mutate?: (toolResult: ToolResultMessage) => void): void => {
			const call: AgentToolCall = { type: "toolCall", id, name, arguments: {} };
			const toolResult = result(call, id, messages.length + 2);
			mutate?.(toolResult);
			const callMessage = assistant(call, messages.length + 1);
			const entrySuffix = messages.length;
			messages.push(callMessage, toolResult);
			const callEntry = messageEntry(`${id}-${entrySuffix}-call`, parentId, callMessage);
			const resultEntry = messageEntry(`${id}-${entrySuffix}-result`, callEntry.id, toolResult);
			entries.push(callEntry, resultEntry);
			parentId = resultEntry.id;
		};
		addPair("skill", "skill");
		addPair("truncated", "read", toolResult => {
			toolResult.prunedAt = 1;
		});
		addPair("omitted", "read", toolResult => {
			toolResult.contextOmitted = true;
		});
		addPair("image", "read", toolResult => {
			toolResult.content.push({ type: "image", data: "abc", mimeType: "image/png" });
		});
		addPair("plan", "read");
		addPair("duplicate", "read");
		addPair("duplicate", "read");
		addPair("mismatch", "read", toolResult => {
			toolResult.toolName = "bash";
		});
		appendFillers(messages);
		for (let index = entries.length; index < messages.length; index++) {
			const entry = messageEntry(`filler-${index}`, parentId, messages[index]!);
			entries.push(entry);
			parentId = entry.id;
		}

		expect(
			collectJevCandidates({
				entries,
				allEntries: entries,
				messages,
				tokenizer: new Tokenizer(),
				protectTokens: 0,
				isProtected: (_toolResult, call) => call.id === "plan",
			}),
		).toEqual([]);
	});
});

describe("Jev scoring", () => {
	it("omits result bodies from fitted state and maps both probabilities to the three actions", async () => {
		const messages: AgentMessage[] = [user("keep the required constraint", 1)];
		const candidates: JevCandidate[] = [];
		for (let index = 0; index < 3; index++) {
			const call: AgentToolCall = {
				type: "toolCall",
				id: `call-${index}`,
				name: "read",
				arguments: { path: `file-${index}.ts` },
			};
			const toolResult = result(call, `SECRET-BODY-${index}`, index * 2 + 3);
			const callIndex = messages.length;
			messages.push(assistant(call, index * 2 + 2));
			const resultIndex = messages.length;
			messages.push(toolResult);
			candidates.push(directCandidate(`t${index + 1}`, call, toolResult, callIndex, resultIndex));
		}
		appendFillers(messages);
		const judge = fakeJudge(async (state, questions) => {
			const serialized = JSON.stringify(state);
			expect(serialized).not.toContain("SECRET-BODY");
			expect(serialized).toContain("chars (omitted)");
			expect(Object.values(questions).every(question => question.type === "noul")).toBe(true);
			return {
				call_t1: { type: "noul", noul: 0.1 },
				result_t1: { type: "noul", noul: 0.9 },
				call_t2: { type: "noul", noul: 0.8 },
				result_t2: { type: "noul", noul: 0.2 },
				call_t3: { type: "noul", noul: 0.2 },
				result_t3: { type: "noul", noul: 0.2 },
			};
		});

		await expect(scoreJevCandidates(messages, candidates, judge, new AbortController().signal)).resolves.toEqual([
			{ id: "t1", action: "keep" },
			{ id: "t2", action: "truncate_result" },
			{ id: "t3", action: "drop_pair" },
		]);
	});

	it.each([
		["missing", undefined],
		["wrong typed", { type: "choice", noul: 0.5 }],
		["non-finite", { type: "noul", noul: Number.NaN }],
		["out of range", { type: "noul", noul: 1.01 }],
	])("rejects the whole proposal for a %s answer", async (_label, malformed) => {
		const call: AgentToolCall = { type: "toolCall", id: "call", name: "read", arguments: {} };
		const toolResult = result(call, "output", 3);
		const messages: AgentMessage[] = [user("goal", 1), assistant(call, 2), toolResult];
		appendFillers(messages);
		const candidate = directCandidate("t1", call, toolResult, 1, 2);
		const judge = fakeJudge(async () => ({
			call_t1: { type: "noul", noul: 0.5 },
			...(malformed === undefined ? {} : { result_t1: malformed }),
		}));
		await expect(scoreJevCandidates(messages, [candidate], judge, new AbortController().signal)).rejects.toThrow(
			"Invalid Jev answer for result_t1",
		);
	});

	it("uses the full staged fitter and limits question batches to two concurrent requests", async () => {
		const messages: AgentMessage[] = [user("goal", 1)];
		const candidates: JevCandidate[] = [];
		for (let index = 0; index < 900; index++) {
			const call: AgentToolCall = {
				type: "toolCall",
				id: `call-${index}`,
				name: "read",
				arguments: { path: `src/generated/${index}.ts`, selector: "1-200" },
			};
			const toolResult = result(call, "x".repeat(100), index * 2 + 3);
			const callIndex = messages.length;
			messages.push(assistant(call, index * 2 + 2));
			const resultIndex = messages.length;
			messages.push(toolResult);
			candidates.push(directCandidate(`t${index + 1}`, call, toolResult, callIndex, resultIndex));
		}
		appendFillers(messages);
		const fitted = fitJevState(messages, candidates);
		expect(fitted.tokens).toBeLessThanOrEqual(25_000);
		expect(fitted.stage).not.toBe("full");
		expect(JSON.stringify(fitted.state)).not.toContain("x".repeat(100));

		const firstTwoStarted = Promise.withResolvers<void>();
		const releaseFirstTwo = Promise.withResolvers<void>();
		let active = 0;
		let maxActive = 0;
		let requests = 0;
		const judge = fakeJudge(async (_state, questions) => {
			requests++;
			active++;
			maxActive = Math.max(maxActive, active);
			if (requests === 2) firstTwoStarted.resolve();
			if (requests <= 2) await releaseFirstTwo.promise;
			active--;
			return Object.fromEntries(Object.keys(questions).map(id => [id, { type: "noul", noul: 1 }]));
		});
		const scoring = scoreJevCandidates(messages, candidates, judge, new AbortController().signal);
		await firstTwoStarted.promise;
		expect(requests).toBe(2);
		releaseFirstTwo.resolve();
		const decisions = await scoring;
		expect(requests).toBeGreaterThan(2);
		expect(maxActive).toBe(2);
		expect(decisions).toHaveLength(candidates.length);
		expect(decisions.every(decision => decision.action === "keep")).toBe(true);

		const secondBatchStarted = Promise.withResolvers<void>();
		const releaseSecondBatch = Promise.withResolvers<void>();
		let rejectedRequests = 0;
		const malformedJudge = fakeJudge(async (_state, questions) => {
			rejectedRequests++;
			const answers: Record<string, unknown> = Object.fromEntries(
				Object.keys(questions).map(id => [id, { type: "noul", noul: 1 }]),
			);
			if (rejectedRequests === 1) {
				const firstQuestionId = Object.keys(questions)[0];
				if (!firstQuestionId) throw new Error("Expected a Jev question");
				answers[firstQuestionId] = { type: "choice", choice: "invalid" };
			} else if (rejectedRequests === 2) {
				secondBatchStarted.resolve();
				await releaseSecondBatch.promise;
			}
			return answers;
		});
		const rejectedScoring = scoreJevCandidates(messages, candidates, malformedJudge, new AbortController().signal);
		await secondBatchStarted.promise;
		releaseSecondBatch.resolve();
		await expect(rejectedScoring).rejects.toThrow("Invalid Jev answer");
		expect(rejectedRequests).toBe(2);
	});

	it("passes native noul requests through TypeSafeJudge and validates the local endpoint response", async () => {
		const received: {
			authorization?: string;
			body?: { questions: Record<string, { type: string }>; state: unknown };
		} = {};
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				received.authorization = request.headers.get("authorization") ?? undefined;
				received.body = (await request.json()) as {
					questions: Record<string, { type: string }>;
					state: unknown;
				};
				const answers = Object.fromEntries(
					Object.keys(received.body.questions).map(id => [
						id,
						{ type: "noul", noul: id.startsWith("call_") ? 0.8 : 0.2 },
					]),
				);
				return Response.json({
					model: "jev-local",
					answers,
					usage: { input_tokens: 12, output_tokens: 2 },
				});
			},
		});
		try {
			const call: AgentToolCall = { type: "toolCall", id: "call", name: "read", arguments: { path: "a.ts" } };
			const toolResult = result(call, "SUPER-SECRET-RESULT", 3);
			const messages: AgentMessage[] = [user("goal", 1), assistant(call, 2), toolResult];
			appendFillers(messages);
			const candidate = directCandidate("t1", call, toolResult, 1, 2);
			const judge = new TypeSafeJudge({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${server.port}` });
			await expect(scoreJevCandidates(messages, [candidate], judge, new AbortController().signal)).resolves.toEqual([
				{ id: "t1", action: "truncate_result" },
			]);
			expect(received.authorization).toBe("Bearer test-key");
			expect(Object.values(received.body?.questions ?? {}).every(question => question.type === "noul")).toBe(true);
			expect(JSON.stringify(received.body?.state)).not.toContain("SUPER-SECRET-RESULT");
		} finally {
			server.stop(true);
		}
	});
});
