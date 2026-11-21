/**
 * `magic` edit mode: edit a file from a described change.
 *
 * The calling agent states the changes in words, one section per file, in the
 * syntax `edit.magic.format` selects:
 *
 * ```text
 * # src/jobs.ts
 * In `drain()`, declare `limit` before `batch`.
 * # src/parse.ts
 * Rename every `retrunValue` to `returnValue`.
 * ```
 *
 * ```text
 * <edit file="src/jobs.ts">
 * In `drain()`, declare `limit` before `batch`.
 * </edit>
 * ```
 *
 * For each file an auxiliary model (the `edit.magic.model` selector, else the
 * `smol` role) reads the numbered file and returns line operations against it. The edit tool applies them as one atomic batch,
 * preserving plan-mode policy, LSP writethrough and the result diff.
 * A rejected batch goes back to the model for a corrected reply. A file
 * whose change runs out of attempts is left as it was. The
 * files' completions run concurrently; their writes do not.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Api, completeSimple, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { parseCodeStatus } from "@oh-my-pi/pi-natives";
import type { EditToolDetails, EditToolPerFileResult } from "@oh-my-pi/pi-tui/tools/edit";
import { concreteThinkingLevel, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { cfgOffline } from "../config/auxiliary-model-policy";
import { getModelMatchPreferences, resolveModelRoleValue, resolveRoleSelection } from "../config/model-resolver";
import { journalCompletion } from "../session/model-usage-journal";
import type { ToolSession } from "../tools";
import { resolvePlanPath } from "../tools/plan-mode-guard";
import applyRequestPrompt from "./magic-apply.md" with { type: "text" };
import applySystemPromptSource from "./magic-apply-system.md" with { type: "text" };
import { blockHints, compileLineEdits } from "./magic-lines";
import { type FileView, fileViews } from "./magic-view";
import { normalizeToLF, stripBom } from "./normalize";
import type { ReplaceBatchParams } from "./schemas";
import { cfgEditMagicFormat, cfgEditMagicModel } from "./settings";

/** Completions per call: the first reply plus corrections after a rejected batch. */
const MAX_ATTEMPTS = 3;
const COMPLETION_MAX_TOKENS = 16_384;
/** One budget across every attempt: the calling agent's turn blocks on the edit. */
const APPLY_TIMEOUT_MS = 120_000;
/** Largest share of the apply model's context window the shown part of a file may take. */
const MAX_CONTEXT_SHARE = 0.5;
/** Conservative characters-per-token estimate for source text. */
const CHARS_PER_TOKEN = 3;

const REFUSAL = /^CANNOT:\s*(.*)/i;
/**
 * Output tokens per character of the shown file and the change, plus slack: a
 * reply never needs more than retyping both, so a model that keeps talking is
 * stopped long before the general output limit.
 */
const OUTPUT_TOKENS_PER_CHAR = 0.5;
const OUTPUT_SLACK_TOKENS = 256;

const APPLY_SYSTEM_PROMPT = prompt.render(applySystemPromptSource);

/** Payload syntax, as `edit.magic.format` names it. */
export type MagicFormat = "markdown" | "xml";

const PATH_HEADER = /^# +(\S.*?)\s*$/;
const EDIT_OPEN = /<edit\s+file="([^"\n]+)"\s*>/g;
const EDIT_CLOSE = "</edit>";

/**
 * Constrained-decoding grammar of each payload syntax: sections that name a
 * file and carry at least one line of changes. The objects are shared, so the
 * tool's wire identity is stable across requests.
 */
