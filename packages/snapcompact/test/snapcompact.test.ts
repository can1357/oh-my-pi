import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message, Usage } from "@oh-my-pi/pi-ai";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import * as snapcompact from "../src";

// Small frames keep render time negligible. Legacy 5x8 shape: 320px → 64 cols
// x 40 rows = 2560 chars. Default (anthropic 8x8r-bw): 40 cols x 20 rows = 800.
const TEST_FRAME_SIZE = 320;

function createUserMessage(content: string): Message {
	return { role: "user", content, timestamp: 0 };
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

function createAssistantMessage(content: AssistantMessage["content"]): Message {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

function createToolResultMessage(text: string): Message {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function makePreparation(
	overrides: Partial<snapcompact.CompactionPreparation<Message>> = {},
): snapcompact.CompactionPreparation<Message> {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [
			createUserMessage("Fix the login bug. The token expires too early!"),
			createAssistantMessage([{ type: "text", text: "Fixed the TTL comparison in src/login.ts." }]),
		],
		turnPrefixMessages: [],
		tokensBefore: 99000,
		previousSummary: undefined,
		previousPreserveData: undefined,
		fileOps: snapcompact.createFileOps(),
		...overrides,
	};
}

describe("scanRenderability", () => {
	it("considers pure ASCII text safe", () => {
		const res = snapcompact.scanRenderability("function hello() { return 'world'; }");
		expect(res.isSafe).toBe(true);
		expect(res.unrenderableRatio).toBe(0);
	});

	it("considers Latin-1 text safe", () => {
		const res = snapcompact.scanRenderability("café résumé naïve");
		expect(res.isSafe).toBe(true);
		expect(res.unrenderableRatio).toBe(0);
	});

	it("uses the embedded Silver fallback for CJK text", () => {
		const res = snapcompact.scanRenderability("const a = '你好世界';");
		expect(res.isSafe).toBe(true);
		expect(res.unrenderableRatio).toBe(0);
	});

	it("detects high unrenderable rates when neither bitmap fonts nor Silver cover the text", () => {
		const res = snapcompact.scanRenderability("\u{e000}".repeat(10));
		expect(res.isSafe).toBe(false);
		expect(res.unrenderableRatio).toBe(1);
	});

	it("ignores whitespace, ANSI, and zero-width markers in ratio calculations", () => {
		// \u001b[31m is ANSI.
		// \u000e \u000f are DIM markers.
		const res = snapcompact.scanRenderability("\u001b[31mhello \u000e \u000f \n\t   world\u001b[0m");
		expect(res.isSafe).toBe(true);
		expect(res.unrenderableRatio).toBe(0);
	});
});

describe("computeFileLists", () => {
	it("drops scheme:// URLs from legacy fileOps before rendering <files>", () => {
		const fileOps = snapcompact.createFileOps();
		fileOps.read.add("src/read-only.ts");
		fileOps.read.add("artifact://7");
		fileOps.edited.add("src/edited.ts");
		fileOps.edited.add("conflict://1");
		fileOps.written.add("local://ctx.md");
		expect(snapcompact.computeFileLists(fileOps)).toEqual({
			readFiles: ["src/read-only.ts"],
			modifiedFiles: ["src/edited.ts"],
		});
	});
});

interface DecodedPng {
	width: number;
	height: number;
	colorType: number;
	/** GLOBAL palette indices (mapped back through PLTE), one byte per pixel. */
	pixels: Uint8Array;
}

/** The renderer's fixed global palette (see PALETTE in snapcompact.rs). */
const GLOBAL_PALETTE = [
	[255, 255, 255],
	[109, 2, 2],
	[109, 53, 2],
	[24, 109, 2],
	[2, 109, 109],
	[2, 32, 109],
	[75, 2, 109],
	[0, 0, 0],
	[255, 247, 194],
	[128, 128, 128],
] as const;

/**
 * Minimal PNG reader for the encoder's own output (indexed, filter None,
 * 1/2/4/8-bit). The encoder narrows each frame's palette to the colors it
 * uses, so decoded indices are mapped back to GLOBAL palette slots via PLTE.
 */
function decodePng(png: Uint8Array): DecodedPng {
	expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let pos = 8;
	let width = 0;
	let height = 0;
	let colorType = -1;
	let depth = 0;
	let plte: Uint8Array | undefined;
	const idatParts: Uint8Array[] = [];
	while (pos < png.length) {
		const length = view.getUint32(pos);
		const type = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7]);
		const data = png.subarray(pos + 8, pos + 8 + length);
		if (type === "IHDR") {
			width = view.getUint32(pos + 8);
			height = view.getUint32(pos + 12);
			depth = data[8];
			colorType = data[9];
		} else if (type === "PLTE") {
			plte = data;
		} else if (type === "IDAT") {
			idatParts.push(data);
		}
		pos += 12 + length;
	}
	// Local palette slot -> global palette index, matched by RGB.
	const toGlobal = new Uint8Array(plte ? plte.length / 3 : 0);
	if (plte) {
		for (let i = 0; i < toGlobal.length; i++) {
			const global = GLOBAL_PALETTE.findIndex(
				([r, g, b]) => plte[i * 3] === r && plte[i * 3 + 1] === g && plte[i * 3 + 2] === b,
			);
			expect(global).toBeGreaterThanOrEqual(0);
			toGlobal[i] = global;
		}
	}
	let idatLength = 0;
	for (const part of idatParts) idatLength += part.length;
	const idat = new Uint8Array(idatLength);
	let offset = 0;
	for (const part of idatParts) {
		idat.set(part, offset);
		offset += part.length;
	}
	// Strip the zlib envelope (2-byte header + trailing Adler-32).
	const raw = Bun.inflateSync(idat.subarray(2, idat.length - 4));
	const per = 8 / depth;
	const rowBytes = Math.ceil(width / per);
	expect(raw.length).toBe(height * (rowBytes + 1));
	const mask = (1 << depth) - 1;
	const pixels = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		expect(raw[y * (rowBytes + 1)]).toBe(0); // filter byte: None
		const row = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
		for (let x = 0; x < width; x++) {
			const byte = row[Math.floor(x / per)];
			const shift = depth * (per - 1 - (x % per));
			const local = (byte >> shift) & mask;
			pixels[y * width + x] = colorType === 3 ? toGlobal[local] : local;
		}
	}
	return { width, height, colorType, pixels };
}

describe("normalize", () => {
	it("collapses horizontal whitespace and folds non-Latin-1 to ASCII", () => {
		expect(snapcompact.normalize("a \t b   c")).toBe("a b c");
		expect(snapcompact.normalize("x → y ✓ “quoted” — em…")).toBe(`x -> y v "quoted" - em...`);
		expect(snapcompact.normalize("café größe")).toBe("café größe"); // Latin-1 has glyphs
		expect(snapcompact.normalize("box │─┌ emoji 🎞")).toBe("box |-+ emoji");
	});

	it("folds newline runs to one full-block glyph, trimming the edges", () => {
		expect(snapcompact.normalize("a\n\n\tb   c\r\nd")).toBe(
			`a${snapcompact.NEWLINE_GLYPH}b c${snapcompact.NEWLINE_GLYPH}d`,
		);
		expect(snapcompact.normalize("\n\nbody\n")).toBe("body");
		expect(snapcompact.normalize("  \n\t  ")).toBe("");
	});

	it("skips characters it cannot render instead of printing ?", () => {
		// Whole ANSI sequences vanish, not just the ESC byte.
		expect(snapcompact.normalize("\u001b[31mred\u001b[0m plain")).toBe("red plain");
		// Bare controls, zero-width format chars, and combining marks drop out.
		expect(snapcompact.normalize("a\u0000b\u0007c\u200bd\ufeffe\u0301f")).toBe("abcdef");
		// Zero-width dim ink toggles survive untouched.
		expect(snapcompact.normalize(`x ${snapcompact.DIM_ON}y${snapcompact.DIM_OFF} z`)).toBe(
			`x ${snapcompact.DIM_ON}y${snapcompact.DIM_OFF} z`,
		);
	});

	it("preserves Silver-supported kana and Hangul for bitmap font fallback", () => {
		expect(snapcompact.normalize("こんにちは")).toBe("こんにちは");
		expect(snapcompact.normalize("カタカナ")).toBe("カタカナ");
		expect(snapcompact.normalize("안녕하세요")).toBe("안녕하세요");
	});

	it("folds semantic emoji and drops decorative emoji", () => {
		expect(snapcompact.normalize("✅ pass ⚠️ warn ❌ fail 😄")).toBe("[OK] pass [WARN] warn [FAIL] fail");
		expect(snapcompact.normalize("✗ ✘")).toBe("x x");
	});

	it("folds compatibility characters to their ASCII skeleton via NFKD", () => {
		expect(snapcompact.normalize("x⁵")).toBe("x5"); // superscript outside Latin-1
		expect(snapcompact.normalize("ＨＥＬＬＯ")).toBe("HELLO"); // fullwidth forms
		expect(snapcompact.normalize("ﬁle")).toBe("file"); // fi ligature
		expect(snapcompact.normalize("step ① then ②")).toBe("step 1 then 2"); // circled digits
		expect(snapcompact.normalize("section Ⅻ")).toBe("section XII"); // roman numeral
		expect(snapcompact.normalize("⅓ cup")).toBe("1/3 cup"); // vulgar fraction
		expect(snapcompact.normalize("𝐇𝐞𝐥𝐥𝐨")).toBe("Hello"); // math-styled alphanumerics
		expect(snapcompact.normalize("™ ‹q› ′ ″ ⇐ ↑")).toBe(`TM <q> ' " <= ^`);
		// Emoji drops, while characters missing from both selected font and Silver fall back to ?.
		expect(snapcompact.normalize("emoji 🎞 \u{e000}")).toBe("emoji ?");
	});
});

