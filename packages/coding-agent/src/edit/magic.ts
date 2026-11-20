/**
 * `magic_edit` edit mode: edit a file from a described change.
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
 * `smol` role) reads the numbered file and answers with SEARCH/REPLACE blocks,
 * which the edit tool applies as one atomic `replace` batch: matching, fuzzy
 * recovery, plan-mode policy, LSP writethrough and the result diff are the
 * tool's usual ones. A rejected batch goes back to the model for a corrected
 * reply; a file whose change runs out of attempts is left as it was. The
 * files' completions run concurrently; their writes do not.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Api, completeSimple, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import type { EditToolDetails, EditToolPerFileResult } from "@oh-my-pi/pi-tui/tools/edit";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { cfgOffline } from "../config/auxiliary-model-policy";
import { getModelMatchPreferences, resolveModelRoleValue, resolveRoleSelection } from "../config/model-resolver";
import { journalCompletion } from "../session/model-usage-journal";
import type { ToolSession } from "../tools";
import { resolvePlanPath } from "../tools/plan-mode-guard";
import applyRequestPrompt from "./magic-apply.md" with { type: "text" };
import applySystemPromptSource from "./magic-apply-system.md" with { type: "text" };
import { normalizeToLF, stripBom } from "./normalize";
import type { ReplaceBatchParams } from "./schemas";
import { cfgEditMagicFormat, cfgEditMagicModel } from "./settings";

/** Completions per call: the first reply plus corrections after a rejected batch. */
const MAX_ATTEMPTS = 3;
const COMPLETION_MAX_TOKENS = 16_384;
/** One budget across every attempt: the calling agent's turn blocks on the edit. */
const APPLY_TIMEOUT_MS = 120_000;
/** Largest share of the apply model's context window the file may take. */
const MAX_CONTEXT_SHARE = 0.5;
/** Conservative characters-per-token estimate for source text. */
const CHARS_PER_TOKEN = 3;

const SEARCH_MARKER = /^<{5,9} ?SEARCH( ALL)?\s*$/i;
const DIVIDER_MARKER = /^={5,9}\s*$/;
const REPLACE_MARKER = /^>{5,9} ?REPLACE\s*$/i;
const REFUSAL = /^\s*CANNOT:\s*(.*)$/i;

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

/** One SEARCH/REPLACE block of an apply-model reply, as whole lines. */
export interface MagicBlock {
	search: string[];
	replace: string[];
	/** `SEARCH ALL`: every occurrence of the fragment is replaced. */
	all: boolean;
}

/** What an apply-model reply asks for. */
export type MagicReply =
	| { kind: "blocks"; blocks: MagicBlock[] }
	/** The model judged the change impossible as described. */
	| { kind: "refusal"; reason: string }
	/** Not a usable set of blocks; `problem` is worded for the model. */
	| { kind: "malformed"; problem: string };

/**
 * Read an apply-model reply. Text outside the blocks (code fences, stray
 * commentary) is ignored; a `CANNOT:` first line is a refusal.
 */
export function parseMagicReply(reply: string): MagicReply {
	const lines = normalizeToLF(reply).split("\n");
	const refusal = lines.find(line => line.trim() !== "")?.match(REFUSAL);
	if (refusal) return { kind: "refusal", reason: refusal[1].trim() || "no reason given" };

	const blocks: MagicBlock[] = [];
	let open: (MagicBlock & { divided: boolean }) | undefined;
	for (const line of lines) {
		if (!open) {
			const marker = SEARCH_MARKER.exec(line);
			if (marker) open = { search: [], replace: [], all: marker[1] !== undefined, divided: false };
		} else if (!open.divided) {
			if (DIVIDER_MARKER.test(line)) open.divided = true;
			else open.search.push(line);
		} else if (REPLACE_MARKER.test(line)) {
			blocks.push({ search: open.search, replace: open.replace, all: open.all });
			open = undefined;
		} else {
			open.replace.push(line);
		}
	}
	if (open) {
		return {
			kind: "malformed",
			problem: `Block ${blocks.length + 1} is not closed: every block needs a \`=======\` line and a closing \`>>>>>>> REPLACE\` line.`,
		};
	}
	if (blocks.length === 0) return { kind: "malformed", problem: "The reply contains no SEARCH/REPLACE block." };
	const empty = blocks.findIndex(block => block.search.every(line => line.trim() === ""));
	if (empty !== -1) {
		return { kind: "malformed", problem: `Block ${empty + 1} has an empty SEARCH: quote the lines to change.` };
	}
	return { kind: "blocks", blocks };
}

/** `replace`-engine operands for `block`, given the LF text of the file it edits. */
function toReplaceEdit(content: string, block: MagicBlock): ReplaceEdit {
	const search = block.search.join("\n");
	if (block.all || block.replace.length > 0) {
		return { old_string: search, new_string: block.replace.join("\n"), replace_all: block.all };
	}
	// An empty REPLACE deletes whole lines, so a line terminator goes with them:
	// the one after, or the one before when the lines end an unterminated file.
	if (content.includes(`${search}\n`)) return { old_string: `${search}\n`, new_string: "" };
	if (content.endsWith(`\n${search}`)) return { old_string: `\n${search}`, new_string: "" };
	return { old_string: search, new_string: "" };
}

