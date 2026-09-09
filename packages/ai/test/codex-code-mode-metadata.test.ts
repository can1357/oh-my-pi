import { describe, expect, it } from "bun:test";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { createCodexModel } from "./helpers";

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

const CONTEXT: Context = {
	systemPrompt: ["You are a helpful assistant."],
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

const COMPLETED_EVENTS: Array<Record<string, unknown>> = [
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "Hello" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello" }],
		},
	},
	{
		type: "response.completed",
		response: {
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	},
];

const NAMESPACES_INFO = {
	functions: {
		name: "functions",
		functions: {
			read: { name: "read", direct: false, code_mode_name: "read", deferred: false, source: { kind: "harness" } },
			eval: { name: "eval", direct: true, code_mode_name: "eval", deferred: false, source: { kind: "harness" } },
		},
	},
};

function decodeCodexRequestBody(body: RequestInit["body"]): string {
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(Bun.zstdDecompressSync(body));
	throw new Error("expected a string or binary Codex request body");
}

interface CapturedCodexMetadata {
	turnMetadata: Record<string, unknown>;
	turnMetadataHeader: string | null;
}

async function captureRequest(opts: Record<string, unknown>): Promise<CapturedCodexMetadata> {
	const { promise, resolve } = Promise.withResolvers<CapturedCodexMetadata>();
	const fetchMock = (async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.endsWith("/responses")) {
			const body = JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>;
			const clientMetadata = (body.client_metadata ?? {}) as Record<string, unknown>;
			const encoded = clientMetadata["x-codex-turn-metadata"];
			resolve({
				turnMetadata: typeof encoded === "string" ? (JSON.parse(encoded) as Record<string, unknown>) : {},
				turnMetadataHeader: new Headers(init?.headers).get("x-codex-turn-metadata"),
			});
		}
		const sse = `${COMPLETED_EVENTS.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as unknown as FetchImpl;
	await streamOpenAICodexResponses(createCodexModel("gpt-5.6-sol"), CONTEXT, {
		apiKey: createCodexTestToken(),
		fetch: fetchMock,
		...opts,
	}).result();
	return promise;
}

async function captureTurnMetadata(opts: Record<string, unknown>): Promise<Record<string, unknown>> {
	return (await captureRequest(opts)).turnMetadata;
}

function createLargeNamespacesInfo(toolCount: number): typeof NAMESPACES_INFO {
	const functions: Record<string, unknown> = {};
	for (let index = 0; index < toolCount; index++) {
		const name = `mcp__server_${index}__some_reasonably_long_tool_name_${index}`;
		functions[name] = { name, direct: false, code_mode_name: name, deferred: false, source: { kind: "mcp" } };
	}
	return { functions: { name: "functions", functions } } as typeof NAMESPACES_INFO;
}

describe("codex code mode tool_namespaces_info metadata", () => {
	it("emits tool_namespaces_info in turn metadata when provided", async () => {
		const turnMetadata = await captureTurnMetadata({ toolNamespacesInfo: NAMESPACES_INFO });
		expect(turnMetadata.tool_namespaces_info).toEqual(NAMESPACES_INFO);
	});

	it("omits tool_namespaces_info when the option is absent", async () => {
		const turnMetadata = await captureTurnMetadata({});
		expect("tool_namespaces_info" in turnMetadata).toBe(false);
	});

	it("mirrors the body turn metadata into the header when Code Mode is inactive", async () => {
		const captured = await captureRequest({});
		expect(captured.turnMetadataHeader).toBe(JSON.stringify(captured.turnMetadata));
	});

	// Regression: the Codex backend rejects requests whose HTTP headers exceed
	// 100KB, and a real session's snapshot (409 tools) serializes to ~100KB on
	// its own. The snapshot must stay in the body envelope only.
	it("keeps a large Code Mode snapshot out of the size-capped header", async () => {
		const namespacesInfo = createLargeNamespacesInfo(409);
		const captured = await captureRequest({ toolNamespacesInfo: namespacesInfo });
		expect(captured.turnMetadata.tool_namespaces_info).toEqual(namespacesInfo);
		const header = captured.turnMetadataHeader ?? "";
		expect(JSON.stringify(captured.turnMetadata).length).toBeGreaterThan(90_000);
		expect(header.length).toBeLessThan(1_000);
		const headerMetadata = JSON.parse(header) as Record<string, unknown>;
		expect("tool_namespaces_info" in headerMetadata).toBe(false);
		expect(headerMetadata.turn_id).toBe(captured.turnMetadata.turn_id);
		expect(headerMetadata.session_id).toBe(captured.turnMetadata.session_id);
	});
});
