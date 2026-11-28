/**
 * `edit.mode: magic`: the agent describes what to change in words, and a
 * dedicated apply model carries out the change on each named file through a
 * multi-turn `replace`/`read`/`search` tool loop over an in-memory buffer.
 *
 * The tool input is Markdown sections headed by `# path`. A section's change
 * is applied in memory, syntax-checked against tree-sitter when the original
 * file parsed, and committed atomically through the edit tool's `replace`
 * engine with a snapshot guard so concurrent external writes are refused.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	completeSimple,
	type Message,
	type Model,
	retryTransientCompletion,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { parseCodeStatus } from "@oh-my-pi/pi-natives";
import { concreteThinkingLevel, toReasoningEffort } from "../thinking/levels";
import type { EditToolDetails, EditToolPerFileResult } from "../tools/details/edit";
import { splitMagicSections } from "./magic-sections";
import { ToolError } from "../tools/tool-errors";
import { isEnoent, prompt, stableStringifyJson } from "@oh-my-pi/pi-utils";
import { cfgOffline } from "../config/auxiliary-model-policy";
import { getModelMatchPreferences, resolveModelRoleValue, resolveRoleSelection } from "../config/model-resolver";
import { journalCompletion } from "../session/model-usage-journal";
import type { ToolSession } from "../tools";
import { resolvePlanPath } from "../tools/plan-mode-guard";
import applyFeedbackPrompt from "./magic-apply-feedback.md" with { type: "text" };
import applyRequestPrompt from "./magic-apply.md" with { type: "text" };
import applySystemPromptSource from "./magic-apply-system.md" with { type: "text" };
import { normalizeApplyArguments, parseWrittenToolCalls } from "./magic-calls";
import {
	APPLY_TOOLS,
	type AppliedReplace,
	applyReplace,
	diagnoseBufferSyntax,
	readBufferLines,
	searchBuffer,
} from "./magic-tools";
import { type FileView, fileViews } from "./magic-view";
import { normalizeToLF, stripBom } from "./normalize";
import type { ReplaceBatchParams } from "./schemas";
import { cfgEditMagicModel } from "./settings";

/** Maximum model turns for one file's edit session. */
const MAX_TURNS = 12;
const COMPLETION_MAX_TOKENS = 16_384;
/** One budget across every turn: the calling agent's turn blocks on the edit. */
const APPLY_TIMEOUT_MS = 120_000;
/** Largest share of the apply model's context window the initial file view may take. */
const MAX_CONTEXT_SHARE = 0.5;
/** Conservative characters-per-token estimate for source text. */
const CHARS_PER_TOKEN = 3;

const REFUSAL = /^CANNOT:\s*(.*)/i;

const APPLY_SYSTEM_PROMPT = prompt.render(applySystemPromptSource);

/**
 * Constrained-decoding grammar of the payload: `# path` sections that carry at
 * least one line of changes. The object is shared, so the tool's wire identity
 * is stable across requests.
 */
export const MAGIC_EDIT_GRAMMAR: { syntax: "lark"; definition: string } = {
	syntax: "lark",
	definition: `start: section+
section: PATH_HEADER LF LF* CHANGE_TEXT (LF change_line* CHANGE_TEXT?)?
change_line: CHANGE_TEXT LF | LF

PATH_HEADER: /# [^\\r\\n]+/
// LLGuidance supports terminal intersection/complement, not priorities or lookarounds.
CHANGE_TEXT: /[^\\r\\n]+/ & ~PATH_HEADER

%import common.LF
`,
};

type ReplaceEdit = ReplaceBatchParams["edits"][number];

/** The changes one payload asks for in one file. */
export interface MagicSection {
	path: string;
	change: string;
}

/** Files a payload names so far, in order and without repeats; tolerates a payload still streaming in. */
export function magicEditPaths(input: string): string[] {
	return [...new Set(splitMagicSections(input).runs.map(run => run.path))];
}

/**
 * Split a `magic` edit payload into one section per named file, in order of
 * first appearance. Repeated headers for the same file merge into one section.
 *
 * # Errors
 * {@link ToolError} when no `# path` header is given, text appears before the
 * first header, or a header carries no change text.
 */
