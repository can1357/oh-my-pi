import { describe, expect, test } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry, SessionMessageEntry, ShakeConfig } from "@oh-my-pi/pi-agent-core/compaction";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	applyShakeRegion,
	applyShakeRegions,
	collectShakeRegions,
	DEFAULT_SHAKE_CONFIG,
	RESCUE_SHAKE_CONFIG,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { convertMessageToLlm } from "../src/compaction/messages";

const tokenizer = new Tokenizer();

let idCounter = 0;
function nextId(): string {
	return `entry-${idCounter++}`;
}

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: nextId(), parentId: null, timestamp: new Date().toISOString(), message };
}

function toolResultMessage(toolName: string, text: string, extra?: Partial<ToolResultMessage>): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${idCounter++}`,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
		...extra,
	};
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

/** Repeat a representative code line enough to clear ~`approxTokens` tokens. */
function fencedBlock(approxTokens: number, lang = "ts"): string {
	const line = "const value = computeSomething(alpha, beta, gamma, delta, epsilon);";
	const count = Math.ceil((approxTokens * 4) / line.length);
	return `\`\`\`${lang}\n${Array(count).fill(line).join("\n")}\n\`\`\``;
}

function xmlBlock(approxTokens: number, tag = "example"): string {
	const line = "  payload row with identifiers alpha beta gamma delta epsilon zeta;";
	const count = Math.ceil((approxTokens * 4) / line.length);
	return `<${tag}>\n${Array(count).fill(line).join("\n")}\n</${tag}>`;
}

function cfg(over: Partial<ShakeConfig> = {}): ShakeConfig {
	return { protectTokens: 0, minSavings: 0, protectedTools: [], fenceMinTokens: 50, ...over };
}

describe("collectShakeRegions — tool results", () => {
	test("collects unprotected tool results and applyShakeRegion sets prunedAt", () => {
		const tr = toolResultMessage("bash", "x".repeat(400));
		const entry = messageEntry(tr);
		const regions = collectShakeRegions([entry], tokenizer, cfg());

		expect(regions).toHaveLength(1);
		const region = regions[0];
		expect(region.kind).toBe("toolResult");
		expect(region.tokens).toBeGreaterThan(0);

		applyShakeRegion(region, "[shaken]");
		expect(tr.prunedAt).toBeGreaterThan(0);
		expect(tr.content).toEqual([{ type: "text", text: "[shaken]" }]);
	});

	test("keeps images in the provider view of an elided mixed tool result", () => {
		const image: ImageContent = {
			type: "image",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
			mimeType: "image/png",
		};
		const tr = toolResultMessage("bash", "[shaken]", {
			content: [{ type: "text", text: "[shaken]" }, image],
			prunedAt: Date.now(),
		});

		const converted = convertMessageToLlm(tr);

		expect(converted?.content).toEqual([{ type: "text", text: "[shaken]" }, image]);
		expect(Array.isArray(converted?.content) ? converted.content[1] : undefined).toBe(image);
	});

	test("never collects protected tools", () => {
		const entry = messageEntry(toolResultMessage("skill", "y".repeat(800)));
		const regions = collectShakeRegions([entry], tokenizer, cfg({ protectedTools: ["skill"] }));
		expect(regions).toHaveLength(0);
	});

	test("never collects already-pruned tool results", () => {
		const entry = messageEntry(toolResultMessage("bash", "z".repeat(800), { prunedAt: Date.now() }));
		const regions = collectShakeRegions([entry], tokenizer, cfg());
		expect(regions).toHaveLength(0);
	});

	test("honors the protect-recent token window", () => {
		const text = "word ".repeat(160); // ~ deterministic token block
		const older = messageEntry(toolResultMessage("bash", text));
		const middle = messageEntry(toolResultMessage("bash", text));
		const recent = messageEntry(toolResultMessage("bash", text));
		const perEntry = tokenizer.countMessage(older.message);
		// Window covers the most recent ~1.5 entries → middle & recent protected, older eligible.
		const regions = collectShakeRegions(
			[older, middle, recent],
			tokenizer,
			cfg({ protectTokens: Math.floor(perEntry * 1.5) }),
		);

		expect(regions).toHaveLength(1);
		expect(regions[0].entry).toBe(older);
	});

	test("minSavings gates the whole batch", () => {
		const entry = messageEntry(toolResultMessage("bash", "q".repeat(800)));
		const tokens = tokenizer.countMessage(entry.message);
		expect(collectShakeRegions([entry], tokenizer, cfg({ minSavings: tokens * 10 }))).toHaveLength(0);
		expect(collectShakeRegions([entry], tokenizer, cfg({ minSavings: 0 }))).toHaveLength(1);
	});
});

