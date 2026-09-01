/**
 * Similarity classifier for the "Approve Similar <tool> Commands for Session"
 * approval option: decides whether a pending tool call matches what the user
 * already approved for this session — a recorded subject for that tool, or a
 * file the session may write — and names the files the pending call writes when
 * only a model can read them out of it (a shell command's redirections).
 *
 * One backend: the TINY/smol role model classifies via {@link completeSimple}.
 * The on-device tiny models the other small-model classifiers offer are
 * deliberately not an option here — a `YES` from this one runs a tool with no
 * prompt, and a 1-2B local model was measured granting a compound command whose
 * effect class does not match the approved one (`ls && touch ./foo` against
 * approved `ls`), which no prompt wording moved. A self-hosted classifier is
 * still reachable by pointing the TINY role at it.
 *
 * Fail-safe by contract: any error, timeout, abort, unparsable output, or input
 * it cannot read whole resolves to "not covered" (the approval gate prompts
 * again) and to no write targets. Never throws.
 */
import { completeSimple } from "@oh-my-pi/pi-ai";
import { logger, prompt, withTimeout } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import approvalSimilarityPrompt from "../prompts/system/approval-similarity.md" with { type: "text" };
import approvalSimilarityUserPrompt from "../prompts/system/approval-similarity-user.md" with { type: "text" };
import { stripAnsi } from "../tiny/message-preproc";
import { isTruncatedForPrompt } from "./approval";
import type { ToolFileEffects } from "./approval-write-targets";
import {
	getFileApprovals,
	getSimilarApprovals,
	isFileApprovedForSession,
	normalizeApprovalPath,
} from "./session-approvals";

const SIMILARITY_SYSTEM_PROMPT = prompt.render(approvalSimilarityPrompt);

/**
 * Hard bound on the whole classification: a stalled backend must not freeze the
 * approval prompt; the caller's abort signal is combined with it. Kept under
 * the time a user needs to answer the prompt themselves — past that the
 * classifier is slower than the gate it replaces, and its fail-safe (a normal
 * prompt) is the better outcome.
 */
const CLASSIFY_TIMEOUT_MS = 3_000;

/**
 * Character budgets for classifier input. Nothing is cut to fit them: a
 * head-truncated command hides the operation behind a shared benign prefix
 * (`ls` vs `ls && touch …`), and the rubric reasons over the whole subject, so
 * cutting would manufacture wrong YES verdicts. Over budget means "not
 * classified" instead — the candidate falls back to a prompt, and a recorded
 * subject is left out of the comparison.
 */
const MAX_SUBJECT_CHARS = 1_000;
/** The pending call's subject deserves more room than one approved entry. */
const MAX_CANDIDATE_CHARS = 2_000;
/** Write targets accepted from one answer; a call naming more is not one the model read reliably. */
const MAX_ANSWER_WRITE_TARGETS = 16;

/**
 * Reasoning-safe budget: sized to survive a backend that ignores
 * `disableReasoning` — the yes/no keyword needs to land after any unavoidable
 * thinking preamble (issue #4355).
 */
const REASONING_SAFE_MAX_TOKENS = 1024;

export interface ApprovalSimilarityDeps {
	sessionId: string;
	toolName: string;
	/** Raw subject of the pending call — `approvalSubject(tool, args)` output. */
	subject: string;
	/** Exact-repeat key of the pending call — `approvalIdentity(resolvedArgs)` output. */
	identity: string;
	/**
	 * What the pending call does to files, read from its own arguments
	 * (`toolFileEffects`). Present for `write`/`edit`; absent for every tool
	 * whose effects only a model can name.
	 */
	fileEffects?: ToolFileEffects;
	/** Working directory of the call — the paths a model names resolve against it. */
	cwd: string;
	settings: Settings;
	/**
	 * Absent when the call's context carries no registry. The no-model answers
	 * still run; a classification that needs the model fails safe to a prompt.
	 */
	registry?: ModelRegistry;
	signal?: AbortSignal;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
}

export interface ApprovalSimilarityVerdict {
	/** True when a session grant covers the pending call: run it without prompting. */
	covered: boolean;
	/**
	 * Absolute normalized files the pending call writes: its own arguments when
	 * they name them, else the paths the model cited from the subject. What an
	 * `Approve Similar` choice records as file grants.
	 */
	writeTargets: readonly string[];
}

