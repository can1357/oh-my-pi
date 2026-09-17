/**
 * Coverage check for compaction summaries and handoff documents.
 *
 * A summary replaces the turns it describes, so nothing downstream can notice
 * what it dropped. This asks the judgment provider, once per user request being
 * compacted away, whether the summary preserves it, and appends the ones it
 * does not — verbatim and bounded — so the next turn still sees them. File
 * operations are already appended deterministically (`upsertFileOperations`),
 * so the only evidence checked here is what the user said.
 *
 * Opt-in via `compaction.coverageCheck`. Best-effort and fail-open: a judge
 * failure, timeout, or abort returns the summary unchanged.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model, NoulQuestion } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { type JudgmentUsage, resolveJudge } from "../judgment";
import coverageNoteTemplate from "../prompts/system/compaction-coverage-note.md" with { type: "text" };
import coverageQuestionTemplate from "../prompts/system/compaction-coverage-question.md" with { type: "text" };
import { preprocessTinyMessage } from "../tiny/message-preproc";
import { ONLINE_MEMORY_MODEL_KEY } from "../tiny/models";

/** Shorter user messages are acknowledgements or steering, not requirements worth re-checking. */
const MIN_REQUEST_CHARS = 40;
/** Requests checked per summary; beyond this the first and last halves are kept. */
const MAX_REQUESTS = 24;
/** Summaries above this are not checked: truncating one would only manufacture false gaps. */
const MAX_SUMMARY_CHARS = 48_000;
/** Bound on the whole check, on top of the caller's own compaction signal. */
const COVERAGE_TIMEOUT_MS = 30_000;
/** Noul probability below which a request counts as not preserved. */
const COVERED_THRESHOLD = 0.5;

export interface CoverageCheckDeps {
	settings: Settings;
	registry: ModelRegistry;
	/** Messages the summary replaces; only user-authored text is examined. */
	messages: readonly AgentMessage[];
	/** Active session model, the LLM chain's last resort. */
	model?: Model;
	sessionId?: string;
	signal?: AbortSignal;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	onUsage?: (usage: JudgmentUsage) => void;
}

/**
 * User-authored requests from `messages`, cleaned through the tiny-model input
 * policy and bounded to {@link MAX_REQUESTS}. Agent-attributed and synthetic
 * user messages (auto-continue, the handoff prompt itself, other harness
 * injections) are not requests; a mid-turn steer typed by the user is.
 */
export function extractUserRequests(messages: readonly AgentMessage[]): string[] {
	const requests: string[] = [];
	for (const message of messages) {
		if (message.role !== "user" || message.attribution === "agent" || message.synthetic) continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter(part => part.type === "text")
						.map(part => part.text)
						.join("\n");
		const cleaned = preprocessTinyMessage(text);
		if (cleaned.length >= MIN_REQUEST_CHARS) requests.push(cleaned);
	}
	if (requests.length <= MAX_REQUESTS) return requests;
	const head = Math.ceil(MAX_REQUESTS / 2);
	return [...requests.slice(0, head), ...requests.slice(requests.length - (MAX_REQUESTS - head))];
}

/**
 * Return `summary` with a note listing the user requests it does not preserve,
 * or unchanged when the check is disabled, nothing qualifies, everything is
 * covered, or the judge fails. The note goes ahead of a trailing `<files>`
 * block so the file-operation tail stays last.
 */
export async function appendCoverageNote(summary: string, deps: CoverageCheckDeps): Promise<string> {
	if (!deps.settings.get("compaction.coverageCheck")) return summary;
	if (summary.trim().length === 0 || summary.length > MAX_SUMMARY_CHARS) return summary;
	const requests = extractUserRequests(deps.messages);
	if (requests.length === 0) return summary;

	const questions: Record<string, NoulQuestion> = {};
	for (let index = 0; index < requests.length; index++) {
		questions[`request${index}`] = {
			type: "noul",
			instructions: prompt.render(coverageQuestionTemplate, { index }),
		};
	}
	const timeout = AbortSignal.timeout(COVERAGE_TIMEOUT_MS);
	const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
	try {
		const judge = resolveJudge({
			settings: deps.settings,
			registry: deps.registry,
			backend: ONLINE_MEMORY_MODEL_KEY,
			sessionModel: deps.model,
			sessionId: deps.sessionId,
			metadataResolver: deps.metadataResolver,
			onUsage: deps.onUsage,
		});
		const { answers } = await judge.judge({ state: { summary, requests }, questions }, { signal });
		// A missing answer counts as covered: the note only ever adds what the
		// judge affirmatively reported missing.
		const uncovered = requests.filter((_, index) => (answers[`request${index}`]?.noul ?? 1) < COVERED_THRESHOLD);
		if (uncovered.length === 0) return summary;
		logger.debug("Compaction summary missed user requests; appending coverage note", {
			checked: requests.length,
			uncovered: uncovered.length,
		});
		return insertCoverageNote(summary, uncovered);
	} catch (error) {
		logger.debug("Compaction coverage check failed; keeping the summary as generated", {
			error: error instanceof Error ? error.message : String(error),
		});
		return summary;
	}
}

function insertCoverageNote(summary: string, uncovered: readonly string[]): string {
	// One bullet per request: collapse internal line breaks so the list survives.
	const note = prompt
		.render(coverageNoteTemplate, { requests: uncovered.map(request => request.replace(/\s+/g, " ").trim()) })
		.trim();
	const filesTag = summary.lastIndexOf("<files>");
	if (filesTag < 0) return `${summary.trimEnd()}\n\n${note}\n`;
	return `${summary.slice(0, filesTag).trimEnd()}\n\n${note}\n\n${summary.slice(filesTag)}`;
}
