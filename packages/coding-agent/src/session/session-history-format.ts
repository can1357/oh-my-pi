/**
 * Concise markdown transcript serializer for `history://` URLs.
 *
 * Unlike `session-dump-format.ts` (verbose `/dump` export), this emits a
 * compressed transcript: full user/assistant/developer text, tool call +
 * result pairs collapsed to single lines, thinking elided, custom messages
 * as one-liners. No system prompt, no tool catalog, no config sections.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { countNewlines, escapeXmlText } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type {
	BashExecutionMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	CustomMessage,
	FileMentionMessage,
	HookMessage,
	PythonExecutionMessage,
} from "./messages";
import { truncateMiddle } from "@oh-my-pi/pi-tui/tools/streaming-output";

export interface HistoryFormatOptions {
	/** Optional H1 prepended to the transcript. */
	title?: string;
	/** Render assistant thinking blocks (default: elided). */
	includeThinking?: boolean;
	/** Render tool intent comment before tool call lines. */
	includeToolIntent?: boolean;
	/** Render watched-session roles as inline `**agent**:` / `**user**:` labels (collapsing consecutive same-role messages) instead of `## ` headings, so a primary transcript embedded inside an advisor turn stays visually distinct. */
	watchedRoles?: boolean;
	/**
	 * Expand the primary agent's injected constraint context — plan mode's rules
	 * (`plan-mode-context`) and the approved plan it implements
	 * (`plan-mode-reference`) — verbatim instead of as a truncated one-liner,
	 * wrapped in a `<primary-context>` tag so a reviewer reads it as the primary's
	 * instructions, not its own. The advisor sets this: a truncated rule (plan
	 * mode's "NEVER create files … except the plan file") makes it raise false
	 * blockers. See {@link PRIMARY_CONTEXT_CUSTOM_TYPES}. Other custom messages
	 * still collapse to a one-liner.
	 */
	expandPrimaryContext?: boolean;
	/**
	 * Append the unified diff (from a tool result's `details.diff`) below
	 * edit/apply_patch tool lines, instead of just the path. The advisor sets
	 * this so it sees what changed without re-reading the file. Bounded by the
	 * same byte budget as expanded tool IO but its own, higher line cap
	 * ({@link EXPANDED_DIFF_MAX_LINES}): a huge diff is middle-truncated rather
	 * than admitted whole.
	 */
	expandEditDiffs?: boolean;
	/**
	 * Append bounded tool-result text and, for `ask`, the structured questions.
	 * Advisor transcripts enable this so reviewers see user decisions and the
	 * evidence returned by primary tools without admitting unbounded output.
	 */
	expandToolIO?: boolean;
	/**
	 * Transform tool input/output — expanded bodies and one-line previews —
	 * before any byte, line or character truncation. The advisor passes its
	 * secret redaction here: a cut through a secret leaves a fragment that no
	 * later whole-transcript pass can recognize.
	 */
	transformExpandedToolIO?: ToolIOTransform;
	/**
	 * Chunked rendering support: a caller formatting one logical transcript in
	 * several calls (the advisor's chunked delta render) passes a result index
	 * built over the WHOLE delta plus one shared consumed-id set, so a toolCall
	 * finds its toolResult across chunk boundaries and the result is never
	 * re-rendered as an orphan in a later chunk.
	 */
	toolResultIndex?: ReadonlyMap<string, ToolResultMessage>;
	consumedToolCallIds?: Set<string>;
	/**
	 * Chunked rendering state: a mutable holder for the watched-role label
	 * (`**user**:` / `**agent**:`) that ended the previous chunk. Lets a caller
	 * formatting one logical transcript across several calls (advisor
	 * multi-message split) keep consecutive same-role collapsing byte-identical
	 * to the single-block render: pass one object across all chunk calls.
	 */
	watchedRoleState?: { lastLabel: string | undefined };
}