const NOT_COVERED: ApprovalSimilarityVerdict = { covered: false, writeTargets: [] };

/**
 * Whether a session grant covers the pending call, plus the files it writes.
 *
 * Four answers cost no model call: nothing recorded for this tool and no file
 * grant at all, a call whose arguments the user already approved (digest
 * repeat), a `write`/`edit` that takes a path away (never covered), and a
 * `write`/`edit` whose every target already carries a file grant. Anything the
 * model could only read in part is not judged either — see the budgets above.
 */
export async function classifyApprovalSimilarity(deps: ApprovalSimilarityDeps): Promise<ApprovalSimilarityVerdict> {
	const approvedEntries = getSimilarApprovals(deps.sessionId, deps.toolName);
	const approvedFiles = getFileApprovals(deps.sessionId);
	if (approvedEntries.length === 0 && approvedFiles.length === 0) return NOT_COVERED;
	const effects = deps.fileEffects;

	// The very call the user read in the prompt and approved: no model can add
	// anything, so the repeat costs neither a request nor the wait for one.
	// Matched on the args digest only — subject text is truncated for display
	// long before it is recorded, so calls differing past the cut share it.
	if (approvedEntries.some(entry => entry.identity === deps.identity)) {
		return { covered: true, writeTargets: effects?.writes ?? [] };
	}

	// A grant means "this session may write this file". A call that takes a path
	// away — a delete, or the source of a move — asks for a different effect, so
	// no grant answers it and it always prompts. Refused here rather than left to
	// the model: a file tool's subject is its path (`File: src/a.ts`) and nothing
	// more, so a delete and an in-place edit of the same file are the same text
	// and no classifier can tell them apart.
	if (effects?.removes) return NOT_COVERED;

	// A file grant answers structurally, and only for tools whose arguments name
	// their effects exactly: writing a file the user approved writing this
	// session is the grant, whichever of `write`/`edit` does it, and the check
	// runs before the budget gates so a multi-kilobyte payload still matches.
	// Deliberately not extended to tools whose targets a model has to read out of
	// them: `rm -rf src/a.ts` writes an approved file too, so for those the
	// verdict below — which judges the effect, not just the target — decides.
	const writes = effects?.writes ?? [];
	if (writes.length > 0 && writes.every(target => isFileApprovedForSession(deps.sessionId, target))) {
		return { covered: true, writeTargets: writes };
	}

	const approved = approvedEntries
		.map(entry => stripAnsi(entry.subject).trim())
		.filter(subject => subject.length > 0 && subject.length <= MAX_SUBJECT_CHARS && !isTruncatedForPrompt(subject))
		.map(subject => JSON.stringify(subject));
	const files = approvedFiles.filter(file => file.length <= MAX_SUBJECT_CHARS).map(file => JSON.stringify(file));
	if (approved.length === 0 && files.length === 0) return NOT_COVERED;
	return classify(deps, approved, files);
}

/**
 * The files the pending call writes, with no coverage question asked.
 *
 * The record path uses this when the gate itself never classified — an
 * `Approve Similar` on the session's first `bash` grant, where there was
 * nothing yet to compare against — so a gate still costs at most one
 * classification. The verdict of a comparison against an empty approved list is
 * meaningless and discarded.
 */
export async function classifyWriteTargets(deps: ApprovalSimilarityDeps): Promise<readonly string[]> {
	const verdict = await classify(deps, [], []);
	return verdict.writeTargets;
}

