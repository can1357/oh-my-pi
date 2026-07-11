/**
 * Snapcompact compaction: archive conversation history as dense bitmap images.
 *
 * Instead of asking an LLM to summarize discarded history, the serialized
 * conversation is rendered into PNG frames of pixel-font text that vision
 * models read back directly, like an archivist at a snapcompact frame
 * reader. Frames are `frameSize` wide; their height hugs the text rows
 * actually printed, so a partially filled frame never bills blank rows.
 *
 * The frame shape is provider-aware. Original choices came from the SQuAD
 * prose evals (`packages/snapcompact`, 200k-token monolithic runs); the
 * spacing choices below come from the tool-result legibility bench
 * (`research/toolbench.py`, real search/read/find output with structure QA),
 * which exposed that the prose-tuned dense cells erase the line numbers and
 * indentation that code/search output depends on:
 *
 * - **Anthropic** (`11on16-bw`): 8x13 glyphs on an 11px advance (extra
 *   letter-spacing), black ink. On the tool-result bench, tracking the
 *   readable cell beat plain `8on16-bw` (opus-4.8 f1 .806 vs .755) and far
 *   beat the prior dense `6x12-dim` (.351, which fell below the OCR ~16px/char
 *   floor and abstained). Opus 4.7+/Fable/Mythos ingest high-res natively
 *   (2576px edge, 4,784 visual-token cap), so those lines get 1932px frames:
 *   same bill, fewer frames. Older Claude lines downscale past 1568px.
 * - **Google** (`8on22-bw` @2048): 8x13 glyphs on a 22px pitch (extra line
 *   spacing), black ink. Leading lifted gemini-3.5-flash to f1 .934 vs .807
 *   for `8on16-bw` and .287 for the prior `doc-8on16-sent-dim`. Gemini 3.x
 *   bills a fixed `media_resolution` budget per image (default 1,120 tokens)
 *   regardless of pixels, so the 2048px frame carries more chars at the same
 *   bill.
 * - **OpenAI** (`8on22-bw`): same leading win (gpt-5.5/gpt-5.4-mini). Patch
 *   billing (32px × 1.2, 10k-patch budget at `detail: "original"`) is
 *   area-proportional, so resolution cannot improve chars/$ — 1568 stays.
 *   `detail: "high"` would downgrade (2,500-patch cap); `original` is sent.
 * - **Unknown providers** default to the Anthropic shape. `providerImageBudget`
 *   still caps per-request images per provider so inline imaging cannot flood a
 *   request with attachments, but the old OpenRouter-specific 8-image cap is
 *   gone; routers now use the same permissive budget as direct Anthropic/Claude
 *   lines unless configured otherwise upstream.
 *
 * The whole pass is local and deterministic — no LLM call, no API key, no
 * latency beyond rendering. Rasterization and PNG encoding happen in native
 * code (`renderSnapcompactPng` in `crates/pi-natives/src/snapcompact.rs`).
 * Frames persist in the compaction entry's `preserveData` and are
 * re-attached to the compaction summary message on every context rebuild.
 */

import type { Api, ImageContent, Message, Model, TextContent } from "@pk-nerdsaver-ai/pi-ai";
import { renderSnapcompactPng } from "@pk-nerdsaver-ai/pi-natives";
import { formatGroupedPaths, prompt } from "@pk-nerdsaver-ai/pi-utils";
import { INTENT_FIELD } from "@pk-nerdsaver-ai/pi-wire";
import fileOperationsTemplate from "./prompts/file-operations.md" with { type: "text" };
import snapcompactSummaryPrompt from "./prompts/snapcompact-summary.md" with { type: "text" };

// ============================================================================
// Shapes
// ============================================================================

/** One eval-validated frame shape: font, cell, ink, repetition, and size. */
export interface Shape {
	/** Bundled font in the native renderer. */
	font: "5x8" | "8x8" | "6x12" | "8x13";
	/** Target cell advance in pixels; differing from the font's natural cell
	 *  renders via Lanczos stretch (anti-aliased RGB frame). */
	cellWidth: number;
	/** Target cell pitch in pixels. */
	cellHeight: number;
	/** `false` → glyphs drawn at natural size on the cell pitch (8on16);
	 *  `true`/`undefined` → legacy auto Lanczos stretch when cell ≠ natural. */
	stretch?: boolean;
	/** Ink: `sent` cycles six hues at sentence boundaries; `bw` is black. */
	variant: "sent" | "bw";
	/** Print stopwords in dim ink (research `dim`/`sent-dim` variants). */
	stopwordDim?: boolean;
	/** 1/undefined = row-major grid; 2 = two word-wrapped newspaper columns
	 *  (research `doc`). */
	columns?: number;
	/** Each text line is printed this many times; copies after the first sit
	 *  on a pale highlight band (redundancy coding). */
	lineRepeat: number;
	/** Frame edge in pixels. */
	frameSize: number;
	/** Per-frame billed-token estimate for the shape's target provider. */
	frameTokenEstimate: number;
	/** Resolution hint attached to frame images (OpenAI-only). */
	imageDetail?: ImageContent["detail"];
}

/** Geometry half of a {@link Shape}: everything except provider billing. */
export type ShapeGeometry = Omit<Shape, "frameTokenEstimate" | "imageDetail">;

/**
 * Frame variants exercised by the SQuAD evals in `research/` that the native
 * renderer reproduces faithfully, keyed by their research names. Font codes:
 * `8x8u` unscii square cell, `8x8r` unscii with every line printed twice
 * (redundancy coding), `6x6u` unscii Lanczos-squeezed to 6x6 (densest
 * readable cell), `5x8` the X.org legacy font on its 2576px frame, `6x12`
 * and `8x13` the X.org misc fonts, `8on16` 8x13 glyphs on an 8x16 cell pitch
 * (no stretch, extra leading), `8on22` the same glyphs on a 22px pitch (more
 * leading), `11on16` the same glyphs on an 11px advance (more tracking),
 * `doc-` prefixed shapes a two-column word-wrapped newspaper layout. Ink:
 * `sent` cycles six hues at sentence boundaries, `bw` is plain black, `-dim`
 * suffix prints stopwords in gray.
 */
