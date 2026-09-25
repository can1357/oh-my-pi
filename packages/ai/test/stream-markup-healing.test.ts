import { describe, expect, it } from "bun:test";
import {
	type Dialect,
	getDialectDefinition,
	type InbandScanEvent,
	ThinkingInbandScanner,
} from "@oh-my-pi/pi-ai/dialect";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, TextContent, ThinkingContent, Tool, ToolCall } from "@oh-my-pi/pi-ai/types";
import { getStreamMarkupHealingPattern, StreamMarkupHealing } from "@oh-my-pi/pi-ai/utils/stream-markup-healing";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

interface SseToolCallDelta {
	index: number;
	id?: string;
	type?: "function";
	function?: { name?: string; arguments?: string };
}

interface SseChoiceDelta {
	content?: string;
	tool_calls?: SseToolCallDelta[];
	reasoning_content?: string;
}

interface SseChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: SseChoiceDelta;
		finish_reason?: "stop" | "tool_calls" | "length" | "content_filter" | null;
	}>;
}

function sseResponse(events: ReadonlyArray<unknown | "[DONE]">): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function mockFetch(events: ReadonlyArray<unknown | "[DONE]">): FetchImpl {
	const fn = async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => sseResponse(events);
	return Object.assign(fn, { preconnect: fetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "list the files", timestamp: Date.now() }],
	};
}

function kimiModel(): Model<"openai-completions"> {
	// OpenRouter-hosted Kimi K2 — the model-id gate engages without pulling
	// in the kimi-code OAuth/device-id paths.
	return getBundledModel("openrouter", "moonshotai/kimi-k2");
}

function chunk(model: string, delta: SseChoiceDelta, finish: SseChunk["choices"][0]["finish_reason"] = null): SseChunk {
	return {
		id: "chatcmpl-kimi-test",
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

const REPORTED_DSML_LEAK =
	"<｜DSML｜tool_calls>\n" +
	' <｜DSML｜invoke name="bash">\n' +
	' <｜DSML｜parameter name="i" string="true">Check Fedora 42 available packages</｜DSML｜parameter>\n' +
	' <｜DSML｜parameter name="command" string="true">docker run --rm --platform linux/arm64 fedora:42 bash -c \'type python3; type git; type sed; type cp; ls /usr/bin/python3 2>/dev/null; rpm -qa | grep -E "^python3|^git-|^sed-|^bash-" | sort\'</｜DSML｜parameter>\n' +
	' <｜DSML｜parameter name="timeout" string="false">15</｜DSML｜parameter>\n' +
	" </｜DSML｜invoke>\n" +
	" </｜DSML｜tool_calls>";

const bashTool: Tool = {
	name: "bash",
	description: "Run a shell command",
	parameters: {
		type: "object",
		properties: {
			[INTENT_FIELD]: { type: "string" },
			command: { type: "string" },
			timeout: { type: "number" },
		},
		required: ["command"],
		additionalProperties: false,
	},
};

const readTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
		},
		required: ["path"],
		additionalProperties: false,
	},
};
const deepseekCloudModel: Model<"ollama-chat"> = buildModel({
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	api: "ollama-chat",
	provider: "ollama-cloud",
	baseUrl: "https://ollama.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131_072,
	maxTokens: 8_192,
});

function geminiCliModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://antigravity.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8_192,
	});
}