/** Max length of the primary-arg summary inside `→ tool(...)` lines. */
const PRIMARY_ARG_MAX = 120;
/** Per-tool budget for expanded advisor input/output. */
const EXPANDED_TOOL_IO_MAX_BYTES = 8 * 1024;
const EXPANDED_TOOL_IO_MAX_LINES = 80;
/** Diffs get more lines than generic tool IO (same byte cap) so mid-edit hunks reach the advisor. */
const EXPANDED_DIFF_MAX_LINES = 300;
const EXPANDED_ASK_FIELD_MAX_BYTES = 2 * 1024;
const EXPANDED_ASK_FIELD_MAX_LINES = 20;

/** Per-tool preference order for the most informative scalar argument. */
const PRIMARY_ARG_KEYS = [
	"path",
	"file_path",
	"filePath",
	"command",
	"cmd",
	"pattern",
	"url",
	"query",
	"prompt",
	"assignment",
	"note",
	"message",
	"op",
	"name",
	"id",
] as const;

/** Collapse whitespace runs and truncate to `max` chars with an ellipsis. */
function oneLine(text: string, max = PRIMARY_ARG_MAX): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Redaction applied to tool I/O before any cut. With `redactionPrefixEnd`
 * (see `SecretObfuscator.redactionPrefixEnd`) one-line previews redact only a
 * prefix ending at a clean cut point, whose redaction matches the whole
 * text's, so hidden text mints nothing; without it they redact the whole text.
 */
export interface ToolIOTransform {
	(text: string): string;
	redactionPrefixEnd?: (text: string, limit: number) => number;
}

/**
 * {@link oneLine}, redacting with `transform` before the cut: a cut inside a
 * secret leaves a fragment no later pass can recognize. Only the redacted
 * prefix is ever shown, so a replacement shorter than its secret cannot pull
 * unredacted text from past the prefix into view.
 */
function previewLine(text: string, transform?: ToolIOTransform, max = PRIMARY_ARG_MAX): string {
	if (!transform) return oneLine(text, max);
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max || !transform.redactionPrefixEnd) return oneLine(transform(flat), max);
	const end = transform.redactionPrefixEnd(flat, max - 1);
	const redacted = transform(flat.slice(0, end));
	return end < flat.length || redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

export function formatExecutionSourcePreview(source: string, transform?: ToolIOTransform): string {
	return previewLine(source, transform);
}

/** Join the text blocks of a string-or-blocks content field. Images become `[image]`. */
function contentToText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
		else parts.push("[image]");
	}
	return parts.join("\n");
}

function lineCount(text: string): number {
	if (!text) return 0;
	return countNewlines(text) + 1;
}

function primaryArgValue(value: unknown): string {
	if (typeof value === "string" && value.length > 0) return value;
	if (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === "string")) {
		return value.join(", ");
	}
	return "";
}

/** Pick the most informative scalar argument of a tool call. */
export function formatToolCallPrimaryArg(
	name: string,
	args: Record<string, unknown> | undefined,
	transform?: ToolIOTransform,
): string {
	return previewLine(primaryArgText(name, args), transform);
}

function primaryArgText(name: string, args: Record<string, unknown> | undefined): string {
	if (!args || typeof args !== "object") return "";
	// Advisor note is the most informative summary; preserve severity too.
	if (name === "advise") {
		const note = typeof args.note === "string" ? args.note : "";
		const severity = typeof args.severity === "string" ? args.severity : "";
		if (note && severity) return `${severity}: ${note}`;
		if (note) return note;
		if (severity) return severity;
	}
	if (name === "grep") {
		const pattern = primaryArgValue(args.pattern);
		const paths = primaryArgValue(args.path) || primaryArgValue(args.paths);
		if (pattern && paths) return `${pattern} @ ${paths}`;
		if (pattern) return pattern;
		if (paths) return paths;
	}
	if (name === "glob") {
		const paths = primaryArgValue(args.path) || primaryArgValue(args.paths);
		if (paths) return paths;
	}
	if (name === "ast_grep") {
		const pattern = primaryArgValue(args.pat);
		if (pattern) return pattern;
	}
	for (const key of PRIMARY_ARG_KEYS) {
		const value = args[key];
		const summary = primaryArgValue(value);
		if (summary) return summary;
	}
	// Fallback: first non-intent string arg, then a compact JSON of the args.
	const rest: Record<string, unknown> = {};
	let restCount = 0;
	for (const key in args) {
		if (key === INTENT_FIELD) continue;
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
		rest[key] = value;
		restCount++;
	}
	if (restCount === 0) return "{}";
	try {
		return JSON.stringify(rest);
	} catch {
		return "";
	}
}

