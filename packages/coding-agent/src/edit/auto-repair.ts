/**
 * Auto-repair for edits that introduce a parse failure.
 *
 * When an applied edit turns a file that parsed into one that no longer does,
 * this module localizes the breakage to the smallest hunk set whose reversion
 * restores the parse, hands that region (with its parseable pre-image as
 * reference) to the `smol` model, and accepts a candidate only when the
 * repaired file re-parses and the candidate is not a plain revert of the
 * intended change.
 *
 * Sizing and acceptance rules come from a static evaluation over recorded
 * parse regressions (`edit-blackbox.jsonl`): median culprit region ~14 lines,
 * 94% under 150 lines; smol fixed 99% with one feedback retry, with ~12% of
 * raw candidates being reverts — hence the explicit revert rejection.
 */
import { completeSimple, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { diffLineRuns, editDiffString, summarizeCode } from "@oh-my-pi/pi-natives";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { resolveRoleSelection } from "../config/model-resolver";
import type { WritethroughCallback } from "../lsp";
import type { ToolSession } from "../tools";
import { invalidateFsScanAfterWrite } from "../tools/fs-cache-invalidation";
import repairPromptSource from "./auto-repair.md" with { type: "text" };
import type { AppliedEditSnapshot } from "./blackbox";

import { cfgEditAutoRepairEnabled } from "./settings";

/** Context lines shown around the culprit hunks. */
const CONTEXT_LINES = 6;
/** Largest repair region worth sending to a small model. */
const MAX_REGION_LINES = 150;
/** Hunk count above which the O(n²) pair search is skipped for the O(n) greedy peel. */
const MAX_PAIR_SEARCH_HUNKS = 24;
/** Initial attempt plus one feedback retry. */
const MAX_ATTEMPTS = 2;
const COMPLETION_MAX_TOKENS = 8192;
const REPAIR_TIMEOUT_MS = 20_000;

/** One changed line run in pre-image (`a`) / post-image (`b`) coordinates. */
interface EditHunk {
	aStart: number;
	aEnd: number;
	bStart: number;
	bEnd: number;
}

function parsesSource(code: string, path: string): boolean {
	return summarizeCode({ code: code.length === 0 ? "\n" : code, path }).parsed;
}

/** The localized broken region plus its parseable pre-image reference. */
export interface RepairRegion {
	/** Replaced line span in the broken file, `[bStart, bEnd)`. */
	bStart: number;
	bEnd: number;
	/** The broken region as it exists on disk. */
	brokenText: string;
	/** Post-image context with culprit hunks reverted; splicing it restores the parse. */
	referenceText: string;
	/** Canonical tree-sitter language name of the pre-image. */
	language: string;
}

function buildHunks(prev: string, next: string): { hunks: EditHunk[]; a: string[]; b: string[] } {
	const runs = diffLineRuns(prev, next);
	const a = prev.split("\n");
	const b = next.split("\n");
	const hunks: EditHunk[] = [];
	let ai = 0;
	let bi = 0;
	for (const run of runs) {
		if (!run.added && !run.removed) {
			ai += run.count;
			bi += run.count;
			continue;
		}
		const del = run.removed ? run.count : 0;
		const add = run.added ? run.count : 0;
		// Merge an adjacent removed+added pair into one replace hunk.
		const last = hunks.at(-1);
		if (last && last.aEnd === ai && last.bEnd === bi) {
			last.aEnd += del;
			last.bEnd += add;
		} else {
			hunks.push({ aStart: ai, aEnd: ai + del, bStart: bi, bEnd: bi + add });
		}
		ai += del;
		bi += add;
	}
	return { hunks, a, b };
}

/** Append `src[start, end)` to `out` without spreading. */
function pushRange(out: string[], src: readonly string[], start: number, end: number): void {
	for (let i = start; i < end; i++) out.push(src[i]);
}

/**
 * Post-image with the given hunks reverted to their pre-image lines. `set`
 * must be ascending; `out` is a scratch buffer reused across trials.
 */
function revertHunks(a: string[], b: string[], hunks: EditHunk[], set: readonly number[], out: string[]): string {
	out.length = 0;
	let bi = 0;
	for (const i of set) {
		const h = hunks[i];
		pushRange(out, b, bi, h.bStart);
		pushRange(out, a, h.aStart, h.aEnd);
		bi = h.bEnd;
	}
	pushRange(out, b, bi, b.length);
	return out.join("\n");
}

/**
 * Find the smallest hunk set whose reversion restores the parse: singles,
 * then pairs (bounded), then a greedy peel that re-applies hunks one at a
 * time while the file keeps parsing.
 */
function isolateCulpritHunks(path: string, a: string[], b: string[], hunks: EditHunk[]): number[] | undefined {
	const n = hunks.length;
	if (n === 0) return undefined;
	const scratch: string[] = [];
	const trial: number[] = [];
	const parsesReverted = (set: readonly number[]): boolean =>
		parsesSource(revertHunks(a, b, hunks, set, scratch), path);

	for (let i = 0; i < n; i++) {
		trial[0] = i;
		trial.length = 1;
		if (parsesReverted(trial)) return [i];
	}

	if (n <= MAX_PAIR_SEARCH_HUNKS) {
		trial.length = 2;
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				trial[0] = i;
				trial[1] = j;
				if (parsesReverted(trial)) return [i, j];
			}
		}
	}

	const keep = new Array<boolean>(n).fill(true);
	// Whether reverting exactly the current `keep` set is known to parse.
	let keepParses = false;
	for (let i = 0; i < n; i++) {
		trial.length = 0;
		for (let k = 0; k < n; k++) {
			if (keep[k] && k !== i) trial.push(k);
		}
		if (parsesReverted(trial)) {
			keep[i] = false;
			keepParses = true;
		}
	}
	const culprits: number[] = [];
	for (let k = 0; k < n; k++) {
		if (keep[k]) culprits.push(k);
	}
	// Reverting every remaining hunk must parse (the full revert is the
	// pre-image); an empty set would mean the pre-image itself is broken.
	if (culprits.length === 0 || (!keepParses && !parsesReverted(culprits))) return undefined;
	return culprits;
}

