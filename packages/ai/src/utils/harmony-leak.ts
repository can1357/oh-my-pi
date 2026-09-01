/**
 * GPT-5 Harmony-header leakage detection and recovery.
 *
 * Background and policy: see `docs/ERRATA-GPT5-HARMONY.md`. This module
 * implements §3 of that document: detection by signal fusion, plus a
 * truncate-and-resume primitive for the `edit` tool when its input is in
 * hashline DSL form. Other tools and surfaces fall through to
 * abort-and-retry handled by the agent loop.
 */
import type { AssistantMessage, Model, ToolCall } from "../types";

// Single source of truth for the marker pattern. `M` in the errata.
// Use a fresh non-global instance for `.test()` to avoid lastIndex pitfalls.
const MARKER_RE = /\bto=functions\.[A-Za-z_]\w*/g;
const HARMONY_RE = /<\|(start|end|channel|message|call|return)\|>/g;

// Reserved Harmony control-token spellings. Escaping these to their inert
// backslash form lets untrusted data (user text, tool results) reach
// harmony-server models (gpt-5.x) without the provider's prompt validator
// rejecting the whole request (invalid_prompt / "Request blocked"). `constrain`
// is escaped too — it is a real control token even though it is not a leak
// signal on its own.
const HARMONY_CONTROL_TOKEN_ESCAPE_RE = /<\|(start|end|message|channel|constrain|return|call)\|>/g;

/**
 * Escape reserved Harmony control tokens in arbitrary text so it can be
 * transported as data to a harmony-dialect model. Returns the input unchanged
 * when it carries no reserved spelling.
 *
 * Callers MUST gate on a harmony target and escape only the transport copy —
 * the persisted transcript keeps the byte-for-byte original.
 */
export function escapeHarmonyControlTokens(text: string): string {
	return text.replace(HARMONY_CONTROL_TOKEN_ESCAPE_RE, "<\\|$1\\|>");
}

/**
 * Escape reserved Harmony control tokens inside a JSON document string (e.g.
 * `function_call.arguments`). Doubles the backslash so the document remains
 * valid JSON whose *decoded* strings carry the inert `<\|token\|>` spelling.
 * `<|` cannot occur outside a string literal in valid JSON, so the blanket
 * replace never corrupts structure; malformed documents are escaped
 * best-effort.
 */
export function escapeHarmonyControlTokensInJson(text: string): string {
	return text.replace(HARMONY_CONTROL_TOKEN_ESCAPE_RE, "<\\\\|$1\\\\|>");
}

/**
 * Whether requests to `model` are served by a Harmony-dialect backend
 * (gpt-5.x / gpt-oss), which rejects reserved control-token spellings appearing
 * as data in the request. Resolves the wire model id (`requestModelId ?? id`)
 * so deployment/catalog aliases — e.g. an Azure alias whose `requestModelId` is
 * `gpt-5.4` — are detected even when the local id is opaque.
 */
export function isHarmonyDialectModel(model: Model): boolean {
	return model.identity.class === "gpt-oss";
}

// Channel-word adjacency (`C`): channel/role name appearing immediately before the marker.
const CHANNEL_WORD_RE = /\b(?:analysis|commentary|assistant|user|system|developer|tool)\s+to=functions\./;

// Glitch-token adjacency (`G`). The Japgolly literal is escaped so this regex
// source itself does not trip detection if the file is scanned (e.g. when
// editing this module via the same agent that detects).
const GLITCH_RE = /\b(?:changedFiles|RTLU|Jsii(?:_commentary)?|\x4aapgolly)\b/;

// Body-channel cascade (`B`): marker followed by ` code` then another marker
// within 200 chars. Single regex; no manual slicing needed.
const BODY_CASCADE_RE = /to=functions\.\w+\s+code\b[\s\S]{0,200}?to=functions\./;

// Fake-result framing (`R`): marker followed within 80 chars by Cell N: framing.
const FAKE_RESULT_RE = /to=functions\.\w+[\s\S]{0,80}?code_output\s*\nCell\s+\d+:/;