describe("shape resolution", () => {
	it("maps provider APIs to their eval-winning shapes", () => {
		expect(snapcompact.resolveShape({ api: "anthropic-messages" })).toBe(snapcompact.SHAPES.anthropic);
		expect(snapcompact.resolveShape({ api: "openai-responses" })).toBe(snapcompact.SHAPES.openai);
		expect(snapcompact.resolveShape({ api: "azure-openai-responses" })).toBe(snapcompact.SHAPES.openai);
		expect(snapcompact.resolveShape({ api: "google-generative-ai" })).toBe(snapcompact.SHAPES.google);
		// Unknown and absent APIs fall back to the unknown family default (8on22-bw with Anthropic token billing).
		const unknownFallback = snapcompact.resolveShape({ api: "some-future-api" });
		expect(unknownFallback.cellHeight).toBe(22);
		expect(unknownFallback.variant).toBe("bw");
		expect(snapcompact.resolveShape(undefined)).toEqual(unknownFallback);
	});

	it("detects the ideal shape from the model id across gateways", () => {
		// A high-res Claude served through an OpenAI-compatible gateway keeps
		// its own geometry (tracked 8x13) AND its 1932px frame; billing follows
		// the gateway family, computed for that frame size (32px patches × 1.2).
		const claudeViaOpenRouter = snapcompact.resolveShape({
			api: "openai-completions",
			id: "anthropic/claude-fable-5",
		});
		expect(claudeViaOpenRouter.font).toBe("8x13");
		expect(claudeViaOpenRouter.cellWidth).toBe(11); // extra tracking
		expect(claudeViaOpenRouter.frameSize).toBe(1932);
		expect(claudeViaOpenRouter.frameTokenEstimate).toBe(Math.ceil(Math.ceil(1932 / 32) ** 2 * 1.2));
		expect(claudeViaOpenRouter.imageDetail).toBe("original");

		// Claude on Vertex must not inherit the Gemini shape; Gemini billing is
		// a fixed per-image budget at any size.
		const claudeOnVertex = snapcompact.resolveShape({ api: "google-vertex", id: "claude-fable-5@20250929" });
		expect(claudeOnVertex.font).toBe("8x13");
		expect(claudeOnVertex.cellWidth).toBe(11);
		expect(claudeOnVertex.frameSize).toBe(1932);
		expect(claudeOnVertex.frameTokenEstimate).toBe(snapcompact.SHAPES.google.frameTokenEstimate);

		// High-res frames are reserved for the lines that read them natively;
		// older Claude lines keep the safe 1568px family default.
		expect(snapcompact.resolveShape({ api: "anthropic-messages", id: "claude-opus-4-8" }).frameSize).toBe(1932);
		expect(snapcompact.resolveShape({ api: "anthropic-messages", id: "anthropic--claude-4.8-opus" }).frameSize).toBe(
			1932,
		);
		expect(snapcompact.resolveShape({ api: "anthropic-messages", id: "claude-opus-4-10" }).frameSize).toBe(1932);
		// Versionless Fable/Mythos aliases (bundled `claude-fable-latest`) never
		// parse a numeric version but still read the high-res tier by name (#8257).
		expect(
			snapcompact.resolveShape({ api: "openai-completions", id: "anthropic/claude-fable-latest" }).frameSize,
		).toBe(1932);
		expect(
			snapcompact.resolveShape({ api: "openai-completions", id: "~anthropic/claude-fable-latest" }).frameSize,
		).toBe(1932);
		// Opus 5+ shares the Anthropic visual-token cap, so it stays on the
		// high-res tier rather than falling back to the 1568px default (#8256).
		expect(snapcompact.resolveShape({ api: "anthropic-messages", id: "claude-opus-5" }).frameSize).toBe(1932);
		expect(snapcompact.resolveShape({ api: "anthropic-messages", id: "claude-opus-6" }).frameSize).toBe(1932);
		// Mixed-case gateway ids matched the pre-catalog-parser /i regex; the
		// parser input is normalized so they stay on the high-res tier.
		expect(snapcompact.resolveShape({ api: "anthropic-messages", id: "CLAUDE-OPUS-5" }).frameSize).toBe(1932);
		// Minor versions past the old 9.10 semver-table bound must not fall
		// back to the 1568px default (same staleness class as #8256).
		expect(snapcompact.resolveShape({ api: "anthropic-messages", id: "claude-opus-5-11" }).frameSize).toBe(1932);
		// Opus lines below 4.7 downscale, so they keep the safe family default.
		expect(snapcompact.resolveShape({ api: "anthropic-messages", id: "claude-opus-4-6" })).toBe(
			snapcompact.SHAPES.anthropic,
		);
		expect(snapcompact.resolveShape({ api: "anthropic-messages", id: "claude-3-5-sonnet" })).toBe(
			snapcompact.SHAPES.anthropic,
		);

		// Gemini reads 2048px frames at the same fixed bill, single-column with
		// extra leading (22px pitch).
		const gemini = snapcompact.resolveShape({ api: "google-generative-ai", id: "gemini-3.5-flash" });
		expect(gemini.frameSize).toBe(2048);
		expect(gemini.columns).toBeUndefined();
		expect(gemini.cellHeight).toBe(22); // extra leading
		expect(gemini.frameTokenEstimate).toBe(1120);

		// Kimi models resolve to 8on22-bw; GLM keeps 8on16-bw.
		const kimiShape = snapcompact.resolveShape({ api: "openai-completions" }, "8on22-bw");
		const glmShape = snapcompact.resolveShape({ api: "openai-completions" }, "8on16-bw");
		expect(snapcompact.resolveShape({ api: "openai-completions", id: "moonshotai/kimi-k2.6" })).toEqual(kimiShape);
		expect(snapcompact.resolveShape({ api: "openai-completions", id: "z-ai/glm-4.6v" })).toEqual(glmShape);

		// Unmeasured model ids fall back to the API family default object.
		expect(snapcompact.resolveShape({ api: "openai-completions", id: "qwen/qwen3-vl" })).toBe(
			snapcompact.SHAPES.openai,
		);
		expect(snapcompact.idealShapeVariant("qwen/qwen3-vl")).toBeUndefined();

		// An explicit variant wins over identity detection, at the variant's
		// own research frame size.
		const forced = snapcompact.resolveShape({ api: "anthropic-messages", id: "claude-fable-5" }, "8x8r-bw");
		expect(forced.lineRepeat).toBe(2);
		expect(forced.frameSize).toBe(1568);
	});

	it("forces a named variant and re-prices it for the provider's billing", () => {
		// "auto" behaves exactly like no override.
		expect(snapcompact.resolveShape({ api: "anthropic-messages" }, "auto")).toBe(snapcompact.SHAPES.anthropic);

		// Forced geometry survives; billing follows the provider, not the variant.
		const denseOnAnthropic = snapcompact.resolveShape({ api: "anthropic-messages" }, "6x6u-sent");
		expect(denseOnAnthropic.cellWidth).toBe(6);
		expect(denseOnAnthropic.variant).toBe("sent");
		expect(denseOnAnthropic.frameTokenEstimate).toBe(snapcompact.SHAPES.anthropic.frameTokenEstimate);
		expect(denseOnAnthropic.imageDetail).toBeUndefined();

		const repeatedOnOpenai = snapcompact.resolveShape({ api: "openai-responses" }, "8x8r-bw");
		expect(repeatedOnOpenai.lineRepeat).toBe(2);
		expect(repeatedOnOpenai.frameTokenEstimate).toBe(snapcompact.SHAPES.openai.frameTokenEstimate);
		expect(repeatedOnOpenai.imageDetail).toBe("original");

		// Billing is computed for the variant's own frame size: the legacy
		// 2576px frame caps out Anthropic's visual-token budget but stays at
		// Gemini's fixed per-image price.
		const legacyOnGoogle = snapcompact.resolveShape({ api: "google-generative-ai" }, "5x8-bw");
		expect(legacyOnGoogle.frameSize).toBe(2576);
		expect(legacyOnGoogle.frameTokenEstimate).toBe(snapcompact.SHAPES.google.frameTokenEstimate);
		const legacyOnAnthropic = snapcompact.resolveShape({ api: "anthropic-messages" }, "5x8-bw");
		expect(legacyOnAnthropic.frameTokenEstimate).toBe(Math.ceil(4784 * 1.05));
	});

	it("every catalog variant resolves to a complete, renderable shape", () => {
		for (const name of snapcompact.SHAPE_VARIANT_NAMES) {
			expect(snapcompact.isShapeVariantName(name)).toBe(true);
			expect(snapcompact.isShape(snapcompact.resolveShape({ api: "openai-responses" }, name))).toBe(true);
			expect(snapcompact.isShape(snapcompact.resolveShape(undefined, name))).toBe(true);
		}
		expect(snapcompact.isShapeVariantName("auto")).toBe(false);
		expect(snapcompact.isShapeVariantName("6x10-sent")).toBe(false);
	});

	it("recognizes complete shape overrides and rejects malformed ones", () => {
		expect(snapcompact.isShape(snapcompact.SHAPES.openai)).toBe(true);
		expect(snapcompact.isShape({ ...snapcompact.SHAPES.openai, cellWidth: 0 })).toBe(false);
		expect(snapcompact.isShape({ ...snapcompact.SHAPES.openai, variant: "color" })).toBe(false);
		expect(snapcompact.isShape({ ...snapcompact.SHAPES.openai, imageDetail: "original" })).toBe(true);
	});

	it("keeps bitmap shapes render-safe via Silver fallback while CJK-heavy auto archives use Silver", () => {
		const cjkHeavyText = "こんにちは 你好 안녕 世界 한국어";
		const silver = snapcompact.resolveShape({ api: "anthropic-messages" }, "silver16-bw");

		expect(snapcompact.scanRenderability(cjkHeavyText).isSafe).toBe(true);
		expect(snapcompact.scanRenderability(cjkHeavyText, { shape: silver }).isSafe).toBe(true);
		expect(snapcompact.normalize(cjkHeavyText)).toBe(cjkHeavyText);
		expect(snapcompact.normalize(cjkHeavyText, { shape: silver })).toBe(cjkHeavyText);
		expect(snapcompact.resolveShapeForText(cjkHeavyText, { api: "anthropic-messages" }, "auto")).toEqual(silver);
	});

	it("keeps ASCII-heavy auto archives on the provider/model shape", () => {
		const model = { api: "openai-responses" as const, id: "gpt-5.5" };
		const expected = snapcompact.resolveShape(model, "auto");
		const actual = snapcompact.resolveShapeForText(
			"function render(value: string) { return value.trim().toLowerCase(); }",
			model,
			"auto",
		);

		expect(actual).toEqual(expected);
		expect(actual.font).not.toBe("silver");
	});

	it("respects explicit non-auto variants even for CJK-heavy text", () => {
		const model = { api: "anthropic-messages" as const };
		const expected = snapcompact.resolveShape(model, "8on16-bw");
		const actual = snapcompact.resolveShapeForText("こんにちは 你好 안녕 世界 한국어", model, "8on16-bw");

		expect(actual).toEqual(expected);
		expect(actual.font).not.toBe("silver");
	});

	it("reports unsupported CJK ideographs unsafe even with the Silver shape selected", () => {
		const silver = snapcompact.resolveShape(undefined, "silver16-bw");
		const res = snapcompact.scanRenderability("\u{31350}".repeat(12), { shape: silver });

		expect(res.isSafe).toBe(false);
		expect(res.unrenderableRatio).toBe(1);
	});

	it("images forwards the per-frame detail hint", () => {
		const archive: snapcompact.Archive = {
			frames: [
				{ data: "ZmFrZQ==", mimeType: "image/png", cols: 10, rows: 10, chars: 5, detail: "original" },
				{ data: "ZmFrZTI=", mimeType: "image/png", cols: 10, rows: 10, chars: 5 },
			],
			totalChars: 10,
			truncatedChars: 0,
		};
		const [withDetail, without] = snapcompact.images(archive);
		expect(withDetail.detail).toBe("original");
		expect("detail" in without).toBe(false);
	});
});