export function formatToolCallIntentPreview(
	args: Record<string, unknown> | undefined,
	transform?: ToolIOTransform,
): string | undefined {
	const intent = args?.[INTENT_FIELD];
	return typeof intent === "string" && intent.trim() ? previewLine(intent, transform, 80) : undefined;
}

export function formatToolResultErrorPreview(content: string | readonly (TextContent | ImageContent)[]): string {
	return oneLine(contentToText(content).split("\n", 1)[0] ?? "");
}

/**
 * Wrap a diff body in a backtick fence sized to outlast the longest backtick
 * run inside it, so a diff that touches markdown (triple backticks) can't break
 * out of the fence. Info string `diff` for syntax highlighting.
 */
function fencedText(text: string, language: string): string {
	const longest = text.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${language}\n${text}\n${fence}`;
}

function boundedToolContext(text: string): string {
	return truncateMiddle(text, {
		maxBytes: EXPANDED_TOOL_IO_MAX_BYTES,
		maxLines: EXPANDED_TOOL_IO_MAX_LINES,
	}).content;
}

function boundedAskJson(value: unknown, transform?: (text: string) => string): string {
	return boundedToolContext(
		JSON.stringify(
			value,
			(_key, nested) => {
				if (typeof nested !== "string") return nested;
				return truncateMiddle(transform?.(nested) ?? nested, {
					maxBytes: EXPANDED_ASK_FIELD_MAX_BYTES,
					maxLines: EXPANDED_ASK_FIELD_MAX_LINES,
				}).content;
			},
			2,
		),
	);
}

function boundedFencedToolContext(text: string, language: string, maxLines = EXPANDED_TOOL_IO_MAX_LINES): string {
	const longestFence = text.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
	// A pathological run can make Markdown fences larger than the whole budget.
	// Use indented code in that case: constant wrapper cost and no delimiter collision.
	if (longestFence * 2 > EXPANDED_TOOL_IO_MAX_BYTES / 2) {
		const marker = "[…content elided to fit advisor context…]";
		const truncated = truncateMiddle(text, {
			maxBytes: EXPANDED_TOOL_IO_MAX_BYTES - Buffer.byteLength(marker) - 2,
			maxLines,
		});
		const bounded = truncated.truncated ? `${marker}\n${truncated.content}` : truncated.content;
		return bounded.replace(/^/gm, "    ");
	}
	const fenceBytes = Math.max(3, longestFence + 1) * 2 + language.length + 2;
	return fencedText(
		truncateMiddle(text, {
			maxBytes: Math.max(1, EXPANDED_TOOL_IO_MAX_BYTES - fenceBytes),
			maxLines,
		}).content,
		language,
	);
}

function expandedAskArguments(
	args: Record<string, unknown> | undefined,
	transform?: (text: string) => string,
): string | undefined {
	if (!args) return undefined;
	const visibleArgs = Object.fromEntries(Object.entries(args).filter(([key]) => key !== INTENT_FIELD));
	try {
		return boundedAskJson(visibleArgs, transform);
	} catch {
		return undefined;
	}
}

function expandedAskDetails(
	result: ToolResultMessage | undefined,
	transform?: (text: string) => string,
): string | undefined {
	if (!result?.details || typeof result.details !== "object") return undefined;
	const details = result.details as {
		question?: unknown;
		questions?: unknown;
		results?: unknown;
	};
	const questions = Array.isArray(details.results)
		? details.results
				.map(item =>
					item && typeof item === "object" && typeof (item as { question?: unknown }).question === "string"
						? (item as { question: string }).question
						: undefined,
				)
				.filter((question): question is string => question !== undefined)
		: Array.isArray(details.questions)
			? details.questions.filter((question): question is string => typeof question === "string")
			: typeof details.question === "string"
				? [details.question]
				: [];
	return questions.length > 0 ? boundedAskJson({ questions }, transform) : undefined;
}

/** One line per tool call: `→ read(src/foo.ts:50-80) ⇒ ok · 31 lines`. */

function expandedToolResultText(text: string | undefined): string | undefined {
	return text?.trim() ? text : undefined;
}
function toolCallLine(
	name: string,
	args: Record<string, unknown> | undefined,
	result: ToolResultMessage | undefined,
	includeToolIntent?: boolean,
	expandEditDiffs?: boolean,
	expandToolIO?: boolean,
	transformExpandedToolIO?: ToolIOTransform,
): string {
	const head = `→ ${name}(${formatToolCallPrimaryArg(name, args, transformExpandedToolIO)})`;
	const rawResultText = result ? contentToText(result.content) : undefined;
	const visibleResultText =
		rawResultText === undefined ? undefined : (transformExpandedToolIO?.(rawResultText) ?? rawResultText);
	let base: string;
	if (!result) {
		base = `${head} ⇒ pending`;
	} else {
		const lines = lineCount(rawResultText ?? "");
		const count = `${lines} ${lines === 1 ? "line" : "lines"}`;
		if (result.isError) {
			const firstLine = formatToolResultErrorPreview(visibleResultText ?? "");
			base = firstLine ? `${head} ⇒ error · ${count} — ${firstLine}` : `${head} ⇒ error · ${count}`;
		} else {
			base = `${head} ⇒ ok · ${count}`;
		}
	}

	if (expandEditDiffs) {
		const diff = (result?.details as { diff?: unknown } | undefined)?.diff;
		if (typeof diff === "string" && diff.trim()) {
			base = `${base}\n${boundedFencedToolContext(transformExpandedToolIO?.(diff) ?? diff, "diff", EXPANDED_DIFF_MAX_LINES)}`;
		}
	}

	if (expandToolIO) {
		const sections: string[] = [];
		if (name === "ask") {
			const askArguments =
				expandedAskArguments(args, transformExpandedToolIO) ?? expandedAskDetails(result, transformExpandedToolIO);
			if (askArguments) sections.push(`Ask input:\n${boundedFencedToolContext(askArguments, "json")}`);
		}
		if (result) {
			const resultText = expandedToolResultText(visibleResultText);
			if (resultText) {
				sections.push(`Tool result:\n${boundedFencedToolContext(resultText, "text")}`);
			}
		}
		if (sections.length > 0) base = `${base}\n${sections.join("\n")}`;
	}

	const formattedIntent = includeToolIntent ? formatToolCallIntentPreview(args, transformExpandedToolIO) : undefined;
	if (formattedIntent) return `// ${formattedIntent}\n${base}`;
	return base;
}