export const SHAPE_VARIANTS = {
	"8x8r-bw": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "bw", lineRepeat: 2, frameSize: 1568 },
	"8x8r-sent": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "sent", lineRepeat: 2, frameSize: 1568 },
	"8x8u-bw": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"8x8u-sent": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "sent", lineRepeat: 1, frameSize: 1568 },
	"6x6u-bw": { font: "8x8", cellWidth: 6, cellHeight: 6, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"6x6u-sent": { font: "8x8", cellWidth: 6, cellHeight: 6, variant: "sent", lineRepeat: 1, frameSize: 1568 },
	"5x8-bw": { font: "5x8", cellWidth: 5, cellHeight: 8, variant: "bw", lineRepeat: 1, frameSize: 2576 },
	"5x8-sent": { font: "5x8", cellWidth: 5, cellHeight: 8, variant: "sent", lineRepeat: 1, frameSize: 2576 },
	"6x12-dim": {
		font: "6x12",
		cellWidth: 6,
		cellHeight: 12,
		variant: "bw",
		stopwordDim: true,
		lineRepeat: 1,
		frameSize: 1568,
	},
	"8x13-bw": { font: "8x13", cellWidth: 8, cellHeight: 13, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"8on16-bw": {
		font: "8x13",
		cellWidth: 8,
		cellHeight: 16,
		stretch: false,
		variant: "bw",
		lineRepeat: 1,
		frameSize: 1568,
	},
	"8on22-bw": {
		font: "8x13",
		cellWidth: 8,
		cellHeight: 22,
		stretch: false,
		variant: "bw",
		lineRepeat: 1,
		frameSize: 1568,
	},
	"11on16-bw": {
		font: "8x13",
		cellWidth: 11,
		cellHeight: 16,
		stretch: false,
		variant: "bw",
		lineRepeat: 1,
		frameSize: 1568,
	},
	"doc-8on16-bw": {
		font: "8x13",
		cellWidth: 8,
		cellHeight: 16,
		stretch: false,
		variant: "bw",
		columns: 2,
		lineRepeat: 1,
		frameSize: 1568,
	},
	"doc-8on16-sent": {
		font: "8x13",
		cellWidth: 8,
		cellHeight: 16,
		stretch: false,
		variant: "sent",
		columns: 2,
		lineRepeat: 1,
		frameSize: 1568,
	},
	"doc-8on16-sent-dim": {
		font: "8x13",
		cellWidth: 8,
		cellHeight: 16,
		stretch: false,
		variant: "sent",
		stopwordDim: true,
		columns: 2,
		lineRepeat: 1,
		frameSize: 1568,
	},
} as const satisfies Record<string, ShapeGeometry>;

/** Research name of one renderable frame variant. */
export type ShapeVariantName = keyof typeof SHAPE_VARIANTS;

/** All variant names, in declaration order (for settings enums). */
export const SHAPE_VARIANT_NAMES = Object.keys(SHAPE_VARIANTS) as readonly ShapeVariantName[];

/** Runtime guard for variant names loaded from config. */
export function isShapeVariantName(value: unknown): value is ShapeVariantName {
	return typeof value === "string" && value in SHAPE_VARIANTS;
}

/** Provider families with distinct image billing. */
type BillingFamily = "anthropic" | "google" | "openai";

function billingFamily(api?: Api): BillingFamily {
	switch (api) {
		case "openai-completions":
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
			return "openai";
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
			return "google";
		default:
			// anthropic-messages, bedrock-converse-stream, and anything unknown
			// share Anthropic's pixel-area pricing as the safe ceiling.
			return "anthropic";
	}
}

/**
 * Per-frame billing for a square frame of edge `frameSize`, by family.
 * Formulas verified against live bills in the resolution benchmarks:
 * - Anthropic: 28px patches, capped at 4,784 visual tokens (the API
 *   downscales past the cap; 1568 → 3,136 measured) + 5% margin.
 * - Google: Gemini 3.x bills a fixed `media_resolution` budget per image —
 *   default HIGH = 1,120 tokens — regardless of pixel size.
 * - OpenAI: 32px patches × 1.2 flagship multiplier, 10,000-patch budget at
 *   `detail: "original"` (1568 → 2,881 measured).
 */
function familyBilling(family: BillingFamily, frameSize: number): Pick<Shape, "frameTokenEstimate" | "imageDetail"> {
	switch (family) {
		case "google":
			return { frameTokenEstimate: 1120 };
		case "openai": {
			const patches = Math.min(Math.ceil(frameSize / 32) ** 2, 10_000);
			return { frameTokenEstimate: Math.ceil(patches * 1.2), imageDetail: "original" };
		}
		default: {
			const patches = Math.min(Math.ceil(frameSize / 28) ** 2, 4784);
			return { frameTokenEstimate: Math.ceil(patches * 1.05) };
		}
	}
}

/** Attach a provider family's billing to a variant geometry. */
function priceShape(base: ShapeGeometry, family: BillingFamily): Shape {
	return { ...base, ...familyBilling(family, base.frameSize) };
}

/** Eval-validated shapes, keyed by the provider family they won on. */
export const SHAPES = {
	/** `11on16-bw`: 8x13 glyphs on an 11px advance (extra tracking), black ink.
	 *  Tool-result legibility bench (real search/read/find output, structure QA)
	 *  on opus-4.8: f1 .806 vs .755 for plain `8on16-bw` and .351 for the prior
	 *  `6x12-dim` default — letter-spacing the readable cell wins; the dense
	 *  6x12 was below the OCR ~16px/char floor and abstained. */
	anthropic: priceShape(SHAPE_VARIANTS["11on16-bw"], "anthropic"),
	/** `8on22-bw`: 8x13 glyphs on a 22px pitch (extra leading), black ink.
	 *  Tool-result legibility bench on gemini-3.5-flash: f1 .934 vs .807 for
	 *  plain `8on16-bw` and .287 for the prior `doc-8on16-sent-dim`; the
	 *  line-spacing reduces row crowding so line numbers stay legible. */
	google: priceShape(SHAPE_VARIANTS["8on22-bw"], "google"),
	/** `8on22-bw`: 8x13 glyphs on a 22px pitch (extra leading), black ink.
	 *  Same line-spacing win for OpenAI; bench on gpt-5.5/gpt-5.4-mini showed
	 *  leading lifts recall on the readable cell over plain `8on16-bw`. */
	openai: priceShape(SHAPE_VARIANTS["8on22-bw"], "openai"),
	/** Original 5x8 X.org shape (pre-shape-table sessions rendered this). */
	legacy: priceShape(SHAPE_VARIANTS["5x8-sent"], "anthropic"),
} satisfies Record<string, Shape>;

/** Runtime guard for shape overrides loaded from config or preserve data. */
export function isShape(value: unknown): value is Shape {
	if (!value || typeof value !== "object") return false;
	const shape = value as Record<string, unknown>;
	const font = shape.font;
	const variant = shape.variant;
	const detail = shape.imageDetail;
	return (
		(font === "5x8" || font === "8x8" || font === "6x12" || font === "8x13") &&
		typeof shape.cellWidth === "number" &&
		shape.cellWidth > 0 &&
		typeof shape.cellHeight === "number" &&
		shape.cellHeight > 0 &&
		(shape.stretch === undefined || typeof shape.stretch === "boolean") &&
		(variant === "sent" || variant === "bw") &&
		(shape.stopwordDim === undefined || typeof shape.stopwordDim === "boolean") &&
		(shape.columns === undefined || shape.columns === 1 || shape.columns === 2) &&
		typeof shape.lineRepeat === "number" &&
		shape.lineRepeat > 0 &&
		typeof shape.frameSize === "number" &&
		shape.frameSize > 0 &&
		typeof shape.frameTokenEstimate === "number" &&
		shape.frameTokenEstimate > 0 &&
		(detail === undefined || detail === "auto" || detail === "low" || detail === "high" || detail === "original")
	);
}

/** Eval-winning variant per provider family (billing fallback when the
 *  model id matches no known reader line). */
const FAMILY_VARIANT: Record<BillingFamily, ShapeVariantName> = {
	anthropic: "11on16-bw",
	google: "8on22-bw",
	openai: "8on22-bw",
};

/** Denser companion variant per family for the foveated archive middle: same
 *  pixels (identical per-frame bill) but a tighter 8px cell, trading some
 *  legibility for ~40% more chars per frame so the least-important middle of a
 *  long archive compresses into fewer frames. */
const FAMILY_VARIANT_LOW: Record<BillingFamily, ShapeVariantName> = {
	anthropic: "8on16-bw",
	google: "8on16-bw",
	openai: "8on16-bw",
};

const FAMILY_SHAPE: Record<BillingFamily, Shape> = {
	anthropic: SHAPES.anthropic,
	google: SHAPES.google,
	openai: SHAPES.openai,
};

/** One model line's ideal format: variant plus an optional frame-size
 *  override when the line reads larger frames at no extra cost. */
export interface IdealShape {
	variant: ShapeVariantName;
	frameSize?: number;
}

/** Eval-winning format per model line, matched against the model id. The
 *  wire API only identifies the gateway — a Claude served through Vertex or
 *  OpenRouter still reads best with its own shape. Patterns cover the model
 *  lines the mono evals measured; everything else falls back to the API
 *  family's winner at the standard 1568px frame. First match wins. */
const MODEL_VARIANTS: readonly (readonly [RegExp, IdealShape])[] = [
	// Opus 4.7+ and Fable/Mythos read high-res natively (2576px edge under a
	// 4,784 visual-token cap → 1932px square sweet spot): same recall and
	// cost as 1568, a third fewer frames.
	[/claude.*(fable|mythos)/i, { variant: "11on16-bw", frameSize: 1932 }],
	[/claude-?opus-?4[.-][7-9]/i, { variant: "11on16-bw", frameSize: 1932 }],
	// Older Claude lines downscale past 1568px — keep the safe size.
	[/claude/i, { variant: "11on16-bw" }],
	// Gemini 3.x bills a fixed 1,120-token budget per image regardless of
	// pixels: 2048px packs more chars per frame at the same bill.
	[/gemini/i, { variant: "8on22-bw", frameSize: 2048 }],
	// gpt-5.5 patch billing is area-proportional; 1568 is already optimal.
	[/gpt|codex/i, { variant: "8on22-bw" }],
	// kimi's image processor downscales past 1792px (64×64 28px patches);
	// 1568 wins on chars/$ and reads at f1 .973 (≤8 frames per request).
	[/kimi/i, { variant: "8on16-bw" }],
	// glm-4.6v .780 mono via direct vendor routing.
	[/glm/i, { variant: "8on16-bw" }],
];

/** Eval-ideal format for a model id, or undefined when unmeasured. */
export function idealShapeVariant(modelId: string): IdealShape | undefined {
	return MODEL_VARIANTS.find(([pattern]) => pattern.test(modelId))?.[1];
}

/** What will read the frames: the wire API (billing) and model id (shape). */
export interface ShapeTarget {
	api?: Api;
	id?: string;
}

/**
 * Pick the frame shape for a reader. An explicit `variant` (anything but
 * `"auto"`) forces that geometry; otherwise the model id selects the
 * eval-winning shape — and frame size — for its model line, falling back to
 * the API family's winner when the model is unmeasured. Billing (token
 * estimate, detail hint) always follows the API family actually carrying
 * the request, computed for the resolved frame size. Accepts a full pi-ai
 * `Model` or any `{ api, id }` subset.
 */
export function resolveShape(model?: ShapeTarget, variant?: ShapeVariantName | "auto"): Shape {
	const family = billingFamily(model?.api);
	if (variant && variant !== "auto") return priceShape(SHAPE_VARIANTS[variant], family);
	const ideal = model?.id ? idealShapeVariant(model.id) : undefined;
	const name = ideal?.variant ?? FAMILY_VARIANT[family];
	if (name === FAMILY_VARIANT[family] && ideal?.frameSize === undefined) return FAMILY_SHAPE[family];
	const base = SHAPE_VARIANTS[name];
	return priceShape(ideal?.frameSize ? { ...base, frameSize: ideal.frameSize } : base, family);
}

// ============================================================================
// Constants
// ============================================================================

/** Legacy frame edge in pixels (the 5x8 shape's eval-validated size). New
 *  shapes carry their own `frameSize`. */
export const FRAME_SIZE = 2576;

/** Default upper bound on archive frames carried per compaction. Sized to hold
 *  ~400k tokens of the high-res Anthropic frame Opus reads (1932px ≈ 5,000
 *  billed tokens each → 80 frames) while staying under the ~100-image
 *  per-request wire cap. Oldest frames are dropped first once the budget is
 *  exceeded (mirrors how iterative text summaries fade the oldest detail); a
 *  caller may pass a lower `maxFrames` upper limit, and per-model context
 *  fitting is handled by the caller's overflow guard. */
export const MAX_FRAMES_DEFAULT = 80;

/** High-quality (legible) frames rendered at each chronological edge of a
 *  foveated archive — the session head (oldest) and the slice just before the
 *  text region (newest) — with the denser low-quality tier filling the middle. */
export const HQ_EDGE_FRAMES = 3;

/** Conservative per-frame token estimate used for context budgeting — the
 *  upper bound across shapes: high-res Claude frames hit the 4,784 visual-token
 *  cap, billed at +5% margin (ceil(4784 * 1.05)). Keeps the overflow guard from
 *  undercounting a high-res archive at the raised {@link MAX_FRAMES_DEFAULT}. */
export const FRAME_TOKEN_ESTIMATE = 5024;

/**
 * Per-request image-count budgets by provider id. These cap how many images an
 * entire request may carry (archive/system-prompt/tool-result imaging combined).
 * The values are conservative policy caps under the vendor hard limits
 * (Anthropic 100, OpenAI 500, Gemini ~2500); unknown providers fall to a safe
 * floor rather than sending unbounded attachments.
 */
export const PROVIDER_IMAGE_BUDGETS: Record<string, number> = {
	anthropic: 90,
	"amazon-bedrock": 90,
	openai: 200,
	"openai-codex": 200,
	google: 200,
	"google-vertex": 200,
	"google-gemini-cli": 200,
	openrouter: 90,
	umans: 10,
};

/** Safe floor for unknown providers (strictest mainstream measured: Groq ~5). */
export const DEFAULT_PROVIDER_IMAGE_BUDGET = 5;

/** Per-request image budget for `provider`; unknown providers get the floor. */
export function providerImageBudget(provider: string | undefined): number {
	return (provider !== undefined ? PROVIDER_IMAGE_BUDGETS[provider] : undefined) ?? DEFAULT_PROVIDER_IMAGE_BUDGET;
}

/** Key under `CompactionEntry.preserveData` holding the frame archive. */
export const PRESERVE_KEY = "snapcompact";

// ============================================================================
// Types
// ============================================================================

/** One developed snapcompact frame: a base64 PNG plus its reading geometry. */
export interface Frame {
	/** Base64-encoded PNG. */
	data: string;
	mimeType: string;
	/** Characters per row in the frame grid (per-column width on doc frames). */
	cols: number;
	/** Text rows in the frame grid (unique lines, not repeated copies). */
	rows: number;
	/** Characters actually printed onto this frame. */
	chars: number;
	/** Shape metadata (absent on legacy frames, which are 5x8 `sent`). */
	font?: Shape["font"];
	variant?: Shape["variant"];
	lineRepeat?: number;
	/** 2 on two-column doc frames; absent on row-major grid frames. */
	columns?: number;
	/** True when stopwords were printed in dim ink. */
	stopwordDim?: boolean;
	/** Resolution hint forwarded to the provider when re-attaching. */
	detail?: ImageContent["detail"];
}

/** Frame archive persisted under `preserveData[PRESERVE_KEY]`. */
export interface Archive {
	/** Rendered frames ordered oldest to newest, re-derived from {@link text}
	 *  each compaction with foveated quality tiers (HQ/LQ/HQ inside the imaged
	 *  middle). May be empty when the whole archive fits in text. */
	frames: Frame[];
	/** Characters currently readable across all frames plus the text regions. */
	totalChars: number;
	/** Characters dropped so far to respect the archive budget. */
	truncatedChars: number;
	/** Full kept archive source (oldest to newest, normalized, bounded to the
	 *  rendered budget) — the single source re-rendered each compaction. */
	text?: string;
	/** Oldest text region kept verbatim around the imaged middle. */
	textHead?: string;
	/** Newest text region kept verbatim around the imaged middle. */
	textTail?: string;
}

export interface Geometry {
	/** Characters per row (per-column line width when `columns === 2`). */
	cols: number;
	rows: number;
	/** Characters that fit one frame (nominal upper bound on doc shapes,
	 *  where real consumption is wrap-dependent). */
	capacity: number;
}

export interface Options<TMessage = Message> extends SerializeOptions {
	/** App-level message transformer (same contract as agent-core's `SummaryOptions.convertToLlm`). */
	convertToLlm?: ConvertToLlm<TMessage>;
	/** Model whose provider API selects the frame shape. */
	model?: Pick<Model, "api">;
	/** Explicit shape override; wins over `model`. */
	shape?: Shape;
	/** Frame edge in pixels. Defaults to the shape's `frameSize`. */
	frameSize?: number;
	/** Upper limit on archive frames; clamped to (and defaulting to) {@link MAX_FRAMES_DEFAULT}. */
	maxFrames?: number;
}

/** Result of rendering one frame. */
export interface RenderedFrame {
	/** Base64-encoded PNG, as returned by the native renderer. */
	data: string;
	cols: number;
	rows: number;
	/** Characters printed (ink toggles excluded; input may be shorter than capacity). */
	chars: number;
}

// ============================================================================
// Compaction data contracts
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface CompactionPreparation<TMessage = Message> {
	/** UUID of first entry to keep. */
	firstKeptEntryId: string;
	/** Messages that will be archived and discarded. */
	messagesToSummarize: TMessage[];
	/** Messages that will be archived as the split-turn prefix, if any. */
	turnPrefixMessages: TMessage[];
	tokensBefore: number;
	/** Summary from previous compaction, for continuity when no prior snapcompact archive exists. */
	previousSummary?: string;
	/** Preserved opaque compaction payload from the previous compaction, if any. */
	previousPreserveData?: Record<string, unknown>;
	/** File operations extracted by the host agent. */
	fileOps: FileOperations;
}

export interface CompactionResult<T = CompactionDetails> {
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	preserveData?: Record<string, unknown>;
}

export type ConvertToLlm<TMessage = Message> = (messages: TMessage[]) => Message[];

function defaultConvertToLlm<TMessage>(messages: TMessage[]): Message[] {
	return messages as unknown as Message[];
}

// ============================================================================
// File operation helpers
// ============================================================================

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}
const URL_SCHEME_RE = /[a-z][a-z0-9+.-]*:\/\//i;