export const MAGIC_EDIT_FORMATS: Record<MagicFormat, { syntax: "lark"; definition: string }> = {
	markdown: {
		syntax: "lark",
		definition: `start: section+
section: PATH_HEADER LF LF* CHANGE_TEXT (LF change_line* CHANGE_TEXT?)?
change_line: CHANGE_TEXT LF | LF

PATH_HEADER: /# [^\\r\\n]+/
// LLGuidance supports terminal intersection/complement, not priorities or lookarounds.
CHANGE_TEXT: /[^\\r\\n]+/ & ~PATH_HEADER

%import common.LF
`,
	},
	xml: {
		syntax: "lark",
		definition: `start: edit (LF+ edit)* LF*
edit: EDIT_OPEN LF LF* CHANGE_TEXT LF change_line* EDIT_CLOSE
change_line: CHANGE_TEXT LF | LF

EDIT_OPEN: /<edit file="[^"\\r\\n]+">/
EDIT_CLOSE: "</edit>"
// LLGuidance supports terminal intersection/complement, not priorities or lookarounds.
CHANGE_TEXT: /[^\\r\\n]+/ & ~EDIT_CLOSE

%import common.LF
`,
	},
};

type ReplaceEdit = ReplaceBatchParams["edits"][number];

/** The changes one payload asks for in one file. */
export interface MagicSection {
	path: string;
	change: string;
}

/** Files a payload names so far, in order and without repeats; tolerates a payload still streaming in. */
export function magicEditPaths(input: string, format: MagicFormat): string[] {
	const text = normalizeToLF(input);
	const found =
		format === "xml"
			? Array.from(text.matchAll(EDIT_OPEN), match => match[1])
			: text.split("\n").map(line => PATH_HEADER.exec(line)?.[1]);
	return [...new Set(found.filter(path => path !== undefined))];
}

/** `(path, text)` runs of a payload in order; `outside` is whatever belongs to no section. */
function splitSections(input: string, format: MagicFormat): { runs: [string, string][]; outside: string } {
	const text = normalizeToLF(input);
	const runs: [string, string][] = [];
	let outside = "";
	if (format === "xml") {
		let cursor = 0;
		for (const open of text.matchAll(EDIT_OPEN)) {
			if (open.index < cursor) continue;
			const bodyStart = open.index + open[0].length;
			const close = text.indexOf(EDIT_CLOSE, bodyStart);
			if (close === -1) throw new ToolError(`\`<edit file="${open[1]}">\` has no closing \`</edit>\`.`);
			outside += text.slice(cursor, open.index);
			runs.push([open[1], text.slice(bodyStart, close)]);
			cursor = close + EDIT_CLOSE.length;
		}
		outside += text.slice(cursor);
		return { runs, outside };
	}
	let current: [string, string] | undefined;
	for (const line of text.split("\n")) {
		const header = PATH_HEADER.exec(line);
		if (header) {
			current = [header[1], ""];
			runs.push(current);
		} else if (current) {
			current[1] += `${line}\n`;
		} else {
			outside += line;
		}
	}
	return { runs, outside };
}

/**
 * Split a payload into its per-file sections. Sections naming the same path
 * merge, in order, so every file is edited once.
 *
 * # Errors
 * {@link ToolError} when there is no section, when text sits outside the
 * sections, when a section describes no change, or (xml) when an element is
 * not closed.
 */
export function parseMagicInput(input: string, format: MagicFormat): MagicSection[] {
	const shape =
		format === "xml" ? '`<edit file="path">` … `</edit>` element' : "`# path` line followed by its changes";
	const { runs, outside } = splitSections(input, format);
	if (runs.length === 0) throw new ToolError(`Give one ${shape} per file.`);
	if (outside.trim() !== "") throw new ToolError(`Every change belongs to a file: use one ${shape} per file.`);
	const bodies = new Map<string, string[]>();
	for (const [path, text] of runs) {
		const body = bodies.get(path) ?? [];
		bodies.set(path, body);
		body.push(text.trim());
	}
	const sections: MagicSection[] = [];
	for (const [path, body] of bodies) {
		const change = body.filter(Boolean).join("\n\n");
		if (change === "") throw new ToolError(`No change is described for ${path}.`);
		sections.push({ path, change });
	}
	return sections;
}

/** `content` with the edit's unique `old_string` (or the whole content) replaced. */
function spliced(content: string, edit: ReplaceEdit): string {
	const at = content.indexOf(edit.old_string);
	return content.slice(0, at) + edit.new_string + content.slice(at + edit.old_string.length);
}