/** One line for a user-initiated `!`/`$` execution. Always attributed to the
 *  user: these roles never carry agent-run commands (the model's bash goes
 *  through `toolCall`), so the `user-` prefix makes provenance explicit for the
 *  advisor and history readers regardless of render mode. */
function executionLine(
	kind: "bash" | "python",
	source: string,
	msg: BashExecutionMessage | PythonExecutionMessage,
	transform?: ToolIOTransform,
): string {
	const status = msg.cancelled
		? "cancelled"
		: msg.exitCode !== undefined && msg.exitCode !== 0
			? `error · exit ${msg.exitCode}`
			: "ok";
	const lines = lineCount(msg.output);
	const sourcePreview = formatExecutionSourcePreview(source, transform);
	return `→ user-${kind}! ${sourcePreview} ⇒ ${status} · ${lines} ${lines === 1 ? "line" : "lines"}`;
}

/**
 * Hidden custom messages that inject the primary agent's operative *constraints*
 * — plan mode's rules and the approved plan it implements. A reviewer (the
 * advisor) must read these verbatim; truncating them hides load-bearing
 * exceptions (e.g. plan mode permits exactly one plan file). Every other custom
 * type stays a one-liner.
 *
 * Deliberately excludes `goal-mode-context`: its body carries live budget
 * counters (tokens/seconds used) that change every turn, so it can neither be
 * deduped against a prior copy nor expanded each turn without flooding the
 * reviewer — and its constraints don't drive the file-write misreads this
 * targets.
 */
