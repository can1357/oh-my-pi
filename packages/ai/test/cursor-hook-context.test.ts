import { afterEach, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { type CursorOptions, streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type {
	AnsweredSteeringEntry,
	Context,
	LiveSteerClaim,
	LiveSteering,
	Model,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ConversationTokenDetailsSchema,
	type ExecClientMessage,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	ReadArgsSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const BUDGET_TOKENS = 60_000;

function frame(message: AgentServerMessage["message"]): Buffer {
	const data = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message }));
	const framed = Buffer.alloc(5 + data.length);
	framed.writeUInt32BE(data.length, 1);
	framed.set(data, 5);
	return framed;
}

function checkpointFrame(usedTokens: number): Buffer {
	return frame({
		case: "conversationCheckpointUpdate",
		value: create(ConversationStateStructureSchema, {
			tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens }),
		}),
	});
}

function execReadFrame(id: number, acceptHookAdditionalContexts: boolean): Buffer {
	return frame({
		case: "execServerMessage",
		value: create(ExecServerMessageSchema, {
			id,
			execId: `exec-${id}`,
			acceptHookAdditionalContexts,
			message: {
				case: "readArgs",
				value: create(ReadArgsSchema, { path: `/tmp/${id}`, toolCallId: `call-${id}` }),
			},
		}),
	});
}

function turnEndedFrame(): Buffer {
	return frame({
		case: "interactionUpdate",
		value: create(InteractionUpdateSchema, {
			message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
		}),
	});
}

/** Connect's clean end-of-stream frame: the server's last message. */
const END_STREAM_FRAME = Buffer.concat([Buffer.from([0x02, 0, 0, 0, 2]), Buffer.from("{}")]);

/** Exec results in the complete frames of `buffer`, plus the bytes of a trailing partial frame. */
function takeExecResults(buffer: Buffer): { results: ExecClientMessage[]; rest: Buffer } {
	const results: ExecClientMessage[] = [];
	let offset = 0;
	while (buffer.length - offset >= 5) {
		const length = buffer.readUInt32BE(offset + 1);
		if (buffer.length - offset < 5 + length) break;
		const message = fromBinary(AgentClientMessageSchema, buffer.subarray(offset + 5, offset + 5 + length));
		if (message.message.case === "execClientMessage") results.push(message.message.value);
		offset += 5 + length;
	}
	return { results, rest: buffer.subarray(offset) };
}

const servers: http2.Http2Server[] = [];
const sessions = new Set<http2.Http2Session>();

afterEach(() => {
	for (const session of sessions) session.destroy();
	for (const server of servers.splice(0)) server.close();
});

/**
 * One Cursor turn scripted as steps: each step's frames go out after the
 * client answers the previous step's exec. Returns the hook contexts the
 * client attached to each exec result, keyed by exec id, and whether the
 * response reports that it was asked to wrap up. `onTerminalEvent` runs when
 * the stream reports its outcome, which is when the agent loop reads what live
 * steering delivered.
 */