const HEADING_MARKER = " ¶";

export function isUrlSchemePath(path: string): boolean {
	return URL_SCHEME_RE.test(path);
}

export function computeFileLists(fileOps: FileOperations): CompactionDetails {
	const modified = new Set([...fileOps.edited, ...fileOps.written].filter(file => !isUrlSchemePath(file)));
	const readFiles = [...fileOps.read].filter(file => !isUrlSchemePath(file) && !modified.has(file)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles, modifiedFiles };
}

/**
 * Format file operations as one `<files>` tag: a grouped, prefix-folded
 * directory tree (find-tool shape) with a ` (Read)` / ` (Write)` / ` (RW)`
 * marker per file. `readSet` is the cumulative read set (`fileOps.read`),
 * used to tell modified files that were also read (RW) from blind writes.
 */
const FILE_OPERATION_SUMMARY_LIMIT = 20;

function stripFileOperationTags(summary: string): string {
	// Legacy <read-files>/<modified-files> tags are still stripped so summaries
	// written before the combined <files> tag self-heal on the next compaction.
	return summary
		.replace(/<files>[\s\S]*?<\/files>\s*/g, "")
		.replace(/<read-files>[\s\S]*?<\/read-files>\s*/g, "")
		.replace(/<modified-files>[\s\S]*?<\/modified-files>\s*/g, "")
		.trimEnd();
}