export const PRIMARY_CONTEXT_CUSTOM_TYPES: ReadonlySet<string> = new Set(["plan-mode-context", "plan-mode-reference"]);

/**
 * Hidden non-primary custom messages whose content is needed to understand visible transcript entries:
 * vision descriptions and the source file behind an `[image]` a user pasted or dropped.
 */
const CONTEXTUAL_NON_PRIMARY_HIDDEN_CUSTOM_TYPES: Record<string, true> = {
	"image-attachment-description": true,
	"image-attachment": true,
};

/**
 * Notices persisted before they carried `{ index, path }` details hold only the text rendered
 * from `prompts/system/image-attachment.md`; these recover both fields from it.
 */
const LEGACY_IMAGE_ATTACHMENT_INDEX = /`\[Image #(\d+)\]`/;
const LEGACY_IMAGE_ATTACHMENT_PATH = /^Source path: `(.+)`$/m;

/** Bounded, actionable history summary built from persisted progress details, not model-facing XML. */
function formatAsyncProgressHistory(details: Record<string, unknown>): string {
	const jobs = Array.isArray(details.jobs) ? details.jobs : [];
	const parts = jobs.map(job => {
		const entry = (job ?? {}) as Record<string, unknown>;
		const id = typeof entry.jobId === "string" ? entry.jobId : "job";
		const head = typeof entry.head === "string" ? entry.head : undefined;
		const tail = typeof entry.tail === "string" ? entry.tail : undefined;
		let text = "";
		if (entry.truncated === true && (head !== undefined || tail !== undefined)) {
			if (head !== undefined && tail !== undefined) {
				const partMax = Math.floor((PRIMARY_ARG_MAX - " … ".length) / 2);
				text = `${oneLine(head, partMax)} … ${oneLine(tail, partMax)}`;
			} else {
				text = oneLine(head ?? tail ?? "");
			}
		} else if (typeof entry.text === "string") {
			// Source-truncated output that still fits the preview budget has no
			// head/tail gap. Keep its retained text without inventing an elision.
			text = oneLine(entry.text);
		}
		const suppressedEvents =
			typeof entry.suppressedEvents === "number" && entry.suppressedEvents > 0 ? entry.suppressedEvents : undefined;
		const suppressed = suppressedEvents === undefined ? "" : ` [${suppressedEvents} progress events suppressed]`;
		const artifact =
			(entry.truncated === true || suppressedEvents !== undefined) && typeof entry.artifactId === "string"
				? ` [full output: artifact://${entry.artifactId}]`
				: "";
		return text ? `${id}: ${text}${suppressed}${artifact}` : `${id}${suppressed}${artifact}`;
	});
	return parts.length > 0 ? `[async-progress] ${parts.join("; ")}` : "[async-progress]";
}