describe("render", () => {
	it("produces an indexed PNG of the declared geometry with sentence-cycled ink (legacy 5x8)", async () => {
		const geometry = snapcompact.geometry(snapcompact.SHAPES.legacy, TEST_FRAME_SIZE);
		expect(geometry).toEqual({ cols: 64, rows: 40, capacity: 2560 });

		const frame = await snapcompact.render(
			"First sentence here. Second one differs.",
			snapcompact.SHAPES.legacy,
			TEST_FRAME_SIZE,
		);
		expect(frame.cols).toBe(64);
		expect(frame.rows).toBe(40);
		expect(frame.chars).toBe(40);

		const decoded = decodePng(Buffer.from(frame.data, "base64"));
		expect(decoded.width).toBe(TEST_FRAME_SIZE);
		// 40 chars on a 64-col grid: one 8px text row; height hugs it instead
		// of padding the frame to a 320px square.
		expect(decoded.height).toBe(8);
		expect(decoded.colorType).toBe(3); // indexed color

		// Two sentences → glyphs printed in ink 1 then ink 2; background stays 0.
		const used = new Set(decoded.pixels);
		expect(used.has(1)).toBe(true);
		expect(used.has(2)).toBe(true);
		expect(used.has(3)).toBe(false);
	});

	it("renders the repeated grid with doubled lines, black ink, and highlight bands", async () => {
		const repeated = snapcompact.resolveShape({ api: "anthropic-messages" }, "8x8r-bw");
		const geometry = snapcompact.geometry(repeated, TEST_FRAME_SIZE);
		expect(geometry).toEqual({ cols: 40, rows: 20, capacity: 800 });

		const frame = await snapcompact.render("Hello world. Again.", repeated, TEST_FRAME_SIZE);
		const decoded = decodePng(Buffer.from(frame.data, "base64"));
		expect(decoded.colorType).toBe(3);
		const used = new Set(decoded.pixels);
		expect(used.has(7)).toBe(true); // black bw ink
		expect(used.has(8)).toBe(true); // repeat highlight band
		expect(used.has(1)).toBe(false); // no sentence hues in bw
	});

	it("renders the anthropic default (tracked 8x13) in plain black, no dim or bands", async () => {
		const geometry = snapcompact.geometry(snapcompact.SHAPES.anthropic, TEST_FRAME_SIZE);
		expect(geometry).toEqual({ cols: 29, rows: 20, capacity: 580 });

		const frames = await snapcompact.renderMany("Reading the films of the archive. Again.", {
			shape: snapcompact.SHAPES.anthropic,
			frameSize: TEST_FRAME_SIZE,
		});
		const decoded = decodePng(Buffer.from(frames[0].data, "base64"));
		expect(decoded.colorType).toBe(3);
		const used = new Set(decoded.pixels);
		expect(used.has(7)).toBe(true); // black ink for all words
		expect(used.has(9)).toBe(false); // tracked default does not dim stopwords
		expect(used.has(8)).toBe(false); // no repeat highlight band
		expect(used.has(1)).toBe(false); // no sentence hues
	});

	it("still dims stopwords on the selectable 6x12-dim variant", async () => {
		const dim = snapcompact.resolveShape({ api: "anthropic-messages" }, "6x12-dim");
		const frames = await snapcompact.renderMany("Reading the films of the archive. Again.", {
			shape: dim,
			frameSize: TEST_FRAME_SIZE,
		});
		const used = new Set(decodePng(Buffer.from(frames[0].data, "base64")).pixels);
		expect(used.has(7)).toBe(true); // black ink for content words
		expect(used.has(9)).toBe(true); // dim gray ink for stopwords ("the", "of")
	});

	it("renders a stretched shape as truecolor RGB", async () => {
		const stretched = snapcompact.resolveShape({ api: "openai-responses" }, "6x6u-sent");
		const frame = await snapcompact.render("Hello world.", stretched, TEST_FRAME_SIZE);
		// IHDR color type byte: 2 = truecolor RGB (anti-aliased stretch output).
		expect(Buffer.from(frame.data, "base64")[25]).toBe(2);
		expect(frame.cols).toBe(Math.floor(TEST_FRAME_SIZE / 6));
	});

	it("renders Silver TrueType Unicode text as truecolor RGB", async () => {
		const silver = snapcompact.resolveShape(undefined, "silver16-bw");
		const frame = await snapcompact.render("你好안녕", silver, 64);
		const png = Buffer.from(frame.data, "base64");
		expect(png[25]).toBe(2);
		expect(png.readUInt32BE(16)).toBe(64);
		expect(png.readUInt32BE(20)).toBe(16);
		expect(frame.cols).toBe(4);
		expect(frame.chars).toBe(4);
	});

	it("renders a Silver fallback glyph across two cells in a bitmap frame", async () => {
		const bitmap = snapcompact.resolveShape(undefined, "8on16-bw"); // 8px-wide cells at 64px → cols 8
		const frame = await snapcompact.render("你", bitmap, 64);
		const decoded = decodePng(Buffer.from(frame.data, "base64"));
		expect(decoded.colorType).toBe(3);
		expect(frame.chars).toBe(1);
		// The wide glyph fills the full two-cell (16px) span, not a single 8px cell.
		let inkBeyondFirstCell = false;
		for (let y = 0; y < decoded.height; y++) {
			for (let x = 8; x < 16; x++) {
				if (decoded.pixels[y * decoded.width + x] === 7) inkBeyondFirstCell = true;
			}
		}
		expect(inkBeyondFirstCell).toBe(true);
	});

	it("caps printed characters at frame capacity", async () => {
		const { capacity } = snapcompact.geometry(snapcompact.SHAPES.legacy, TEST_FRAME_SIZE);
		const frame = await snapcompact.render("x".repeat(capacity + 500), snapcompact.SHAPES.legacy, TEST_FRAME_SIZE);
		expect(frame.chars).toBe(capacity);
	});

	it("fills a full pitch-black cell for the newline glyph", async () => {
		// Legacy 5x8 cells: the glyph at row 0, col 1 spans x 5..10, y 0..8.
		const frame = await snapcompact.render(
			`a${snapcompact.NEWLINE_GLYPH}b`,
			snapcompact.SHAPES.legacy,
			TEST_FRAME_SIZE,
		);
		expect(frame.chars).toBe(3); // the block occupies exactly one cell
		const decoded = decodePng(Buffer.from(frame.data, "base64"));
		for (let y = 0; y < 8; y++) {
			for (let x = 5; x < 10; x++) {
				// Pitch-black ink (palette 7), even in the sentence-hue variant.
				expect(decoded.pixels[y * decoded.width + x]).toBe(7);
			}
		}
	});
});

