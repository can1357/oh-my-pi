/**
 * Contract: /dump renders the tool catalog through the shared AI inventory
 * renderer — a simplified TypeScript signature (derived from the wire JSON
 * Schema) plus each tool's examples in the model's native tool-call syntax.
 *
 * Tools carry live arktype schemas; the dump must surface a readable signature
 * (not the schema instance's internals) and must include examples, which the
 * previous `<parameter>`-per-key JSON Schema dump dropped entirely.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Model, Usage } from "@oh-my-pi/pi-ai";
import { formatSessionDumpText } from "@oh-my-pi/pi-coding-agent/session/session-dump-format";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const HARMONY_MODEL = { provider: "openai", id: "gpt-5", name: "GPT-5" } as Model;

describe("formatSessionDumpText tool parameters", () => {
	it("renders arktype schemas as a TypeScript signature, not schema internals", () => {
		const webSearchSchema = type({
			"query /** search query */": "string",
			"recency?": "'day' | 'week'",
		});

		const out = formatSessionDumpText({
			messages: [],
			tools: [
				{
					name: "web_search",
					description: "Searches the web.",
					parameters: webSearchSchema,
				},
			],
		});

		expect(out).toContain("namespace functions {");
		expect(out).toContain("type web_search = (_: {");
		expect(out).toContain("// search query");
		expect(out).toContain("query: string,");
		expect(out).toContain('recency?: "day" | "week",');
		// Arktype JSON Schema should not leak arktype internals into the dump.
		expect(out).not.toContain("_arktype");
		expect(out).not.toContain("ArkType");
		// Tool params are no longer emitted as XML <parameter> elements.
		expect(out).not.toContain('<parameter name="type">');
	});

	it("passes plain JSON-Schema parameters through to a TypeScript signature", () => {
		const out = formatSessionDumpText({
			messages: [],
			tools: [
				{
					name: "legacy",
					description: "Legacy tool.",
					parameters: {
						type: "object",
						properties: { path: { type: "string", description: "a path" } },
						required: ["path"],
					},
				},
			],
		});

		expect(out).toContain("type legacy = (_: {");
		expect(out).toContain("// a path");
		expect(out).toContain("path: string,");
	});

	it("includes tool examples in Python call syntax", () => {
		const findSchema = type({ paths: "string[]" });

		const out = formatSessionDumpText({
			messages: [],
			tools: [
				{
					name: "glob",
					description: "Globs files.",
					parameters: findSchema,
					examples: [{ call: { paths: ["src/**/*.ts"] } }],
				},
			],
		});

		expect(out).toContain("## Available Tools");
		expect(out).toContain("@example");
		expect(out).toContain('glob(paths=["src/**/*.ts"])');
	});

	it("omits the Available Tools section if inlineToolDescriptors is true", () => {
		const out = formatSessionDumpText({
			messages: [],
			inlineToolDescriptors: true,
			tools: [
				{
					name: "web_search",
					description: "Searches the web.",
					parameters: { type: "object" },
				},
			],
		});

		expect(out).not.toContain("## Available Tools");
	});

	it("does not falsely omit the Available Tools section even if systemPrompt contains tool headings", () => {
		const out = formatSessionDumpText({
			messages: [],
			systemPrompt: ["# Inventory\nThis is a rule discussing # Tool: web_search.\nNever call it directly."],
			inlineToolDescriptors: false,
			tools: [
				{
					name: "web_search",
					description: "Searches the web.",
					parameters: { type: "object" },
				},
			],
		});

		expect(out).toContain("## Available Tools");
	});
});

describe("formatSessionDumpText markdown-headings transcript", () => {
	it("renders the main /dump transcript with legacy markdown role headings, not native envelopes", () => {
		const out = formatSessionDumpText({
			model: HARMONY_MODEL,
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Reading." },
						{
							type: "toolCall",
							id: "c1",
							name: "read",
							arguments: { [INTENT_FIELD]: "Reading the file", path: "src/foo.ts" },
						},
					],
					api: "mock",
					provider: "mock",
					model: "mock",
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "read",
					content: [{ type: "text", text: "file body" }],
					isError: false,
					timestamp: 3,
				},
			],
		});

		// Legacy per-message markdown headings (the pre-16.x /dump shape the user wants back).
		expect(out).toContain("## User");
		expect(out).toContain("## Assistant");
		expect(out).toContain("### Tool Result: read");
		expect(out).toContain("### Tool Call: read");
		expect(out).toContain("path: src/foo.ts");
		// The `i` intent renders as a `//` comment under the heading, never inside the YAML args.
		expect(out).toContain("// Reading the file");
		expect(out).not.toContain(`${INTENT_FIELD}:`);
		// Tool calls render as a readable heading + YAML, never the <invoke>/<parameter> XML.
		expect(out).not.toContain("<invoke ");
		expect(out).not.toContain("<parameter ");
		expect(out).toContain("file body");
		// The 16.x native-dialect transcript wrapper and envelopes must be gone.
		expect(out).not.toContain("## Transcript");
		expect(out).not.toContain("<|start|>");
	});

	it("fences system notices under a readable title without breaking on nested code fences", () => {
		const notice = `<system-notice>
Background job completed with:
\`\`\`sh
printf 'done\\n'
\`\`\`
</system-notice>`;
		const out = formatSessionDumpText({
			messages: [
				{
					role: "custom",
					customType: "async-progress",
					content: notice,
					display: true,
					attribution: "agent",
					timestamp: 1,
				},
			],
		});

		expect(out).toContain("## System Notice: Async Progress");
		expect(out).toContain(`\`\`\`\`xml\n${notice}\n\`\`\`\``);
		expect(out).not.toContain("## async-progress");
	});

	it("leaves ordinary custom XML messages unchanged", () => {
		const content = "<system-noticeable>ordinary custom content</system-noticeable>";
		const out = formatSessionDumpText({
			messages: [
				{
					role: "custom",
					customType: "plugin-message",
					content,
					display: true,
					attribution: "agent",
					timestamp: 1,
				},
			],
		});

		expect(out).toContain("## plugin-message");
		expect(out).toContain(content);
		expect(out).not.toContain("## System Notice:");
		expect(out).not.toContain("```xml");
	});

	it("does not nest a thinking block that already carries a literal <thinking> envelope (#2700)", () => {
		const out = formatSessionDumpText({
			messages: [
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "<thinking>\nCheck the logs.\n</thinking>" }],
					api: "mock",
					provider: "mock",
					model: "mock",
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 1,
				},
			],
		});

		expect(out).toContain("<thinking>\nCheck the logs.\n</thinking>");
		expect(out).not.toContain("<thinking>\n<thinking>");
	});

	it("renders sibling thinking blocks split by a tool call without nesting envelopes", () => {
		const out = formatSessionDumpText({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "<thinking>\nfirst\n</thinking>" },
						{ type: "toolCall", id: "c1", name: "read", arguments: { path: "f.ts" } },
						{ type: "thinking", thinking: "<thinking>\nsecond\n</thinking>" },
					],
					api: "mock",
					provider: "mock",
					model: "mock",
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 1,
				},
			],
		});

		// Each block is unwrapped then re-wrapped independently — never nested.
		expect(out).toContain("<thinking>\nfirst\n</thinking>");
		expect(out).toContain("<thinking>\nsecond\n</thinking>");
		expect(out).not.toContain("<thinking>\n<thinking>");
	});
});