const FENCE_RE = /^\s*(?:```+|~~~+)/;

// Non-Latin scripts seen in the corpus: CJK + ext, Cyrillic, Thai, Georgian,
// Armenian, Kannada, Telugu, Devanagari, Arabic, Malayalam.
const SCRIPT_CLASS =
	"\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u0400-\u04FF\u0E00-\u0E7F\u10A0-\u10FF\u0530-\u058F\u0C80-\u0CFF\u0C00-\u0C7F\u0900-\u097F\u0600-\u06FF\u0D00-\u0D7F";
const SCRIPT_RUN_RE = new RegExp(`[${SCRIPT_CLASS}]{2,}`, "u");

// Recovery registry. Each entry's parser must recognize the configured
// sentinel (per-tool, see eval/parse.ts and hashline/executor.ts) and surface
// a warning to the model so it knows to re-issue any remaining work.
// `accepts` gates on input shape: tools whose contaminated input doesn't
// match the parser's expected DSL fall through to abort-and-retry.
//
// • `edit`: hashline DSL input begins with `@<path>`. Apply_patch envelopes
//   (`*** Begin Patch …`) and JSON-schema variants are not recoverable —
//   their parsers don't recognize `*** Abort`.
// • `eval`: any string is a parseable cell sequence (the parser is lenient
//   and falls back to implicit-cell mode on bare strings).
interface RecoveryConfig {
	sentinel: string;
	accepts: (input: string) => boolean;
}
const RECOVERY_REGISTRY: Record<string, RecoveryConfig> = {
	edit: {
		sentinel: "\n*** Abort\n",
		accepts: input => input.replace(/^\s+/, "").startsWith("@"),
	},
	eval: {
		sentinel: "\n*** Abort\n",
		accepts: () => true,
	},
};

const SIGNAL_ORDER = ["M", "C", "G", "S", "B", "R", "T"] as const;

export type HarmonySignalClass = "H" | (typeof SIGNAL_ORDER)[number];

export type HarmonySurface = "assistant_text" | "assistant_thinking" | "tool_arg";

export interface HarmonySignal {
	classes: HarmonySignalClass[];
	start: number;
	end: number;
	text: string;
}

export interface HarmonyDetection {
	surface: HarmonySurface;
	contentIndex?: number;
	toolName?: string;
	toolCallId?: string;
	signals: HarmonySignal[];
}

export interface HarmonyAuditEvent {
	action: "truncate_resume" | "abort_retry" | "escalated";
	surface: HarmonySurface;
	signal: string;
	retryN: number;
	model: string;
	provider: string;
	toolName?: string;
	removedLen: number;
	removedSha8: string;
	removedPreview: string;
	removedBlob?: string;
}

export interface HarmonyRecoveredToolCall {
	message: AssistantMessage;
	removed: string;
}

/**
 * Whether to run leak detection on responses from this model. The default-on policy
 * lives on the harmony-leak-mitigation axis in providers/openai-codex.kdl.
 * It targets the provider rather than enumerating model ids so future models
 * do not silently bypass this cheap mitigation.
 */
export function isHarmonyLeakMitigationTarget(model: Model): boolean {
	const compat = model.compat;
	return compat !== undefined && "harmonyLeakMitigation" in compat && compat.harmonyLeakMitigation === true;
}

export function signalListLabel(signals: readonly HarmonySignal[]): string {
	const seen: string[] = [];
	for (const signal of signals) {
		const label = signal.classes.join("+");
		if (!seen.includes(label)) seen.push(label);
	}
	return seen.join(",") || "none";
}

/**
 * Detect harmony-protocol leakage in `text`. Returns undefined if clean.
 *
 * Trip rule: `H` alone, or `M` paired with at least one co-signal
 * (`C`/`G`/`S`/`B`/`R`/`T`). Bare `M` does not trip — this document, its
 * tests, and bug reports legitimately carry the marker.
 *
 * The `tool_arg` surface is held to a stricter rule. A tool argument is
 * arbitrary file/data content that can legitimately carry the marker, a
 * channel word, harmony control tokens, or a non-Latin script run (editing
 * these very fixtures does exactly that). The only robust leak signal there
 * is content trailing the structurally-valid parse, so a `tool_arg` detection
 * additionally requires the `T` co-signal. Absent a `parsedEnd` boundary `T`
 * is never set, so `tool_arg` scanning stays inert and a legitimate codex tool
 * call is never hard-aborted. `assistant_text`/`assistant_thinking` keep the
 * base rule.
 *
 * `parsedEnd`, when supplied, marks the byte at which a structurally valid
 * tool-argument parse ends; markers at or past it set the `T` co-signal.
 * `contentIndex`/`toolName`/`toolCallId` flow through to the returned
 * detection for downstream auditing.
 */
export function detectHarmonyLeak(
	text: string,
	surface: HarmonySurface,
	options: {
		parsedEnd?: number;
		contentIndex?: number;
		toolName?: string;
		toolCallId?: string;
	} = {},
): HarmonyDetection | undefined {
	const fences = computeFenceRanges(text);
	const signals: HarmonySignal[] = [];

	for (const match of text.matchAll(HARMONY_RE)) {
		const start = match.index ?? 0;
		if (isInsideFence(fences, start)) continue;
		signals.push(makeSignal(["H"], start, start + match[0].length, match[0]));
	}

	for (const match of text.matchAll(MARKER_RE)) {
		const start = match.index ?? 0;
		if (isInsideFence(fences, start)) continue;
		const end = start + match[0].length;
		const classes: HarmonySignalClass[] = ["M"];

		const adjacent = text.slice(Math.max(0, start - 64), Math.min(text.length, end + 16));
		const near = text.slice(Math.max(0, start - 16), Math.min(text.length, end + 16));
		const forward = text.slice(start, Math.min(text.length, start + 240));

		if (CHANNEL_WORD_RE.test(adjacent)) classes.push("C");
		if (GLITCH_RE.test(near)) classes.push("G");
		if (hasScriptMismatchNear(text, start, end)) classes.push("S");
		if (BODY_CASCADE_RE.test(forward)) classes.push("B");
		if (FAKE_RESULT_RE.test(forward)) classes.push("R");
		if (options.parsedEnd !== undefined && start >= options.parsedEnd) classes.push("T");

		// `M` alone never trips: legitimate documentation/tests carry it.
		if (classes.length > 1) {
			signals.push(makeSignal(classes, start, end, match[0]));
		}
	}

	if (signals.length === 0) return undefined;
	// Tool arguments are data: they can legitimately embed the marker, a channel
	// word, harmony control tokens, or a non-Latin script run. Only a marker
	// trailing the structurally-valid parse (`T`) is a reliable leak signal, so
	// refuse to trip a `tool_arg` detection without it. Without a `parsedEnd`
	// boundary `T` is never set and the surface stays inert.
	if (surface === "tool_arg" && !signals.some(s => s.classes.includes("T"))) return undefined;
	signals.sort((a, b) => a.start - b.start || a.end - b.end);
	return {
		surface,
		contentIndex: options.contentIndex,
		toolName: options.toolName,
		toolCallId: options.toolCallId,
		signals,
	};
}

/**
 * Scan an assistant message's content blocks; return the first detection.
 *
 * `toolArgParseEnd`, when supplied, resolves the byte offset at which a tool
 * call's structurally-valid argument parse ends (the `T` co-signal in
 * {@link detectHarmonyLeak}). Callers that can parse a tool's argument DSL pass
 * it to enable `tool_arg` leak detection; omitting it keeps that surface inert
 * — the safe default the agent loop relies on, since it cannot bound a streamed
 * tool DSL and must never hard-abort a legitimate tool call.
 */
export function detectHarmonyLeakInAssistantMessage(
	message: AssistantMessage,
	toolArgParseEnd?: (toolCall: ToolCall) => number | undefined,
): HarmonyDetection | undefined {
	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i];
		if (block.type === "text") {
			const d = detectHarmonyLeak(block.text, "assistant_text", { contentIndex: i });
			if (d) return d;
		} else if (block.type === "thinking") {
			const d = detectHarmonyLeak(block.thinking, "assistant_thinking", { contentIndex: i });
			if (d) return d;
		} else if (block.type === "toolCall") {
			const argText = getToolArgumentText(block);
			if (argText !== undefined) {
				const d = detectHarmonyLeak(argText, "tool_arg", {
					contentIndex: i,
					toolName: block.name,
					toolCallId: block.id,
					parsedEnd: toolArgParseEnd?.(block),
				});
				if (d) return d;
			}
		}
	}
	return undefined;
}

/**
 * Truncate a contaminated tool call at the start of the contaminated line and
 * append the tool's recovery sentinel. Returns a recovered AssistantMessage
 * (containing only the cleaned tool call), a synthetic continuation user
 * message asking the model to re-issue the rest, and the removed substring
 * for auditing. Returns undefined when the tool is not recovery-eligible or
 * the truncation would leave nothing meaningful to dispatch.
 *
 * `providerPayload` is dropped from the recovered message: for Codex the
 * encrypted reasoning blob is opaque/signed and we cannot validate that it is
 * uncontaminated. The model re-reasons on the next turn.
 */
export function recoverHarmonyToolCall(
	message: AssistantMessage,
	detection: HarmonyDetection,
): HarmonyRecoveredToolCall | undefined {
	if (detection.surface !== "tool_arg" || detection.contentIndex === undefined) return undefined;
	const block = message.content[detection.contentIndex];
	if (block?.type !== "toolCall") return undefined;

	const config = RECOVERY_REGISTRY[block.name];
	if (!config) return undefined;

	const input = block.arguments?.input;
	if (typeof input !== "string") return undefined;
	if (!config.accepts(input)) return undefined;

	const offset = detection.signals[0]?.start;
	if (offset === undefined) return undefined;

	const truncated = truncateAtLineAndAppendSentinel(input, offset, config.sentinel);
	if (truncated === undefined) return undefined;

	const cleanToolCall: ToolCall = {
		...block,
		arguments: { ...block.arguments, input: truncated.clean },
	};
	const cleanMessage: AssistantMessage = {
		...message,
		content: [cleanToolCall],
		// Drop encrypted reasoning blob: opaque, possibly carries the leak forward.
		providerPayload: undefined,
		stopReason: "toolUse",
		errorMessage: undefined,
	};
	return { message: cleanMessage, removed: truncated.removed };
}

/**
 * Return the contaminated substring from `message` for audit purposes when
 * recovery is not applicable (abort path). Walks from the first detected
 * signal to end-of-content within the relevant block. Returns "" if the
 * detection cannot be resolved against the message.
 */
export function extractHarmonyRemoved(message: AssistantMessage, detection: HarmonyDetection): string {
	if (detection.contentIndex === undefined) return "";
	const block = message.content[detection.contentIndex];
	if (!block) return "";
	const start = detection.signals[0]?.start ?? 0;
	if (block.type === "text") return block.text.slice(start);
	if (block.type === "thinking") return block.thinking.slice(start);
	if (block.type === "toolCall") {
		const text = getToolArgumentText(block);
		return text ? text.slice(start) : "";
	}
	return "";
}

export function createHarmonyAuditEvent(params: {
	action: HarmonyAuditEvent["action"];
	detection: HarmonyDetection;
	model: Model;
	retryN: number;
	removed: string;
}): HarmonyAuditEvent {
	return {
		action: params.action,
		surface: params.detection.surface,
		signal: signalListLabel(params.detection.signals),
		retryN: params.retryN,
		model: params.model.id,
		provider: params.model.provider,
		toolName: params.detection.toolName,
		removedLen: params.removed.length,
		removedSha8: sha8(params.removed),
		removedPreview: redactedJunkPreview(params.removed),
		removedBlob: Bun.env.OMP_HARMONY_DEBUG === "1" ? params.removed : undefined,
	};
}

// ─── internals ──────────────────────────────────────────────────────────────

function makeSignal(classes: HarmonySignalClass[], start: number, end: number, text: string): HarmonySignal {
	if (classes[0] === "H") return { classes: ["H"], start, end, text };
	const sorted: HarmonySignalClass[] = [];
	for (const cls of SIGNAL_ORDER) {
		if (classes.includes(cls)) sorted.push(cls);
	}
	return { classes: sorted, start, end, text };
}

/**
 * Precompute fenced-code-block ranges once per text. Each range is a
 * [start, end) span of bytes inside any ```/~~~ fence. O(n) once instead of
 * O(n) per detected match.
 */
function computeFenceRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let inFence = false;
	let fenceStart = 0;
	let lineStart = 0;
	while (lineStart <= text.length) {
		const newline = text.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? text.length : newline;
		const line = text.slice(lineStart, lineEnd);
		if (FENCE_RE.test(line)) {
			if (inFence) {
				ranges.push([fenceStart, lineEnd]);
				inFence = false;
			} else {
				fenceStart = lineStart;
				inFence = true;
			}
		}
		if (newline === -1) break;
		lineStart = newline + 1;
	}
	if (inFence) ranges.push([fenceStart, text.length]);
	return ranges;
}