describe("renderMany", () => {
	it("returns no frames for empty or whitespace-only input", async () => {
		expect(
			await snapcompact.renderMany("", { shape: snapcompact.SHAPES.anthropic, frameSize: TEST_FRAME_SIZE }),
		).toEqual([]);
		expect(
			await snapcompact.renderMany("  \n\t  ", { shape: snapcompact.SHAPES.anthropic, frameSize: TEST_FRAME_SIZE }),
		).toEqual([]);
		expect(snapcompact.frames("", { shape: snapcompact.SHAPES.anthropic, frameSize: TEST_FRAME_SIZE })).toBe(0);
	});

	it("pages text into image blocks matching the predicted frame count", async () => {
		const shape = snapcompact.SHAPES.anthropic;
		const { capacity } = snapcompact.geometry(shape, TEST_FRAME_SIZE);

		const short = await snapcompact.renderMany("hello world", { shape, frameSize: TEST_FRAME_SIZE });
		expect(short).toHaveLength(1);
		expect(short[0].type).toBe("image");
		expect(short[0].mimeType).toBe("image/png");

		const text = "x".repeat(capacity * 2 + 10);
		const frames = await snapcompact.renderMany(text, { shape, frameSize: TEST_FRAME_SIZE });
		expect(frames).toHaveLength(3);
		expect(snapcompact.frames(text, { shape, frameSize: TEST_FRAME_SIZE })).toBe(3);
	});

	it("counts wide CJK as two grid cells in bitmap shapes and one in Silver", () => {
		const bitmap = snapcompact.resolveShape(undefined, "8on16-bw"); // cols 8 (even) at 64px
		const cap = snapcompact.geometry(bitmap, 64).capacity;
		// Wide glyphs take two cells, so half a frame's worth of cells fits as chars.
		expect(snapcompact.frames("你".repeat(cap / 2), { shape: bitmap, frameSize: 64 })).toBe(1);
		expect(snapcompact.frames("你".repeat(cap / 2 + 1), { shape: bitmap, frameSize: 64 })).toBe(2);
		// ASCII stays one cell per char on the same shape.
		expect(snapcompact.frames("a".repeat(cap), { shape: bitmap, frameSize: 64 })).toBe(1);
		// The square-celled Silver shape draws CJK one cell each (no doubling).
		const silver = snapcompact.resolveShape(undefined, "silver16-bw");
		const silverCap = snapcompact.geometry(silver, 64).capacity;
		expect(snapcompact.frames("你".repeat(silverCap), { shape: silver, frameSize: 64 })).toBe(1);
	});

	it("honors maxFrames and propagates the shape's detail hint", async () => {
		const shape = snapcompact.SHAPES.openai;
		const { capacity } = snapcompact.geometry(shape, TEST_FRAME_SIZE);
		const frames = await snapcompact.renderMany("x".repeat(capacity * 3), {
			shape,
			frameSize: TEST_FRAME_SIZE,
			maxFrames: 2,
		});
		expect(frames).toHaveLength(2);
		// The openai shape carries imageDetail: "original"; anthropic carries none.
		expect(frames[0].detail).toBe("original");
		const bw = await snapcompact.renderMany("hi", {
			shape: snapcompact.SHAPES.anthropic,
			frameSize: TEST_FRAME_SIZE,
		});
		expect(bw[0].detail).toBeUndefined();
	});
});

