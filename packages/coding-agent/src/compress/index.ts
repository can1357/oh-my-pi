/**
 * `omp compress` — rewrite text files into the dense prompt register.
 *
 * One agent per file, two tools each. The agent submits a draft with `rewrite`; the
 * command answers with that draft, its measured size, and the losses the agent declared,
 * then asks for a verdict. The agent either resubmits or calls `approve`, which ends the
 * run. Only an approved draft is ever written.
 *
 * Verification is the agent's declared loss list plus the review turn — the command
 * deliberately runs no diff or keyword check of its own.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectDir, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { createProgressReporter } from "../cli/progress-reporter";
import type { AgentSession } from "../session/agent-session";
import { mapWithConcurrencyLimitAllSettled } from "../task/parallel";
import { shortenPath } from "../tools/render-utils";
import requestPrompt from "./prompts/request.md" with { type: "text" };
import reviewPrompt from "./prompts/review.md" with { type: "text" };
import { CompressProtocol } from "./protocol";
import { createCompressSession } from "./session";
import type { CompressDraft, CompressFileResult, CompressResult, CompressStatus } from "./types";

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_CONCURRENCY = 4;
const LOSS_PREVIEW = 200;

/** User-facing options for `omp compress`. */
export interface CompressCommandOptions {
	/** Files and glob patterns to compress. */
	files: string[];
	/** Model selector; defaults to the configured session model. */
	model?: string;
	/** Maximum drafts per file before that file gives up unapproved. Default 3. */
	maxRounds?: number;
	/** Concurrent files. Default 4. */
	concurrency?: number;
	/** Write the approved text here instead of stdout. Single file only. */
	output?: string;
	/** Overwrite each source file with its approved text. */
	inPlace?: boolean;
}

/**
 * Expand `patterns` into a deduplicated, sorted list of absolute file paths.
 *
 * Entries containing glob metacharacters are matched against `cwd`; everything else is
 * treated as a literal path so filenames containing brackets still resolve. Throws when
 * a literal path is missing or a pattern matches nothing, since silently compressing
 * fewer files than asked is worse than failing.
 */
export async function resolveCompressTargets(patterns: readonly string[], cwd: string): Promise<string[]> {
	const found = new Set<string>();
	for (const pattern of patterns) {
		if (/[*?[\]{}]/.test(pattern)) {
			// `dot: true` — prompt corpora live under dot directories such as `.omp/commands`.
			const matches = new Bun.Glob(pattern).scanSync({ cwd, absolute: true, onlyFiles: true, dot: true });
			let matched = 0;
			for (const match of matches) {
				found.add(match);
				matched += 1;
			}
			if (matched === 0) throw new Error(`No files matched "${pattern}"`);
			continue;
		}
		const resolved = path.resolve(cwd, pattern);
		const stat = await fs.stat(resolved).catch(() => undefined);
		if (!stat?.isFile()) throw new Error(`Not a file: ${shortenPath(resolved)}`);
		found.add(resolved);
	}
	return [...found].sort();
}