/** `content` with each line behind its 1-based number and a tab. */
function numberLines(content: string): string {
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines.map((line, index) => `${index + 1}\t${line}`).join("\n");
}

/**
 * Turn `change` into an applied edit of `path`: ask `complete` for
 * SEARCH/REPLACE blocks against `content` (the file's LF text), hand them to
 * `apply` as one atomic batch, and return a rejection to the model for a
 * corrected reply. Resolves with the result of the batch that applied.
 *
 * # Errors
 * {@link ToolError} when the model declines the change, or when no reply
 * applied within {@link MAX_ATTEMPTS}. `apply` never succeeded, so the file is
 * as it was.
 */
export async function applyDescribedChange(options: {
	path: string;
	change: string;
	content: string;
	complete: (request: string) => Promise<string>;
	apply: (edits: ReplaceEdit[]) => Promise<AgentToolResult<EditToolDetails>>;
}): Promise<AgentToolResult<EditToolDetails>> {
	const { path, change, content } = options;
	const file = numberLines(content);
	let previous: string | undefined;
	let rejection = "";
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const reply = await options.complete(
			prompt.render(applyRequestPrompt, { path, file, change, previous, rejection }),
		);
		const parsed = parseMagicReply(reply);
		if (parsed.kind === "refusal") {
			throw new ToolError(`No change was made to ${path}: ${parsed.reason}`);
		}
		if (parsed.kind === "blocks") {
			const result = await options.apply(parsed.blocks.map(block => toReplaceEdit(content, block)));
			if (!result.isError) return result;
			rejection = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		} else {
			rejection = parsed.problem;
		}
		previous = reply;
	}
	throw new ToolError(
		`The change to ${path} could not be applied in ${MAX_ATTEMPTS} attempts; the file is unchanged. Last rejection:\n${rejection}\nDescribe the change more exactly: quote the lines it touches.`,
	);
}

/** The model that writes the patch, and one completion against it. */
interface Applier {
	/** `provider/id`, for error messages. */
	name: string;
	model: Model<Api>;
	complete(request: string): Promise<string>;
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
	const model = selector
		? resolveModelRoleValue(selector, pool, {
				settings: session.settings,
				matchPreferences: getModelMatchPreferences(session.settings),
			}).model
		: resolveRoleSelection(["smol"], session.settings, pool)?.model;
	if (!registry || !model) {
		throw new ToolError(
			selector
				? `\`edit.magic.model\` (${selector}) matches no available model.`
				: "`edit.mode: magic_edit` needs a model to apply the change: configure the `smol` role or `edit.magic.model`.",
		);
	}
	const name = `${model.provider}/${model.id}`;
	const sessionId = session.getSessionId?.() ?? undefined;
	if (!(await registry.getApiKey(model, sessionId))) {
		throw new ToolError(`The edit cannot reach ${name}: no credential for ${model.provider}.`);
	}

	const timeout = AbortSignal.timeout(APPLY_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const complete = async (request: string): Promise<string> => {
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
						maxTokens: Math.min(model.maxTokens ?? COMPLETION_MAX_TOKENS, COMPLETION_MAX_TOKENS),
						disableReasoning: true,
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
		if (response.stopReason === "length") {
			throw new ToolError(
				`${name} ran out of output before finishing the edit; split the change into smaller calls.`,
			);
		}
		return response.content.map(block => (block.type === "text" ? block.text : "")).join("");
	};
	return { name, model, complete };
}

/**
 * Apply one section: read its file, have `applier` write the change as
 * SEARCH/REPLACE blocks, and pass them to `apply`.
 *
 * # Errors
 * {@link ToolError} when the file is missing, binary or too large for the
 * apply model, and as {@link applyDescribedChange}.
 */
async function applySection(options: {
	session: ToolSession;
	section: MagicSection;
	applier: Applier;
	apply: (edits: ReplaceEdit[]) => Promise<AgentToolResult<EditToolDetails>>;
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
	if (window > 0 && content.length / CHARS_PER_TOKEN > window * MAX_CONTEXT_SHARE) {
		throw new ToolError(`${target} is too large for ${applier.name} to edit from a description.`);
	}
	return applyDescribedChange({ path: target, change, content, complete: applier.complete, apply: options.apply });
}

/**
 * Carry out one `edit` call made in `magic_edit` mode. Every per-file section
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
	apply: (path: string, edits: ReplaceEdit[]) => Promise<AgentToolResult<EditToolDetails>>;
	signal?: AbortSignal;
}): Promise<AgentToolResult<EditToolDetails>> {
	const { session, signal } = options;
	const sections = parseMagicInput(options.input, cfgEditMagicFormat.get(session.settings));
	const applier = await resolveApplier(session, signal);
	// Completions overlap; writes go one at a time, as within any other edit call.
	let writes: Promise<unknown> = Promise.resolve();
	const settled = await Promise.all(
		sections.map(async section => {
			const apply = (edits: ReplaceEdit[]) => {
				const write = writes.then(() => options.apply(section.path, edits));
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
