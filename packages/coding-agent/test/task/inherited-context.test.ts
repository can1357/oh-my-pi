import { describe, expect, it, vi } from "bun:test";
import type { Context, Message, Model } from "@oh-my-pi/pi-ai";
import {
	type CustomMessage,
	convertToLlm,
	INHERITED_CONTEXT_MESSAGE_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { providerImageBudget } from "@oh-my-pi/snapcompact";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import {
	buildInheritedContext,
	extractIdentifiers,
	INHERITED_CONTEXT_CHARS,
	INHERITED_CONTEXT_MAX_FRAMES,
	InheritedContextFrames,
	type InheritedContext,
	type ShapeSetting,
	inheritedContextMessage,
	restoreEvictedFrames,
} from "@oh-my-pi/pi-coding-agent/task/inherited-context";

const HASH = "40cf59cf8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293c17051";

function visionModel(
	input: Model["input"],
	{ id, api, provider }: Pick<Model, "id" | "api" | "provider"> = {
		id: "claude-sonnet-4-5",
		api: "anthropic-messages",
		provider: "anthropic",
	},
): Model {
	return {
		id,
		name: id,
		api,
		provider,
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
			"Run cargo test --release --features=simd on port 4317; score 0.91 vs 27,832 chars.",
			"Commit bcd5b0b996 landed. The year 12 and the word deadbeef are not identifiers; src/task-a is.",
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
		expect(ids).toContain("src/task-a");
		// Contained in the longer path, so not listed separately.
		expect(ids).not.toContain("resample.rs:358-384");
	});

	it("keeps backtick spans, short flags with values, versions, and code names", () => {
		const text = [
			"Ran `bun test --watch` with -n 4 and -j8 against v1.2.3-beta.1; plain -v and well-known stay out.",
			"Then SnapcompactInline, INHERITED_CONTEXT_CHARS, snapcompact.resolveShape, and Foo::bar changed.",
		].join("\n");
		const ids = extractIdentifiers(text);
		for (const id of [
			"bun test --watch",
			"-n 4",
			"-j8",
			"v1.2.3-beta.1",
			"SnapcompactInline",
			"INHERITED_CONTEXT_CHARS",
			"snapcompact.resolveShape",
			"Foo::bar",
		]) {
			expect(ids).toContain(id);
		}
		expect(ids).not.toContain("-v");
		// Inside the more recent backtick span.
		expect(ids).not.toContain("--watch");
	});

	it("keeps the latest run of identifiers that fits the budget, 15% of a full tail by default", () => {
		const text = Array.from({ length: 10 }, (_, i) => `step ${1000 + i}`).join("\n");
		// Each costs its length plus a line break.
		expect(extractIdentifiers(text, 15)).toEqual(["1007", "1008", "1009"]);
		const full = Array.from({ length: 4_000 }, (_, i) => `step ${10_000 + i}`).join("\n");
		const listed = extractIdentifiers(full);
		expect(listed.at(-1)).toBe("13999");
		expect(listed.length).toBe(Math.floor((INHERITED_CONTEXT_CHARS * 0.15) / 6));
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

	it("hands the child secrets it can encode and decode itself, including regex-matched ones", () => {
		const plain = "hunter2-not-a-real-token-0000";
		const matched = "tok_examplefixture";
		const entries = [
			{ type: "plain" as const, content: plain },
			{ type: "regex" as const, content: "tok_[a-z0-9]+" },
		];
		const parent = new SecretObfuscator(entries);
		const messages = [userMessage(`export GITHUB_TOKEN=${plain}\ncurl -H "X-Key: ${matched}" /srv/api/v1/run`)];
		const context = buildInheritedContext(messages, parent);
		expect(context!.text).toContain(`export GITHUB_TOKEN=${plain}`);
		// A separate session, as the child is: its boundary encodes the tail and decodes the model's reuse of it.
		const child = new SecretObfuscator(entries);
		const sent = child.obfuscate(context!.text);
		expect(sent).not.toContain(plain);
		expect(sent).not.toContain(matched);
		expect(child.deobfuscate(sent)).toBe(context!.text);
	});

	it("never keeps part of a secret cut at the tail edge", () => {
		const secret = `tok_${"a1".repeat(40)}`;
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "tok_[a-z0-9]+" }]);
		// One long line, so the cut cannot snap to a line start: raw, it lands 20 characters before the secret ends.
		const line = `${"x".repeat(2_000)} ${secret}${"y".repeat(INHERITED_CONTEXT_CHARS - 20)}`;
		const context = buildInheritedContext([userMessage(line)], obfuscator);
		expect(context!.text.includes(secret) || !context!.text.includes(secret.slice(-20))).toBe(true);
		expect(buildInheritedContext([userMessage(line)], undefined)!.text.startsWith(secret.slice(-20))).toBe(true);
	});

	it("never hands the child a secret whose rule lost its context at the cut", () => {
		const token = "fixture".repeat(4);
		const entries = [{ type: "regex" as const, content: "(?<=\\bBearer )[A-Za-z0-9._~+/=-]{20,}" }];
		const parent = new SecretObfuscator(entries);
		const placeholderChars = parent.obfuscate(`Bearer ${token}`).length - "Bearer ".length;
		// One long line; each suffix size lands the encoded cut inside "Bearer ", which the lookbehind needs.
		for (let into = 1; into <= "Bearer ".length; into++) {
			const suffix = "y".repeat(INHERITED_CONTEXT_CHARS - placeholderChars - into);
			const line = `${"x".repeat(2_000)} Bearer ${token}${suffix}`;
			const context = buildInheritedContext([userMessage(line)], parent);
			expect(new SecretObfuscator(entries).obfuscate(context?.text ?? "")).not.toContain(token);
		}
	});

	it("never hands the child a secret fragment when secrets dominate the recent conversation", () => {
		// Long plain secrets (PEM blocks, credential JSON) encode to short placeholders, so the encoded
		// text is far shorter than the raw text it came from.
		const entries = Array.from({ length: 10 }, (_, i) => ({
			type: "plain" as const,
			content: `secret${i}-${"q".repeat(6_000)}`,
		}));
		const parent = new SecretObfuscator(entries);
		const text = `${"filler line\n".repeat(2_000)}${entries.map(entry => entry.content).join("\n")}\ndone`;
		const context = buildInheritedContext([userMessage(text)], parent);
		const sent = new SecretObfuscator(entries).obfuscate(context?.text ?? "");
		expect(sent).not.toContain("q".repeat(64));
	});

	it("lists no fragment of a secret in the identifier sidecar", () => {
		// The hex pattern stops at each dash, so it would pull runs out of a UUID-shaped secret.
		const secret = ["3f2a9c1e", "4b7d", "4e2a", "9c3f", "8a1b2c3d4e5f"].join("-");
		const parent = new SecretObfuscator([{ type: "plain", content: secret }]);
		const context = buildInheritedContext([userMessage(`api key ${secret} for build ${HASH}`)], parent);
		expect(context!.identifiers).toContain(HASH);
		expect(context!.identifiers.some(token => secret.includes(token) || token.includes("$$"))).toBe(false);
	});

	it("encodes secrets before the serializer truncates or escapes them", () => {
		// A tool result over the serializer's limit keeps a head and a tail; this secret straddles the head cut.
		const cut = ["fixture", "secret", "straddling", "the", "head", "cut", "x"].join("-");
		// Tool-call arguments are JSON-escaped; this plain secret contains a quote and a backslash.
		const escaped = ['pa"ss', "word-fixture-only"].join("\\");
		const entries = [
			{ type: "plain" as const, content: cut },
			{ type: "plain" as const, content: escaped },
		];
		const output = `${"o".repeat(1_185)}${cut}${"p".repeat(4_000)}`;
		const messages = [
			userMessage("run the build"),
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: `login ${escaped}` } }],
				timestamp: 0,
			} as unknown as Message,
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: output }],
				isError: false,
				timestamp: 0,
			} as Message,
		];
		const context = buildInheritedContext(messages, new SecretObfuscator(entries));
		expect(context).toBeDefined();
		const sent = new SecretObfuscator(entries).obfuscate(context!.text);
		expect(sent).not.toContain(cut.slice(0, 15));
		expect(sent).not.toContain(JSON.stringify(escaped).slice(1, -1));
		expect(sent).not.toContain("word-fixture-only");
	});

	it("sends tool output without the rasterizer's dim markers", () => {
		const toolResult = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "a.txt\nb.txt" }],
			isError: false,
			timestamp: 0,
		} as Message;
		const context = buildInheritedContext([userMessage("run it"), toolResult], undefined);
		expect(context!.text).toContain("a.txt\nb.txt");
		expect(context!.text).not.toMatch(/[\u000e\u000f]/);
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

	it("stays text when its frames would push the request past the provider image budget", async () => {
		const model = visionModel(["text", "image"]);
		const built = childContext(context);
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const full: Context = {
			messages: [
				...built.messages,
				{
					role: "user",
					content: Array.from({ length: providerImageBudget(model) }, () => image),
					timestamp: 0,
				} as Message,
			],
		};
		expect(await new InheritedContextFrames().transform(full, model, false)).toBe(full);
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

	it("goes back to text when a later image clamp drops its frames", async () => {
		const frames = new InheritedContextFrames();
		const built = childContext(context);
		const sent = await frames.transform(built, visionModel(["text", "image"]), false);
		const [turn] = sent.messages;
		// What the oldest-first byte clamp leaves of the turn: the preamble and an omission stub.
		const clamped = (turn!.content as { type: string }[]).filter(block => block.type === "text");
		const evicted: Context = { messages: [{ ...turn!, content: clamped } as Message, ...sent.messages.slice(1)] };
		const restored = restoreEvictedFrames(evicted, built, sent);
		expect(restored.messages[0]).toBe(built.messages[0]);
		expect(restored.messages[1]).toBe(evicted.messages[1]);
	});

	it("keeps its frames when no clamp touched them", async () => {
		const built = childContext(context);
		const sent = await new InheritedContextFrames().transform(built, visionModel(["text", "image"]), false);
		expect(restoreEvictedFrames(sent, built, sent)).toBe(sent);
	});
});