/** Compress every requested file through the rewrite/approve loop. */
export async function runCompressCommand(options: CompressCommandOptions): Promise<CompressResult> {
	const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	if (!Number.isInteger(maxRounds) || maxRounds <= 0) throw new Error("--rounds must be a positive integer");
	if (!Number.isInteger(concurrency) || concurrency <= 0) throw new Error("--agents must be a positive integer");
	if (options.inPlace && options.output) throw new Error("--in-place and --out are mutually exclusive");
	// Paths and patterns follow the shell's cwd, as a file-taking CLI must; the project
	// dir only scopes settings discovery for the sessions.
	const invocationDir = process.cwd();
	const cwd = getProjectDir();
	const targets = await resolveCompressTargets(options.files, invocationDir);
	if (targets.length === 0) throw new Error("No files to compress");
	if (targets.length > 1 && !options.inPlace) {
		throw new Error(`${targets.length} files matched; pass --in-place to rewrite them (--out takes a single file)`);
	}

	const abortController = new AbortController();
	const abort = (): void => abortController.abort(new Error("Compress interrupted"));
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	const progress = createProgressReporter("Compressing");
	const emitToStdout = targets.length === 1 && !options.inPlace && options.output === undefined;

	try {
		console.error(`Compressing ${targets.length} file(s)${options.model ? ` with ${options.model}` : ""}`);
		progress.start(targets.length);
		const settled = await mapWithConcurrencyLimitAllSettled(
			targets,
			Math.min(concurrency, targets.length),
			async (target, index, signal) => {
				// A failing file must not cancel its peers, and must still be reported: turn
				// every failure into a result instead of letting it reject the batch entry.
				let result: CompressFileResult;
				try {
					result = await compressFile({
						target,
						cwd,
						invocationDir,
						options,
						maxRounds,
						emitToStdout,
						signal,
						index,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					result = { path: target, status: "cancelled", rounds: 0, error: message };
				}
				progress.complete();
				if (!progress.interactive) reportFile(result, emitToStdout);
				return result;
			},
			abortController.signal,
		);
		progress.finish();

		const files: CompressFileResult[] = [];
		for (let index = 0; index < settled.results.length; index += 1) {
			const outcome = settled.results[index];
			const target = targets[index] ?? "<unknown>";
			if (outcome?.status === "fulfilled") {
				files.push(outcome.value);
				continue;
			}
			const reason = outcome?.status === "rejected" ? outcome.reason : undefined;
			const error = reason instanceof Error ? reason.message : reason ? String(reason) : "Cancelled";
			const cancelled: CompressFileResult = { path: target, status: "cancelled", rounds: 0, error };
			files.push(cancelled);
			// Never streamed from the worker, so report it here regardless of mode.
			if (!progress.interactive) reportFile(cancelled, emitToStdout);
		}
		if (progress.interactive) for (const file of files) reportFile(file, emitToStdout);
		return summarize(files, emitToStdout);
	} finally {
		progress.finish();
		process.off("SIGINT", abort);
		process.off("SIGTERM", abort);
	}
}

/** Run one file's rewrite/approve loop in its own isolated session. */
async function compressFile(input: {
	target: string;
	/** Project dir scoping settings discovery for the session. */
	cwd: string;
	/** Shell cwd, used to resolve `--out`. */
	invocationDir: string;
	options: CompressCommandOptions;
	maxRounds: number;
	emitToStdout: boolean;
	signal?: AbortSignal;
	/** Position in the batch; only used to keep concurrent agent ids distinct. */
	index: number;
}): Promise<CompressFileResult> {
	const { target, cwd, options, maxRounds } = input;
	const source = await fs.readFile(target, "utf8");
	if (source.trim().length === 0) {
		return { path: target, status: "stalled", rounds: 0, error: "no text to compress" };
	}
	const protocol = new CompressProtocol(source);
	// Delimiters carry a per-run nonce so a source document — which is itself a prompt,
	// often full of tags — cannot close its own inert-data block early.
	const nonce = randomUUID().slice(0, 8);
	const { session } = await createCompressSession({
		cwd,
		model: options.model,
		protocol,
		agentId: `Compress${input.index + 1}-${nonce}`,
	});
	const onAbort = (): void => {
		void session.abort({ reason: "Compress interrupted" });
	};
	input.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await turn(
			session,
			prompt.render(requestPrompt, {
				path: shortenPath(target),
				source_size: `Source: ${protocol.sourceWords} words, ${protocol.sourceTokens} tokens.`,
				source,
				nonce,
			}),
		);
		let reviewed = 0;
		while (!protocol.approved) {
			const draft = protocol.latest;
			// No draft at all, a reviewed draft the agent neither replaced nor approved,
			// or a draft past the budget: every one of these ends the run.
			if (!draft || draft.round === reviewed || draft.round > maxRounds) break;
			reviewed = draft.round;
			protocol.markReviewed(draft.round);
			await turn(session, renderReview({ protocol, draft, nonce, maxRounds, final: draft.round >= maxRounds }));
		}

		const draft = protocol.latest;
		const status: CompressStatus = protocol.approved ? "approved" : draft ? "unapproved" : "stalled";
		let outputPath: string | undefined;
		if (status === "approved" && draft && !input.emitToStdout) {
			const destination = options.inPlace ? target : path.resolve(input.invocationDir, options.output ?? "");
			await fs.writeFile(destination, draft.text.endsWith("\n") ? draft.text : `${draft.text}\n`, "utf8");
			outputPath = destination;
		}
		return {
			path: target,
			status,
			draft,
			metrics: draft ? protocol.metrics(draft) : undefined,
			verdict: protocol.verdict,
			rounds: protocol.rounds,
			outputPath,
			sessionFile: session.sessionFile,
		};
	} finally {
		input.signal?.removeEventListener("abort", onAbort);
		await session.dispose();
	}
}

/** Send one prompt and wait for the agent to settle. */
async function turn(session: AgentSession, text: string): Promise<void> {
	await session.prompt(text, { expandPromptTemplates: false, synthetic: true, userInitiated: false });
	await session.waitForIdle();
}

/** Quote a draft back to the agent with its size, its declared losses, and the verdict request. */
function renderReview(input: {
	protocol: CompressProtocol;
	draft: CompressDraft;
	nonce: string;
	maxRounds: number;
	final: boolean;
}): string {
	const { draft } = input;
	const metrics = input.protocol.metrics(draft);
	const percent = (metrics.ratio * 100).toFixed(1);
	const losses =
		draft.losses.length === 0
			? "You declared no losses. If that is wrong, the next draft must say so."
			: draft.losses.map(loss => `- ${loss.content}\n  Accepted because: ${loss.reason}`).join("\n");
	return prompt.render(reviewPrompt, {
		round: String(draft.round),
		metrics: `${metrics.sourceWords} → ${metrics.draftWords} words, ${metrics.sourceTokens} → ${metrics.draftTokens} tokens (${percent}% smaller).`,
		losses,
		draft: draft.text,
		nonce: input.nonce,
		closing: input.final
			? `This is the final round (budget ${input.maxRounds}). Call \`approve\` to accept this draft, or call \`rewrite\` once more only if it is genuinely unshippable — an unapproved run writes nothing.`
			: "Is this acceptable? Every loss above must be one you would defend to a reader who never saw the source, and the draft must stand alone. Call `approve` to accept it, or `rewrite` to replace it.",
	});
}

/**
 * Print one file's outcome and declared losses on stderr, so the approved text can own
 * stdout for a single-file run (`omp compress f.md > out.md`).
 */
function reportFile(file: CompressFileResult, emitToStdout: boolean): void {
	const label = shortenPath(file.path);
	if (file.error) {
		console.error(`  ${label}: ${file.status} — ${sanitizeText(file.error)}`);
		return;
	}
	const metrics = file.metrics;
	const size = metrics
		? `${metrics.sourceTokens} → ${metrics.draftTokens} tok (${(metrics.ratio * 100).toFixed(1)}%)`
		: "no draft";
	console.error(
		`  ${label}: ${file.status}, ${size}, ${file.rounds} draft(s), ${file.draft?.losses.length ?? 0} loss(es)`,
	);
	for (const loss of file.draft?.losses ?? []) {
		const content = loss.content.length > LOSS_PREVIEW ? `${loss.content.slice(0, LOSS_PREVIEW)}…` : loss.content;
		console.error(`    - ${sanitizeText(content)}`);
		console.error(`      ${sanitizeText(loss.reason)}`);
	}
	if (file.status !== "approved") {
		console.error("      nothing written");
		return;
	}
	if (file.outputPath) console.error(`      wrote ${shortenPath(file.outputPath)}`);
	if (emitToStdout && file.draft) console.log(file.draft.text);
}

/** Aggregate per-file outcomes into the command result and print the totals. */
function summarize(files: CompressFileResult[], emitToStdout: boolean): CompressResult {
	let sourceTokens = 0;
	let draftTokens = 0;
	let approved = 0;
	for (const file of files) {
		if (file.status === "approved") approved += 1;
		if (!file.metrics || file.status !== "approved") continue;
		sourceTokens += file.metrics.sourceTokens;
		draftTokens += file.metrics.draftTokens;
	}
	if (files.length > 1) {
		const percent = sourceTokens === 0 ? "0.0" : (((sourceTokens - draftTokens) / sourceTokens) * 100).toFixed(1);
		console.error(
			`Approved ${approved}/${files.length}: ${sourceTokens} → ${draftTokens} tokens (${percent}% smaller)`,
		);
	}
	if (!emitToStdout && approved === 0) console.error("Nothing written");
	return { exitCode: approved === files.length ? 0 : 1, files, sourceTokens, draftTokens };
}