export function parseMagicInput(input: string): MagicSection[] {
	const { runs, outside } = splitMagicSections(input);
	if (runs.length === 0) throw new ToolError("Give one `# path` line followed by its changes per file.");
	if (outside.trim() !== "") {
		throw new ToolError("Every change belongs to a file: put it under that file's `# path` line.");
	}
	const bodies = new Map<string, string[]>();
	for (const { path, text } of runs) {
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

function toolResult(call: ToolCall, text: string, isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

/** Replay written calls as native calls instead of the text or its original Responses items. */
function withWrittenToolCalls(response: AssistantMessage, calls: ToolCall[]): AssistantMessage {
	const { providerPayload: _native, ...rest } = response;
	return {
		...rest,
		content: [...response.content.filter(block => block.type !== "text"), ...calls],
		stopReason: "toolUse",
	};
}

/**
 * Drive the apply model across turns of `replace`, `read`, and `search` tool
 * calls against an in-memory buffer of `content`, syntax-check the final
 * buffer, and commit one atomic edit through `apply`.
 *
 * If the model declines on an initial excerpt without inspecting more of the
 * file and a wider view is available, the loop restarts afresh with that view.
 *
 * # Errors
 * {@link ToolError} when the file is empty, when the model refuses, when the
 * edits leave the file unparseable or unfinished within {@link MAX_TURNS}, or
 * when `apply` rejects the commit.
 */
export async function applyDescribedChange(options: {
	path: string;
	change: string;
	content: string;
	/** Initial views of `content`, narrowest first; at least one view. */
	views?: FileView[];
	/** Run one model completion turn with the current conversation and tools. */
	complete: (messages: Message[], tools: Tool[]) => Promise<AssistantMessage>;
	apply: (edits: ReplaceEdit[]) => Promise<AgentToolResult<EditToolDetails>>;
}): Promise<AgentToolResult<EditToolDetails>> {
	const { path, change, content } = options;
	if (content === "") throw new ToolError(`${path} is empty; use write instead.`);
	const views = options.views ?? fileViews(content, change);
	const parses = (code: string) => parseCodeStatus({ code: code === "" ? "\n" : code, path }).parsed;
	const parsed = parses(content);
	const replaceAttempts = new Map<string, string | null>();

	viewLoop: for (const [viewIndex, view] of views.entries()) {
		let working = content;
		const applied: AppliedReplace[] = [];
		let inspected = false;
		let failedReplacement = false;
		let lastFeedback: string | undefined;
		const messages: Message[] = [
			{
				role: "user",
				content: prompt.render(applyRequestPrompt, {
					path,
					change,
					file: view.text,
					partial: view.partial,
					totalLines: view.totalLines,
				}),
				timestamp: Date.now(),
			},
		];

		for (let turn = 1; turn <= MAX_TURNS; turn++) {
			const response = await options.complete(messages, APPLY_TOOLS);
			const feedback: { truncated?: boolean; syntax?: string; failed?: boolean; callFormat?: boolean } = {};
			if (response.stopReason === "length") {
				// Providers may expose partly parsed tool calls on a truncated turn. Do not stage or replay them.
				feedback.truncated = true;
				failedReplacement = true;
			} else {
				let reply = response;
				let calls = reply.content.filter(block => block.type === "toolCall");
				let text = "";
				if (calls.length === 0) {
					text = response.content
						.map(block => (block.type === "text" ? block.text : ""))
						.join("")
						.trim();
					const written = parseWrittenToolCalls(text);
					if (written.calls.length === 0) {
						feedback.callFormat = written.attempted;
					} else {
						calls = written.calls.map((call, n) => ({ type: "toolCall", id: `written_${turn}_${n}`, ...call }));
						reply = withWrittenToolCalls(response, calls);
					}
				}
				if (calls.length > 0) {
					const replyIndex = messages.length;
					messages.push(reply);
					let repairedCalls: Map<ToolCall, ToolCall> | undefined;
					let replaced = false;
					let failed = false;
					for (const call of calls) {
						const args = normalizeApplyArguments(call);
						if (typeof args === "string") {
							if (call.name !== "read" && call.name !== "search") failed = true;
							messages.push(toolResult(call, args, true));
							continue;
						}
						if (args !== call.arguments && Object.hasOwn(call.arguments, "__rawJson")) {
							(repairedCalls ??= new Map()).set(call, { ...call, arguments: args });
						}
						if (call.name === "replace") {
							const key = stableStringifyJson(args);
							const previous = replaceAttempts.get(key);
							if (previous !== undefined) {
								if (previous === null) {
									messages.push(
										toolResult(call, "This exact replace was already applied. Do not repeat it.", true),
									);
								} else {
									failed = true;
									messages.push(toolResult(call, `This exact replace already failed: ${previous}`, true));
								}
								continue;
							}
							const attempt = applyReplace(working, args);
							if ("error" in attempt) {
								failed = true;
								replaceAttempts.set(key, attempt.error);
								messages.push(toolResult(call, attempt.error, true));
							} else {
								replaced = true;
								replaceAttempts.set(key, null);
								working = attempt.content;
								applied.push(attempt.step);
								messages.push(toolResult(call, attempt.message, false));
							}
						} else if (call.name === "read" || call.name === "search") {
							const result = call.name === "read" ? readBufferLines(working, args) : searchBuffer(working, args);
							if ("error" in result) messages.push(toolResult(call, result.error, true));
							else {
								inspected = true;
								messages.push(toolResult(call, result.text, false));
							}
						} else {
							failed = true;
							messages.push(toolResult(call, "Available tools: replace, read, search.", true));
						}
					}
					const repairs = repairedCalls;
					if (repairs) {
						const { providerPayload: _native, ...rest } = reply;
						messages[replyIndex] = {
							...rest,
							content: reply.content.map(block =>
								block.type === "toolCall" ? (repairs.get(block) ?? block) : block,
							),
						};
					}
					if (replaced || failed) failedReplacement = failed;
					if (replaced) lastFeedback = undefined;
					continue;
				}

				const refusal = text.match(REFUSAL);
				if (refusal) {
					if (!inspected && applied.length === 0 && viewIndex + 1 < views.length) continue viewLoop;
					throw new ToolError(`No change was made to ${path}: ${refusal[1].trim() || "no reason given"}`);
				}
				if (failedReplacement) feedback.failed = true;
				else if (/^DONE[.!]?$/i.test(text) && working !== content) {
					if (parsed && !parses(working)) {
						feedback.syntax = diagnoseBufferSyntax(content, working, applied, parses);
					} else {
						const result = await options.apply([{ old_string: content, new_string: working, replace_all: true }]);
						if (!result.isError) return result;
						const reason = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
						throw new ToolError(`The change to ${path} could not be applied: ${reason}`);
					}
				}
				messages.push(response);
			}

			const correction = prompt.render(applyFeedbackPrompt, feedback).trim();
			if (turn === MAX_TURNS || correction === lastFeedback) {
				throw new ToolError(`The change to ${path} did not finish; the file is unchanged. ${correction}`);
			}
			lastFeedback = correction;
			messages.push({ role: "user", content: correction, timestamp: Date.now() });
		}
		throw new ToolError(`The change to ${path} did not finish within ${MAX_TURNS} turns; the file is unchanged.`);
	}

	throw new ToolError(`The change to ${path} could not be applied; the file is unchanged.`);
}

/** The model that drives the apply tools, and one completion turn against it. */
interface Applier {
	model: Model<Api>;
	complete(messages: Message[], tools: Tool[]): Promise<AssistantMessage>;
}

/**
 * Resolve the apply model for `session` and bind a completion turn to it.
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
	const ceiling = Math.min(model.maxTokens ?? COMPLETION_MAX_TOKENS, COMPLETION_MAX_TOKENS);
	const complete = async (messages: Message[], tools: Tool[]): Promise<AssistantMessage> => {
		const journal = journalCompletion(session.sessionManager, {
			purpose: "magic-edit",
			role: selector ? undefined : "smol",
		});
		const last = messages.at(-1);
		const promptText = last?.role === "user" && typeof last.content === "string" ? last.content : undefined;
		const response = await retryTransientCompletion(
			async () => {
				session.costGate?.admit();
				const attempt = await completeSimple(
					model,
					{
						systemPrompt: [APPLY_SYSTEM_PROMPT],
						messages,
						tools,
					},
					{
						apiKey: registry.resolver(model, sessionId),
						sessionId,
						maxTokens: ceiling,
						reasoning,
						disableReasoning: reasoning === undefined,
						signal: combined,
					},
				);
				session.costGate?.record(attempt.usage.cost.total);
				journal?.(attempt, promptText);
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
		return response;
	};
	return { model, complete };
}

/**
 * Apply one section: read its file, run the multi-turn apply loop against an
 * in-memory buffer, and commit the resulting edit together with the raw text
 * snapshot so `apply` can refuse a file that changed concurrently on disk.
 *
 * # Errors
 * {@link ToolError} when the file is missing or binary, and as {@link applyDescribedChange}.
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
	return applyDescribedChange({
		path: target,
		change,
		content,
		views: fileViews(content, change, limit),
		complete: applier.complete,
		apply: edits => options.apply(edits, raw),
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
	const sections = parseMagicInput(options.input);
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
				checkoutNotice: details?.checkoutNotice,
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