function formatFileList(readFiles: string[], modifiedFiles: string[], readSet?: ReadonlySet<string>): string {
	if (readFiles.length === 0 && modifiedFiles.length === 0) return "";
	const mode = new Map<string, "Read" | "Write" | "RW">();
	for (const file of readFiles) mode.set(file, "Read");
	for (const file of modifiedFiles) mode.set(file, readSet?.has(file) ? "RW" : "Write");
	const all = [...mode.keys()].sort();
	let files = formatGroupedPaths(all.slice(0, FILE_OPERATION_SUMMARY_LIMIT), path => ` (${mode.get(path)})`);
	if (all.length > FILE_OPERATION_SUMMARY_LIMIT) {
		files += `\n[…${all.length - FILE_OPERATION_SUMMARY_LIMIT} files elided…]`;
	}
	return files;
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[], readSet?: ReadonlySet<string>): string {
	const files = formatFileList(readFiles, modifiedFiles, readSet);
	return files.length > 0 ? prompt.render(fileOperationsTemplate, { files }) : "";
}

export function upsertFileOperations(
	summary: string,
	readFiles: string[],
	modifiedFiles: string[],
	readSet?: ReadonlySet<string>,
): string {
	const baseSummary = stripFileOperationTags(summary);
	const fileOperations = formatFileOperations(readFiles, modifiedFiles, readSet);
	if (!fileOperations) return baseSummary;
	if (!baseSummary) return fileOperations;
	return `${baseSummary}\n\n${fileOperations}`;
}

// ============================================================================
// Message serialization
// ============================================================================

/** Default per-tool-result character cap in serialized history. */
export const TOOL_RESULT_MAX_CHARS = 2000;

/** Default per-argument-value character cap inside serialized tool calls
 *  (write/edit bodies otherwise dump whole files into the archive). */
export const TOOL_ARG_MAX_CHARS = 500;

/** Default character cap across one tool call's full serialized argument list. */
export const TOOL_CALL_MAX_CHARS = 2000;

/** Default fraction of a truncation budget spent on the head; the remainder
 *  keeps the tail, where command errors and test failures usually land. */
export const TRUNCATE_HEAD_RATIO = 0.6;

/** Zero-width ink toggles understood by the native renderer (shift-out/in):
 *  text between them prints in dim gray ink without occupying a cell. */
export const DIM_ON = "\u000e";
export const DIM_OFF = "\u000f";

/** Character budgets applied while serializing discarded history for frame
 *  rendering. Pass `Infinity` to disable an individual cap. */
export interface SerializeOptions {
	/** Per-tool-result cap. Defaults to {@link TOOL_RESULT_MAX_CHARS}. */
	toolResultMaxChars?: number;
	/** Per-argument-value cap. Defaults to {@link TOOL_ARG_MAX_CHARS}. */
	toolArgMaxChars?: number;
	/** Whole-argument-list cap per call. Defaults to {@link TOOL_CALL_MAX_CHARS}. */
	toolCallMaxChars?: number;
	/** Head share of each budget, clamped to [0, 1]. Defaults to {@link TRUNCATE_HEAD_RATIO}. */
	truncateHeadRatio?: number;
	/** Print tool-result text in dim gray ink so archived conversation reads
	 *  louder than archived tool noise. Defaults to `true`. */
	dimToolResults?: boolean;
}

/** Keep the head and tail of `text`, eliding the middle beyond `maxChars`. */
function truncateForSummary(text: string, maxChars: number, headRatio: number): string {
	if (text.length <= maxChars) return text;
	const ratio = Math.min(Math.max(headRatio, 0), 1);
	const headChars = Math.round(maxChars * ratio);
	const tailChars = maxChars - headChars;
	const elided = text.length - maxChars;
	const tail = tailChars > 0 ? text.slice(-tailChars) : "";
	return `${text.slice(0, headChars)} […${elided}ch elided…] ${tail}`;
}

const DIM_MARKERS = /[\u000e\u000f]/g;

/** Plain-text history kept verbatim at each chronological edge, in HQ-frame-
 *  capacity units per edge. One page at the start and one at the end preserves
 *  high-fidelity context around the imaged middle while keeping the total text
 *  budget equal to the prior 2-page tail-only scheme. */
const TEXT_EDGE_PAGES = 1;

/** Normalized archive text → plain text: drop zero-width dim toggles and
 *  print newline glyphs as real newlines. */
function toPlainText(text: string): string {
	return stripDimMarkers(text).replaceAll(NEWLINE_GLYPH, "\n");
}

/** Strip stray ink toggles from raw content so it cannot forge dim spans. */
function stripDimMarkers(text: string): string {
	return text.replace(DIM_MARKERS, "");
}

