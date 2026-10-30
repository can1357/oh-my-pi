import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { streamFactoryDroid } from "../src/providers/factory-droid";
import type { Context, Message } from "../src/types";
import corpus from "./fixtures/factory-droid-native-requests.json" with { type: "json" };
import { factoryModel, workosJwt } from "./helpers/factory-droid";
import {
	NATIVE_CASES,
	type NativeCapture,
	type NativeCase,
	type NativeRequest,
	projectNativeRequest,
} from "./helpers/factory-droid-native";

/**
 * Every request dialect the Factory rules encode, checked against what the
 * pinned native CLI actually sent to Factory for the same model, upstream and
 * effort: the opening request and the follow-up carrying a tool result.
 * Regenerate the corpus with `scripts/capture-factory-droid-native.ts` when
 * the CLI version is bumped.
 */
const captures = corpus as NativeCapture[];

const opening: Message[] = [{ role: "user", content: "Read probe.txt.", timestamp: 1 }];

/** The follow-up history: a (thinking-led, when reasoning is on) tool call and its result. */
function followUp(capture: NativeCapture, thinking: boolean): Message[] {
	return [
		...opening,
		{
			role: "assistant",
			content: [
				...(thinking ? [{ type: "thinking" as const, thinking: "Read it.", thinkingSignature: "sig" }] : []),
				{ type: "toolCall", id: "call_1", name: "Read", arguments: { path: "probe.txt" } },
			],
			api: "factory-droid-agent",
			provider: "factory-droid",
			model: capture.model,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "Read",
			content: [{ type: "text", text: "nonce" }],
			isError: false,
			timestamp: 3,
		},
	];
}

/**
 * A primed case resumes after the round trip ran with reasoning on: the
 * thinking-led tool call, the answer, and a new user turn.
 */
function resumed(capture: NativeCapture): Message[] {
	const history = followUp(capture, true);
	const toolTurn = history[1];
	if (toolTurn.role !== "assistant") throw new Error("expected the tool-call turn");
	return [
		...history,
		{
			...toolTurn,
			content: [
				{ type: "thinking", thinking: "Answer it.", thinkingSignature: "sig-2" },
				{ type: "text", text: "nonce" },
			],
			stopReason: "stop",
			timestamp: 4,
		},
		{ role: "user", content: "Reply with exactly: done", timestamp: 5 },
	];
}

async function encode(capture: NativeCapture, turn: 0 | 1): Promise<NativeRequest | undefined> {
	const model = factoryModel(capture.model, [capture.upstream]);
	// The capture pinned each upstream through live routing.
	model.factoryDroidRoutingSource = "configured_order";
	const disabled = capture.effort === "off" || capture.effort === "none";
	const context: Context = {
		messages: capture.prime ? resumed(capture) : turn === 0 ? opening : followUp(capture, !disabled),
		// `bash` is one of the tools omp's Anthropic encoder marks strict; native never does.
		tools: [
			{ name: "Read", description: "Read a file", parameters: type({ path: "string" }) },
			{ name: "bash", description: "Run a command", parameters: type({ command: "string" }) },
		],
	};
	let request: NativeRequest | undefined;
	await streamFactoryDroid(model, context, {
		apiKey: workosJwt({ external_org_id: "org-capture" }),
		sessionId: "native-parity",
		...(disabled ? { disableReasoning: true } : { reasoning: capture.effort as Effort }),
		fetch: async (url, init) => {
			request ??= projectNativeRequest(
				new URL(String(url)).pathname,
				Object.fromEntries(new Headers(init?.headers)),
				JSON.parse(String(init?.body)),
				{ history: capture.prime !== undefined },
			);
			return Response.json({ error: { message: "captured" } }, { status: 400 });
		},
	}).result();
	return request;
}

describe("Factory Droid native request parity", () => {
	it("covers every declared case", () => {
		expect(captures.map(({ requests: _requests, ...testCase }): NativeCase => testCase)).toEqual([...NATIVE_CASES]);
	});

	it.each(
		captures.map(
			capture =>
				[
					`${capture.model}@${capture.upstream} ${capture.effort}${capture.prime ? ` after ${capture.prime}` : ""}`,
					capture,
				] as const,
		),
	)("%s matches the native dialect on every recorded turn", async (_label, capture) => {
		expect(await encode(capture, 0)).toEqual(capture.requests[0]);
		if (!capture.prime) expect(await encode(capture, 1)).toEqual(capture.requests[1]);
	});
});