/** A repair region plus the post-image lines it was computed against. */
interface ComputedRegion {
	region: RepairRegion;
	b: string[];
}

function computeRegion(snapshot: AppliedEditSnapshot): ComputedRegion | undefined {
	const { path, prev, next } = snapshot;
	const { hunks, a, b } = buildHunks(prev, next);
	const culprits = isolateCulpritHunks(path, a, b, hunks);
	if (!culprits) return undefined;

	// `culprits` is ascending and hunks are ordered by position.
	const first = hunks[culprits[0]];
	const last = hunks[culprits[culprits.length - 1]];
	const bStart = Math.max(0, first.bStart - CONTEXT_LINES);
	const bEnd = Math.min(b.length, last.bEnd + CONTEXT_LINES);
	if (bEnd - bStart > MAX_REGION_LINES) return undefined;

	// Reference = post-image context with each culprit hunk's lines swapped for
	// its pre-image lines, so splicing the reference reproduces the culprit
	// reversion exactly (which parses by construction).
	const ref: string[] = [];
	let bi = bStart;
	for (const i of culprits) {
		const h = hunks[i];
		pushRange(ref, b, bi, h.bStart);
		pushRange(ref, a, h.aStart, h.aEnd);
		bi = h.bEnd;
	}
	pushRange(ref, b, bi, bEnd);

	const language = summarizeCode({ code: prev.length === 0 ? "\n" : prev, path }).language ?? "source";
	return {
		region: {
			bStart,
			bEnd,
			brokenText: b.slice(bStart, bEnd).join("\n"),
			referenceText: ref.join("\n"),
			language,
		},
		b,
	};
}

/**
 * Localize the parse breakage introduced by `prev → next` to a bounded line
 * region. Returns `undefined` when the breakage cannot be isolated under
 * {@link MAX_REGION_LINES} — callers fall back to the plain parse warning.
 */
export function computeRepairRegion(snapshot: AppliedEditSnapshot): RepairRegion | undefined {
	return computeRegion(snapshot)?.region;
}

/** Replace the region's line span in the post-image with `text`. */
function spliceRegion(b: string[], region: RepairRegion, text: string): string {
	const out: string[] = [];
	pushRange(out, b, 0, region.bStart);
	const lines = text.split("\n");
	pushRange(out, lines, 0, lines.length);
	pushRange(out, b, region.bEnd, b.length);
	return out.join("\n");
}

/**
 * Re-indent a candidate by trimmed-line alignment against source lines:
 * candidate lines that match a source line modulo whitespace inherit the
 * source line verbatim, recovering indentation small models routinely drop
 * from echoed context.
 */
function realignToSource(srcLines: string[], candidate: string): string {
	const out = candidate.split("\n");
	const runs = diffLineRuns(srcLines.map(l => l.trim()).join("\n"), out.map(l => l.trim()).join("\n"));
	const merged: string[] = [];
	let si = 0;
	let oi = 0;
	for (const run of runs) {
		if (!run.added && !run.removed) {
			for (let k = 0; k < run.count; k++) merged.push(srcLines[si + k]);
			si += run.count;
			oi += run.count;
		} else if (run.removed) {
			si += run.count;
		} else {
			for (let k = 0; k < run.count; k++) merged.push(out[oi + k]);
			oi += run.count;
		}
	}
	return merged.join("\n");
}

/** Strip one wrapping markdown code fence, if present. */
function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
	return match ? match[1] : trimmed;
}