describe("serializeConversation", () => {
	it("truncates oversized tool results keeping head and tail", () => {
		const text = `HEAD-${"x".repeat(5000)}-TAIL`;
		const out = snapcompact.serializeConversation([createToolResultMessage(text)]);
		// Default cap 2000 at 0.6 head ratio: 1200 head + 800 tail survive.
		expect(out).toContain("<out>");
		expect(out).toContain("HEAD-");
		expect(out).toContain("[…3010ch elided…]");
		expect(out.endsWith(`-TAIL${snapcompact.DIM_OFF}\n</out>`)).toBe(true);
	});

	it("honors configured budgets; Infinity disables a cap", () => {
		const text = "a".repeat(100);
		const tight = snapcompact.serializeConversation([createToolResultMessage(text)], {
			toolResultMaxChars: 10,
			truncateHeadRatio: 0.5,
		});
		expect(tight).toContain("[…90ch elided…]");
		const off = snapcompact.serializeConversation([createToolResultMessage(text)], {
			toolResultMaxChars: Number.POSITIVE_INFINITY,
		});
		expect(off).toContain(text);
	});

	it("caps oversized tool-call argument values without touching small ones", () => {
		const out = snapcompact.serializeConversation([
			createAssistantMessage([
				{ type: "toolCall", id: "c1", name: "write", arguments: { path: "a.ts", content: "y".repeat(3000) } },
			]),
		]);
		// JSON-encoded content is 3002 chars; per-value cap 500 elides 2502.
		expect(out).toContain('write(path="a.ts", content=');
		expect(out).toContain("[…2502ch elided…]");
	});

	it("caps the whole serialized argument list per call", () => {
		const args: Record<string, unknown> = {};
		for (let i = 0; i < 10; i++) args[`arg${i}`] = "z".repeat(400);
		const out = snapcompact.serializeConversation([
			createAssistantMessage([{ type: "toolCall", id: "c1", name: "tool", arguments: args }]),
		]);
		expect(out).toContain("arg0=");
		expect(out).toContain("ch elided");
		// 10 values x ~400 chars collapse to the 2000-char call budget plus markers.
		expect(out.length).toBeLessThan(2200);
	});

	it("renders roles with compact inline headings", () => {
		const out = snapcompact.serializeConversation([
			createUserMessage("do the thing"),
			createAssistantMessage([{ type: "text", text: "done" }]),
		]);
		expect(out).toBe("¶user:do the thing\n\n¶ai:done");
	});

	it("merges a tool call with its paired result into one block, intent as a // comment", () => {
		const out = snapcompact.serializeConversation(
			[
				createAssistantMessage([
					{
						type: "toolCall",
						id: "c1",
						name: "bash",
						arguments: { [INTENT_FIELD]: "Running tests", command: "bun test" },
					},
				]),
				{ ...createToolResultMessage("3 pass"), toolCallId: "c1" } as Message,
			],
			{ dimToolResults: false },
		);
		expect(out).toBe('¶call:bash(command="bun test")//Running tests\n<out>\n3 pass\n</out>');
	});

	it("prefers the harness-derived intent over the raw intent arg and squashes newlines", () => {
		const out = snapcompact.serializeConversation([
			createAssistantMessage([
				{
					type: "toolCall",
					id: "c1",
					name: "bash",
					arguments: { [INTENT_FIELD]: "raw arg", command: "ls" },
					intent: "Derived\nintent  line",
				},
			]),
		]);
		expect(out).toContain("//Derived intent line");
		expect(out).not.toContain("raw arg");
		expect(out).not.toContain(`${INTENT_FIELD}=`);
	});

	it("folds thinking into separate sections above the text", () => {
		const out = snapcompact.serializeConversation([
			createAssistantMessage([
				{ type: "thinking", thinking: "weigh options" },
				{ type: "text", text: "the answer" },
			]),
		]);
		expect(out).toBe("¶think:weigh options\n\n¶ai:the answer");
	});

	it("drops ¶think reasoning sections when includeThinking is false but keeps the reply", () => {
		const out = snapcompact.serializeConversation(
			[
				createAssistantMessage([
					{ type: "thinking", thinking: "private chain of thought" },
					{ type: "text", text: "the answer" },
				]),
			],
			{ includeThinking: false },
		);
		expect(out).not.toContain("¶think:");
		expect(out).not.toContain("private chain of thought");
		expect(out).toBe("¶ai:the answer");
	});

	it("gives a thinking-only turn its own heading before the tool calls", () => {
		const out = snapcompact.serializeConversation([
			createAssistantMessage([
				{ type: "thinking", thinking: "plan first" },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
			]),
		]);
		expect(out).toBe('¶think:plan first\n\n¶call:read(path="a.ts")');
	});

	it("renders an orphan tool result (call outside the window) standalone", () => {
		const out = snapcompact.serializeConversation([createToolResultMessage("ok")], { dimToolResults: false });
		expect(out).toBe("¶call:\n<out>\nok\n</out>");
	});

	it("preserves content order: text before and after a tool call stay split around it", () => {
		const out = snapcompact.serializeConversation(
			[
				createAssistantMessage([
					{ type: "text", text: "before" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
					{ type: "text", text: "after" },
				]),
				{ ...createToolResultMessage("file body"), toolCallId: "c1" } as Message,
			],
			{ dimToolResults: false },
		);
		expect(out).toBe('¶ai:before\n\n¶call:read(path="a.ts")\n<out>\nfile body\n</out>\n\n¶ai:after');
	});

	it("does not split assistant prose around a useless tool call", () => {
		const out = snapcompact.serializeConversation([
			createAssistantMessage([
				{ type: "text", text: "before" },
				{ type: "toolCall", id: "c-drop", name: "search", arguments: { pattern: "zzz" } },
				{ type: "text", text: "after" },
			]),
			{ ...createToolResultMessage("No matches found"), toolCallId: "c-drop", useless: true } as Message,
		]);
		// The useless call vanishes and its surrounding prose stays in one block.
		expect(out).toBe("¶ai:before\nafter");
	});

	it("drops blank text/thinking blocks instead of emitting an empty assistant heading", () => {
		const out = snapcompact.serializeConversation(
			[
				createAssistantMessage([
					{ type: "thinking", thinking: "   " },
					{ type: "text", text: "" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
				]),
				{ ...createToolResultMessage("body"), toolCallId: "c1" } as Message,
			],
			{ dimToolResults: false },
		);
		expect(out).toBe('¶call:read(path="a.ts")\n<out>\nbody\n</out>');
		expect(out).not.toContain("¶ai:");
	});

	it("wraps tool-result bodies in dim toggles by default and strips stray toggles from content", () => {
		const out = snapcompact.serializeConversation([
			createUserMessage(`hello ${snapcompact.DIM_ON}world`),
			createToolResultMessage("ok"),
		]);
		expect(out).toContain(`<out>\n${snapcompact.DIM_ON}ok${snapcompact.DIM_OFF}\n</out>`);
		// A stray toggle in user content cannot forge a dim span.
		expect(out).toContain("¶user:hello world");
	});

	it("skips tool call/result pairs flagged useless", () => {
		const out = snapcompact.serializeConversation([
			createAssistantMessage([
				{ type: "toolCall", id: "c-keep", name: "search", arguments: { pattern: "alpha" } },
				{ type: "toolCall", id: "c-drop", name: "search", arguments: { pattern: "zzz_nothing" } },
			]),
			{ ...createToolResultMessage("alpha match found"), toolCallId: "c-keep" } as Message,
			{ ...createToolResultMessage("No matches found"), toolCallId: "c-drop", useless: true } as Message,
		]);
		expect(out).toContain('pattern="alpha"');
		expect(out).toContain("alpha match found");
		expect(out).not.toContain("zzz_nothing");
		expect(out).not.toContain("No matches found");
	});

	it("merges consecutive blocks of the same role", () => {
		const out = snapcompact.serializeConversation([
			createUserMessage("hello"),
			createUserMessage("world"),
			createAssistantMessage([{ type: "text", text: "hi" }]),
			createAssistantMessage([{ type: "text", text: "there" }]),
		]);
		expect(out).toBe("¶user:hello\nworld\n\n¶ai:hi\nthere");
	});

	it("merges consecutive tool calls under a single prefix", () => {
		const out = snapcompact.serializeConversation([
			createAssistantMessage([
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "c2", name: "read", arguments: { path: "b.ts" } },
			]),
		]);
		expect(out).toBe('¶call:read(path="a.ts")\nread(path="b.ts")');
	});
});

describe("compact", () => {
	it("stores small archives as plain text with no frames", async () => {
		const fileOps = snapcompact.createFileOps();
		fileOps.read.add("src/auth.ts");
		fileOps.edited.add("src/login.ts");
		const result = await snapcompact.compact(makePreparation({ fileOps }), { frameSize: TEST_FRAME_SIZE });

		expect(result.summary).toContain("HISTORY");
		expect(result.summary).toContain("`¶user:`");
		expect(result.summary).toContain("`¶call:`");
		expect(result.summary).toContain("`¶call:name(args)//intent`");
		expect(result.summary).toContain("FILES\n===================\n# src/\nauth.ts (Read)\nlogin.ts (Write)");

		const archive = snapcompact.getPreservedArchive(result.preserveData);
		expect(archive?.frames).toHaveLength(0);
		expect(archive?.textTail).toBeUndefined();
		expect(archive?.truncatedChars).toBe(0);

		const blocks = archive ? snapcompact.historyBlocks(archive) : [];
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.type).toBe("text");
	});

	it("carries dim tool-output spans from text into the first image frame", async () => {
		const result = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [createUserMessage("Run the suite."), createToolResultMessage("FAIL ".repeat(330))],
			}),
			{ frameSize: TEST_FRAME_SIZE, maxFrames: 2 },
		);
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		expect(archive?.frames.length).toBeGreaterThanOrEqual(1);
		const decoded = decodePng(Buffer.from(archive?.frames[0].data ?? "", "base64"));
		// Palette index 9 is the dim tool-output ink.
		expect(new Set(decoded.pixels).has(9)).toBe(true);
	});

	it("keeps image frames free of dim ink when dimToolResults is false", async () => {
		const result = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [createUserMessage("Run."), createToolResultMessage("all good ".repeat(200))],
			}),
			{ frameSize: TEST_FRAME_SIZE, maxFrames: 2, dimToolResults: false },
		);
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		expect(archive?.frames.length).toBeGreaterThanOrEqual(1);
		const decoded = decodePng(Buffer.from(archive?.frames[0].data ?? "", "base64"));
		expect(new Set(decoded.pixels).has(9)).toBe(false);
	});

	it("keeps plain text at both edges and images in the middle", async () => {
		const longText = `HEAD sentinel AA. ${"Important fact number one. ".repeat(400)}TAIL sentinel QQZZ.`;
		const result = await snapcompact.compact(
			makePreparation({ messagesToSummarize: [createUserMessage(longText)] }),
			{ frameSize: TEST_FRAME_SIZE, maxFrames: 5 },
		);
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		expect(archive?.frames).toHaveLength(5);
		expect(archive?.textHead).toContain("HEAD sentinel AA");
		expect(archive?.textTail).toContain("TAIL sentinel QQZZ");

		const blocks = archive ? snapcompact.historyBlocks(archive) : [];
		expect(blocks[0]?.type).toBe("text");
		expect((blocks[0] as { text: string }).text).toContain("imaged middle below");
		expect(blocks.at(-1)?.type).toBe("text");
		expect((blocks.at(-1) as { text: string }).text).toContain("imaged middle above");
		expect(blocks.filter(block => block.type === "image")).toHaveLength(5);
	});

	it("uses three HQ image frames on each edge when the budget allows", async () => {
		const hugeText = `HEAD sentinel. ${"Important fact number one. ".repeat(1000)}TAIL sentinel.`;
		const result = await snapcompact.compact(
			makePreparation({ messagesToSummarize: [createUserMessage(hugeText)] }),
			{ model: { api: "anthropic-messages" }, frameSize: TEST_FRAME_SIZE, maxFrames: 7 },
		);
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		expect(archive?.frames).toHaveLength(7);
		const hiCols = snapcompact.geometry(snapcompact.SHAPES.anthropic, TEST_FRAME_SIZE).cols;
		const cols = archive?.frames.map(frame => frame.cols) ?? [];
		expect(cols.slice(0, 3)).toEqual([hiCols, hiCols, hiCols]);
		expect(cols.slice(-3)).toEqual([hiCols, hiCols, hiCols]);
		expect(cols[3]).toBeGreaterThan(hiCols);
		expect(result.summary).toContain(`${hiCols} or ${cols[3]} characters wide`);
	});

	it("keeps foveated Silver archives on the Silver font", async () => {
		const silver = snapcompact.resolveShape(undefined, "silver16-bw");
		const result = await snapcompact.compact(
			makePreparation({ messagesToSummarize: [createUserMessage("你好世界".repeat(200))] }),
			{ shape: silver, frameSize: 64, maxFrames: 1 },
		);
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		expect(archive?.frames.length).toBeGreaterThan(0);
		expect(archive?.frames.every(frame => frame.font === "silver")).toBe(true);
	});

	it("re-renders later compactions from the kept source text", async () => {
		const first = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [createUserMessage("A long first turn. ".repeat(500))],
			}),
			{ frameSize: TEST_FRAME_SIZE, maxFrames: 5 },
		);
		const second = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [createUserMessage("A short follow-up turn.")],
				previousSummary: first.summary,
				previousPreserveData: first.preserveData,
			}),
			{ frameSize: TEST_FRAME_SIZE, maxFrames: 5 },
		);
		const archive = snapcompact.getPreservedArchive(second.preserveData);
		expect(archive?.text).toContain("A short follow-up turn.");
		expect(archive?.textTail ?? archive?.textHead).toContain("A short follow-up turn.");
		expect(archive?.frames.length).toBe(5);
	});

	it("re-compacting with a smaller maxFrames than the previous archive shrinks the frame count", async () => {
		const first = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [
					createUserMessage(`HEAD SENTINEL. ${"Important fact number one. ".repeat(1000)}TAIL SENTINEL.`),
				],
			}),
			{ frameSize: TEST_FRAME_SIZE, maxFrames: 7 },
		);
		const firstArchive = snapcompact.getPreservedArchive(first.preserveData);
		expect(firstArchive?.frames.length).toBe(7);

		// No new messages: rebuild the SAME archive at a reduced budget — the
		// dead-end rescue path for a trailing over-threshold archive.
		const shrunk = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [],
				previousSummary: first.summary,
				previousPreserveData: first.preserveData,
			}),
			{ frameSize: TEST_FRAME_SIZE, maxFrames: 3 },
		);
		const shrunkArchive = snapcompact.getPreservedArchive(shrunk.preserveData);
		expect(shrunkArchive?.frames.length).toBeGreaterThan(0);
		expect(shrunkArchive?.frames.length).toBeLessThanOrEqual(3);
		expect(shrunkArchive?.textHead ?? shrunkArchive?.text).toContain("HEAD SENTINEL.");
	});

	it("keeps the original text head across later compactions", async () => {
		const first = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [
					createUserMessage(`ORIGINAL BEGINNING SENTINEL. ${"A long first turn. ".repeat(500)}`),
				],
			}),
			{ frameSize: TEST_FRAME_SIZE, maxFrames: 5 },
		);
		const second = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [createUserMessage("A short follow-up turn.")],
				previousSummary: first.summary,
				previousPreserveData: first.preserveData,
			}),
			{ frameSize: TEST_FRAME_SIZE, maxFrames: 5 },
		);
		const archive = snapcompact.getPreservedArchive(second.preserveData);
		expect(archive?.text).toContain("ORIGINAL BEGINNING SENTINEL.");
		expect(archive?.textHead).toContain("ORIGINAL BEGINNING SENTINEL.");
		expect(archive?.textTail ?? archive?.textHead).toContain("A short follow-up turn.");
	});

	it("keeps continuity for legacy frame-only archives by falling back to the prior summary", async () => {
		const result = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [createUserMessage("New work after a legacy archive.")],
				previousSummary: "Legacy beginning summary: user approved PLAN.md and started auth work.",
				previousPreserveData: {
					snapcompact: {
						frames: [
							{
								data: btoa("legacy-frame"),
								mimeType: "image/png",
								cols: 1,
								rows: 1,
								chars: 12,
							},
						],
						totalChars: 12,
						truncatedChars: 0,
					},
				},
			}),
			{ frameSize: TEST_FRAME_SIZE, maxFrames: 5 },
		);
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		expect(archive?.text).toContain("Legacy beginning summary");
		expect(result.summary).toContain("condensed digest of still-older context");
	});

	it("includes the previous text summary when the prior compaction was not snapcompact", async () => {
		const result = await snapcompact.compact(
			makePreparation({ previousSummary: "Older context: project scaffolding done." }),
			{ frameSize: TEST_FRAME_SIZE },
		);
		expect(result.summary).toContain("condensed digest of still-older context");
	});

	it("strips the OpenAI remote payload and preserves unrelated preserveData", async () => {
		const first = await snapcompact.compact(makePreparation(), { frameSize: TEST_FRAME_SIZE });
		const second = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [createUserMessage("A new turn happened after the first compaction.")],
				previousSummary: first.summary,
				previousPreserveData: {
					...first.preserveData,
					openaiRemoteCompaction: { provider: "openai", replacementHistory: [] },
					appKey: "kept",
				},
			}),
			{ frameSize: TEST_FRAME_SIZE },
		);

		expect(second.summary).not.toContain("[Summary of earlier history]");
		expect(second.preserveData?.openaiRemoteCompaction).toBeUndefined();
		expect(second.preserveData?.appKey).toBe("kept");
	});

	it("scrubs legacy ¶think: sections from the prior archive when thinking is excluded", async () => {
		const first = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [
					createUserMessage("Investigate the flaky auth test."),
					createAssistantMessage([
						{ type: "thinking", thinking: "legacy private chain of thought" },
						{ type: "text", text: "The token clock is skewed." },
					]),
				],
			}),
			{ frameSize: TEST_FRAME_SIZE },
		);
		expect(snapcompact.getPreservedArchive(first.preserveData)?.text ?? "").toContain("¶think:");

		const second = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [createUserMessage("Continue after switching to Claude.")],
				previousPreserveData: first.preserveData,
			}),
			{ frameSize: TEST_FRAME_SIZE, includeThinking: false },
		);
		const archiveText = snapcompact.getPreservedArchive(second.preserveData)?.text ?? "";
		expect(archiveText).not.toContain("¶think:");
		expect(archiveText).not.toContain("legacy private chain of thought");
		expect(archiveText).toContain("Investigate the flaky auth test.");
		expect(archiveText).toContain("The token clock is skewed.");
	});

	it("keeps legacy ¶think: sections when thinking stays included", async () => {
		const first = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [
					createAssistantMessage([
						{ type: "thinking", thinking: "legacy private chain of thought" },
						{ type: "text", text: "Visible reply." },
					]),
				],
			}),
			{ frameSize: TEST_FRAME_SIZE },
		);
		const second = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [createUserMessage("Another turn.")],
				previousPreserveData: first.preserveData,
			}),
			{ frameSize: TEST_FRAME_SIZE },
		);
		expect(snapcompact.getPreservedArchive(second.preserveData)?.text ?? "").toContain("¶think:");
	});
});