/** One-liner for custom/hook messages: `[irc] A → B: body…`. */
function customOneLiner(msg: CustomMessage | HookMessage, transform?: ToolIOTransform): string {
	const details = (msg.details ?? {}) as Record<string, unknown>;
	const str = (key: string): string => (typeof details[key] === "string" ? (details[key] as string) : "");
	switch (msg.customType) {
		case "irc:incoming":
			return `[irc] ${str("from") || "?"} → me: ${previewLine(str("message"), transform)}`;
		case "irc:relay":
			return `[irc] ${str("from") || "?"} → ${str("to") || "?"}: ${previewLine(str("body"), transform)}`;
		case "irc:workpool":
			return `[pool] ${str("pool")} → ${str("to") || "?"}: ${previewLine(str("body"), transform)}`;
		case "async-result": {
			const jobs = Array.isArray(details.jobs) && details.jobs.length > 0 ? details.jobs : [details];
			const labels = jobs
				.map(job => {
					const j = (job ?? {}) as Record<string, unknown>;
					return typeof j.label === "string" && j.label ? j.label : typeof j.jobId === "string" ? j.jobId : "job";
				})
				.join(", ");
			return `[async-result] ${previewLine(labels, transform)}`;
		}
		case "image-attachment": {
			// The notice body is model-facing boilerplate; its path would be cut by `oneLine`.
			// Emit the full path so a reader of the transcript can `read` the file.
			const text = contentToText(msg.content);
			const path = str("path") || LEGACY_IMAGE_ATTACHMENT_PATH.exec(text)?.[1];
			if (!path) return `[${msg.customType}] ${oneLine(text)}`;
			const index =
				typeof details.index === "number" ? details.index : (LEGACY_IMAGE_ATTACHMENT_INDEX.exec(text)?.[1] ?? "?");
			return `[image-attachment] Image #${index}: ${path}`;
		}
		case "async-progress":
			return formatAsyncProgressHistory(details);
		default:
			return `[${msg.customType}] ${previewLine(contentToText(msg.content), transform)}`;
	}
}

/**
 * Format a session's message array as a concise markdown transcript.
 *
 * `messages` is the session's in-memory message array (or the read-only
 * equivalent loaded from a session file) — the same shapes
 * `session-dump-format.ts` consumes.
 */