function isInsideFence(ranges: Array<[number, number]>, position: number): boolean {
	for (const [start, end] of ranges) {
		if (position >= start && position < end) return true;
		if (start > position) break;
	}
	return false;
}

function hasScriptMismatchNear(text: string, start: number, end: number): boolean {
	const near = text.slice(Math.max(0, start - 32), Math.min(text.length, end + 32));
	if (!SCRIPT_RUN_RE.test(near)) return false;
	const surrounding = text.slice(Math.max(0, start - 200), Math.min(text.length, end + 200));
	if (surrounding.length === 0) return false;
	let ascii = 0;
	for (let i = 0; i < surrounding.length; i++) {
		if (surrounding.charCodeAt(i) < 128) ascii++;
	}
	return ascii / surrounding.length >= 0.85;
}

/**
 * Tool-call argument text used for detection scanning. For tools whose args
 * include a free-form `input` string we scan that directly so reported byte
 * offsets line up with the original. For everything else we fall back to a
 * JSON-stringified blob so detection still fires; that path's offsets are
 * NOT meaningful for slicing the original args, but the recovery path gates
 * on `block.arguments.input` being a string and only ever slices that.
 */
function getToolArgumentText(toolCall: ToolCall): string | undefined {
	if (typeof toolCall.arguments?.input === "string") return toolCall.arguments.input;
	try {
		return JSON.stringify(toolCall.arguments);
	} catch {
		return undefined;
	}
}