/**
 * Ask `complete` for an edit to the LF snapshot, compile it into one atomic
 * batch, and return any rejection to the model for correction.
 *
 * The model is shown `views` in order (by default {@link fileViews}): a reply
 * that fails against an excerpt is asked for again with the next, wider view.
 *
 * # Errors
 * {@link ToolError} when the model declines the change with nothing wider to
 * show it, or when no reply applied within {@link MAX_ATTEMPTS}. `apply` never
 * succeeded, so the file is as it was.
 */
export async function applyDescribedChange(options: {
	path: string;
	change: string;
	content: string;
	/** What the model may be shown, narrowest first; at least one view. */
	views?: FileView[];
	/** One completion of at most `maxTokens` output tokens. */
	complete: (request: string, maxTokens: number) => Promise<Reply>;
	apply: (edits: ReplaceEdit[], checkSnapshot?: boolean) => Promise<AgentToolResult<EditToolDetails>>;
}): Promise<AgentToolResult<EditToolDetails>> {
	const { path, change, content } = options;
	const views = options.views ?? fileViews(content, change);
	const parses = (code: string) => parseCodeStatus({ code: code === "" ? "\n" : code, path }).parsed;
	// A file that parses must still parse: a wrong range goes back to the model, not to syntax repair.
	const parsed = parses(content);
	let view = 0;
	let previous: string | undefined;
	let rejection = "";
	/** A change whose ranges were doubted once; repeating it confirms it. */
	let doubted: string | undefined;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const currentView = views[view];
		const { text: file, partial } = currentView;
		// Whatever goes wrong against an excerpt, the next attempt sees more of the file.
		const wider = view < views.length - 1;
		if (wider) view++;
		const { text: reply, truncated } = await options.complete(
			prompt.render(applyRequestPrompt, {
				path,
				file,
				partial,
				change,
				previous,
				rejection,
			}),
			Math.ceil((file.length + change.length) * OUTPUT_TOKENS_PER_CHAR) + OUTPUT_SLACK_TOKENS,
		);
		const refusal = reply.trim().match(REFUSAL);
		if (refusal) {
			// The model may have missed lines the excerpt left out: ask afresh.
			if (wider) continue;
			const reason = refusal[1].trim() || "no reason given";
			throw new ToolError(
				partial
					? `No change was made to ${path}: ${reason}\nThe model saw only the lines your description names: quote the lines to change, or give their line numbers.`
					: `No change was made to ${path}: ${reason}`,
			);
		}
		const compiled = compileLineEdits(normalizeToLF(reply.trim()), content, currentView, truncated);
		const hints = "edit" in compiled ? blockHints(content, compiled.ranges, currentView) : "";
		const key = "edit" in compiled ? `${compiled.edit.old_string}\0${compiled.edit.new_string}` : "";
		if ("edit" in compiled && parsed && !parses(spliced(content, compiled.edit))) {
			rejection = `Nothing was applied: after these operations the file no longer parses, so a range cuts a block in two${hints ? `: ${hints}` : ""}.`;
		} else if (hints && key !== doubted) {
			// A range that does not match the block it starts may be off by a line: the model confirms it by repeating it.
			doubted = key;
			rejection = `Nothing was applied: ${hints}. Correct the range, or send the same operations again if that is intended.`;
		} else if ("edit" in compiled) {
			const result = await options.apply([compiled.edit], true);
			if (!result.isError) return result;
			rejection = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		} else if (truncated) {
			throw new ToolError(
				`The model ran out of output before finishing the change to ${path}; the file is unchanged. Split the change into smaller calls.`,
			);
		} else {
			rejection = compiled.problem;
		}
		previous = reply;
	}
	throw new ToolError(
		`The change to ${path} could not be applied in ${MAX_ATTEMPTS} attempts; the file is unchanged. Last rejection:\n${rejection}\nDescribe the change more exactly: quote the lines it touches.`,
	);
}

/** One apply-model reply; `truncated` when it ran into the output limit. */
interface Reply {
	text: string;
	truncated: boolean;
}

/** The model that writes the patch, and one completion against it. */
interface Applier {
	/** `provider/id`, for error messages. */
	name: string;
	model: Model<Api>;
	complete(request: string, maxTokens: number): Promise<Reply>;
}

