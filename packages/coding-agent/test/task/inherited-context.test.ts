import { describe, expect, it } from "bun:test";
import type { Context, Message, Model } from "@oh-my-pi/pi-ai";
import { type CustomMessage, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import {
	buildInheritedContext,
	extractIdentifiers,
	INHERITED_CONTEXT_CHARS,
	INHERITED_CONTEXT_MAX_FRAMES,
	INHERITED_CONTEXT_MESSAGE_TYPE,
	InheritedContextFrames,
	type InheritedContext,
	inheritedContextMessage,
} from "@oh-my-pi/pi-coding-agent/task/inherited-context";

const HASH = "40cf59cf8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293c17051";

function visionModel(input: Model["input"]): Model {
	return {
		id: "claude-sonnet-4-5",
		name: "Sonnet",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	} as Model;
}

function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: 0 } as Message;
}

describe("extractIdentifiers", () => {
	it("keeps long hashes, paths with line ranges, flags, and numbers verbatim", () => {
		const text = [
			`The final build hash is ${HASH}.`,
			"Fix lives in crates/image/src/resample.rs:358-384 and ~/Projects/oh-my-pi/packages/x.ts.",
			"Run `cargo test --release --features=simd` on port 4317; score 0.91 vs 27,832 chars.",
			"Commit bcd5b0b996 landed. The year 12, word deadbeef, and jobs/services are not identifiers; src/task-a is.",
		].join("\n");
		const ids = extractIdentifiers(text);
		expect(ids).toContain(HASH);
		expect(ids).toContain("crates/image/src/resample.rs:358-384");
		expect(ids).toContain("~/Projects/oh-my-pi/packages/x.ts");
		expect(ids).toContain("--release");
		expect(ids).toContain("--features=simd");
		expect(ids).toContain("4317");
		expect(ids).toContain("0.91");
		expect(ids).toContain("27,832");
		expect(ids).toContain("bcd5b0b996");
		expect(ids).not.toContain("12");
		expect(ids).not.toContain("deadbeef");
		expect(ids).not.toContain("jobs/services");
		expect(ids).toContain("src/task-a");
		// Contained in the longer path, so not listed separately.
		expect(ids).not.toContain("resample.rs:358-384");
	});

	it("keeps the most recently mentioned identifiers when over the limit", () => {
		const text = Array.from({ length: 10 }, (_, i) => `step ${1000 + i}`).join("\n");
		expect(extractIdentifiers(text, 3)).toEqual(["1007", "1008", "1009"]);
	});
});

describe("buildInheritedContext", () => {
	it("keeps only the tail of a long conversation, starting at a line boundary", () => {
		const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} of the parent transcript`);
		const context = buildInheritedContext([userMessage(lines.join("\n"))], undefined);
		expect(context).toBeDefined();
		expect(context!.text.length).toBeLessThanOrEqual(INHERITED_CONTEXT_CHARS);
		expect(context!.text).toContain("line 3999 of the parent transcript");
		expect(context!.text).not.toContain("line 0 of");
		expect(context!.text.startsWith("line ")).toBe(true);
	});

	it("returns undefined without conversation text", () => {
		expect(buildInheritedContext([], undefined)).toBeUndefined();
	});

	it("encodes secrets before the tail and identifiers are built", () => {
		const secret = "hunter2-not-a-real-token-0000";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const messages = [userMessage(`export GITHUB_TOKEN=${secret}\nthen push to /srv/repos/app.git`)];
		const context = buildInheritedContext(messages, text => obfuscator.obfuscate(text));
		expect(context!.text).not.toContain(secret);
		expect(context!.text).toContain("export GITHUB_TOKEN=");
		expect(context!.identifiers.some(id => id.includes(secret))).toBe(false);
		expect(context!.identifiers).toContain("/srv/repos/app.git");
		// Encoding runs per call: the cached raw window does not pin an earlier redaction state.
		expect(buildInheritedContext(messages, undefined)!.text).toContain(secret);
	});
});

/** The child's provider context for an inherited tail, built the way the session builds it. */
function childContext(context: InheritedContext): Context {
	const { content, details } = inheritedContextMessage(context);
	const custom = {
		role: "custom",
		customType: INHERITED_CONTEXT_MESSAGE_TYPE,
		content,
		display: false,
		details,
		timestamp: 0,
	} as CustomMessage;
	return { messages: [...convertToLlm([custom]), userMessage("Do the assigned work.")] };
}

function preambleText(context: Context): string {
	const block = (context.messages[0]!.content as { type: string; text?: string }[])[0]!;
	return block.text ?? "";
}

describe("inherited context turn", () => {
	const context = { text: `Build ${HASH} passed.\n`.repeat(40), identifiers: [HASH] };

	it("reaches the provider as an agent-authored user turn, never developer authority", () => {
		const [turn] = childContext(context).messages;
		expect(turn).toMatchObject({ role: "user", attribution: "agent", inheritedContext: true });
		expect((turn!.content as { type: string }[]).map(block => block.type)).toEqual(["text", "text"]);
	});

	it("is drawn as frames with the identifier sidecar for a vision model", async () => {
		const sent = await new InheritedContextFrames().transform(
			childContext(context),
			visionModel(["text", "image"]),
			false,
		);
		const [preamble, ...frames] = sent.messages[0]!.content as { type: string; text?: string; mimeType?: string }[];
		expect(preamble!.text).toContain(`- \`${HASH}\``);
		expect(frames.length).toBeGreaterThan(0);
		expect(frames.length).toBeLessThanOrEqual(INHERITED_CONTEXT_MAX_FRAMES);
		expect(frames.every(block => block.type === "image" && block.mimeType === "image/png")).toBe(true);
		expect(sent.messages[1]).toMatchObject({ role: "user" });
	});

	it("stays text for a model without image input or with images blocked", async () => {
		const frames = new InheritedContextFrames();
		const built = childContext(context);
		expect(await frames.transform(built, visionModel(["text"]), false)).toBe(built);
		expect(await frames.transform(built, visionModel(["text", "image"]), true)).toBe(built);
		const tail = (built.messages[0]!.content as { text: string }[])[1]!;
		expect(tail.text).toBe(context.text);
	});

	it("lists only identifiers from the part the frames hold when the shape fits less than the tail", async () => {
		const OLD_HASH = "9a8b7c6d5e4f30211203f4e5d6c7b8a9";
		// A full-size CJK tail: the CJK grid holds far less per frame than the dense Latin shape.
		const cjk = "检查构建结果并记录每一步的输出。\n".repeat(Math.floor((INHERITED_CONTEXT_CHARS - 200) / 17));
		const text = `start ${OLD_HASH}\n${cjk}end ${HASH}\n`;
		const tail = { text, identifiers: extractIdentifiers(text) };
		expect(tail.identifiers).toContain(OLD_HASH);
		const sent = await new InheritedContextFrames().transform(
			childContext(tail),
			visionModel(["text", "image"]),
			false,
		);
		const frames = (sent.messages[0]!.content as { type: string }[]).slice(1);
		expect(frames.length).toBeGreaterThan(0);
		expect(frames.length).toBeLessThanOrEqual(INHERITED_CONTEXT_MAX_FRAMES);
		expect(preambleText(sent)).toContain(HASH);
		expect(preambleText(sent)).not.toContain(OLD_HASH);
	});
});