describe("inherited frame profile", () => {
	const context = { text: `Build ${HASH} passed.\n`.repeat(40), identifiers: [HASH] };
	const claude = { id: "claude-sonnet-5-5", api: "anthropic-messages", provider: "anthropic" } as const;
	const opus = { id: "claude-opus-4-7", api: "anthropic-messages", provider: "anthropic" } as const;
	const gemini = { id: "gemini-3.8-flash", api: "google-generative-ai", provider: "google" } as const;
	const gpt = { id: "gpt-5.4", api: "openai-responses", provider: "openai" } as const;

	async function sent(target: Pick<Model, "id" | "api" | "provider">, shape: ShapeSetting = "auto") {
		const render = vi.spyOn(snapcompact, "renderMany");
		try {
			const framed = await new InheritedContextFrames().transform(
				childContext(context),
				visionModel(["text", "image"], target),
				false,
				shape,
			);
			const { cellWidth, cellHeight, frameSize } = render.mock.calls[0]![1]!.shape!;
			return { geometry: { cellWidth, cellHeight, frameSize }, sidecar: preambleText(framed).includes(HASH) };
		} finally {
			render.mockRestore();
		}
	}

	it.each([
		["Claude", claude],
		// Not snapcompact's high-res compaction frame.
		["Opus 4.7", opus],
	])("draws %s frames in 8x13-bw at 1568px with the sidecar", async (_, target) => {
		expect(await sent(target)).toEqual({
			geometry: { cellWidth: 8, cellHeight: 13, frameSize: 1568 },
			sidecar: true,
		});
	});

	it("draws Gemini frames in 11on16-bw at 1568px without the sidecar", async () => {
		expect(await sent(gemini)).toEqual({
			geometry: { cellWidth: 11, cellHeight: 16, frameSize: 1568 },
			sidecar: false,
		});
	});

	it("keeps snapcompact's shape and the sidecar for an unmeasured model class", async () => {
		const { cellWidth, cellHeight, frameSize } = snapcompact.resolveShapeForText(
			context.text,
			visionModel(["text", "image"], gpt),
			"auto",
		);
		expect(await sent(gpt)).toEqual({ geometry: { cellWidth, cellHeight, frameSize }, sidecar: true });
	});

	it("keeps auto's CJK grid for text the measured shapes' font cannot draw", async () => {
		const cjk = { text: "检查构建结果并记录每一步的输出。\n".repeat(200), identifiers: [] };
		const render = vi.spyOn(snapcompact, "renderMany");
		try {
			for (const target of [claude, gemini]) {
				await new InheritedContextFrames().transform(
					childContext(cjk),
					visionModel(["text", "image"], target),
					false,
				);
			}
			expect(render.mock.calls.map(call => call[1]!.shape!.font)).toEqual(["silver", "silver"]);
		} finally {
			render.mockRestore();
		}
	});

	it("lets an explicit snapcompact.shape win, sidecar included", async () => {
		for (const target of [claude, gemini]) {
			const { geometry, sidecar } = await sent(target, "8on22-bw");
			expect(geometry).toMatchObject({ cellWidth: 8, cellHeight: 22 });
			expect(sidecar).toBe(true);
		}
	});
});