function truncateAtLineAndAppendSentinel(
	input: string,
	offset: number,
	sentinel: string,
): { clean: string; removed: string } | undefined {
	const lineStart = offset <= 0 ? 0 : input.lastIndexOf("\n", offset - 1) + 1;
	if (lineStart === 0) return undefined; // would cut everything
	const head = input.slice(0, lineStart).replace(/\s+$/, "");
	if (head.length === 0) return undefined;
	return {
		clean: head + sentinel,
		removed: input.slice(lineStart),
	};
}

function sha8(text: string): string {
	return Bun.sha(text, "hex").slice(0, 8);
}

const PREVIEW_KEEP_RE = new RegExp(`[${SCRIPT_CLASS}\\s】【”“…」「、。]`, "u");
const PREVIEW_TOKEN_RE =
	/^(?:to=functions\.[A-Za-z_]\w*|analysis|commentary|assistant|user|system|developer|tool|changedFiles|RTLU|Jsii(?:_commentary)?|\x4aapgolly)/;

/**
 * Privacy-safe preview for the audit log: keeps marker/channel/glitch tokens,
 * non-Latin script chars, and CJK punctuation; replaces everything else
 * (potential source/secrets) with `·`. Sufficient to grow the glitch-token
 * denylist from logs without exposing source content. Capped at 64 chars.
 */
function redactedJunkPreview(text: string): string {
	const source = text.slice(0, 64);
	let out = "";
	for (let i = 0; i < source.length; ) {
		const tok = PREVIEW_TOKEN_RE.exec(source.slice(i));
		if (tok) {
			out += tok[0];
			i += tok[0].length;
			continue;
		}
		const ch = source[i] ?? "";
		out += PREVIEW_KEEP_RE.test(ch) ? ch : "·";
		i++;
	}
	return out;
}