function normalizeForRevertCheck(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** A successful region repair: the full repaired file content. */
export interface RegionRepair {
	content: string;
	region: RepairRegion;
	/** Completion attempts consumed (1 = first shot, 2 = feedback retry). */
	attempts: number;
}

/**
 * Repair one parse regression with an injected completer. Accepts the first
 * candidate (verbatim, or realigned against the broken region or the
 * reference) that is not a revert of the intended change and whose splice
 * makes the whole file parse again. One feedback retry on failure.
 */
export async function repairParseRegression(
	snapshot: AppliedEditSnapshot,
	complete: (builtPrompt: string) => Promise<string>,
): Promise<RegionRepair | undefined> {
	const computed = computeRegion(snapshot);
	if (!computed) return undefined;
	const { region, b } = computed;
	const normalizedReference = normalizeForRevertCheck(region.referenceText);

	let previousAttempt: string | undefined;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const built = prompt.render(repairPromptSource, {
			lang: region.language,
			before: region.referenceText,
			after: region.brokenText,
			previousAttempt,
		});
		const candidate = stripCodeFence(await complete(built));
		previousAttempt = candidate;

		// Realigned variants first: where the candidate echoes a known line
		// modulo whitespace they restore the file's original bytes, so when both
		// forms parse the realigned one preserves indentation the model dropped.
		const variants = new Set([
			realignToSource(b.slice(region.bStart, region.bEnd), candidate),
			realignToSource(region.referenceText.split("\n"), candidate),
			candidate,
		]);
		for (const text of variants) {
			// A candidate that merely restores the pre-image silently discards the
			// intended change — worse than surfacing the parse warning.
			if (normalizeForRevertCheck(text) === normalizedReference) continue;
			const content = spliceRegion(b, region, text);
			if (parsesSource(content, snapshot.path)) return { content, region, attempts: attempt };
		}
	}
	return undefined;
}

/** A committed auto-repair, for the edit tool's result message. */
export interface EditAutoRepairOutcome {
	/** Unified diff of the repair (broken on-disk content → repaired content). */
	diff: string;
	/** `provider/id` of the model that produced the repair. */
	model: string;
	attempts: number;
}

/**
 * Attempt to auto-repair a committed edit that introduced a parse failure,
 * writing the repaired content through the edit tool's LSP writethrough.
 * Gated on `edit.autoRepair.enabled` and the `smol` role resolving to an
 * authenticated model. Returns `undefined` whenever repair is unavailable,
 * unsafe (file changed or recovered on its own), or rejected by validation.
 */
export async function attemptEditAutoRepair(options: {
	session: ToolSession;
	snapshot: AppliedEditSnapshot;
	writethrough: WritethroughCallback;
	signal?: AbortSignal;
}): Promise<EditAutoRepairOutcome | undefined> {
	const { session, snapshot, writethrough } = options;
	if (!cfgEditAutoRepairEnabled.get(session.settings)) return undefined;
	const registry = session.modelRegistry;
	if (!registry) return undefined;
	const model = resolveRoleSelection(["smol"], session.settings, registry.getAvailable())?.model;
	if (!model) return undefined;
	const sessionId = session.getSessionId?.() ?? undefined;
	// Resolve the key eagerly so the session-sticky credential is recorded and
	// an unauthenticated smol role bails before any region work.
	const apiKey = await registry.getApiKey(model, sessionId);
	if (!apiKey) return undefined;

	// Repair against the bytes on disk, not the snapshot: a later operation in
	// the same call or a format-on-write pass may have moved the file since the
	// observation — and may even have restored the parse.
	let current: string;
	try {
		current = await Bun.file(snapshot.path).text();
	} catch {
		return undefined;
	}
	if (parsesSource(current, snapshot.path)) return undefined;

	const modelName = `${model.provider}/${model.id}`;
	logger.debug("Edit auto-repair started", { path: snapshot.path, model: modelName });
	// One budget across both attempts: the edit tool result blocks on this, so
	// a slow repair model must not stall the turn past the ceiling.
	const timeout = AbortSignal.timeout(REPAIR_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const complete = async (builtPrompt: string): Promise<string> => {
		const response = await retryTransientCompletion(
			() =>
				completeSimple(
					model,
					{ messages: [{ role: "user", content: builtPrompt, timestamp: Date.now() }] },
					{
						apiKey: registry.resolver(model, sessionId),
						sessionId,
						maxTokens: COMPLETION_MAX_TOKENS,
						disableReasoning: true,
						signal,
					},
				),
			{ signal, provider: model.provider },
		);
		if (response.stopReason === "error") {
			throw new Error(response.errorMessage ?? "auto-repair completion failed");
		}
		// An abort resolves (not rejects) with empty content; treating that as a
		// candidate would silently burn the retry and hide the stall.
		if (response.stopReason === "aborted") {
			throw new Error(
				timeout.aborted
					? `auto-repair timed out after ${REPAIR_TIMEOUT_MS}ms waiting on ${modelName}`
					: "auto-repair aborted",
			);
		}
		return response.content.map(block => (block.type === "text" ? block.text : "")).join("");
	};

	const repair = await repairParseRegression({ ...snapshot, next: current }, complete);
	if (!repair) return undefined;

	await writethrough(snapshot.path, repair.content, options.signal, Bun.file(snapshot.path));
	invalidateFsScanAfterWrite(snapshot.path);
	logger.debug("Edit auto-repair applied", {
		path: snapshot.path,
		attempts: repair.attempts,
		regionLines: repair.region.bEnd - repair.region.bStart,
	});
	const diffResult = editDiffString(current, repair.content, snapshot.path);
	return { diff: diffResult.diff, model: modelName, attempts: repair.attempts };
}