/**
 * Resolve the apply model for `session` and bind a completion to it.
 *
 * # Errors
 * {@link ToolError} when `edit.magic.model` matches no available model, when
 * the `smol` role resolves to none, or when the model has no credential.
 */
async function resolveApplier(session: ToolSession, signal?: AbortSignal): Promise<Applier> {
	const registry = session.modelRegistry;
	const offline = cfgOffline.get(session.settings);
	const activeProvider = session.getActiveModel?.()?.provider;
	const available = registry?.getAvailable() ?? [];
	const pool = offline ? available.filter(candidate => candidate.provider === activeProvider) : available;
	const selector = cfgEditMagicModel.get(session.settings);
	const resolved = selector
		? resolveModelRoleValue(selector, pool, {
				settings: session.settings,
				matchPreferences: getModelMatchPreferences(session.settings),
			})
		: resolveRoleSelection(["smol"], session.settings, pool);
	const model = resolved?.model;
	// Typing a described change needs no deliberation: reasoning runs only when the selector asks (`…:low`).
	const reasoning = toReasoningEffort(concreteThinkingLevel(resolved?.thinkingLevel));
	if (!registry || !model) {
		throw new ToolError(
			selector
				? `\`edit.magic.model\` (${selector}) matches no available model.`
				: "`edit.mode: magic` needs a model to apply the change: configure the `smol` role or `edit.magic.model`.",
		);
	}
	const name = `${model.provider}/${model.id}`;
	const sessionId = session.getSessionId?.() ?? undefined;
	if (!(await registry.getApiKey(model, sessionId))) {
		throw new ToolError(`The edit cannot reach ${name}: no credential for ${model.provider}.`);
	}

	const timeout = AbortSignal.timeout(APPLY_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const complete = async (request: string, maxTokens: number): Promise<Reply> => {
		const journal = journalCompletion(session.sessionManager, {
			purpose: "magic-edit",
			role: selector ? undefined : "smol",
		});
		const response = await retryTransientCompletion(
			async () => {
				session.costGate?.admit();
				const attempt = await completeSimple(
					model,
					{
						systemPrompt: [APPLY_SYSTEM_PROMPT],
						messages: [{ role: "user", content: request, timestamp: Date.now() }],
					},
					{
						apiKey: registry.resolver(model, sessionId),
						sessionId,
						maxTokens: Math.min(model.maxTokens ?? COMPLETION_MAX_TOKENS, COMPLETION_MAX_TOKENS, maxTokens),
						reasoning,
						disableReasoning: reasoning === undefined,
						signal: combined,
					},
				);
				session.costGate?.record(attempt.usage.cost.total);
				journal?.(attempt, request);
				return attempt;
			},
			{ signal: combined, provider: model.provider },
		);
		if (response.stopReason === "error") {
			throw new ToolError(`${name} failed while writing the edit: ${response.errorMessage ?? "unknown error"}`);
		}
		// An abort resolves with empty content rather than rejecting.
		if (response.stopReason === "aborted") {
			throw new ToolError(
				timeout.aborted
					? `The edit timed out after ${APPLY_TIMEOUT_MS / 1000}s waiting on ${name}; the file is unchanged.`
					: "The edit was aborted; the file is unchanged.",
			);
		}
		return {
			text: response.content.map(block => (block.type === "text" ? block.text : "")).join(""),
			truncated: response.stopReason === "length",
		};
	};
	return { name, model, complete };
}

/**
 * Apply one section: read its file, have `applier` write the change as line
 * operations, and pass the compiled edit to `apply` together with the raw text
 * it was written against, so `apply` can refuse a file that changed since.
 *
 * # Errors
 * {@link ToolError} when the file is missing or binary, when no view of it
 * fits the apply model, and as {@link applyDescribedChange}.
 */
async function applySection(options: {
	session: ToolSession;
	section: MagicSection;
	applier: Applier;
	apply: (edits: ReplaceEdit[], rawSnapshot?: string) => Promise<AgentToolResult<EditToolDetails>>;
	signal?: AbortSignal;
}): Promise<AgentToolResult<EditToolDetails>> {
	const { session, applier, signal } = options;
	const { path: target, change } = options.section;
	const absolute = await resolvePlanPath(session, target, signal);
	let raw: string;
	try {
		raw = await Bun.file(absolute).text();
	} catch (error) {
		if (isEnoent(error)) throw new ToolError(`${target} does not exist; this edit changes existing files.`);
		throw error;
	}
	if (raw.includes("\0")) throw new ToolError(`${target} is binary; this edit changes text files.`);
	// LF line ends and no BOM, as the edit engine matches it.
	const content = normalizeToLF(stripBom(raw).text);
	const window = applier.model.contextWindow ?? 0;
	const limit = window > 0 ? window * MAX_CONTEXT_SHARE * CHARS_PER_TOKEN : undefined;
	const views = fileViews(content, change, limit);
	if (views.length === 0) {
		throw new ToolError(
			`${target} is too large for ${applier.name} to read whole, and the change names no part of it to show instead: quote the lines to change, or give their line numbers.`,
		);
	}
	return applyDescribedChange({
		path: target,
		change,
		content,
		views,
		complete: applier.complete,
		apply: (edits, checkSnapshot) => options.apply(edits, checkSnapshot ? raw : undefined),
	});
}

/**
 * Carry out one `edit` call made in `magic` mode. Every per-file section
 * of `input` is applied on its own through `apply`, the edit tool's atomic
 * `replace` batch for one file: a section that fails leaves its file
 * untouched and does not stop the others.
 *
 * Resolves with the applied diffs and, for a failed section, why it was not
 * applied; `isError` only when no section applied.
 *
 * # Errors
 * {@link ToolError} for a malformed payload (see {@link parseMagicInput}),
 * when no apply model is usable, and when the only section fails.
 */
export async function runMagicEdit(options: {
	session: ToolSession;
	input: string;
	apply: (path: string, edits: ReplaceEdit[], rawSnapshot?: string) => Promise<AgentToolResult<EditToolDetails>>;
	signal?: AbortSignal;
}): Promise<AgentToolResult<EditToolDetails>> {
	const { session, signal } = options;
	const sections = parseMagicInput(options.input, cfgEditMagicFormat.get(session.settings));
	const applier = await resolveApplier(session, signal);
	// Completions overlap; writes go one at a time, as within any other edit call.
	let writes: Promise<unknown> = Promise.resolve();
	const settled = await Promise.all(
		sections.map(async section => {
			const apply = (edits: ReplaceEdit[], rawSnapshot?: string) => {
				const write = writes.then(() => options.apply(section.path, edits, rawSnapshot));
				writes = write.catch(() => {});
				return write;
			};
			try {
				return { section, result: await applySection({ session, section, applier, apply, signal }) };
			} catch (error) {
				if (!(error instanceof ToolError) || sections.length === 1) throw error;
				return { section, failure: error.message };
			}
		}),
	);
	if (settled.length === 1 && settled[0].result) return settled[0].result;

	const content: AgentToolResult<EditToolDetails>["content"] = [];
	const perFileResults: EditToolPerFileResult[] = [];
	for (const { section, result, failure } of settled) {
		if (result) {
			content.push(...result.content);
			const details = result.details;
			perFileResults.push({
				path: details?.path ?? section.path,
				diff: details?.diff ?? "",
				firstChangedLine: details?.firstChangedLine,
				diagnostics: details?.diagnostics,
				op: details?.op,
				meta: details?.meta,
			});
		} else {
			content.push({ type: "text", text: `[${section.path}] not applied: ${failure}` });
			perFileResults.push({ path: section.path, diff: "", isError: true, errorText: failure });
		}
	}
	const applied = perFileResults.filter(file => !file.isError);
	return {
		content,
		details: {
			diff: applied.map(file => file.diff).join("\n"),
			firstChangedLine: applied[0]?.firstChangedLine,
			perFileResults,
		},
		isError: applied.length === 0 ? true : undefined,
	};
}