describe("archive helpers", () => {
	it("getPreservedArchive rejects malformed payloads", () => {
		expect(snapcompact.getPreservedArchive(undefined)).toBeUndefined();
		expect(snapcompact.getPreservedArchive({ [snapcompact.PRESERVE_KEY]: "nope" })).toBeUndefined();
		expect(snapcompact.getPreservedArchive({ [snapcompact.PRESERVE_KEY]: { frames: [] } })).toBeUndefined();
		const valid: snapcompact.Archive = {
			frames: [{ data: "ZmFrZQ==", mimeType: "image/png", cols: 64, rows: 40, chars: 10 }],
			totalChars: 10,
			truncatedChars: 0,
		};
		expect(snapcompact.getPreservedArchive({ [snapcompact.PRESERVE_KEY]: valid })).toEqual(valid);
	});

	it("getPreservedArchive round-trips text-only and text-tail archives", () => {
		const textOnly: snapcompact.Archive = {
			frames: [],
			totalChars: 21,
			truncatedChars: 0,
			text: "older history newer history",
			textHead: "older history newer history",
		};
		expect(snapcompact.getPreservedArchive({ [snapcompact.PRESERVE_KEY]: textOnly })).toEqual(textOnly);

		const archive: snapcompact.Archive = {
			frames: [{ data: "ZmFrZQ==", mimeType: "image/png", cols: 64, rows: 40, chars: 10 }],
			totalChars: 10,
			truncatedChars: 0,
			textTail: "newest unframed history",
		};
		expect(snapcompact.getPreservedArchive({ [snapcompact.PRESERVE_KEY]: archive })).toEqual(archive);
	});

	it("stripPreservedArchive drops the frame archive and collapses to undefined when empty", () => {
		expect(snapcompact.stripPreservedArchive(undefined)).toBeUndefined();
		// No archive key: pass through unchanged.
		expect(snapcompact.stripPreservedArchive({ other: "keep-me" })).toEqual({ other: "keep-me" });
		// Archive key alongside unrelated state: strip only the archive.
		expect(
			snapcompact.stripPreservedArchive({
				other: "keep-me",
				[snapcompact.PRESERVE_KEY]: { frames: [], totalChars: 0, truncatedChars: 0 },
			}),
		).toEqual({ other: "keep-me" });
		// Archive key was the only state: collapse to undefined, never persist `{}`.
		expect(
			snapcompact.stripPreservedArchive({
				[snapcompact.PRESERVE_KEY]: { frames: [], totalChars: 0, truncatedChars: 0 },
			}),
		).toBeUndefined();
	});

	it("historyBlocks orders text head, imaged middle, then text tail", () => {
		const archive: snapcompact.Archive = {
			frames: [{ data: btoa("middle"), mimeType: "image/png", cols: 8, rows: 8, chars: 4 }],
			totalChars: 40,
			truncatedChars: 0,
			text: "head text middle tail text",
			textHead: "head text",
			textTail: "tail text",
		};
		const blocks = snapcompact.historyBlocks(archive);
		expect(blocks.map(block => block.type)).toEqual(["text", "image", "text"]);
		expect((blocks[0] as { text: string }).text).toContain("head text");
		expect((blocks[1] as { data: string }).data).toBe(btoa("middle"));
		expect((blocks[2] as { text: string }).text).toContain("tail text");
	});

	it("provider image budgets stay permissive while unknown providers keep the safe floor", () => {
		expect(snapcompact.providerImageBudget("openrouter")).toBe(90);
		expect(snapcompact.providerImageBudget("umans")).toBe(10);
		// Unknown providers fall to the safe floor.
		expect(snapcompact.providerImageBudget(undefined)).toBe(snapcompact.DEFAULT_PROVIDER_IMAGE_BUDGET);
		expect(snapcompact.providerImageBudget("some-new-router")).toBe(snapcompact.DEFAULT_PROVIDER_IMAGE_BUDGET);
		expect(snapcompact.providerImageBudget("openai-codex")).toBe(200);
		expect(snapcompact.providerFrameBudget("some-new-router")).toBe(snapcompact.DEFAULT_PROVIDER_IMAGE_BUDGET);
		expect(snapcompact.providerFrameBudget("umans")).toBe(10);
		expect(snapcompact.providerFrameBudget("anthropic")).toBe(snapcompact.MAX_FRAMES_DEFAULT);
		// Anthropic's image cap is the high-water mark the default frame count
		// must stay under; unknown providers are clamped separately via
		// providerFrameBudget so their lower image floors cannot archive frames
		// the send path will drop.
		expect(snapcompact.MAX_FRAMES_DEFAULT).toBeLessThanOrEqual(snapcompact.providerImageBudget("anthropic"));
	});
});