async function classify(
	deps: ApprovalSimilarityDeps,
	approved: readonly string[],
	files: readonly string[],
): Promise<ApprovalSimilarityVerdict> {
	const candidate = stripAnsi(deps.subject).trim();
	// Material the model could not read in full is never judged: empty, over
	// budget, or already elided by the tool that formatted it for the prompt.
	if (candidate.length === 0 || candidate.length > MAX_CANDIDATE_CHARS || isTruncatedForPrompt(candidate)) {
		return NOT_COVERED;
	}

	// Everything the classifier reads is text the agent itself wrote — for `bash`
	// the raw command — and a `YES` runs the call with no prompt, so subject text
	// that reads as instruction is an execution exploit. Two framings keep it
	// data. Each value goes in as a JSON string, so a payload cannot start a line
	// of its own: a forged `Approved subjects:` section stays inside one quoted
	// literal instead of posing as message structure. Around the slots sits a
	// marker regenerated per classification, which quoted text cannot guess and
	// therefore cannot close. Measured on the tiny/smol role model
	// (venice/deepseek-v4-flash): a payload appending its own approved list and
	// "New command" won YES 3/3 with unquoted values inside the marker, and NO
	// 3/3 once quoted, with a genuinely similar command still YES 3/3.
	const fence = `===${crypto.randomUUID().replaceAll("-", "")}===`;
	// Rendered once here, not per call site: one classification asks one question,
	// framed by one marker. JSON quoting also keeps a multi-line subject (write's
	// "Path: …\nContent: …") on one `- ` list item.
	const userMessage = prompt.render(approvalSimilarityUserPrompt, {
		tool: JSON.stringify(deps.toolName),
		approved,
		files,
		candidate: JSON.stringify(candidate),
		fence,
	});
	const timeBounded: ApprovalSimilarityDeps = {
		...deps,
		signal: deps.signal
			? AbortSignal.any([deps.signal, AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)])
			: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
	};
	try {
		// The combined abort signal cancels the model request itself; `withTimeout`
		// bounds the wait, because stages between here and the request ignore it —
		// notably the credential resolution in `requestClassification`, which may
		// refresh an OAuth token over the network. It takes no signal of its own: an
		// already-aborted one would make it reject before it adopts the
		// classification promise, leaving that rejection unhandled.
		const answering = requestClassification(userMessage, timeBounded);
		const output = await withTimeout(answering, CLASSIFY_TIMEOUT_MS, "classification timed out");
		if (output === undefined) return NOT_COVERED;
		const answer = parseApprovalSimilarity(output);
		return {
			covered: answer.verdict === true,
			// Arguments beat the model: when the call's own arguments state its file
			// effects, the answer's list can only be redundant or wrong — including
			// when they state that it writes nothing.
			writeTargets: deps.fileEffects
				? deps.fileEffects.writes
				: citedWriteTargets(answer.writes, candidate, deps.cwd),
		};
	} catch (error) {
		logger.debug("approval-similarity: classification failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return NOT_COVERED;
	}
}

/**
 * The answer's write targets, kept only where the subject itself proves them.
 *
 * A target must appear verbatim in the subject the user read: both argument sets
 * reaching the model were written by an agent that may be acting on injected
 * content, and a file grant auto-approves later `write`/`edit` calls, so a path
 * the model invented (or one an injected instruction asked it to add) must not
 * become one. Whatever survives is resolved against the call's own working
 * directory, which is how a grant recorded from `out.txt` matches a later
 * absolute path.
 */
function citedWriteTargets(writes: readonly string[], candidate: string, cwd: string): readonly string[] {
	const targets: string[] = [];
	for (const write of writes) {
		const cited = write.trim();
		if (cited.length === 0 || !candidate.includes(cited)) continue;
		const normalized = normalizeApprovalPath(cited, cwd);
		if (normalized && !targets.includes(normalized)) targets.push(normalized);
	}
	return targets;
}