export function serializeConversation(messages: Message[], options?: SerializeOptions): string {
	const toolResultMaxChars = options?.toolResultMaxChars ?? TOOL_RESULT_MAX_CHARS;
	const toolArgMaxChars = options?.toolArgMaxChars ?? TOOL_ARG_MAX_CHARS;
	const toolCallMaxChars = options?.toolCallMaxChars ?? TOOL_CALL_MAX_CHARS;
	const headRatio = options?.truncateHeadRatio ?? TRUNCATE_HEAD_RATIO;
	const dimToolResults = options?.dimToolResults !== false;
	const parts: string[] = [];

	// Tool results flagged contextually useless (and their paired calls) carry no
	// information worth archiving — skip the whole pair. Surviving results are
	// indexed by tool-call id so each merges into its originating `# Tool call`.
	const uselessCallIds = new Set<string>();
	const resultTextByCallId = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role !== "toolResult") continue;
		if (msg.useless === true && msg.isError !== true) {
			uselessCallIds.add(msg.toolCallId);
			continue;
		}
		const text = msg.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("");
		if (text) resultTextByCallId.set(msg.toolCallId, text);
	}

	// Wrap a raw tool-result body in an `<out>` block, dimming only the body so
	// the frame coloring keeps structure (headings, calls) loud.
	const renderResultBlock = (rawText: string): string => {
		const body = truncateForSummary(stripDimMarkers(rawText), toolResultMaxChars, headRatio);
		return `<out>\n${dimToolResults ? `${DIM_ON}${body}${DIM_OFF}` : body}\n</out>`;
	};

	const mergedCallIds = new Set<string>();

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((content): content is { type: "text"; text: string } => content.type === "text")
							.map(content => content.text)
							.join("");
			if (content) parts.push(`# User${HEADING_MARKER}\n${stripDimMarkers(content)}`);
		} else if (msg.role === "assistant") {
			// Stream blocks in content order: buffer thinking/text, then flush a
			// `# Assistant` block (thinking as italics above the text) right before
			// each tool call, so text or thinking after a call stays after it.
			let pendingThinking: string[] = [];
			let pendingText: string[] = [];
			const flushAssistant = () => {
				const sections: string[] = [];
				if (pendingThinking.length > 0) sections.push(`_${pendingThinking.join("\n")}_`);
				if (pendingText.length > 0) sections.push(pendingText.join("\n"));
				if (sections.length > 0) parts.push(`# Assistant${HEADING_MARKER}\n${sections.join("\n\n")}`);
				pendingThinking = [];
				pendingText = [];
			};

			for (const block of msg.content) {
				if (block.type === "text") {
					const text = stripDimMarkers(block.text);
					if (text.trim()) pendingText.push(text);
				} else if (block.type === "thinking") {
					const thinking = stripDimMarkers(block.thinking);
					if (thinking.trim()) pendingThinking.push(thinking);
				} else if (block.type === "toolCall") {
					if (uselessCallIds.has(block.id)) continue;
					flushAssistant();
					const args = block.arguments as Record<string, unknown>;
					// Prefer the harness-derived intent, else the raw intent arg; render it as
					// a one-line `//comment` and drop it from the args below.
					const rawIntent =
						typeof block.intent === "string"
							? block.intent
							: typeof args[INTENT_FIELD] === "string"
								? (args[INTENT_FIELD] as string)
								: "";
					const intent = stripDimMarkers(rawIntent).replace(/\s+/g, " ").trim();
					const argsStr = truncateForSummary(
						Object.entries(args)
							.filter(([key]) => key !== INTENT_FIELD)
							.map(
								([key, value]) =>
									`${key}=${truncateForSummary(JSON.stringify(value) ?? "undefined", toolArgMaxChars, headRatio)}`,
							)
							.join(", "),
						toolCallMaxChars,
						headRatio,
					);
					const lines = [`# Tool call${HEADING_MARKER}`];
					if (intent) lines.push(`//${intent}`);
					lines.push(`${block.name}(${argsStr})`);
					const resultText = resultTextByCallId.get(block.id);
					if (resultText !== undefined) {
						mergedCallIds.add(block.id);
						lines.push(renderResultBlock(resultText));
					}
					parts.push(lines.join("\n"));
				}
			}
			flushAssistant();
		} else if (msg.role === "toolResult") {
			// Paired results already merged into their `# Tool call` block above;
			// only orphans (call archived outside this window) render standalone.
			if (uselessCallIds.has(msg.toolCallId) || mergedCallIds.has(msg.toolCallId)) continue;
			const resultText = resultTextByCallId.get(msg.toolCallId);
			if (resultText !== undefined) parts.push(`# Tool call${HEADING_MARKER}\n${renderResultBlock(resultText)}`);
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Preserve-data helpers
// ============================================================================

const OPENAI_REMOTE_COMPACTION_PRESERVE_KEY = "openaiRemoteCompaction";

function stripOpenAiRemoteCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!preserveData || !(OPENAI_REMOTE_COMPACTION_PRESERVE_KEY in preserveData)) {
		return preserveData;
	}
	const { [OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: _removed, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

// ============================================================================
// Text normalization
// ============================================================================

/** Punctuation and symbol folds applied before the NFKD fallback in
 *  {@link normalize}: quotes, dashes, bullets, arrows, and dot leaders that
 *  have no compatibility decomposition (or one that is itself non-ASCII). */
const CHAR_FOLD: Record<string, string> = {
	// Quotation marks and primes.
	"\u2018": "'",
	"\u2019": "'",
	"\u201a": "'",
	"\u201b": "'",
	"\u201c": '"',
	"\u201d": '"',
	"\u201e": '"',
	"\u2032": "'",
	"\u2033": '"',
	"\u2035": "'",
	"\u2036": '"',
	"\u2039": "<",
	"\u203a": ">",
	// Dashes, hyphens, and the fraction slash NFKD leaves in vulgar fractions.
	"\u2010": "-",
	"\u2011": "-",
	"\u2012": "-",
	"\u2013": "-",
	"\u2014": "-",
	"\u2015": "-",
	"\u2212": "-",
	"\u2044": "/",
	// Dot leaders and ellipses.
	"\u2024": ".",
	"\u2025": "..",
	"\u2026": "...",
	"\u22ef": "...",
	// Bullets.
	"\u2022": "*",
	"\u2023": "*",
	"\u2043": "-",
	"\u2219": "*",
	"\u25cf": "*",
	"\u25a0": "*",
	"\u25aa": "*",
	// Arrows.
	"\u2190": "<-",
	"\u2191": "^",
	"\u2192": "->",
	"\u2193": "v",
	"\u2194": "<->",
	"\u21d0": "<=",
	"\u21d2": "=>",
	"\u21d4": "<=>",
	// Check marks and crosses.
	"\u2713": "v",
	"\u2714": "v",
	"\u2717": "x",
	"\u2718": "x",
};

/** Printed in place of newline runs: the native renderer fills this cell
 *  entirely with pitch-black ink, so line structure survives whitespace
 *  collapsing at a one-cell cost. */
export const NEWLINE_GLYPH = "\u2588";

/** Collapsed in one pass: whitespace plus zero-width format characters (ZWSP,
 *  BOM, directional marks — JS `\s` already counts BOM as whitespace, so they
 *  must fold here, before the per-character pass). */
const COLLAPSIBLE = /[\s\p{Cf}]+/gu;

/** Runs carrying one of these collapse to {@link NEWLINE_GLYPH}. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/** Leading/trailing spaces or newline glyphs add no information to a frame. */
const EDGE_RUNS = /^[ \u2588]+|[ \u2588]+$/g;

/** Glyph-less code points skipped outright instead of printing `?`: controls
 *  (bare ESC/BEL/NUL — full ANSI sequences are stripped beforehand),
 *  combining marks the fonts cannot compose, and lone surrogates. */
const UNRENDERABLE = /[\p{Cc}\p{Mn}\p{Me}\p{Cs}]/u;

/** Combining marks NFKD splits off accented letters; dropped so the base
 *  letter prints without the diacritic the bundled fonts cannot compose. */
const COMBINING_MARKS = /\p{M}+/gu;

/**
 * Aggressive single-code-point ASCII fold via Unicode NFKD: decompose the
 * compatibility form (fullwidth, super/subscripts, ligatures, circled and
 * math-styled alphanumerics, Roman numerals, vulgar fractions, …), strip the
 * combining marks, and keep the ASCII/Latin-1 skeleton — routing any residual
 * punctuation back through {@link CHAR_FOLD}. Returns `undefined` when the code
 * point has no decomposition or still leaves an undrawable glyph, so the
 * caller falls back to `?`.
 */
function foldToAscii(ch: string): string | undefined {
	const decomposed = ch.normalize("NFKD").replace(COMBINING_MARKS, "");
	if (decomposed === ch) return undefined;
	let out = "";
	for (const part of decomposed) {
		const cp = part.codePointAt(0) as number;
		if ((cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp <= 0xff)) {
			out += part;
			continue;
		}
		const fold = CHAR_FOLD[part];
		if (fold === undefined) return undefined;
		out += fold;
	}
	return out;
}

/**
 * Prepare text for printing: strip ANSI escape sequences, collapse horizontal
 * whitespace runs to single spaces and newline-bearing runs to one
 * {@link NEWLINE_GLYPH} (drawn as a pitch-black cell), then fold everything
 * outside the fonts' ASCII + Latin-1 coverage to ASCII approximations — first
 * through the {@link CHAR_FOLD} punctuation table, then via an NFKD
 * decomposition that recovers the ASCII skeleton of compatibility characters
 * (fullwidth, super/subscripts, ligatures, circled/math-styled alphanumerics,
 * Roman numerals, vulgar fractions). Unrenderable control/format/combining
 * characters are dropped without occupying a cell; `?` remains the fallback
 * for unsupported graphic characters. The zero-width ink toggles
 * {@link DIM_ON}/{@link DIM_OFF} pass through untouched.
 */
export function normalize(text: string): string {
	const stripped = text.includes("\u001b") ? Bun.stripANSI(text) : text;
	const collapsed = stripped
		// A run of pure format chars (BOM is both \s and Cf) vanishes; only a
		// run containing genuine whitespace separates words.
		.replace(COLLAPSIBLE, run => (LINE_BREAK.test(run) ? NEWLINE_GLYPH : /[^\p{Cf}]/u.test(run) ? " " : ""))
		.replace(EDGE_RUNS, "");
	let out = "";
	for (const ch of collapsed) {
		const cp = ch.codePointAt(0) as number;
		if ((cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp <= 0xff)) {
			out += ch;
			continue;
		}
		if (ch === DIM_ON || ch === DIM_OFF || ch === NEWLINE_GLYPH) {
			out += ch;
			continue;
		}
		const fold = CHAR_FOLD[ch];
		if (fold !== undefined) {
			out += fold;
		} else if (cp >= 0x2500 && cp <= 0x257f) {
			// Box drawing: keep table skeletons legible.
			out += cp === 0x2502 || cp === 0x2503 ? "|" : cp === 0x2500 || cp === 0x2501 ? "-" : "+";
		} else {
			const folded = foldToAscii(ch);
			if (folded !== undefined) out += folded;
			else if (!UNRENDERABLE.test(ch)) out += "?";
		}
	}
	return out;
}

/**
 * Scan text to determine the proportion of graphic characters that will hit the
 * `?` fallback during {@link normalize}. Used as a preflight check to abort
 * snapcompact and fall back to the text summarizer when the input is heavily
 * non-renderable (e.g., CJK).
 */
export function scanRenderability(text: string): { isSafe: boolean; unrenderableRatio: number } {
	const stripped = text.includes("\u001b") ? Bun.stripANSI(text) : text;
	const collapsed = stripped
		.replace(COLLAPSIBLE, run => (LINE_BREAK.test(run) ? NEWLINE_GLYPH : /[^\p{Cf}]/u.test(run) ? " " : ""))
		.replace(EDGE_RUNS, "");
	let totalGraphics = 0;
	let fallbackCount = 0;
	for (const ch of collapsed) {
		const cp = ch.codePointAt(0) as number;
		if ((cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp <= 0xff)) {
			totalGraphics++;
			continue;
		}
		if (ch === DIM_ON || ch === DIM_OFF || ch === NEWLINE_GLYPH) {
			continue;
		}
		const fold = CHAR_FOLD[ch];
		if (fold !== undefined) {
			totalGraphics++;
		} else if (cp >= 0x2500 && cp <= 0x257f) {
			totalGraphics++;
		} else {
			const folded = foldToAscii(ch);
			if (folded !== undefined) {
				totalGraphics++;
			} else if (!UNRENDERABLE.test(ch)) {
				totalGraphics++;
				fallbackCount++;
			}
		}
	}
	const unrenderableRatio = totalGraphics > 0 ? fallbackCount / totalGraphics : 0;
	return { isSafe: unrenderableRatio <= 0.05, unrenderableRatio };
}

// ============================================================================
// Stopword dimming
// ============================================================================

/** High-frequency function words a reader can reconstruct from context; the
 *  dim shapes render them in light gray so content words carry the contrast
 *  (verbatim from `research/bdf.py` `_STOPWORDS`). */
const STOPWORDS: ReadonlySet<string> = new Set(
	(
		"the a an and or of to in on at as is are was were be been by for with that this it its from had has have not but " +
		"he she his her they their them which also who whom when where while will would could should there then than " +
		"into over under about after before between during each such these those some most more other only same so"
	).split(" "),
);

/** Maximal alphabetic runs (ASCII + Latin-1 letters, the fonts' coverage). */
const ALPHA_RUN = /[a-zA-Z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff]+/g;

/** Splitter that keeps the zero-width ink toggles as their own segments. */
const DIM_MARKER_SPLIT = /([\u000e\u000f])/;

/**
 * Wrap each maximal alphabetic run that is a stopword in {@link DIM_ON} /
 * {@link DIM_OFF} so it prints in dim gray ink. Spans that are already dim
 * (e.g. archived tool output) pass through untouched — wrapping there would
 * terminate the enclosing dim span early. Markers are zero-width, so the
 * visible glyph count is unchanged.
 */
export function dimStopwords(text: string): string {
	const parts = text.split(DIM_MARKER_SPLIT);
	let dim = false;
	let out = "";
	for (const part of parts) {
		if (part === DIM_ON) {
			dim = true;
			out += part;
		} else if (part === DIM_OFF) {
			dim = false;
			out += part;
		} else if (dim) {
			out += part;
		} else {
			out += part.replace(ALPHA_RUN, word => (STOPWORDS.has(word.toLowerCase()) ? DIM_ON + word + DIM_OFF : word));
		}
	}
	return out;
}

// ============================================================================
// Doc layout (two word-wrapped newspaper columns)
// ============================================================================

/** Char cells between the two doc columns (research exp14 `GUTTER`). */
const DOC_GUTTER = 3;

/**
 * Greedy word-wrap, no mid-word breaks (hard split only for width+ words) —
 * ported verbatim from `research/exp14_bestgpt.py` `wrap()`. Zero-width dim
 * markers count toward word length here; serialized history places them at
 * word boundaries, so the drift is at most one cell per affected line.
 */
export function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	let cur = "";
	for (const token of text.split(/\s+/)) {
		if (token.length === 0) continue;
		let word = token;
		while (word.length > width) {
			// Pathological; never hit on prose.
			if (cur) {
				lines.push(cur);
				cur = "";
			}
			lines.push(word.slice(0, width));
			word = word.slice(width);
		}
		if (!cur) {
			cur = word;
		} else if (cur.length + 1 + word.length <= width) {
			cur += ` ${word}`;
		} else {
			lines.push(cur);
			cur = word;
		}
	}
	if (cur) lines.push(cur);
	return lines;
}

/**
 * Paginate already-normalized text for a doc shape: wrap once at the column
 * width, then slice into pages of `2 * rows` lines, each page `\n`-joined.
 * Every input character lands on exactly one page (whitespace becomes the
 * wrap points).
 */
function docPages(normalized: string, geo: Geometry): string[] {
	const lines = wrap(normalized, geo.cols);
	const perPage = 2 * geo.rows;
	const pages: string[] = [];
	for (let offset = 0; offset < lines.length; offset += perPage) {
		pages.push(lines.slice(offset, offset + perPage).join("\n"));
	}
	return pages;
}

// ============================================================================
// Rendering
// ============================================================================

export function geometry(shape: Shape, size: number = shape.frameSize): Geometry {
	const gridCols = Math.floor(size / shape.cellWidth);
	const rows = Math.floor(size / shape.cellHeight / shape.lineRepeat);
	if (shape.columns === 2) {
		const cols = Math.floor((gridCols - DOC_GUTTER) / 2);
		return { cols, rows, capacity: 2 * cols * rows };
	}
	return { cols: gridCols, rows, capacity: gridCols * rows };
}

const NEWLINES = /\n/g;

function nativeRenderOptions(shape: Shape, size: number) {
	return {
		size,
		font: shape.font,
		cellWidth: shape.cellWidth,
		cellHeight: shape.cellHeight,
		stretch: shape.stretch,
		variant: shape.variant,
		lineRepeat: shape.lineRepeat,
		columns: shape.columns,
	};
}

function renderedChars(text: string, shape: Shape, capacity: number): number {
	let visible = text.length - (text.match(DIM_MARKERS)?.length ?? 0);
	// Doc line separators consume no cell; in the grid they print as a blank.
	if (shape.columns === 2) visible -= text.match(NEWLINES)?.length ?? 0;
	return Math.min(visible, capacity);
}

/** Render one snapcompact frame from already-normalized text. Doc shapes
 *  (`columns === 2`) expect one page of `\n`-joined pre-wrapped lines. */
export async function render(text: string, shape: Shape, size: number = shape.frameSize): Promise<RenderedFrame> {
	const { cols, rows, capacity } = geometry(shape, size);
	const chars = renderedChars(text, shape, capacity);
	const data = await renderSnapcompactPng(text, nativeRenderOptions(shape, size));
	return { data, cols, rows, chars };
}

/** Stateful per-page text finisher: re-opens a dim span the previous page
 *  boundary cut through, then applies stopword dimming when the shape asks
 *  for it (after pagination, so capacity math never sees the markers). */
function pageFinisher(shape: Shape): (page: string) => string {
	let dimOpen = false;
	return page => {
		const text = dimOpen ? DIM_ON + page : page;
		dimOpen = text.lastIndexOf(DIM_ON) > text.lastIndexOf(DIM_OFF);
		return shape.stopwordDim ? dimStopwords(text) : text;
	};
}

/** Options for {@link renderMany} and {@link frames}. */
export interface RenderManyOptions {
	/** Explicit shape; wins over `model`. */
	shape?: Shape;
	/** Model whose `api` selects the eval-optimal shape. */
	model?: Pick<Model, "api">;
	/** Frame edge in px; defaults to the shape's `frameSize`. */
	frameSize?: number;
	/** Hard cap on frames produced; omit for unbounded (caller decides usage). */
	maxFrames?: number;
}

/**
 * Render arbitrary text into snapcompact PNG frames as LLM image blocks
 * (first page first). Empty/whitespace-only input yields no frames.
 */
export async function renderMany(text: string, options?: RenderManyOptions): Promise<ImageContent[]> {
	const shape = options?.shape ?? resolveShape(options?.model);
	const frameSize = options?.frameSize ?? shape.frameSize;
	const geo = geometry(shape, frameSize);
	const normalized = normalize(text);
	const cap = options?.maxFrames;
	// Build the per-frame texts in order first (cheap, synchronous), then fan
	// the native PNG renders out concurrently — render() is async/off-thread,
	// so awaiting each before starting the next leaves throughput on the table.
	const pageTexts: string[] = [];
	if (shape.columns === 2) {
		const finish = pageFinisher(shape);
		for (const page of docPages(normalized, geo)) {
			if (cap !== undefined && pageTexts.length >= cap) break;
			pageTexts.push(finish(page));
		}
	} else {
		for (let offset = 0; offset < normalized.length; offset += geo.capacity) {
			if (cap !== undefined && pageTexts.length >= cap) break;
			let chunk = normalized.slice(offset, offset + geo.capacity);
			if (shape.stopwordDim) chunk = dimStopwords(chunk);
			pageTexts.push(chunk);
		}
	}
	const rendered = await Promise.all(pageTexts.map(page => render(page, shape, frameSize)));
	return rendered.map(frame => ({
		type: "image",
		data: frame.data,
		mimeType: "image/png",
		...(shape.imageDetail ? { detail: shape.imageDetail } : {}),
	}));
}

/** Frames needed to hold `text` at the given shape/size, without rendering.
 *  For doc shapes this wraps the text once and counts pages of `2 * rows`
 *  lines; for grid shapes it divides by the frame capacity. */
export function frames(text: string, options?: Pick<RenderManyOptions, "shape" | "model" | "frameSize">): number {
	const shape = options?.shape ?? resolveShape(options?.model);
	const geo = geometry(shape, options?.frameSize ?? shape.frameSize);
	const normalized = normalize(text);
	if (shape.columns === 2) return Math.ceil(wrap(normalized, geo.cols).length / (2 * geo.rows));
	return Math.ceil(normalized.length / geo.capacity);
}

// ============================================================================
// Archive helpers
// ============================================================================

/** Validate and extract a persisted frame archive from `preserveData`. */
export function getPreservedArchive(preserveData: Record<string, unknown> | undefined): Archive | undefined {
	const candidate = preserveData?.[PRESERVE_KEY];
	if (!candidate || typeof candidate !== "object") return undefined;
	const archive = candidate as Archive;
	const frames = Array.isArray(archive.frames)
		? archive.frames.filter(
				frame =>
					!!frame &&
					typeof frame.data === "string" &&
					frame.data.length > 0 &&
					typeof frame.mimeType === "string" &&
					typeof frame.cols === "number" &&
					typeof frame.rows === "number" &&
					typeof frame.chars === "number",
			)
		: [];
	const text = typeof archive.text === "string" && archive.text.length > 0 ? archive.text : undefined;
	const textHead = typeof archive.textHead === "string" && archive.textHead.length > 0 ? archive.textHead : undefined;
	const textTail = typeof archive.textTail === "string" && archive.textTail.length > 0 ? archive.textTail : undefined;
	// A text-only archive (everything fit in the plain-text regions) is valid;
	// only an archive carrying neither frames nor text is empty.
	if (frames.length === 0 && text === undefined && textHead === undefined && textTail === undefined) return undefined;
	return {
		frames,
		totalChars: typeof archive.totalChars === "number" ? archive.totalChars : 0,
		truncatedChars: typeof archive.truncatedChars === "number" ? archive.truncatedChars : 0,
		...(text !== undefined ? { text } : {}),
		...(textHead !== undefined ? { textHead } : {}),
		...(textTail !== undefined ? { textTail } : {}),
	};
}

/** Drop the persisted frame archive ({@link PRESERVE_KEY}) from `preserveData`,
 *  returning the remaining state — or `undefined` when nothing else remains, so
 *  an empty `{}` is never persisted. Callers strip the archive once its frames
 *  have been migrated into a new compaction's text, preventing the stale frames
 *  from leaking back into the rebuilt context. */
export function stripPreservedArchive(
	preserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!preserveData || !(PRESERVE_KEY in preserveData)) return preserveData;
	const { [PRESERVE_KEY]: _removed, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Extract persisted archive source text as plain text for LLM summarization. */
export function archiveSourceText(archive: Archive): string | undefined {
	const text =
		archive.text ??
		[archive.textHead, archive.textTail]
			.filter((part): part is string => typeof part === "string" && part.length > 0)
			.join(NEWLINE_GLYPH);
	return text.length > 0 ? toPlainText(text) : undefined;
}

/** Convert archive frames into LLM image blocks (oldest first). */
export function images(archive: Archive): ImageContent[] {
	return archive.frames.map(frame => ({
		type: "image",
		data: frame.data,
		mimeType: frame.mimeType,
		...(frame.detail ? { detail: frame.detail } : {}),
	}));
}
/** Ordered archive blocks for a compaction summary message, oldest to newest:
 *  the oldest text region, the imaged middle, then the newest text region.
 *  Runtime-only; reconstructed from {@link Archive} on each context rebuild
 *  instead of persisted on the session entry. */
export function historyBlocks(archive: Archive): (TextContent | ImageContent)[] {
	const blocks: (TextContent | ImageContent)[] = [];
	const hasImages = archive.frames.length > 0;
	if (archive.textHead) {
		const suffix = hasImages ? "\n-------------- imaged middle below\n" : "";
		blocks.push({ type: "text", text: toPlainText(archive.textHead) + suffix });
	}
	blocks.push(...images(archive));
	if (archive.textTail) {
		const prefix = hasImages
			? "-------------- imaged middle above\n"
			: archive.truncatedChars > 0
				? "\n-------------- middle history omitted above\n"
				: "";
		const tail = prefix + toPlainText(archive.textTail);
		if (blocks.length > 0 && blocks[blocks.length - 1]?.type === "text") {
			(blocks[blocks.length - 1] as TextContent).text += tail;
		} else {
			blocks.push({ type: "text", text: tail });
		}
	}
	return blocks;
}

// ============================================================================
// Compaction entry point
// ============================================================================

/** Denser companion of `high` for the foveated archive middle: same family and
 *  frame size (identical per-frame bill) but a tighter cell. Returns `high`
 *  unchanged for doc layouts or when no denser variant exists (foveation off). */
function denseCompanion(high: Shape, api: Api | undefined): Shape {
	if (high.columns === 2) return high;
	const family = billingFamily(api);
	const low = priceShape({ ...SHAPE_VARIANTS[FAMILY_VARIANT_LOW[family]], frameSize: high.frameSize }, family);
	return geometry(low).capacity > geometry(high).capacity ? low : high;
}

/** One planned frame: the source slice and the shape (quality tier) to render. */
interface PlanFrame {
	text: string;
	shape: Shape;
}

/** A foveated archive layout: frames oldest→newest for the imaged middle, the
 *  verbatim text kept at both chronological edges, the flat kept source to
 *  persist, and the chars dropped this round to fit the budget. */
interface ArchiveLayout {
	frames: PlanFrame[];
	textHead: string;
	textTail: string;
	keptText: string;
	truncatedChars: number;
}

/** Slice `text` into `capacity`-char frames at one shape (tier). */
function sliceFrames(text: string, capacity: number, shape: Shape): PlanFrame[] {
	const out: PlanFrame[] = [];
	for (let offset = 0; offset < text.length; offset += capacity) {
		out.push({ text: text.slice(offset, offset + capacity), shape });
	}
	return out;
}

/**
 * Lay out the accumulated archive `text` (oldest→newest) with text at both
 * chronological edges and images in the middle. One HQ-capacity stays verbatim
 * at the oldest edge, one at the newest edge, and the middle between them is
 * imaged. If the imaged middle itself overflows `maxFrames`, foveate it
 * internally (HQ/LQ/HQ) and drop the oldest slice of its dense center.
 */
function planArchive(text: string, high: Shape, low: Shape, maxFrames: number): ArchiveLayout {
	const capHi = geometry(high).capacity;
	const edgeCap = TEXT_EDGE_PAGES * capHi;
	if (text.length <= 2 * edgeCap) {
		return { frames: [], textHead: text, textTail: "", keptText: text, truncatedChars: 0 };
	}
	if (maxFrames < 1) {
		const textHead = text.slice(0, edgeCap);
		const textTail = text.slice(text.length - edgeCap);
		return {
			frames: [],
			textHead,
			textTail,
			keptText: textHead + textTail,
			truncatedChars: text.length - textHead.length - textTail.length,
		};
	}

	const textHead = text.slice(0, edgeCap);
	const textTail = text.slice(text.length - edgeCap);
	const imageText = text.slice(edgeCap, text.length - edgeCap);
	if (imageText.length === 0) {
		return { frames: [], textHead: text, textTail: "", keptText: text, truncatedChars: 0 };
	}

	// Doc layouts wrap (no char-slicing) and don't foveate: one tier, keep the
	// newest pages with the session head pinned, drop the oldest middle.
	if (high.columns === 2) {
		const pages = docPages(imageText, geometry(high));
		let kept = pages;
		let truncatedChars = 0;
		if (pages.length > maxFrames) {
			const dropped = pages.slice(1, pages.length - (maxFrames - 1));
			truncatedChars = dropped.reduce((sum, page) => sum + page.length, 0);
			kept = [...pages.slice(0, 1), ...pages.slice(pages.length - (maxFrames - 1))];
		}
		const flat = kept.map(page => page.replaceAll("\n", " ")).join(" ");
		return {
			frames: kept.map(page => ({ text: page, shape: high })),
			textHead,
			textTail,
			keptText: textHead + flat + textTail,
			truncatedChars,
		};
	}

	// Grid: render all-HQ when the image region fits the budget outright.
	if (Math.ceil(imageText.length / capHi) <= maxFrames) {
		return {
			frames: sliceFrames(imageText, capHi, high),
			textHead,
			textTail,
			keptText: textHead + imageText + textTail,
			truncatedChars: 0,
		};
	}

	// Foveate the imaged middle: HQ edges, dense center, drop the oldest dense slice.
	const capLo = geometry(low).capacity;
	const imageEdgeFrames = Math.min(HQ_EDGE_FRAMES, Math.floor((maxFrames - 1) / 2));
	const imageEdgeCap = imageEdgeFrames * capHi;
	const imageHead = imageText.slice(0, imageEdgeCap);
	const imageTail = imageEdgeCap > 0 ? imageText.slice(imageText.length - imageEdgeCap) : "";
	let middleText = imageText.slice(imageEdgeCap, imageText.length - imageEdgeCap);
	let truncatedChars = 0;
	const middleCap = (maxFrames - 2 * imageEdgeFrames) * capLo;
	if (middleText.length > middleCap) {
		truncatedChars = middleText.length - middleCap;
		middleText = middleText.slice(truncatedChars);
	}
	return {
		frames: [
			...sliceFrames(imageHead, capHi, high),
			...sliceFrames(middleText, capLo, low),
			...sliceFrames(imageTail, capHi, high),
		],
		textHead,
		textTail,
		keptText: textHead + imageHead + middleText + imageTail + textTail,
		truncatedChars,
	};
}

/**
 * Run a snapcompact compaction over prepared messages. Fully local: serializes
 * the discarded history, appends it to the accumulated archive source text, and
 * re-renders that source into an ordered history layout: plain text at the
 * oldest edge, imaged middle, then plain text at the newest edge. The imaged
 * middle itself foveates (HQ/LQ/HQ) when it grows large.
 *
 * The full kept source persists on the archive (`text`) so each later compaction
 * unfolds and re-renders it coherently alongside the newly archived history.
 *
 * If the previous compaction was text-based, its summary is printed at the head
 * of the archive as `[Summary of earlier history]` so no continuity is lost.
 */
export async function compact<TMessage = Message>(
	preparation: CompactionPreparation<TMessage>,
	options?: Options<TMessage>,
): Promise<CompactionResult> {
	const { firstKeptEntryId, tokensBefore, previousSummary, previousPreserveData, fileOps } = preparation;
	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no ID - session may need migration");
	}
	const baseShape = options?.shape ?? resolveShape(options?.model);
	const frameSize = options?.frameSize ?? baseShape.frameSize;
	const high = frameSize === baseShape.frameSize ? baseShape : { ...baseShape, frameSize };
	const low = denseCompanion(high, options?.model?.api);
	const geo = geometry(high);
	// The engine default caps archive growth; a caller-supplied maxFrames only
	// lowers it further (an upper limit), never raising it past the default.
	const maxFrames = Math.max(1, Math.min(options?.maxFrames ?? MAX_FRAMES_DEFAULT, MAX_FRAMES_DEFAULT));

	const messages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(messages);
	let archiveText = normalize(serializeConversation(llmMessages, options));

	const previousArchive = getPreservedArchive(previousPreserveData);
	const previousText =
		previousArchive?.text ??
		[previousArchive?.textHead, previousArchive?.textTail]
			.filter((part): part is string => typeof part === "string" && part.length > 0)
			.join(NEWLINE_GLYPH);
	const hasPreviousText = previousText.length > 0;
	const includedPreviousSummary = !hasPreviousText && !!previousSummary;
	if (includedPreviousSummary && previousSummary) {
		const head = `[Summary of earlier history] ${normalize(previousSummary)}`;
		archiveText = archiveText.length > 0 ? `${head} [Recent conversation] ${archiveText}` : head;
	}

	let truncatedChars = previousArchive?.truncatedChars ?? 0;

	// Re-compacting a snapcompacted history unfolds the prior archive's source
	// text and treats it as one coherent transcript: the previous kept source
	// ages in ahead of the new history, then the whole thing is re-rendered.
	if (hasPreviousText) {
		archiveText = archiveText.length > 0 ? `${previousText}${NEWLINE_GLYPH}${archiveText}` : previousText;
	}

	const layout = planArchive(archiveText, high, low, maxFrames);
	truncatedChars += layout.truncatedChars;

	// Re-render the planned frames, carrying any open dim span across every
	// boundary: textHead → frames → textTail.
	let dimOpen = layout.textHead.lastIndexOf(DIM_ON) > layout.textHead.lastIndexOf(DIM_OFF);
	const newFrames: Promise<Frame>[] = [];
	for (const planned of layout.frames) {
		let pageText: string = dimOpen ? DIM_ON + planned.text : planned.text;
		dimOpen = pageText.lastIndexOf(DIM_ON) > pageText.lastIndexOf(DIM_OFF);
		if (planned.shape.stopwordDim) pageText = dimStopwords(pageText);
		newFrames.push(
			render(pageText, planned.shape).then(rendered => ({
				data: rendered.data,
				mimeType: "image/png",
				cols: rendered.cols,
				rows: rendered.rows,
				chars: rendered.chars,
				font: planned.shape.font,
				variant: planned.shape.variant,
				lineRepeat: planned.shape.lineRepeat,
				...(planned.shape.columns === 2 ? { columns: 2 } : {}),
				...(planned.shape.stopwordDim ? { stopwordDim: true } : {}),
				...(planned.shape.imageDetail ? { detail: planned.shape.imageDetail } : {}),
			})),
		);
	}

	const textHead = layout.textHead;
	const textTail = layout.textTail.length > 0 ? (dimOpen ? DIM_ON : "") + layout.textTail : "";
	const textChars = textHead.length + textTail.length;

	const frames = await Promise.all(newFrames);
	const totalChars = frames.reduce((sum, frame) => sum + frame.chars, 0) + textChars;
	const mixedShapes = frames.some(
		frame =>
			frame.cols !== geo.cols ||
			frame.rows !== geo.rows ||
			(frame.variant ?? "sent") !== high.variant ||
			(frame.lineRepeat ?? 1) !== high.lineRepeat ||
			(frame.columns ?? 1) !== (high.columns ?? 1) ||
			(frame.stopwordDim ?? false) !== (high.stopwordDim ?? false),
	);

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	const files = formatFileList(readFiles, modifiedFiles, fileOps.read);

	let summary: string;
	if (frames.length === 0 && textHead.length === 0 && textTail.length === 0 && files.length === 0) {
		summary = "No prior history.";
	} else {
		summary = prompt.render(snapcompactSummaryPrompt, {
			frameCount: frames.length,
			multipleFrames: frames.length > 1,
			docColumns: high.columns === 2,
			cols: geo.cols,
			rows: geo.rows,
			sentenceInk: high.variant === "sent",
			stopwordDimmed: high.stopwordDim === true,
			dimmedToolResults: options?.dimToolResults !== false,
			lineRepeated: high.lineRepeat > 1,
			mixedShapes,
			truncatedChars,
			includedPreviousSummary,
			files: files.length > 0 ? files : undefined,
		});
	}

	// A snapcompact pass replaces any provider-side replacement history; strip the
	// OpenAI remote-compaction payload like the default summarizer path does.
	const basePreserve = stripOpenAiRemoteCompactionPreserveData(previousPreserveData) ?? {};
	const persistedText =
		layout.keptText.length > 0 && layout.textTail.length > 0
			? `${layout.keptText.slice(0, layout.keptText.length - layout.textTail.length)}${textTail}`
			: layout.keptText;
	const archive: Archive = {
		frames,
		totalChars,
		truncatedChars,
		...(persistedText.length > 0 ? { text: persistedText } : {}),
		...(textHead ? { textHead } : {}),
		...(textTail ? { textTail } : {}),
	};

	const textNote = textChars > 0 ? ` (+${textChars.toLocaleString()} chars as text)` : "";
	return {
		summary,
		shortSummary: `Archived ${totalChars.toLocaleString()} chars of history onto ${frames.length} snapcompact frame${frames.length === 1 ? "" : "s"}${textNote}`,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles },
		preserveData: { ...basePreserve, [PRESERVE_KEY]: archive },
	};
}