describe("dimStopwords", () => {
	const { DIM_ON, DIM_OFF, dimStopwords } = snapcompact;

	it("wraps maximal alphabetic stopword runs in zero-width dim toggles", () => {
		expect(dimStopwords("the cat sat on a mat")).toBe(
			`${DIM_ON}the${DIM_OFF} cat sat ${DIM_ON}on${DIM_OFF} ${DIM_ON}a${DIM_OFF} mat`,
		);
		// Case-insensitive; punctuation bounds the run.
		expect(dimStopwords("The end.")).toBe(`${DIM_ON}The${DIM_OFF} end.`);
		// A stopword embedded in a longer word stays untouched.
		expect(dimStopwords("theory")).toBe("theory");
	});

	it("passes through spans that are already dim", () => {
		const input = `alpha ${DIM_ON}the tool output${DIM_OFF} and omega`;
		expect(dimStopwords(input)).toBe(`alpha ${DIM_ON}the tool output${DIM_OFF} ${DIM_ON}and${DIM_OFF} omega`);
		// An unterminated dim span (page straddle) suppresses wrapping to its end.
		expect(dimStopwords(`${DIM_ON}so it goes`)).toBe(`${DIM_ON}so it goes`);
	});

	it("changes only zero-width markers, never visible glyphs", () => {
		const input = "this is the content of a frame";
		const dimmed = dimStopwords(input);
		expect(dimmed).not.toBe(input);
		expect(dimmed.replace(/[\u000e\u000f]/g, "")).toBe(input);
	});
});