/** One classifier request: the rubric as the system turn, the subjects as the user turn. */
async function requestClassification(userMessage: string, deps: ApprovalSimilarityDeps): Promise<string | undefined> {
	// A context without a registry cannot resolve a classifier model, so the
	// requirement lives here rather than at the gate — the no-model answers must
	// still run — and joins the throws below under the caller's fail-safe (a
	// normal approval prompt).
	const registry = deps.registry;
	if (!registry) {
		throw new Error("approval-similarity: no model registry for classification");
	}
	const resolved = resolveRoleSelection(["tiny", "smol"], deps.settings, registry.getAvailable());
	const model = resolved?.model;
	if (!model) {
		throw new Error("approval-similarity: no tiny/smol model available for classification");
	}
	const apiKey = await registry.getApiKey(model, deps.sessionId);
	if (!apiKey) {
		throw new Error(`approval-similarity: no API key for ${model.provider}/${model.id}`);
	}
	const metadata = deps.metadataResolver?.(model.provider);

	const response = await completeSimple(
		model,
		{
			systemPrompt: [SIMILARITY_SYSTEM_PROMPT],
			messages: [
				{
					role: "user",
					content: userMessage,
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: registry.resolver(model, deps.sessionId),
			maxTokens: REASONING_SAFE_MAX_TOKENS,
			disableReasoning: true,
			metadata,
			signal: deps.signal,
		},
	);

	if (response.stopReason === "error") {
		throw new Error(`approval-similarity: classification failed: ${response.errorMessage ?? "unknown error"}`);
	}

	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

/**
 * Reasoning the model leaked into its answer channel: the two plain tag
 * forms every dialect in `@oh-my-pi/pi-ai` renders thinking with. An unpaired
 * open tag is left alone — a truncated verdict must not be read as one.
 */
const THINK_BLOCK = /<(think|thinking)>[\s\S]*?<\/\1>/gi;
/** Emphasis, code spans, quotes, and sentence punctuation around a one-word answer. */
const VERDICT_DECORATION = /^[\s"'`*_]+|[\s"'`*_.,!?]+$/g;
/**
 * Code spans and emphasis wrapped around a whole line. Stripped before any line
 * is read: small models fence their write line about a third of the time, and a
 * `` `WRITES: []` `` line that misses its match below counts as a second
 * verdict line, costing a good verdict its parse.
 */
const LINE_DECORATION = /^[\s`*_]+|[\s`*_]+$/g;
/**
 * The optional write-target line. Any `WRITES:` line counts as one, whatever
 * follows: a payload the answer mangled must not fall through into the verdict
 * lines, where it would cost a valid verdict its parse.
 */
const WRITES_LINE = /^WRITES:\s*(.*)$/i;

export interface ApprovalSimilarityAnswer {
	/** `undefined` unless the answer is exactly one `yes`/`no` word — anything else fails safe to a prompt. */
	verdict: boolean | undefined;
	/** Paths the model claims the call writes, exactly as it wrote them; unvalidated. */
	writes: readonly string[];
}

/**
 * Parse one classifier answer: a bare `yes`/`no` line, plus an optional
 * `WRITES: [...]` line naming the files the call writes.
 *
 * The verdict parse is strict, because that verdict grants execution and both
 * prompt files demand exactly one word: a prefix match would read "yesterday it
 * worked" and "YES, but destructive" as approvals, and any extra prose line
 * leaves the verdict unparsable. The write list is optional and independent — a
 * malformed or missing one costs the answer nothing, since a model that only
 * ever emits a bare verdict must keep working.
 */
export function parseApprovalSimilarity(text: string): ApprovalSimilarityAnswer {
	const lines = text
		.replace(THINK_BLOCK, " ")
		.split("\n")
		.map(line => line.replace(LINE_DECORATION, ""))
		.filter(line => line.length > 0);
	let writes: readonly string[] = [];
	const verdictLines: string[] = [];
	for (const line of lines) {
		const targets = WRITES_LINE.exec(line);
		const array = targets?.[1];
		if (array === undefined) {
			verdictLines.push(line);
			continue;
		}
		if (writes.length > 0) continue;
		// Parse the bracketed span only, so trailing prose or punctuation the
		// answer appended to the list still yields the list.
		const start = array.indexOf("[");
		const end = array.lastIndexOf("]");
		if (start < 0 || end < start) continue;
		try {
			const parsed: unknown = JSON.parse(array.slice(start, end + 1));
			if (Array.isArray(parsed)) {
				writes = parsed
					.filter((entry): entry is string => typeof entry === "string")
					.slice(0, MAX_ANSWER_WRITE_TARGETS);
			}
		} catch {
			// A mangled array is no evidence of anything; the verdict still stands.
		}
	}
	const verdict =
		verdictLines.length === 1 ? verdictLines[0]?.replace(VERDICT_DECORATION, "").toLowerCase() : undefined;
	return {
		verdict: verdict === "yes" ? true : verdict === "no" ? false : undefined,
		writes,
	};
}