function ndjsonResponse(lines: ReadonlyArray<unknown>): Response {
	const body = `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
	const encoder = new TextEncoder();
	const bodyStream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(body));
			controller.close();
		},
	});
	return new Response(bodyStream, {
		status: 200,
		headers: { "content-type": "application/x-ndjson" },
	});
}

function mockNdjsonFetch(lines: ReadonlyArray<unknown>): FetchImpl {
	const fn = async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => ndjsonResponse(lines);
	return Object.assign(fn, { preconnect: fetch.preconnect });
}
function healingModel(provider: string, id: string): Model<"ollama-chat"> {
	return buildModel({
		id,
		api: "ollama-chat",
		provider,
		baseUrl: "http://localhost:11434",
		name: id,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

describe("StreamMarkupHealing pattern selection", () => {
	it("routes tool-call leaks to their grammar and everything else to thinking", () => {
		expect(getStreamMarkupHealingPattern(healingModel("openrouter", "moonshotai/kimi-k2"))).toBe("kimi");
		expect(getStreamMarkupHealingPattern(healingModel("ollama-cloud", "deepseek-v4-pro"))).toBe("dsml");
		expect(getStreamMarkupHealingPattern(healingModel("nanogpt", "deepseek/deepseek-v4-pro"))).toBe("dsml");
		// Every other model heals leaked reasoning idioms by default.
		expect(getStreamMarkupHealingPattern(healingModel("opencode-zen", "minimax-m3"))).toBe("thinking");
		expect(getStreamMarkupHealingPattern(healingModel("openrouter", "google/gemini-3.5-flash"))).toBe("thinking");
		expect(getStreamMarkupHealingPattern(healingModel("ollama-cloud", "gpt-oss:120b"))).toBe("thinking");
		expect(getStreamMarkupHealingPattern(healingModel("openai", "deepseek-v4-pro"))).toBe("dsml");
	});
});

describe("openai-completions leaked thinking healing", () => {
	// Gemini on OpenRouter (chat-completions) leaks its canonical ` ```thinking `
	// fence into `delta.content`. The default "thinking" healer must lift it back
	// into a thinking block instead of leaving the fence as visible text (#bug).
	const geminiModel = buildModel({
		id: "google/gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8_192,
	});

	it("lifts a leaked gemini thinking fence out of the visible reply", async () => {
		const leaked = "```thinking\nWeigh the options.\n```\nFinal answer.";
		const fetchMock = mockFetch([
			chunk(geminiModel.id, { content: leaked }),
			chunk(geminiModel.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(geminiModel, baseContext(), {
			apiKey: "test",
			fetch: fetchMock,
		}).result();

		const text = result.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("");
		const thinking = result.content
			.filter((b): b is ThinkingContent => b.type === "thinking")
			.map(b => b.thinking)
			.join("");

		expect(thinking).toContain("Weigh the options.");
		expect(text).not.toContain("```thinking");
		expect(text.trim()).toBe("Final answer.");
	});

	it("keeps healed thinking from duplicating structured reasoning", async () => {
		const fetchMock = mockFetch([
			chunk(geminiModel.id, { reasoning_content: "structured reasoning" }),
			chunk(geminiModel.id, { content: "```thinking\nleaked copy\n```visible" }),
			chunk(geminiModel.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(geminiModel, baseContext(), {
			apiKey: "test",
			fetch: fetchMock,
		}).result();

		const text = result.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("");
		const thinking = result.content
			.filter((b): b is ThinkingContent => b.type === "thinking")
			.map(b => b.thinking)
			.join("");

		expect(thinking).toBe("structured reasoning");
		expect(thinking).not.toContain("leaked copy");
		expect(text.trim()).toBe("visible");
	});
});

describe("official OpenAI leaked thinking healing exemption", () => {
	// The official OpenAI endpoint returns structured reasoning and never leaks
	// fences, so neither the provider-local healer nor the central
	// wrapLeakedThinkingStream wrap runs — a ` ```thinking ` block the model chose
	// to write must stay verbatim visible text. Routed through stream() (not the
	// provider directly) so both gates are exercised.
	const officialOpenAI = getBundledModel("openai", "gpt-5.5");
	const completionsModel = buildModel({
		...officialOpenAI,
		api: "openai-completions",
	});

	it("leaves a leaked fence intact for the official OpenAI endpoint", async () => {
		const leaked = "```thinking\nWeigh the options.\n```\nFinal answer.";
		const result = await stream(completionsModel, baseContext(), {
			apiKey: "test",
			fetch: mockFetch([
				chunk(completionsModel.id, { content: leaked }),
				chunk(completionsModel.id, {}, "stop"),
				"[DONE]",
			]),
		}).result();

		expect(result.content.map(b => b.type)).toEqual(["text"]);
		expect(result.content.filter((b): b is ThinkingContent => b.type === "thinking")).toHaveLength(0);
		expect(result.content.map(b => (b.type === "text" ? b.text : "")).join("")).toBe(leaked);
	});
});

describe("google-gemini-cli leaked thinking healing", () => {
	it("lifts a leaked Gemini thinking fence before a native tool call", async () => {
		const model = geminiCliModel();
		const fetchMock = mockFetch([
			{
				response: {
					candidates: [
						{
							content: {
								role: "model",
								parts: [
									{
										text: "```thinking\nCheck the provider path.\n```\nI will inspect the file.",
										thoughtSignature: "visible-text-signature",
									},
									{
										functionCall: {
											name: "read",
											args: { path: "packages/ai/src/providers/google-gemini-cli.ts" },
											id: "call_read_1",
										},
										thoughtSignature: "function-call-signature",
									},
								],
							},
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 5,
						thoughtsTokenCount: 3,
						totalTokenCount: 18,
					},
				},
			},
		]);

		const result = await streamGoogleGeminiCli(
			model,
			{ ...baseContext(), tools: [readTool] },
			{
				apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
				fetch: fetchMock,
			},
		).result();

		expect(result.content.map(block => block.type)).toEqual(["thinking", "text", "toolCall"]);
		const thinking = result.content
			.filter((block): block is ThinkingContent => block.type === "thinking")
			.map(block => block.thinking)
			.join("");
		const textBlocks = result.content.filter((block): block is TextContent => block.type === "text");
		const text = textBlocks.map(block => block.text).join("");
		const calls = result.content.filter((block): block is ToolCall => block.type === "toolCall");

		expect(thinking).toBe("Check the provider path.\n");
		expect(text).toBe("\nI will inspect the file.");
		expect(text).not.toContain("```thinking");
		expect(calls).toHaveLength(1);
		expect(textBlocks[0]?.textSignature).toBe("visible-text-signature");
		expect(calls[0]?.id).toBe("call_read_1");
		expect(calls[0]?.thoughtSignature).toBe("function-call-signature");
		expect(result.stopReason).toBe("toolUse");
	});
});

describe("StreamMarkupHealing DSML envelope pattern", () => {
	it("parses the reporter's verbatim leak into a structured tool call", () => {
		const healing = new StreamMarkupHealing({ pattern: "dsml" });
		expect(healing.feed(REPORTED_DSML_LEAK)).toBe("");

		const calls = healing.drainCompleted();
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call.name).toBe("bash");
		expect(call.id).toMatch(/^call_[0-9a-f]+$/);

		const args = JSON.parse(call.arguments) as Record<string, unknown>;
		expect(args[INTENT_FIELD]).toBe("Check Fedora 42 available packages");
		expect(args.timeout).toBe(15);
		expect(String(args.command)).toContain("2>/dev/null");
		expect(String(args.command)).toContain('grep -E "^python3|^git-|^sed-|^bash-"');
	});

	it("reconstructs an envelope split across chunk boundaries", () => {
		const healing = new StreamMarkupHealing({ pattern: "dsml" });
		let visible = "";
		for (let i = 0; i < REPORTED_DSML_LEAK.length; i += 7) {
			visible += healing.feed(REPORTED_DSML_LEAK.slice(i, i + 7));
		}
		visible += healing.flushPending();
		expect(visible).toBe("");

		const calls = healing.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("bash");
		expect(JSON.parse(calls[0].arguments)).toMatchObject({ timeout: 15 });
	});

	it("preserves text/tool-call/text order for mixed chunks", () => {
		const healing = new StreamMarkupHealing({ pattern: "dsml" });
		const events = healing.feedEvents(`Before\n${REPORTED_DSML_LEAK}\nAfter`);
		expect(events.map(event => event.type)).toEqual(["text", "toolCall", "text"]);

		const [before, call, after] = events;
		if (before?.type !== "text" || call?.type !== "toolCall" || after?.type !== "text") {
			throw new Error("DSML healing emitted unexpected event order");
		}
		expect(before.text).toBe("Before\n");
		expect(call.call.name).toBe("bash");
		expect(after.text).toBe("\nAfter");
	});

	it("drops partial calls when the stream ends mid-envelope", () => {
		const healing = new StreamMarkupHealing({ pattern: "dsml" });
		const truncated = REPORTED_DSML_LEAK.slice(0, REPORTED_DSML_LEAK.length - 30);
		expect(healing.feed(truncated)).toBe("");
		expect(healing.flushPending()).toBe("");
		expect(healing.drainCompleted()).toHaveLength(0);
	});

	it("accepts the ASCII pipe variant", () => {
		const healing = new StreamMarkupHealing({ pattern: "dsml" });
		healing.feed(
			"<|DSML|tool_calls>" +
				'<|DSML|invoke name="bash">' +
				'<|DSML|parameter name="cmd" string="true">ls -la</|DSML|parameter>' +
				"</|DSML|invoke>" +
				"</|DSML|tool_calls>",
		);
		const calls = healing.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("bash");
		expect(JSON.parse(calls[0].arguments)).toEqual({ cmd: "ls -la" });
	});

	it("passes a bare '<' in idle prose through without holding it back", () => {
		const healing = new StreamMarkupHealing({ pattern: "dsml" });
		// No '>' anywhere in the tail — the old any-'<' hold-back froze display here.
		expect(healing.feed("if a < b:\n    return a")).toBe("if a < b:\n    return a");
	});

	it("still holds back a tail that is a partial DSML section-open tag", () => {
		const healing = new StreamMarkupHealing({ pattern: "dsml" });
		expect(healing.feed("run ")).toBe("run ");
		expect(healing.feed("<｜DSML｜tool")).toBe("");
		expect(healing.feed("_calls>")).toBe("");
		expect(
			healing.feed(
				'<｜DSML｜invoke name="bash"><｜DSML｜parameter name="cmd">ls</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>',
			),
		).toBe("");
		expect(healing.drainCompleted()).toHaveLength(1);
	});

	it("strips leaked orphan DSML close tags with no matching open (issue #10556)", () => {
		// Long-session degradation: the model leaks bare closers into visible text.
		// They must never survive into stored content, where replay reinforces the
		// XML-protocol mimicry that drops subsequent tool calls.
		const healing = new StreamMarkupHealing({ pattern: "dsml" });
		const leaked = "分析文本。\n\n</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>";
		const visible = healing.feed(leaked) + healing.flushPending();
		expect(visible).toBe("分析文本。\n\n\n\n");
		expect(healing.drainCompleted()).toHaveLength(0);
	});

	it("preserves whitespace after orphan DSML closers split across chunk boundaries", () => {
		const healing = new StreamMarkupHealing({ pattern: "dsml" });
		const leaked = "text</｜DSML｜parameter> \n  </|DSML|invoke>\n\tmore";
		let visible = "";
		for (let i = 0; i < leaked.length; i += 5) visible += healing.feed(leaked.slice(i, i + 5));
		visible += healing.flushPending();
		expect(visible).toBe("text \n  \n\tmore");
		expect(healing.drainCompleted()).toHaveLength(0);
	});

	it("heals a leaked thinking fence while still reconstructing the tool call", () => {
		// The DSML grammar's xml scanner does not parse thinking; proving the fence
		// is lifted shows the always-on thinking healer runs alongside it.
		const healing = new StreamMarkupHealing({ pattern: "dsml" });
		const events = [
			...healing.feedEvents("```thinking\nplan\n```before "),
			...healing.feedEvents(REPORTED_DSML_LEAK),
			...healing.feedEvents(" after"),
			...healing.flushEvents(),
		];
		const thinking = events.flatMap(e => (e.type === "thinking" ? [e.thinking] : [])).join("");
		const text = events.flatMap(e => (e.type === "text" ? [e.text] : [])).join("");
		const calls = events.filter(e => e.type === "toolCall");
		expect(thinking).toBe("plan\n");
		expect(text).toBe("before  after");
		expect(calls).toHaveLength(1);
	});
});

describe("StreamMarkupHealing Qwen XML pattern", () => {
	const leaked = '<tool_calls>\n<read path="/etc/hostname" />\n</tool_calls>';

	it("parses a self-closing tool element into a structured call", () => {
		const healing = new StreamMarkupHealing({ pattern: "qwen" });
		expect(healing.feed(leaked)).toBe("");

		const calls = healing.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("read");
		expect(JSON.parse(calls[0]!.arguments)).toEqual({ path: "/etc/hostname" });
	});

	it("reconstructs markup split across arbitrary chunk boundaries", () => {
		const healing = new StreamMarkupHealing({ pattern: "qwen" });
		let visible = "";
		for (const char of leaked) visible += healing.feed(char);
		visible += healing.flushPending();

		expect(visible).toBe("");
		expect(healing.drainCompleted()).toHaveLength(1);
	});

	it("preserves text around a complete tool-call section", () => {
		const healing = new StreamMarkupHealing({ pattern: "qwen" });
		const events = healing.feedEvents(`Before\n${leaked}\nAfter`);

		expect(events.map(event => event.type)).toEqual(["text", "toolCall", "text"]);
	});

	it("drops an incomplete tool-call section", () => {
		const healing = new StreamMarkupHealing({ pattern: "qwen" });
		expect(healing.feed('<tool_calls><read path="/etc/host')).toBe("");
		expect(healing.flushPending()).toBe("");
		expect(healing.drainCompleted()).toHaveLength(0);
	});
});

describe("StreamMarkupHealing thinking pattern", () => {
	it("parses plain think tags as thinking events across chunk boundaries", () => {
		const healing = new StreamMarkupHealing({ pattern: "thinking" });
		expect(healing.feedEvents("visible <thin")).toEqual([{ type: "text", text: "visible " }]);
		expect(healing.feedEvents("king>hidden</think")).toEqual([{ type: "thinking", thinking: "hidden" }]);
		expect(healing.feedEvents("ing> answer")).toEqual([{ type: "text", text: " answer" }]);
	});

	// Heal input (one or more chunks) through the public entry point, returning the
	// visible text and the recovered thinking. Spread a string to stream per char.
	const heal = (...chunks: string[]): { text: string; thinking: string } => {
		const healing = new StreamMarkupHealing({ pattern: "thinking" });
		const events = [...chunks.flatMap(chunk => healing.feedEvents(chunk)), ...healing.flushEvents()];
		let text = "";
		let thinking = "";
		for (const event of events) {
			if (event.type === "text") text += event.text;
			else if (event.type === "thinking") thinking += event.thinking;
		}
		return { text, thinking };
	};

	// Exhaustive over the dialect union: a missing case is a compile error, so the
	// healer is proven to recover every dialect's canonical `renderThinking` form.
	const DIALECT_CASES: { [K in Dialect]: K } = {
		anthropic: "anthropic",
		deepseek: "deepseek",
		gemini: "gemini",
		gemma: "gemma",
		glm: "glm",
		harmony: "harmony",
		hermes: "hermes",
		kimi: "kimi",
		minimax: "minimax",
		qwen3: "qwen3",
		xml: "xml",
	};

	for (const dialect of Object.values(DIALECT_CASES)) {
		it(`heals leaked ${dialect} reasoning back into thinking`, () => {
			const rendered = getDialectDefinition(dialect).renderThinking("REASONING_SENTINEL");
			const { text, thinking } = heal(`prefix ${rendered} suffix`);
			expect(thinking).toContain("REASONING_SENTINEL");
			expect(text).toBe("prefix  suffix");
		});
	}

	it("heals a gemini ```thinking fence streamed character by character", () => {
		const { text, thinking } = heal(..."Sure.```thinking\nweigh options\n```Done.");
		expect(thinking).toBe("weigh options\n");
		expect(text).toBe("Sure.Done.");
	});

	it("heals a bare harmony analysis channel leak", () => {
		const { text, thinking } = heal("<|channel|>analysis<|message|>planning the edit<|end|>Final answer.");
		expect(thinking).toBe("planning the edit");
		expect(text).toBe("Final answer.");
	});

	it("heals a leaked <scratchpad> section", () => {
		const { text, thinking } = heal("<scratchpad>jot</scratchpad>visible");
		expect(thinking).toBe("jot");
		expect(text).toBe("visible");
	});

	it("passes a bare '<' in idle prose through without holding it back", () => {
		expect(heal("if a < b:\n    return a")).toEqual({ text: "if a < b:\n    return a", thinking: "" });
	});

	it("leaves unrelated markup as visible text", () => {
		expect(heal("see <div>content</div> end")).toEqual({ text: "see <div>content</div> end", thinking: "" });
	});

	// Issue #5665: a literal reasoning tag inside a Markdown inline-code span was
	// read as a leaked <think> boundary, splitting the visible row into
	// text + thinking and corrupting the rendered Markdown.
	it("keeps a literal think tag inside inline code as visible text", () => {
		const literal = `<${"think"}>`;
		const row = `| [#1203 MiniMax CN leaks \`${literal}\` text](https://x) | Fixed | PR merged |`;
		expect(heal(row)).toEqual({ text: row, thinking: "" });
	});

	it("keeps a literal think tag inside inline code when streamed char by char", () => {
		const literal = `<${"think"}>`;
		const row = `prefix \`${literal}\` suffix`;
		expect(heal(...row)).toEqual({ text: row, thinking: "" });
	});

	it("keeps a literal think tag inside a fenced code block as visible text", () => {
		const literal = `<${"think"}>`;
		const block = `\`\`\`md\n${literal}\n\`\`\`\nafter`;
		expect(heal(block)).toEqual({ text: block, thinking: "" });
	});

	// Issue #5665 (review follow-up): a fenced block only closes on its own fence
	// line. An inline backtick run inside the block (a `` ``` `` string literal)
	// must not exit code mode early and let a later literal think tag be healed.
	it("keeps a fenced block open across an inner triple-backtick literal", () => {
		const literal = `<${"think"}>literal</${"think"}>`;
		const block = `\`\`\`md\nconst fence = '\`\`\`';\n${literal}\n\`\`\`\nafter`;
		expect(heal(block)).toEqual({ text: block, thinking: "" });
		expect(heal(...block)).toEqual({ text: block, thinking: "" });
	});

	// Issue #5665 (review follow-up): CommonMark treats a fence indented by up to
	// three spaces as fenced code. The scanner must still open a fenced block (not
	// an inline span) so an inner triple-backtick literal does not close it early.
	it("recognizes a fence indented up to three spaces as a fenced block", () => {
		const literal = `<${"think"}>literal</${"think"}>`;
		for (const indent of ["", " ", "   "]) {
			const block = `${indent}\`\`\`md\nconst fence = '\`\`\`';\n${literal}\n${indent}\`\`\`\nafter`;
			expect(heal(block)).toEqual({ text: block, thinking: "" });
			expect(heal(...block)).toEqual({ text: block, thinking: "" });
		}
	});

	it("still heals a leaked think tag outside inline code", () => {
		const literal = `<${"think"}>`;
		expect(heal(`before \`code\` ${literal}secret</think> after`)).toEqual({
			text: "before `code`  after",
			thinking: "secret",
		});
	});

	it("emits one balanced thinking boundary for a healed fence", () => {
		const scanner = new ThinkingInbandScanner();
		const events: InbandScanEvent[] = [...scanner.feed("a```thinking\nx\n```b"), ...scanner.flush()];
		expect(events.filter(e => e.type === "thinkingStart")).toHaveLength(1);
		expect(events.filter(e => e.type === "thinkingEnd")).toHaveLength(1);
		const thinking = events.map(e => (e.type === "thinkingDelta" ? e.delta : "")).join("");
		expect(thinking).toBe("x\n");
	});
});
describe("Kimi K2 leaked markup healing", () => {
	const model = kimiModel();

	it("strips a complete section emitted in a single chunk and synthesizes the tool call", async () => {
		const leaked =
			"<|tool_calls_section_begin|>" +
			"<|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>" +
			'{"path":"src/index.ts"}' +
			"<|tool_call_end|>" +
			"<|tool_calls_section_end|>";

		const fetchMock = mockFetch([
			chunk(model.id, { content: "I'll read it. " }),
			chunk(model.id, { content: leaked }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test", fetch: fetchMock }).result();

		const text = result.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("");
		expect(text).toBe("I'll read it. ");
		expect(text).not.toContain("<|");

		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("read");
		expect(toolCalls[0].arguments).toEqual({ path: "src/index.ts" });
		expect(toolCalls[0].id).toMatch(/^call_[0-9a-f]+$/);

		// Section was emitted alongside finish_reason:"stop" — promote to toolUse.
		expect(result.stopReason).toBe("toolUse");
	});

	it("reconstructs a section split across chunk boundaries (token straddles two chunks)", async () => {
		const full =
			"<|tool_calls_section_begin|>" +
			"<|tool_call_begin|>list_files:0<|tool_call_argument_begin|>" +
			'{"path":"."}' +
			"<|tool_call_end|>" +
			"<|tool_calls_section_end|>";

		// Split mid-token to force partial-prefix holdback.
		const split = "<|tool_ca";
		const a = full.slice(0, full.indexOf(split) + split.length);
		const b = full.slice(a.length);

		const fetchMock = mockFetch([
			chunk(model.id, { content: a }),
			chunk(model.id, { content: b }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test", fetch: fetchMock }).result();

		const text = result.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("");
		expect(text).toBe("");

		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("list_files");
		expect(toolCalls[0].arguments).toEqual({ path: "." });
		expect(result.stopReason).toBe("toolUse");
	});

	it("handles multiple tool calls inside a single section", async () => {
		const leaked =
			"<|tool_calls_section_begin|>" +
			"<|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>" +
			'{"path":"a.ts"}' +
			"<|tool_call_end|>" +
			"<|tool_call_begin|>functions.read:1<|tool_call_argument_begin|>" +
			'{"path":"b.ts"}' +
			"<|tool_call_end|>" +
			"<|tool_calls_section_end|>";

		const fetchMock = mockFetch([chunk(model.id, { content: leaked }), chunk(model.id, {}, "stop"), "[DONE]"]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test", fetch: fetchMock }).result();
		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");

		expect(toolCalls).toHaveLength(2);
		expect(toolCalls.map(tc => tc.name)).toEqual(["read", "read"]);
		expect(toolCalls.map(tc => tc.arguments)).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);
		// IDs are independently generated, never colliding.
		expect(toolCalls[0].id).not.toBe(toolCalls[1].id);
	});

	it("preserves arguments split across many chunks (no premature parse)", async () => {
		const head = "<|tool_calls_section_begin|><|tool_call_begin|>functions.write:0<|tool_call_argument_begin|>";
		const tail = "<|tool_call_end|><|tool_calls_section_end|>";
		const argsParts = ['{"path":"', "out.txt", '","content":"', "hello world", '"}'];

		const fetchMock = mockFetch([
			chunk(model.id, { content: head }),
			...argsParts.map(part => chunk(model.id, { content: part })),
			chunk(model.id, { content: tail }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test", fetch: fetchMock }).result();
		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");

		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("write");
		expect(toolCalls[0].arguments).toEqual({ path: "out.txt", content: "hello world" });
	});

	it("passes prose through unchanged when no markers are present", async () => {
		const fetchMock = mockFetch([
			chunk(model.id, { content: "Hello, " }),
			chunk(model.id, { content: "world!" }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test", fetch: fetchMock }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("");

		expect(text).toBe("Hello, world!");
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
		expect(result.stopReason).toBe("stop");
	});

	it("emits a literal '<|' that is not a token prefix without holding it back forever", async () => {
		// `<|hello|>` is not any known token. It should land in visible text.
		const fetchMock = mockFetch([
			chunk(model.id, { content: "before <|hello|> after" }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test", fetch: fetchMock }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("");

		expect(text).toBe("before <|hello|> after");
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
	});

	it("does NOT promote an error finish_reason to toolUse even when healed calls exist", async () => {
		// `content_filter` maps to `stopReason: "error"`. The promotion path used
		// to clobber any non-toolUse stop reason; it must now leave error alone.
		const leaked =
			"<|tool_calls_section_begin|>" +
			"<|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>" +
			'{"path":"src/x.ts"}' +
			"<|tool_call_end|>" +
			"<|tool_calls_section_end|>";

		const fetchMock = mockFetch([
			chunk(model.id, { content: leaked }),
			chunk(model.id, {}, "content_filter"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test", fetch: fetchMock }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("content_filter");
	});

	it("drops synthesized calls when the same chunk also carries structured tool_calls", async () => {
		// The host leaks Kimi markers AND emits the structured tool_calls payload
		// in the same delta. Without the suppression, the agent would see TWO
		// calls (same intent, different IDs). We want exactly one.
		const leaked =
			"<|tool_calls_section_begin|>" +
			"<|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>" +
			'{"path":"src/index.ts"}' +
			"<|tool_call_end|>" +
			"<|tool_calls_section_end|>";

		const fetchMock = mockFetch([
			chunk(model.id, {
				content: leaked,
				tool_calls: [
					{
						index: 0,
						id: "call_structured_abc",
						type: "function",
						function: { name: "read", arguments: '{"path":"src/index.ts"}' },
					},
				],
			}),
			chunk(model.id, {}, "tool_calls"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test", fetch: fetchMock }).result();
		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].id).toBe("call_structured_abc");
		expect(toolCalls[0].name).toBe("read");
		expect(toolCalls[0].arguments).toEqual({ path: "src/index.ts" });

		const text = result.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("");
		expect(text).not.toContain("<|");
		// Structured calls drove the finish reason themselves; promotion path
		// is bypassed because the synthesized calls were discarded.
		expect(result.stopReason).toBe("toolUse");
	});

	it("preserves leaked Kimi thinking when structured tool calls suppress synthesized calls", async () => {
		const fetchMock = mockFetch([
			chunk(model.id, {
				content: "<think>plan</think>",
				tool_calls: [
					{
						index: 0,
						id: "call_structured_abc",
						type: "function",
						function: { name: "read", arguments: '{"path":"src/index.ts"}' },
					},
				],
			}),
			chunk(model.id, {}, "tool_calls"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test", fetch: fetchMock }).result();
		const thinking = result.content
			.filter((b): b is ThinkingContent => b.type === "thinking")
			.map(b => b.thinking)
			.join("");
		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");

		expect(thinking).toBe("plan");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].id).toBe("call_structured_abc");
		expect(toolCalls[0].arguments).toEqual({ path: "src/index.ts" });
	});

	it("does not duplicate leaked Kimi thinking when explicit reasoning is present", async () => {
		const fetchMock = mockFetch([
			chunk(model.id, { reasoning_content: "plan", content: "<think>plan</think>answer" }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test", fetch: fetchMock }).result();
		const thinking = result.content
			.filter((b): b is ThinkingContent => b.type === "thinking")
			.map(b => b.thinking)
			.join("");
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("");

		expect(thinking).toBe("plan");
		expect(text).toBe("answer");
	});

	it("promotes a later healed call even if an earlier chunk had structured tool_calls", async () => {
		const leaked =
			"<|tool_calls_section_begin|>" +
			"<|tool_call_begin|>functions.write:0<|tool_call_argument_begin|>" +
			'{"path":"out.txt","content":"ok"}' +
			"<|tool_call_end|>" +
			"<|tool_calls_section_end|>";

		const fetchMock = mockFetch([
			chunk(model.id, {
				tool_calls: [
					{
						index: 0,
						id: "call_structured_first",
						type: "function",
						function: { name: "read", arguments: '{"path":"src/index.ts"}' },
					},
				],
			}),
			chunk(model.id, { content: leaked }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test", fetch: fetchMock }).result();
		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls.map(call => call.name)).toEqual(["read", "write"]);
		expect(toolCalls[0].id).toBe("call_structured_first");
		expect(toolCalls[1].arguments).toEqual({ path: "out.txt", content: "ok" });
		expect(result.stopReason).toBe("toolUse");
	});

	it("passes a literal <|tool_call_end|> through as text when no section is active", async () => {
		const prose = "Use <|tool_call_end|> to close a call.";
		const fetchMock = mockFetch([chunk(model.id, { content: prose }), chunk(model.id, {}, "stop"), "[DONE]"]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test", fetch: fetchMock }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("");
		expect(text).toBe(prose);
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
		expect(result.stopReason).toBe("stop");
	});
});

describe("Ollama provider DSML envelope healing", () => {
	it("emits a healed tool call, suppresses leaked text, and promotes stop", async () => {
		const fetchMock = mockNdjsonFetch([
			{
				model: "deepseek-v4-pro",
				message: { role: "assistant", content: " 精神精神\n\n" },
				done: false,
			},
			{
				model: "deepseek-v4-pro",
				message: { role: "assistant", content: `${REPORTED_DSML_LEAK}\nThat should give us the package list.` },
				done: false,
			},
			{
				model: "deepseek-v4-pro",
				done: true,
				done_reason: "stop",
				prompt_eval_count: 12,
				eval_count: 200,
			},
		]);

		const result = await stream(
			deepseekCloudModel,
			{ messages: [{ role: "user", content: "Check Fedora packages", timestamp: Date.now() }] },
			{ apiKey: "test-key", fetch: fetchMock },
		).result();

		const visibleText = result.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map(b => b.text)
			.join("");
		expect(visibleText).not.toContain("DSML");
		expect(visibleText).not.toContain("<｜");

		const [prefix, healedCall, suffix] = result.content;
		if (prefix?.type !== "text" || healedCall?.type !== "toolCall" || suffix?.type !== "text") {
			throw new Error("Ollama DSML healing emitted unexpected content order");
		}
		expect(prefix.text).toBe(" 精神精神\n\n");
		expect(healedCall.name).toBe("bash");
		expect(suffix.text).toBe("\nThat should give us the package list.");

		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("bash");
		expect(toolCalls[0].arguments).toMatchObject({
			[INTENT_FIELD]: "Check Fedora 42 available packages",
			timeout: 15,
		});
		expect(String(toolCalls[0].arguments.command)).toContain("docker run");
		expect(result.stopReason).toBe("toolUse");
	});

	it("leaves non-DeepSeek Ollama content untouched", async () => {
		const fetchMock = mockNdjsonFetch([
			{
				model: "gpt-oss:120b",
				message: { role: "assistant", content: "Inline `<｜literal｜>` token in prose." },
				done: false,
			},
			{
				model: "gpt-oss:120b",
				done: true,
				done_reason: "stop",
				prompt_eval_count: 1,
				eval_count: 1,
			},
		]);

		const result = await stream(
			{ ...deepseekCloudModel, id: "gpt-oss:120b", name: "GPT OSS 120B" },
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-key", fetch: fetchMock },
		).result();

		const text = result.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map(b => b.text)
			.join("");
		expect(text).toBe("Inline `<｜literal｜>` token in prose.");
		expect(result.stopReason).toBe("stop");
	});
});

describe("OpenAI completions MiniMax thinking healing", () => {
	it("parses OpenCode Zen MiniMax think tags into a thinking block", async () => {
		const model: Model<"openai-completions"> = buildModel({
			id: "minimax-m3",
			name: "MiniMax M3",
			api: "openai-completions",
			provider: "opencode-zen",
			baseUrl: "https://opencode.ai/zen/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		});
		const fetchMock = mockFetch([
			chunk(model.id, { content: "visible <thin" }),
			chunk(model.id, { content: "k>hidden reasoning</think" }),
			chunk(model.id, { content: ">" }),
			chunk(model.id, { content: " answer" }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.content).toEqual([
			{ type: "text", text: "visible " },
			{ type: "thinking", thinking: "hidden reasoning", thinkingSignature: undefined },
			{ type: "text", text: " answer" },
		]);
	});
});

describe("OpenAI completions provider DSML envelope healing", () => {
	it("heals the envelope into a structured tool call and suppresses leaked text", async () => {
		const model: Model<"openai-completions"> = buildModel({
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "openai-completions",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131_072,
			maxTokens: 8_192,
		});
		const fetchMock = mockFetch([
			chunk(model.id, { content: "I'll check.\n" }),
			chunk(model.id, { content: `${REPORTED_DSML_LEAK}\nThat should give us the package list.` }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "Check Fedora", timestamp: Date.now() }] },
			{ apiKey: "test-key", fetch: fetchMock },
		).result();

		const text = result.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map(b => b.text)
			.join("");
		expect(text).not.toContain("DSML");
		expect(text).not.toContain("<｜");
		expect(text.startsWith("I'll check.")).toBe(true);

		const [prefix, healedCall, suffix] = result.content;
		if (prefix?.type !== "text" || healedCall?.type !== "toolCall" || suffix?.type !== "text") {
			throw new Error("OpenAI DSML healing emitted unexpected content order");
		}
		expect(prefix.text).toBe("I'll check.\n");
		expect(healedCall.name).toBe("bash");
		expect(suffix.text).toBe("\nThat should give us the package list.");

		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("bash");
		expect(toolCalls[0].arguments).toMatchObject({
			[INTENT_FIELD]: "Check Fedora 42 available packages",
			timeout: 15,
		});
		expect(result.stopReason).toBe("toolUse");
	});

	it("heals NanoGPT-hosted DeepSeek V4 Pro DSML leaks (issue #1488)", async () => {
		const model = getBundledModel<"openai-completions">("nanogpt", "deepseek/deepseek-v4-pro");

		let payload: Record<string, unknown> | undefined;
		const fetchMock = mockFetch([
			chunk(model.id, { content: "Checking.\n" }),
			chunk(model.id, { content: REPORTED_DSML_LEAK }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "Check Fedora", timestamp: Date.now() }], tools: [bashTool] },
			{
				apiKey: "test-key",
				reasoning: "high",
				fetch: fetchMock,
				onPayload: value => {
					payload = value as Record<string, unknown>;
				},
			},
		).result();

		// Issue #1488: `:tools` triggers NanoGPT's server-side tool-call parser
		// which 502s on complex DeepSeek payloads. We route via the default
		// path and rely on DSML healing instead.
		expect(payload?.model).toBe("deepseek/deepseek-v4-pro");
		expect(payload?.reasoning_effort).toBe("high");
		expect(payload?.tools).toBeDefined();
		const text = result.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map(b => b.text)
			.join("");
		expect(text).not.toContain("DSML");
		expect(text).not.toContain("<｜");

		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("bash");
		expect(toolCalls[0].arguments).toMatchObject({
			[INTENT_FIELD]: "Check Fedora 42 available packages",
			timeout: 15,
		});
		expect(result.stopReason).toBe("toolUse");
	});

	it("keeps indexed parallel NanoGPT read deltas attached to their own tool calls", async () => {
		const model = getBundledModel<"openai-completions">("nanogpt", "deepseek/deepseek-v4-pro");
		const fetchMock = mockFetch([
			chunk(model.id, {
				tool_calls: [
					{ index: 0, id: "call_a", type: "function", function: { name: "read", arguments: "" } },
					{ index: 1, id: "call_b", type: "function", function: { name: "read", arguments: "" } },
				],
			}),
			chunk(model.id, {
				tool_calls: [
					{ index: 0, function: { arguments: '{"path":"a.ts"}' } },
					{ index: 1, function: { arguments: '{"path":"b.ts"}' } },
				],
			}),
			chunk(model.id, {}, "tool_calls"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "Read a.ts and b.ts", timestamp: Date.now() }], tools: [readTool] },
			{ apiKey: "test-key", reasoning: "high", fetch: fetchMock },
		).result();

		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls.map(call => call.id)).toEqual(["call_a", "call_b"]);
		expect(toolCalls.map(call => call.name)).toEqual(["read", "read"]);
		expect(toolCalls.map(call => call.arguments)).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);
		expect(result.stopReason).toBe("toolUse");
	});
});