describe("wrap", () => {
	it("greedily packs words at the column width", () => {
		expect(snapcompact.wrap("aa bb cc dd", 5)).toEqual(["aa bb", "cc dd"]);
		expect(snapcompact.wrap("one two three", 8)).toEqual(["one two", "three"]);
		// Exactly-width words fit without splitting.
		expect(snapcompact.wrap("abcd", 4)).toEqual(["abcd"]);
		expect(snapcompact.wrap("", 10)).toEqual([]);
	});

	it("hard-splits only words wider than the line", () => {
		expect(snapcompact.wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
		// The current line flushes before the oversized word's slices, and the
		// remainder seeds the next line.
		expect(snapcompact.wrap("xx abcdefghij yy", 4)).toEqual(["xx", "abcd", "efgh", "ij", "yy"]);
	});
});

describe("doc layout", () => {
	const docShape = snapcompact.resolveShape(undefined, "doc-8on16-bw");

	it("computes two-column geometry with the 3-cell gutter", () => {
		// 1568px: 196 grid cells → (196-3)/2 = 96 per column; 1568/16 = 98 rows.
		expect(snapcompact.geometry(docShape)).toEqual({ cols: 96, rows: 98, capacity: 2 * 96 * 98 });
		// 160px: 20 grid cells → 8 per column, 10 rows per column.
		expect(snapcompact.geometry(docShape, 160)).toEqual({ cols: 8, rows: 10, capacity: 160 });
	});

	it("frames() counts pages of wrapped lines, two columns per page", () => {
		// 8-char column x 10 rows → 20 lines per page; "ab ab ab" fills a line.
		const words = (n: number) => Array.from({ length: n }, () => "ab").join(" ");
		expect(snapcompact.frames(words(60), { shape: docShape, frameSize: 160 })).toBe(1);
		expect(snapcompact.frames(words(61), { shape: docShape, frameSize: 160 })).toBe(2);
		expect(snapcompact.frames("", { shape: docShape, frameSize: 160 })).toBe(0);
	});
});

describe("new shape variants", () => {
	const newNames = [
		"6x12-dim",
		"8x13-bw",
		"8on16-bw",
		"doc-8on16-bw",
		"doc-8on16-sent",
		"doc-8on16-sent-dim",
	] as const;

	it("registers the six research winners as priceable variants", () => {
		for (const name of newNames) {
			expect(snapcompact.isShapeVariantName(name)).toBe(true);
			expect(snapcompact.SHAPE_VARIANT_NAMES).toContain(name);
			const shape = snapcompact.resolveShape(undefined, name);
			expect(snapcompact.isShape(shape)).toBe(true);
			expect(shape.frameSize).toBe(1568);
		}
	});

	it("isShape validates the new optional fields", () => {
		const base = snapcompact.resolveShape(undefined, "doc-8on16-sent-dim");
		expect(snapcompact.isShape({ ...base, columns: 3 })).toBe(false);
		expect(snapcompact.isShape({ ...base, columns: 1 })).toBe(true);
		expect(snapcompact.isShape({ ...base, stretch: "no" })).toBe(false);
		expect(snapcompact.isShape({ ...base, stopwordDim: 1 })).toBe(false);
		expect(snapcompact.isShape({ ...base, font: "9x9" })).toBe(false);
	});
});

describe("data URL elision", () => {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><desc>${"A".repeat(6000)}</desc></svg>`;
	const b64 = Buffer.from(svg, "utf8").toString("base64");
	const dataUrl = `data:image/svg+xml;base64,${b64}`;
	const placeholder = `[data URL omitted: image/svg+xml, ${b64.length} base64 chars]`;
	// No base64 run long enough to read as an image payload may survive.
	const leakedPayload = /;base64,[A-Za-z0-9+/=]{40}/;
	const markerInPayload = /;base64,[A-Za-z0-9+/=]*\s*\[(?:…|\.{3})\d+ch elided/;
	const recognizableDataUrl = /data:[A-Za-z][\w.+-]*\/[\w.+-]+(?:;[\w!#$%&'*+.^|~-]+=[\w!#$%&'*+.^|~-]+)*;base64,/i;

	it("prevents archived Markdown tool-result images from reaching providers as sliced undecodable data URLs", () => {
		const out = snapcompact.serializeConversation([
			createToolResultMessage(`Reader output:\n\n![inline SVG](${dataUrl})\ntrailing text`),
		]);
		expect(out).toContain(placeholder);
		expect(out).not.toMatch(leakedPayload);
		expect(out).toContain("trailing text");
	});

	it("prevents archived bare tool-result data URLs from reaching providers as sliced undecodable payloads", () => {
		const out = snapcompact.serializeConversation([createToolResultMessage(`see ${dataUrl} end`)]);
		expect(out).toContain(placeholder);
		expect(out).not.toMatch(leakedPayload);
	});

	it("prevents character-cap head/tail cuts from leaving a recognizable data URL in archived tool results", () => {
		// Sweep the atom across the 1,200-char head and 800-char tail boundaries.
		// Each pad is a distinct cut landing: 0 start, 600 inside head, 1150/1199
		// straddle the head cut, 4000 discarded middle, 6500 straddle tail, 7400 tail.
		for (const pad of [0, 600, 1150, 1199, 4000, 6500, 7400]) {
			const text = `${"p".repeat(pad)} ![img](${dataUrl}) ${"s".repeat(7600 - pad)}`;
			const out = snapcompact.normalize(snapcompact.serializeConversation([createToolResultMessage(text)]));
			expect(out).not.toMatch(leakedPayload);
			expect(out).not.toMatch(markerInPayload);
		}
	});

	it("prevents archived tool-call arguments from reaching providers as sliced undecodable data URLs", () => {
		const out = snapcompact.serializeConversation([
			createAssistantMessage([
				{
					type: "toolCall",
					id: "c1",
					name: "write",
					arguments: { path: "a.html", content: `<img src="${dataUrl}">` },
				},
			]),
		]);
		expect(out).not.toMatch(leakedPayload);
		expect(out).toContain("data URL omitted: image/svg+xml");
	});

	it("prevents a canonical 1x1 GIF data URL from surviving in archived tool results as image input", () => {
		const payload = "R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
		const out = snapcompact.serializeConversation([
			createToolResultMessage(`const BLANK = "data:image/gif;base64,${payload}";`),
		]);
		expect(out).toContain(`[data URL omitted: image/gif, ${payload.length} base64 chars]`);
		expect(out).not.toMatch(/data:image\/gif;base64,/i);
	});

	it("prevents prose mentions like data:image/png;base64,abc from being rewritten into placeholders", () => {
		const prose = "e.g. 'data:image/png;base64,abc' is the expected shape";
		const out = snapcompact.serializeConversation([createToolResultMessage(prose)]);
		expect(out).toContain(prose);
		expect(out).not.toContain("data URL omitted");
	});

	it("prevents a ;charset=utf-8 data URL from surviving in archived tool results as image input", () => {
		const url = `data:image/svg+xml;charset=utf-8;base64,${b64}`;
		const out = snapcompact.serializeConversation([createToolResultMessage(`see ${url} end`)]);
		expect(out).toContain(`[data URL omitted: image/svg+xml;charset=utf-8, ${b64.length} base64 chars]`);
		expect(out).not.toMatch(recognizableDataUrl);
	});

	it("prevents uppercase DATA:/BASE64 data URLs from surviving in archived tool results as image input", () => {
		const url = `DATA:IMAGE/PNG;BASE64,${b64}`;
		const out = snapcompact.serializeConversation([createToolResultMessage(`see ${url} end`)]);
		expect(out).toContain(`[data URL omitted: IMAGE/PNG, ${b64.length} base64 chars]`);
		expect(out).not.toMatch(recognizableDataUrl);
	});

	it("prevents user-message data URLs from surviving as sliced undecodable image refs in the compacted archive", async () => {
		const result = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [
					createUserMessage(`${"context ".repeat(400)}![img](${dataUrl})${" more".repeat(400)}`),
				],
			}),
			{ frameSize: TEST_FRAME_SIZE, maxFrames: 3 },
		);
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		const all = `${archive?.text ?? ""}\n${archive?.textHead ?? ""}\n${archive?.textTail ?? ""}`;
		expect(all).not.toMatch(leakedPayload);
		expect(all).not.toMatch(markerInPayload);
	});

	it("prevents re-compaction of a pre-guard archive from replaying undecodable data-URL fragments", async () => {
		const legacyHead =
			`earlier work ![a](${dataUrl}) then ` +
			`data:image/png;base64,${"QUFB".repeat(50)} [...900ch elided...] ${"QUFB".repeat(10)} and ` +
			`data:image/webp;base64, [...123ch elided...] QUFB plus a bare cut data:image/jpeg;base64,`;
		const result = await snapcompact.compact(
			makePreparation({
				messagesToSummarize: [createUserMessage("Next turn after legacy archive.")],
				previousPreserveData: {
					snapcompact: {
						frames: [],
						totalChars: legacyHead.length,
						truncatedChars: 0,
						textHead: legacyHead,
						textTail: "recent tail",
					},
				},
			}),
			{ frameSize: TEST_FRAME_SIZE, maxFrames: 3 },
		);
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		const all = `${archive?.text ?? ""}\n${archive?.textHead ?? ""}\n${archive?.textTail ?? ""}`;
		expect(all).not.toMatch(/data:[A-Za-z][\w.+-]*\/[\w.+-]+;base64,/);
		expect(all).not.toMatch(markerInPayload);
		expect(all).toContain("data URL omitted: image/svg+xml");
		expect(all).toContain("data URL omitted: image/webp");
	});

	it("prevents historyBlocks from replaying poisoned archive prefixes as invalid image input", () => {
		const rows: Array<{ head: string; placeholder: string; retain?: string }> = [
			{
				// cut +0: empty payload after `;base64,` (exercises regex `*` zero-width match)
				head: "history ![x](data:image/svg+xml;base64,",
				placeholder: "data URL omitted: image/svg+xml",
			},
			{
				// cut +1: `Q` (strict archive path below source floor)
				head: "history ![x](data:image/svg+xml;base64,Q",
				placeholder: "data URL omitted: image/svg+xml",
			},
			{
				// cut +39: `${"QUFB".repeat(9)}QUL` (just below 40-char floor)
				head: `history ![x](data:image/svg+xml;base64,${"QUFB".repeat(9)}QUL`,
				placeholder: "data URL omitted: image/svg+xml",
			},
			{
				// marker directly after comma: pre-guard slice landed on `;base64,`
				head: "data:image/webp;base64, [...900ch elided...] QUFB rest",
				placeholder: "data URL omitted: image/webp",
				retain: " rest",
			},
			{
				// parameterized archive fragment: explicit source+archive RFC 2397 requirement
				head: "data:image/svg+xml;charset=utf-8;base64,Q",
				placeholder: "data URL omitted: image/svg+xml;charset=utf-8",
			},
		];
		for (const row of rows) {
			const blocks = snapcompact.historyBlocks({
				frames: [],
				totalChars: row.head.length,
				truncatedChars: 5,
				textHead: row.head,
				textTail: "tail",
			});
			const text = blocks.map(b => (b.type === "text" ? b.text : "")).join("\n");
			expect(text).not.toMatch(recognizableDataUrl);
			expect(text).toContain(row.placeholder);
			if (row.retain !== undefined) {
				expect(text).toContain(row.retain);
				expect(text).not.toContain(";base64,");
				expect(text).not.toContain("ch elided");
			}
		}
	});

	it("prevents archive migration text from replaying invalid image input to summarizers/providers", () => {
		const poisoned = "data:image/png;base64,QUFB [...900ch elided...] QUFB";
		const text = snapcompact.archiveSourceText({
			frames: [],
			totalChars: poisoned.length,
			truncatedChars: 0,
			textHead: poisoned,
		});
		expect(text).toContain("[data URL omitted: image/png, 908 base64 chars]");
		expect(text).not.toMatch(recognizableDataUrl);
	});

	it("prevents unmatched Markdown brackets from stalling tool-result compaction", () => {
		// Unmatched `[` plus `;base64,` used to stall tool-result compaction in
		// the data-URL matcher before the 2,000-character cap could apply.
		const text = `${"[".repeat(80_000)};base64,`;
		const out = snapcompact.serializeConversation([createToolResultMessage(text)]);
		const marker = "[…78008ch elided…]";
		expect(out).toContain(marker);
		expect(out).toContain(
			`${snapcompact.DIM_ON}${"[".repeat(1200)} ${marker} ${"[".repeat(792)};base64,${snapcompact.DIM_OFF}`,
		);
	}, 2_000);
});
