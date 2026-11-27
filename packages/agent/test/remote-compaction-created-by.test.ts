import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { type CompactionPreparation, compact, DEFAULT_COMPACTION_SETTINGS } from "@oh-my-pi/pi-agent-core/compaction";
import { getCompactionV2PreserveData } from "@oh-my-pi/pi-agent-core/compaction/openai";
import type { AssistantMessage, FetchImpl, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

// The Responses API sets `created_by` on its output items and refuses any input
// item that holds it: `400 Unknown parameter: 'input[7].created_by'`.

type Route = "v1" | "v2" | "codex-v2";
type CreatedBy = string | null | undefined;

const ENDPOINT: Record<Route, string> = {
	v1: "/v1/responses/compact",
	v2: "/v1/responses",
	"codex-v2": "/codex/responses",
};
const ROUTES = Object.keys(ENDPOINT) as Route[];
const CASES = ROUTES.flatMap(route => [[route, "a string", "svc_x"] as const, [route, "null", null] as const]);

function routeModel(route: Route): Model {
	const model = buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		remoteCompaction: { enabled: true, v2StreamingEnabled: route !== "v1" },
	});
	if (route !== "codex-v2") return model;
	return {
		...model,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.example/backend-api",
		preferWebsockets: false,
		remoteCompaction: { enabled: true, api: "openai-codex-responses", v2StreamingEnabled: true },
	};
}

function withCreatedBy<T extends Record<string, unknown>>(item: T, createdBy: CreatedBy): T {
	return createdBy === undefined ? item : { ...item, created_by: createdBy };
}

/** A previous compaction's replacement history as stored: output items kept whole. */
function storedHistory(createdBy: CreatedBy): Array<Record<string, unknown>> {
	const entry = withCreatedBy({ stdout: "ls output", stderr: "", outcome: { type: "exit", exit_code: 0 } }, createdBy);
	return [
		{ type: "function_call", call_id: "call_prev", name: "read", arguments: "{}" },
		withCreatedBy({ type: "function_call_output", call_id: "call_prev", output: "earlier output" }, createdBy),
		withCreatedBy({ type: "shell_call_output", call_id: "call_shell", output: [entry] }, createdBy),
		withCreatedBy({ type: "compaction", encrypted_content: "enc_prev" }, createdBy),
	];
}

function preserveData(route: Route, provider: string, replacementHistory: Array<Record<string, unknown>>) {
	if (route !== "v1")
		return { openaiRemoteCompaction: { version: "v2", provider, replacementHistory, usedTokens: 1200 } };
	const compactionItem = replacementHistory.findLast(item => item.type === "compaction");
	return { openaiRemoteCompaction: { provider, replacementHistory, compactionItem } };
}

/** A turn whose stored `providerPayload` holds its output item whole, and the turn's tool result. */
function storedTurn(model: Model, createdBy: CreatedBy): [AssistantMessage, ToolResultMessage] {
	const call = { type: "function_call", id: "fc_live", call_id: "call_live", name: "read", arguments: "{}" };
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call_live|fc_live", name: "read", arguments: {} }],
			timestamp: 2,
			provider: model.provider,
			model: model.id,
			api: model.api,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: model.provider,
				dt: true,
				items: [withCreatedBy({ ...call, status: "completed" }, createdBy)],
			},
		},
		{
			role: "toolResult",
			toolCallId: "call_live|fc_live",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			isError: false,
			timestamp: 3,
		},
	];
}

function makePreparation(
	route: Route,
	messagesToSummarize: CompactionPreparation["messagesToSummarize"],
	previousPreserveData?: Record<string, unknown>,
): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize,
		turnPrefixMessages: [],
		recentMessages: [{ role: "user", content: "recent", timestamp: 4 }],
		isSplitTurn: false,
		tokensBefore: 100_000,
		fileOps: snapcompact.createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteStreamingV2Enabled: route !== "v1" },
		previousPreserveData,
	};
}

/** Capture each compaction request; each answers with a compaction item stamped `created_by: null`, as seen live. */
function stubCompaction(route: Route) {
	const requests: Array<{ url: string; input: Array<Record<string, unknown>> }> = [];
	const fetch: FetchImpl = async (url, init) => {
		const body: unknown = JSON.parse(String(init?.body));
		if (!piUtils.isRecord(body) || !Array.isArray(body.input))
			throw new Error("compaction request has no input array");
		requests.push({ url: String(url), input: body.input.filter(piUtils.isRecord) });
		const item = { type: "compaction", encrypted_content: `enc_${requests.length}`, created_by: null };
		if (route === "v1") return Response.json({ output: [item] });
		const events = [
			{ type: "response.output_item.done", output_index: 0, item },
			{
				type: "response.completed",
				response: { usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101 } },
			},
		];
		const stream = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	};
	return { fetch, requests };
}