export function formatSessionHistoryMarkdown(messages: unknown[], opts?: HistoryFormatOptions): string {
	const typed = messages as AgentMessage[];
	const lines: string[] = [];
	if (opts?.title) {
		lines.push(`# ${opts.title}`, "");
	}

	// Index tool results by call id so each toolCall collapses to one line.
	// Chunked callers supply a whole-delta index + shared consumed set so
	// call/result pairs resolve across chunk boundaries.
	let resultsByCallId = opts?.toolResultIndex;
	if (!resultsByCallId) {
		const local = new Map<string, ToolResultMessage>();
		for (const msg of typed) {
			if (msg.role === "toolResult") {
				local.set(msg.toolCallId, msg);
			}
		}
		resultsByCallId = local;
	}
	const consumed = opts?.consumedToolCallIds ?? new Set<string>();
	// In watched mode, consecutive same-role messages collapse under one label
	// (the watched agent emits one assistant message per tool call, so otherwise
	// every call repeats `**agent**:`). Cleared whenever a
	// non-role-labeled line is emitted so the next turn re-labels.
	// Chunked callers seed the previous chunk's trailing label so collapsing
	// stays byte-identical to the single-block render.
	let lastWatchedLabel: string | undefined = opts?.watchedRoleState?.lastLabel;
	// Emit a watched-mode role label, collapsing consecutive same-role turns
	// under one label (matching the user/assistant paths). Used for the
	// user-attributed `!`/`$` execution lines so the advisor never reads them
	// as agent actions.
	const pushWatchedRole = (label: string, body: string): void => {
		if (lastWatchedLabel === label) {
			lines.push(body, "");
		} else {
			lines.push(label, body, "");
			lastWatchedLabel = label;
		}
	};

	for (const msg of typed) {
		switch (msg.role) {
			case "user":
			case "developer": {
				const text = contentToText(msg.content);
				if (!text.trim()) break;
				if (opts?.watchedRoles) {
					const label = `**${msg.role}**:`;
					if (lastWatchedLabel === label) {
						lines.push(text, "");
					} else {
						lines.push(label, text, "");
						lastWatchedLabel = label;
					}
				} else {
					lines.push(`## ${msg.role}`, "", text, "");
				}
				break;
			}
			case "assistant": {
				const assistantMsg = msg as AssistantMessage;
				const body: string[] = [];
				for (const block of assistantMsg.content) {
					if (block.type === "text") {
						if (block.text.trim()) body.push(block.text);
					} else if (block.type === "toolCall") {
						const result = resultsByCallId.get(block.id);
						if (result) consumed.add(block.id);
						body.push(
							toolCallLine(
								block.name,
								block.arguments,
								result,
								opts?.includeToolIntent,
								opts?.expandEditDiffs,
								opts?.expandToolIO,
								opts?.transformExpandedToolIO,
							),
						);
					} else if (opts?.includeThinking && block.type === "thinking" && block.thinking.trim()) {
						body.push(`_thinking:_ ${block.thinking}`);
					}
					// redactedThinking elided entirely (no readable text)
				}
				if (body.length === 0) break;
				if (opts?.watchedRoles) {
					const label = "**agent**:";
					if (lastWatchedLabel === label) {
						lines.push(...body, "");
					} else {
						lines.push(label, ...body, "");
						lastWatchedLabel = label;
					}
				} else {
					lines.push("## assistant", "", ...body, "");
				}
				break;
			}
			case "toolResult": {
				// Normally consumed by its toolCall; orphans (e.g. truncated history) get their own line.
				if (consumed.has(msg.toolCallId)) break;
				lines.push(
					toolCallLine(
						msg.toolName,
						undefined,
						msg,
						opts?.includeToolIntent,
						opts?.expandEditDiffs,
						opts?.expandToolIO,
						opts?.transformExpandedToolIO,
					),
					"",
				);
				lastWatchedLabel = undefined;
				break;
			}
			case "bashExecution": {
				const bashMsg = msg as BashExecutionMessage;
				if (bashMsg.excludeFromContext) break;
				const bashLine = executionLine("bash", bashMsg.command, bashMsg, opts?.transformExpandedToolIO);
				if (opts?.watchedRoles) {
					pushWatchedRole("**user**:", bashLine);
				} else {
					lines.push(bashLine, "");
					lastWatchedLabel = undefined;
				}
				break;
			}
			case "pythonExecution": {
				const pythonMsg = msg as PythonExecutionMessage;
				if (pythonMsg.excludeFromContext) break;
				const pythonLine = executionLine("python", pythonMsg.code, pythonMsg, opts?.transformExpandedToolIO);
				if (opts?.watchedRoles) {
					pushWatchedRole("**user**:", pythonLine);
				} else {
					lines.push(pythonLine, "");
					lastWatchedLabel = undefined;
				}
				break;
			}
			case "custom":
			case "hookMessage": {
				const custom = msg as CustomMessage | HookMessage;
				if (
					custom.display === false &&
					!PRIMARY_CONTEXT_CUSTOM_TYPES.has(custom.customType) &&
					CONTEXTUAL_NON_PRIMARY_HIDDEN_CUSTOM_TYPES[custom.customType] !== true
				) {
					break;
				}
				if (opts?.expandPrimaryContext && PRIMARY_CONTEXT_CUSTOM_TYPES.has(custom.customType)) {
					const text = contentToText(custom.content).trim();
					if (text) {
						lines.push(
							`<primary-context kind="${custom.customType}">`,
							escapeXmlText(text),
							"</primary-context>",
							"",
						);
					}
				} else {
					lines.push(customOneLiner(custom, opts?.transformExpandedToolIO), "");
				}
				lastWatchedLabel = undefined;
				break;
			}
			case "branchSummary": {
				const branchMsg = msg as BranchSummaryMessage;
				lines.push(
					`[branch] from ${branchMsg.fromId}: ${previewLine(branchMsg.summary, opts?.transformExpandedToolIO)}`,
					"",
				);
				lastWatchedLabel = undefined;
				break;
			}
			case "compactionSummary": {
				const compactMsg = msg as CompactionSummaryMessage;
				lines.push(`[compaction] ${previewLine(compactMsg.summary, opts?.transformExpandedToolIO)}`, "");
				lastWatchedLabel = undefined;
				break;
			}
			case "fileMention": {
				const fileMsg = msg as FileMentionMessage;
				lines.push(
					`[file-mention] ${previewLine(fileMsg.files.map(f => f.path).join(", "), opts?.transformExpandedToolIO)}`,
					"",
				);
				lastWatchedLabel = undefined;
				break;
			}
		}
	}

	if (opts?.watchedRoleState) {
		opts.watchedRoleState.lastLabel = lastWatchedLabel;
	}

	return `${lines.join("\n").trim()}\n`;
}
