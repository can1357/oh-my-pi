/**
 * The two-tool protocol behind `omp compress`.
 *
 * The agent sees exactly two tools. `rewrite` submits a complete draft plus every
 * loss the agent chose to accept; `approve` accepts the newest draft and ends the
 * run. Approval is gated on a review turn: the command replies to each draft with
 * its measured size and its declared losses and asks for a verdict, so the agent
 * judges its own work with the losses in front of it instead of self-certifying
 * inside the turn that produced them.
 *
 * @example
 * const protocol = new CompressProtocol(source);
 * const tools = [protocol.rewriteTool(), protocol.approveTool()];
 * // …drive a session, then read protocol.latest / protocol.approved
 */
import { type } from "@oh-my-pi/omptype";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { ToolDefinition } from "../extensibility/extensions";
import approveDescription from "../prompts/tools/approve.md" with { type: "text" };
import rewriteDescription from "../prompts/tools/rewrite.md" with { type: "text" };
import type { CompressDraft, CompressLoss, CompressMetrics } from "./types";

const lossSchema = type({
	content: type("string > 0").describe("the dropped source content, quoted or described precisely"),
	reason: type("string > 0").describe("why the compressed text is still correct without it"),
});

const rewriteSchema = type({
	text: type("string > 0").describe("the complete compressed text, ready to ship verbatim"),
	losses: lossSchema
		.array()
		.describe(
			"every claim, qualifier, example, default, or exact string deliberately dropped; empty array only when the draft loses nothing",
		),
	"+": "reject",
}).describe("submit a compressed draft together with everything it drops");

const approveSchema = type({
	verdict: type("string > 0").describe("why the newest draft is acceptable as the final output"),
	"+": "reject",
}).describe("accept the newest draft as the final output");

/** Transcript details for one `rewrite` call. */
export interface RewriteDetails {
	round: number;
	draftTokens: number;
	losses: number;
}

/** Transcript details for one `approve` call. */
export interface ApproveDetails {
	round: number;
}

// Both tools are plain `ToolDefinition`s rather than concretely parameterized ones:
// `renderCall`/`renderResult` are contravariant function properties, so a tool carrying
// a concrete schema or details type is not assignable to the `customTools` element type.
// Executors therefore validate their arguments through the schema and type the details
// object they build, instead of asserting either across the boundary.

/** Words in `text`. Guards the `"".split(/\s+/).length === 1` trap. */
function words(text: string): number {
	const trimmed = text.trim();
	return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** Draft ledger shared by the protocol tools and the command loop. */
export class CompressProtocol {
	readonly #tokenizer: Tokenizer;
	readonly #sourceWords: number;
	readonly #sourceTokens: number;
	readonly #drafts: CompressDraft[] = [];
	#reviewed = 0;
	#approved = false;
	#verdict: string | undefined;

	/**
	 * Metrics measure source-vs-draft ratios with the default estimate. The
	 * compress session resolves its model after this ledger is constructed, so
	 * no catalog model is available here.
	 */
	constructor(source: string) {
		this.#tokenizer = new Tokenizer();
		this.#sourceWords = words(source);
		this.#sourceTokens = this.#tokenizer.countTokens(source);
	}

	/** Newest submitted draft, or undefined before the first `rewrite`. */
	get latest(): CompressDraft | undefined {
		return this.#drafts.at(-1);
	}

	/** True once `approve` accepted the newest draft. */
	get approved(): boolean {
		return this.#approved;
	}

	/** The agent's stated reason for accepting the final draft. */
	get verdict(): string | undefined {
		return this.#verdict;
	}

	/** Number of drafts submitted so far. */
	get rounds(): number {
		return this.#drafts.length;
	}

	/** Words in the source text. */
	get sourceWords(): number {
		return this.#sourceWords;
	}

	/** Tokens in the source text. */
	get sourceTokens(): number {
		return this.#sourceTokens;
	}

	/** Size of `draft` against the source. */
	metrics(draft: CompressDraft): CompressMetrics {
		const draftTokens = this.#tokenizer.countTokens(draft.text);
		return {
			sourceWords: this.#sourceWords,
			draftWords: words(draft.text),
			sourceTokens: this.#sourceTokens,
			draftTokens,
			ratio: this.#sourceTokens === 0 ? 0 : (this.#sourceTokens - draftTokens) / this.#sourceTokens,
		};
	}

	/** Record that the command has shown `round` back to the agent for a verdict. */
	markReviewed(round: number): void {
		this.#reviewed = Math.max(this.#reviewed, round);
	}

	/**
	 * Record a draft and return it. Supersedes any prior approval, so an accepted
	 * draft cannot be silently replaced by a later one.
	 */
	submit(text: string, losses: readonly CompressLoss[]): CompressDraft {
		const draft: CompressDraft = {
			round: this.#drafts.length + 1,
			text,
			losses: losses.map(loss => ({ content: loss.content, reason: loss.reason })),
		};
		this.#drafts.push(draft);
		this.#approved = false;
		this.#verdict = undefined;
		return draft;
	}

	/**
	 * Accept the newest draft and return it.
	 *
	 * Throws when no draft exists, or when the newest draft has not been shown back
	 * to the agent for a verdict — approval is only meaningful after that review.
	 */
	accept(verdict: string): CompressDraft {
		const draft = this.latest;
		if (!draft) throw new Error("Call rewrite before approve: there is no draft to accept");
		if (draft.round > this.#reviewed) {
			throw new Error(
				`Draft ${draft.round} has not been reviewed yet. End this turn; the review turn arrives next, and you approve there.`,
			);
		}
		this.#approved = true;
		this.#verdict = verdict;
		return draft;
	}

	/** Tool that records a draft. Thin adapter over {@link submit}. */
	rewriteTool(): ToolDefinition {
		return {
			name: "rewrite",
			label: "Rewrite",
			description: rewriteDescription.trim(),
			parameters: rewriteSchema,
			approval: "read",
			strict: true,
			execute: async (_toolCallId, rawParams) => {
				const params = rewriteSchema(rawParams);
				if (params instanceof type.errors) throw new Error(`rewrite received invalid arguments: ${params.summary}`);
				const draft = this.submit(params.text, params.losses);
				const metrics = this.metrics(draft);
				const percent = (metrics.ratio * 100).toFixed(1);
				const summary = `Draft ${draft.round} recorded: ${metrics.sourceTokens} → ${metrics.draftTokens} tokens (${percent}% smaller), ${draft.losses.length} declared loss(es). A review turn follows.`;
				const details: RewriteDetails = {
					round: draft.round,
					draftTokens: metrics.draftTokens,
					losses: draft.losses.length,
				};
				return { content: [{ type: "text", text: summary }], details };
			},
		};
	}

	/** Tool that accepts the newest reviewed draft. Thin adapter over {@link accept}. */
	approveTool(): ToolDefinition {
		return {
			name: "approve",
			label: "Approve",
			description: approveDescription.trim(),
			parameters: approveSchema,
			approval: "read",
			strict: true,
			execute: async (_toolCallId, rawParams) => {
				const params = approveSchema(rawParams);
				if (params instanceof type.errors) throw new Error(`approve received invalid arguments: ${params.summary}`);
				const draft = this.accept(params.verdict);
				const details: ApproveDetails = { round: draft.round };
				return {
					content: [{ type: "text", text: `Draft ${draft.round} approved. The run ends here.` }],
					details,
				};
			},
		};
	}
}