async function runTurn(
	steps: Buffer[][],
	options: Partial<CursorOptions> = {},
	onTerminalEvent: () => void = () => {},
): Promise<{
	contexts: Map<number, string[]>;
	wrappedUp: boolean;
	answeredSteering?: AnsweredSteeringEntry[];
	stopReason: string;
}> {
	const contextsByExecId = new Map<number, string[]>();
	const server = http2.createServer();
	servers.push(server);
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (providerStream: http2.ServerHttp2Stream) => {
		let nextStep = 0;
		const sendNextStep = () => {
			const step = steps[nextStep++];
			if (step && ((step.at(-1)?.[0] ?? 0) & 0x02) !== 0) providerStream.end(Buffer.concat(step));
			else if (step) providerStream.write(Buffer.concat(step));
			else providerStream.end(turnEndedFrame());
		};
		providerStream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		let pending: Buffer = Buffer.alloc(0);
		let started = false;
		providerStream.on("data", (chunk: Buffer) => {
			if (!started) {
				started = true;
				sendNextStep();
				return;
			}
			const { results, rest } = takeExecResults(Buffer.concat([pending, chunk]));
			pending = rest;
			for (const result of results) {
				contextsByExecId.set(
					result.id,
					result.hookAdditionalContexts.map(context => context.content),
				);
				sendNextStep();
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected HTTP/2 fixture server address");

	const model: Model<"cursor-agent"> = buildModel({
		id: "cursor-context-budget-fixture",
		name: "Cursor context budget fixture",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: `http://127.0.0.1:${address.port}`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 1,
	});
	const context: Context = { messages: [{ role: "user", content: "read files", timestamp: 1 }] };
	const response = streamCursor(model, context, {
		apiKey: "test-token",
		contextBudgetTokens: BUDGET_TOKENS,
		...options,
	});
	for await (const event of response) {
		if (event.type === "done" || event.type === "error") onTerminalEvent();
	}
	const message = await response.result();
	return {
		contexts: contextsByExecId,
		wrappedUp: message.contextBudgetWrapUp === true,
		answeredSteering: message.answeredSteering,
		stopReason: message.stopReason,
	};
}

it("asks the turn to wrap up once, on the first accepting result past the budget", async () => {
	const { contexts, wrappedUp } = await runTurn([
		[checkpointFrame(40_000), execReadFrame(1, true)],
		// Crossed, but this frame cannot carry context: the notice must wait, not vanish.
		[checkpointFrame(70_000), execReadFrame(2, false)],
		[execReadFrame(3, true)],
		[checkpointFrame(80_000), execReadFrame(4, true)],
	]);

	expect(contexts.get(1)).toEqual([]);
	expect(contexts.get(2)).toEqual([]);
	expect(contexts.get(3)).toEqual([expect.stringContaining("70000")]);
	expect(contexts.get(4)).toEqual([]);
	expect(wrappedUp).toBe(true);
});

it("asks a turn whose first step already crossed the budget to wrap up", async () => {
	// The turn opened below the budget (the host decides that before the
	// request); its first checkpoint is past it and its first result cannot
	// carry context, so the first accepting result must still get the notice.
	const { contexts } = await runTurn([
		[checkpointFrame(70_000), execReadFrame(1, false)],
		[checkpointFrame(90_000), execReadFrame(2, true)],
	]);

	expect(contexts.get(1)).toEqual([]);
	expect(contexts.get(2)).toEqual([expect.stringContaining("90000")]);
});

it("waits until the conversation is past the budget, like the host's compaction check", async () => {
	const { contexts } = await runTurn([
		[checkpointFrame(BUDGET_TOKENS), execReadFrame(1, true)],
		[checkpointFrame(BUDGET_TOKENS + 1), execReadFrame(2, true)],
	]);

	expect(contexts.get(1)).toEqual([]);
	expect(contexts.get(2)).toEqual([expect.stringContaining(String(BUDGET_TOKENS + 1))]);
});

it("does not report a wrap-up when the turn ended before any result could carry the notice", async () => {
	// The host must not treat this turn as budget-stopped: the model never saw
	// the notice and ended on its own.
	const { contexts, wrappedUp } = await runTurn([[checkpointFrame(70_000), execReadFrame(1, false)]]);

	expect(contexts.get(1)).toEqual([]);
	expect(wrappedUp).toBe(false);
});

/** A steering queue holding one user message; records how its claim was settled. */
function queuedSteering(content: UserMessage["content"]): { source: LiveSteering; outcomes: string[] } {
	const outcomes: string[] = [];
	let queued: UserMessage[] = [{ role: "user", content, timestamp: 2 }];
	const source: LiveSteering = {
		wait: signal => {
			if (queued.length > 0) return Promise.resolve();
			const idle = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => idle.resolve(), { once: true });
			return idle.promise;
		},
		claim: async (): Promise<LiveSteerClaim | undefined> => {
			const messages = queued;
			queued = [];
			if (messages.length === 0) return undefined;
			return {
				messages,
				accept: () => outcomes.push("accepted"),
				absorb: () => outcomes.push("absorbed"),
				reject: () => outcomes.push("rejected"),
			};
		},
	};
	return { source, outcomes };
}

it("delivers user steering with the next tool result that accepts context", async () => {
	const steering = queuedSteering("stop and use the staging bucket");

	const { contexts, answeredSteering } = await runTurn(
		[[execReadFrame(1, false)], [execReadFrame(2, true)], [execReadFrame(3, true)]],
		{
			liveSteering: steering.source,
		},
	);

	expect(contexts.get(1)).toEqual([]);
	expect(contexts.get(2)).toEqual(["stop and use the staging bucket"]);
	expect(contexts.get(3)).toEqual([]);
	expect(steering.outcomes).toEqual(["absorbed"]);
	expect(answeredSteering).toEqual([{ text: "stop and use the staging bucket", beforeContentIndex: 2 }]);
});

it("hands undelivered steering back before the turn reports its outcome", async () => {
	// The agent loop collects declined steering when the outcome arrives; a
	// rejection after that point would drop the user's message.
	const steering = queuedSteering("also check the logs");
	let outcomesAtTerminalEvent: string[] = [];

	await runTurn([[execReadFrame(1, false)]], { liveSteering: steering.source }, () => {
		outcomesAtTerminalEvent = [...steering.outcomes];
	});

	expect(outcomesAtTerminalEvent).toEqual(["rejected"]);
});

it("leaves steering with an image for the next request instead of dropping the image", async () => {
	const steering = queuedSteering([
		{ type: "text", text: "inspect this screenshot" },
		{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
	]);

	const { contexts } = await runTurn([[execReadFrame(1, true)], [execReadFrame(2, true)]], {
		liveSteering: steering.source,
	});

	expect([...contexts.values()]).toEqual([[], []]);
	expect(steering.outcomes).toEqual(["rejected"]);
});

it("keeps the notice when the server ends the stream before the result can be written", async () => {
	// The exec handler is still running when the end frame arrives; its result,
	// written after the transport ended, is dropped, so the model never reads it.
	const { contexts, wrappedUp } = await runTurn([[checkpointFrame(70_000), execReadFrame(1, true), END_STREAM_FRAME]]);

	expect(contexts.has(1)).toBe(false);
	expect(wrappedUp).toBe(false);
});

it("hands steering back when the server ends the stream before the result can be written", async () => {
	const steering = queuedSteering("also check the logs");

	const { contexts } = await runTurn([[execReadFrame(1, true), END_STREAM_FRAME]], {
		liveSteering: steering.source,
	});

	expect(contexts.has(1)).toBe(false);
	expect(steering.outcomes).toEqual(["rejected"]);
});

it("preserves answeredSteering on the error message when the stream fails after absorbing steering", async () => {
	const steering = queuedSteering("stop and use the staging bucket");
	const payload = Buffer.from(JSON.stringify({ error: { code: "internal", message: "boom" } }));
	const errorEndFrame = Buffer.alloc(5 + payload.length);
	errorEndFrame[0] = 0x02;
	errorEndFrame.writeUInt32BE(payload.length, 1);
	errorEndFrame.set(payload, 5);

	const { contexts, answeredSteering, stopReason } = await runTurn([[execReadFrame(1, true)], [errorEndFrame]], {
		liveSteering: steering.source,
	});

	expect(contexts.get(1)).toEqual(["stop and use the staging bucket"]);
	expect(steering.outcomes).toEqual(["absorbed"]);
	expect(stopReason).toBe("error");
	expect(answeredSteering).toEqual([{ text: "stop and use the staging bucket", beforeContentIndex: 1 }]);
});