/** Where an input holds its own `created_by` key: an item's top level, or a `shell_call_output` entry. */
function createdByPaths(items: ReadonlyArray<Record<string, unknown>>): string[] {
	const paths: string[] = [];
	for (const [index, item] of items.entries()) {
		if (Object.hasOwn(item, "created_by")) paths.push(`[${index}]`);
		if (item.type !== "shell_call_output" || !Array.isArray(item.output)) continue;
		for (const [entryIndex, entry] of item.output.entries()) {
			if (piUtils.isRecord(entry) && Object.hasOwn(entry, "created_by"))
				paths.push(`[${index}].output[${entryIndex}]`);
		}
	}
	return paths;
}

async function compactionInput(route: Route, createdBy: CreatedBy): Promise<Array<Record<string, unknown>>> {
	const model = routeModel(route);
	const { fetch, requests } = stubCompaction(route);
	const messages = [{ role: "user" as const, content: "long history", timestamp: 1 }, ...storedTurn(model, createdBy)];
	const preparation = makePreparation(route, messages, preserveData(route, model.provider, storedHistory(createdBy)));
	await compact(preparation, model, "not-a-secret", undefined, undefined, { fetch });
	expect(requests).toHaveLength(1);
	expect(requests[0]!.url).toEndWith(ENDPOINT[route]);
	return requests[0]!.input;
}

describe("remote compaction replays stored output items without created_by", () => {
	beforeEach(() => {
		vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test.each(CASES)(
		"%s request drops created_by (%s) from the stored replacement history and the stored turn",
		async (route, _label, createdBy) => {
			// The probe sees the key wherever the stored history holds it, `null` included.
			expect(createdByPaths(storedHistory(createdBy))).toHaveLength(4);
			const input = await compactionInput(route, createdBy);
			expect(createdByPaths(input)).toEqual([]);
			for (const [type, key, value] of [
				["function_call", "call_id", "call_live"],
				["function_call_output", "call_id", "call_prev"],
				["shell_call_output", "call_id", "call_shell"],
				["compaction", "encrypted_content", "enc_prev"],
			]) {
				expect(input.filter(item => item.type === type && item[key] === value)).toHaveLength(1);
			}
			// Nothing but created_by changed.
			expect(input).toEqual(await compactionInput(route, undefined));
		},
	);

	test.each(["v2", "codex-v2"] as const)(
		"%s request drops created_by: null from a shell output entry whose item holds none",
		async route => {
			const model = routeModel(route);
			const { fetch, requests } = stubCompaction(route);
			const entry = { stdout: "ls output", stderr: "", outcome: { type: "exit", exit_code: 0 } };
			const history = [
				{ type: "shell_call_output", call_id: "call_shell", output: [{ ...entry, created_by: null }] },
			];
			const messages = [{ role: "user" as const, content: "long history", timestamp: 1 }];
			const preparation = makePreparation(route, messages, preserveData(route, model.provider, history));
			await compact(preparation, model, "not-a-secret", undefined, undefined, { fetch });
			expect(requests).toHaveLength(1);
			expect(requests[0]!.input.filter(item => item.type === "shell_call_output")).toStrictEqual([
				{ type: "shell_call_output", call_id: "call_shell", output: [entry] },
			]);
		},
	);

	test.each(ROUTES)(
		"%s: a compaction item the API returned with created_by: null reaches the next compaction without it",
		async route => {
			const model = routeModel(route);
			const { fetch, requests } = stubCompaction(route);
			const preparation = makePreparation(route, [{ role: "user", content: "long history", timestamp: 1 }]);
			const first = await compact(preparation, model, "not-a-secret", undefined, undefined, { fetch });
			// The output item is stored as the API sent it.
			expect(getCompactionV2PreserveData(first.preserveData)?.replacementHistory.at(-1)).toStrictEqual({
				type: "compaction",
				encrypted_content: "enc_1",
				created_by: null,
			});
			const next = { ...preparation, previousSummary: first.summary, previousPreserveData: first.preserveData };
			await compact(next, model, "not-a-secret", undefined, undefined, { fetch });
			expect(requests).toHaveLength(2);
			const input = requests[1]!.input;
			expect(input.filter(item => item.encrypted_content === "enc_1")).toStrictEqual([
				{ type: "compaction", encrypted_content: "enc_1" },
			]);
			expect(createdByPaths(input)).toEqual([]);
		},
	);
});