describe("collectShakeRegions — fenced / XML blocks", () => {
	test("detects a large fenced block and applyShakeRegion splices it out", () => {
		const fence = fencedBlock(120);
		const text = `intro line\n${fence}\noutro line`;
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		const regions = collectShakeRegions([entry], tokenizer, cfg());

		expect(regions).toHaveLength(1);
		const region = regions[0];
		expect(region.kind).toBe("block");
		if (region.kind !== "block") throw new Error("expected block region");
		expect(text.slice(region.start, region.end)).toBe(fence);

		applyShakeRegion(region, "[shaken]");
		const block = (entry.message as AssistantMessage).content[0] as TextContent;
		expect(block.text).toBe("intro line\n[shaken]\noutro line");
	});

	test("ignores fenced blocks below fenceMinTokens", () => {
		const text = "intro\n```ts\nconst a = 1;\n```\noutro";
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		expect(collectShakeRegions([entry], tokenizer, cfg({ fenceMinTokens: 400 }))).toHaveLength(0);
	});

	test("detects a top-level XML block", () => {
		const xml = xmlBlock(120);
		const text = `before\n${xml}\nafter`;
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		const regions = collectShakeRegions([entry], tokenizer, cfg());

		expect(regions).toHaveLength(1);
		const region = regions[0];
		if (region.kind !== "block") throw new Error("expected block region");
		expect(text.slice(region.start, region.end)).toBe(xml);
	});

	test("never targets toolCall blocks and points blockIndex at the text block", () => {
		const fence = fencedBlock(120);
		const toolCall: ToolCall = { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "x" } };
		const entry = messageEntry(
			assistantMessage([{ type: "text", text: "tiny" }, toolCall, { type: "text", text: `pre\n${fence}\npost` }]),
		);
		const regions = collectShakeRegions([entry], tokenizer, cfg());

		expect(regions).toHaveLength(1);
		const region = regions[0];
		if (region.kind !== "block") throw new Error("expected block region");
		expect(region.blockIndex).toBe(2);
	});

	test("does not cross message boundaries — each large block stays in its own entry", () => {
		const a = messageEntry(assistantMessage([{ type: "text", text: `a\n${fencedBlock(120)}\na` }]));
		const b = messageEntry(assistantMessage([{ type: "text", text: `b\n${fencedBlock(120, "py")}\nb` }]));
		const regions = collectShakeRegions([a, b], tokenizer, cfg());

		expect(regions).toHaveLength(2);
		expect(regions[0].entry).toBe(a);
		expect(regions[1].entry).toBe(b);
	});

	test("ignores unterminated fences (conservative)", () => {
		const text = `intro\n\`\`\`ts\n${"const a = 1;\n".repeat(60)}`; // never closes
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		expect(collectShakeRegions([entry], tokenizer, cfg())).toHaveLength(0);
	});
});

describe("applyShakeRegions — multi-region ordering", () => {
	test("splices two blocks in one text block correctly (highest-start-first)", () => {
		const first = fencedBlock(80);
		const second = fencedBlock(80, "py");
		const text = `head\n${first}\nmiddle\n${second}\ntail`;
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		const regions = collectShakeRegions([entry], tokenizer, cfg());
		expect(regions).toHaveLength(2);

		applyShakeRegions([
			{ region: regions[0], replacement: "[A]" },
			{ region: regions[1], replacement: "[B]" },
		]);
		const block = (entry.message as AssistantMessage).content[0] as TextContent;
		expect(block.text).toBe("head\n[A]\nmiddle\n[B]\ntail");
	});
});

describe("shake config presets", () => {
	test("aggressive preset protects skill and keeps a small recent tail", () => {
		expect(AGGRESSIVE_SHAKE_CONFIG.protectTokens).toBeGreaterThan(0);
		expect(AGGRESSIVE_SHAKE_CONFIG.minSavings).toBe(0);
		expect(AGGRESSIVE_SHAKE_CONFIG.protectedTools).toContain("skill");
	});

	test("manual shake preserves the recent tool-result tail instead of stripping everything", () => {
		const older = messageEntry(toolResultMessage("bash", "old-result ".repeat(300)));
		const recent = messageEntry(toolResultMessage("bash", "recent-result ".repeat(3000)));
		const regions = collectShakeRegions([older, recent], tokenizer, AGGRESSIVE_SHAKE_CONFIG);

		// The recent result sits inside the preserved tail; the older one is
		// still shaken aggressively.
		expect(regions).toHaveLength(1);
		expect(regions[0].entry).toBe(older);
	});

	test("default preset keeps a protect window", () => {
		expect(DEFAULT_SHAKE_CONFIG.protectTokens).toBeGreaterThan(0);
		expect(DEFAULT_SHAKE_CONFIG.protectedTools).toContain("skill");
	});

	test("rescue preset overrides the manual tail so it can elide the newest result", () => {
		const recent = messageEntry(toolResultMessage("bash", "oversized-result ".repeat(2000)));
		const regions = collectShakeRegions([recent], tokenizer, RESCUE_SHAKE_CONFIG);
		expect(regions).toHaveLength(1);
		expect(regions[0].entry).toBe(recent);
	});

	test("empty branch yields no regions", () => {
		expect(collectShakeRegions([] as SessionEntry[], tokenizer, AGGRESSIVE_SHAKE_CONFIG)).toHaveLength(0);
	});
});

describe("collectShakeRegions — useless results", () => {
	test("useless tool result inside the protect window yields a region; identical plain result does not", () => {
		const text = "No matches found in any scanned file.\n".repeat(20);
		const flagged = messageEntry(toolResultMessage("search", text, { useless: true }));
		const plain = messageEntry(toolResultMessage("search", text));
		// Window far larger than the whole branch: only the flagged result bypasses it.
		const regions = collectShakeRegions([flagged, plain], tokenizer, cfg({ protectTokens: 1_000_000 }));
		expect(regions).toHaveLength(1);
		expect(regions[0].entry).toBe(flagged);
	});

	test("an error result never bypasses the window even when flagged", () => {
		const entry = messageEntry(toolResultMessage("search", "boom\n".repeat(50), { useless: true, isError: true }));
		expect(collectShakeRegions([entry], tokenizer, cfg({ protectTokens: 1_000_000 }))).toHaveLength(0);
	});
});
