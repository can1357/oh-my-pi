/**
 * Builds session journals (JSONL) the way omp writes them, for Spotlight ingest tests. Each method appends entries;
 * the clock advances on every entry.
 */

/** A tool call to issue from an assistant request. */
export interface CallSpec {
	name: string;
	args: Record<string, unknown>;
	/** Defaults to a fresh `toolu_<n>` id. */
	id?: string;
}

/** Usage of one request: its prompt split and output, priced at Opus-like rates unless `cost` overrides. */
export interface RequestSpec {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	output?: number;
	/** Total cost; the split follows the token buckets. */
	cost?: number;
	/** Model time (ms); default 80% of the builder's step. */
	duration?: number;
	calls?: CallSpec[];
}

/** The `details.spotlight.original` of a shortened result. */
export interface OriginalSpec {
	url: string;
	lines: number;
	start?: number;
	path?: string;
	kept: [number, number][];
	/** Spotlight's per-line heat (`0`–`9`, `-` unscored); default none. */
	heat?: string;
}

/** What the experiment did to one result. */
export interface ShapeSpec {
	inTokens: number;
	outTokens: number;
	/** Characters of the full input; default inTokens × 4. */
	inChars?: number;
	/** What `plain` would have shown; omitted, the trace predates it (the dashboard estimates it). */
	plainTokens?: number;
	/** The score-free coin skipped Spotlight. */
	scoreFree?: boolean;
	/** A cut wider than plain that pi did not apply (its tokens): the model got plain's text, `outTokens`. */
	cappedTokens?: number;
	steps?: string[];
	original?: OriginalSpec;
	costUsd?: number;
	ms?: number;
	/** Spotlight calls that failed (the no-score fallback shaped the result). */
	failures?: number;
	/**
	 * Held out: the model saw the result unshaped (`text`), while the counts and `original` describe the would-be cut
	 * and `shapedUrl` names its text.
	 */
	holdout?: { shapedUrl: string };
	/**
	 * Kept whole by pi's former edit gate: like a held-out result, the model saw `text` (plain's page) while the
	 * counts and `original` describe the would-be cut.
	 */
	gated?: boolean;
	/** Journal the `spotlight:shape` entry (default true). */
	shapeEntry?: boolean;
	/** Persist `details.spotlight` on the result (default true). */
	details?: boolean;
}

export interface ResultSpec {
	text: string;
	shape?: ShapeSpec;
	/** The call failed (default false). */
	isError?: boolean;
}

const RATES = { input: 5e-6, output: 25e-6, cacheRead: 0.5e-6, cacheWrite: 6.25e-6 };

/** Characters of the (would-be) shaped text: the shown text of an applied cut, the would-be cut's of a held-out one. */
function outChars(spec: ShapeSpec, text: string): number {
	if (spec.holdout || spec.gated || spec.cappedTokens !== undefined) return spec.outTokens * 4;
	return spec.original ? text.length : spec.inTokens * 4;
}

/** The trace's `gated` flag, when the spec sets it. */
function gateFields(spec: ShapeSpec): Record<string, boolean> {
	return spec.gated ? { gated: true } : {};
}

/** The trace's `plainChars`/`plainTokens`, when the spec sets them. */
function plainFields(spec: ShapeSpec): Record<string, number> {
	return {
		...(spec.plainTokens === undefined ? {} : { plainChars: spec.plainTokens * 4, plainTokens: spec.plainTokens }),
		...(spec.cappedTokens === undefined
			? {}
			: { cappedChars: spec.cappedTokens * 4, cappedTokens: spec.cappedTokens }),
	};
}

/** Builders made in this process; part of every id so separate transcripts never share entry or call ids. */
let builders = 0;

export class SpotlightSessionBuilder {
	readonly #lines: string[] = [];
	readonly #toolNames = new Map<string, string>();
	#clock: number;
	#step: number;
	#nextId = 0;
	#lastId: string | null = null;
	readonly #tag: string;

	constructor(start: number, step = 5_000) {
		this.#clock = start;
		this.#step = step;
		builders++;
		this.#tag = `${start.toString(36)}${builders.toString(36)}`;
	}

	/** Current journal time (ms). */
	get now(): number {
		return this.#clock;
	}

	/** Let `ms` pass before the next entry. */
	wait(ms: number): this {
		this.#clock += ms;
		return this;
	}

	#tick(): string {
		this.#clock += this.#step;
		return new Date(this.#clock).toISOString();
	}

	#id(): string {
		this.#nextId++;
		return `${this.#tag}-${this.#nextId.toString(16)}`;
	}

	#push(entry: Record<string, unknown>): void {
		this.#lines.push(JSON.stringify(entry));
	}

	#entry(fields: Record<string, unknown>): string {
		const id = this.#id();
		this.#push({ ...fields, id, parentId: this.#lastId, timestamp: this.#tick() });
		this.#lastId = id;
		return id;
	}

	header(cwd: string, title?: string): this {
		if (title) this.#push({ type: "title", v: 1, title, source: "auto" });
		this.#push({ type: "session", version: 3, id: `s${this.#clock}`, timestamp: this.#tick(), cwd });
		return this;
	}

	title(title: string): this {
		this.#entry({ type: "title_change", title, source: "auto" });
		return this;
	}

	/** The `spotlight:session` marker pi writes when a session starts with the experiment on. */
	marker(): this {
		this.#entry({
			type: "custom",
			customType: "spotlight:session",
			data: {
				tools: ["read", "bash", "eval", "grep"],
				model: "whiskers-latest",
				thinking: "low",
				urlHost: "cloud.stencil.so",
				piVersion: "18.15.0",
				holdout: 0.1,
				scoreFree: 0.1,
			},
		});
		return this;
	}

	/** The `spotlight:assignment` entry of journals written while sessions drew an arm. */
	legacyAssignment(arm: string): this {
		this.#entry({
			type: "custom",
			customType: "spotlight:assignment",
			data: {
				arm,
				findRanker: "spotlight",
				source: "random",
				tools: ["read", "bash", "eval", "grep"],
				model: "whiskers-latest",
				thinking: "low",
				urlHost: "cloud.stencil.so",
				piVersion: "18.14.0",
				holdout: 0.1,
				scoreFree: 0.1,
			},
		});
		return this;
	}

	user(text: string): this {
		this.#entry({
			type: "message",
			message: { role: "user", content: [{ type: "text", text }], timestamp: this.#clock },
		});
		return this;
	}

	/** One main-loop request; returns its tool call ids. */
	request(spec: RequestSpec = {}): string[] {
		const input = spec.input ?? 500;
		const cacheRead = spec.cacheRead ?? 0;
		const cacheWrite = spec.cacheWrite ?? 0;
		const output = spec.output ?? 200;
		const listed = {
			input: input * RATES.input,
			output: output * RATES.output,
			cacheRead: cacheRead * RATES.cacheRead,
			cacheWrite: cacheWrite * RATES.cacheWrite,
		};
		const listedTotal = listed.input + listed.output + listed.cacheRead + listed.cacheWrite;
		const scale = spec.cost !== undefined && listedTotal > 0 ? spec.cost / listedTotal : 1;
		const ids: string[] = [];
		const content: Record<string, unknown>[] = (spec.calls ?? []).map(call => {
			const id = call.id ?? `toolu_${this.#tag}_${this.#nextId.toString(36)}_${ids.length}`;
			ids.push(id);
			this.#toolNames.set(id, call.name);
			return { type: "toolCall", id, name: call.name, arguments: call.args };
		});
		if (content.length === 0) content.push({ type: "text", text: "done" });
		this.#entry({
			type: "message",
			message: {
				role: "assistant",
				content,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-4-5",
				stopReason: ids.length > 0 ? "toolUse" : "stop",
				timestamp: this.#clock + this.#step,
				duration: spec.duration ?? Math.round(this.#step * 0.8),
				usage: {
					input,
					output,
					cacheRead,
					cacheWrite,
					totalTokens: input + output + cacheRead + cacheWrite,
					cost: {
						input: listed.input * scale,
						output: listed.output * scale,
						cacheRead: listed.cacheRead * scale,
						cacheWrite: listed.cacheWrite * scale,
						total: listedTotal * scale,
					},
				},
			},
		});
		return ids;
	}

	/** A side request journaled as `model_usage` (a title or widget model): it must not read as a compaction. */
	sideRequest(input = 300): this {
		this.#entry({
			type: "model_usage",
			purpose: "job-widget",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			usage: {
				input,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input + 20,
				cost: { input: input * 1e-6, output: 1e-4, cacheRead: 0, cacheWrite: 0, total: input * 1e-6 + 1e-4 },
			},
		});
		return this;
	}

	/** The `spotlight:shape` journal entry of a call (normally written by {@link result}). */
	shapeEntry(toolCallId: string, spec: ShapeSpec, text: string): this {
		const tool = this.#toolNames.get(toolCallId) ?? "read";
		const steps = spec.steps ?? (spec.original ? ["window"] : ["none"]);
		this.#entry({
			type: "custom",
			customType: "spotlight:shape",
			data: {
				toolCallId,
				tool,
				steps,
				inChars: spec.inChars ?? spec.inTokens * 4,
				outChars: outChars(spec, text),
				inTokens: spec.inTokens,
				outTokens: spec.outTokens,
				...plainFields(spec),
				ms: spec.ms ?? 120,
				...(spec.holdout ? { holdout: true } : {}),
				...(spec.scoreFree ? { scoreFree: true } : {}),
				...gateFields(spec),
				spotlight: {
					calls: spec.costUsd ? 1 : 0,
					failures: spec.failures ?? 0,
					ms: spec.ms ?? 120,
					tokens: spec.inTokens,
					costUsd: spec.costUsd ?? 0,
				},
				stats: {},
			},
		});
		return this;
	}

	/** The result message of a call (preceded by its shape entry when the experiment evaluated it). */
	result(toolCallId: string, spec: ResultSpec): this {
		const shape = spec.shape;
		if (shape && shape.shapeEntry !== false) this.shapeEntry(toolCallId, shape, spec.text);
		return this.resultMessage(toolCallId, spec);
	}

	/** Only the result message (its shape entry written separately, e.g. in an earlier sync). */
	resultMessage(toolCallId: string, spec: ResultSpec): this {
		const tool = this.#toolNames.get(toolCallId) ?? "read";
		const shape = spec.shape;
		const details =
			shape && shape.details !== false
				? {
						spotlight: {
							tool,
							steps: shape.steps ?? (shape.original ? ["window"] : ["none"]),
							inChars: shape.inChars ?? shape.inTokens * 4,
							outChars: outChars(shape, spec.text),
							inTokens: shape.inTokens,
							outTokens: shape.outTokens,
							...plainFields(shape),
							savedTokens: shape.gated
								? 0
								: Math.max(0, (shape.plainTokens ?? shape.inTokens) - shape.outTokens),
							...(shape.holdout ? { holdout: true } : {}),
							...(shape.scoreFree ? { scoreFree: true } : {}),
							...gateFields(shape),
							...(shape.original
								? {
										original: {
											url: shape.original.url,
											lines: shape.original.lines,
											start: shape.original.start ?? 1,
											...(shape.original.path ? { path: shape.original.path } : {}),
											heat: shape.original.heat ?? "",
											kept: shape.original.kept,
											...(shape.holdout ? { shapedUrl: shape.holdout.shapedUrl } : {}),
										},
									}
								: {}),
						},
					}
				: undefined;
		this.#entry({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId,
				toolName: tool,
				content: [{ type: "text", text: spec.text }],
				...(details ? { details } : {}),
				isError: spec.isError ?? false,
				timestamp: this.#clock + this.#step,
			},
		});
		return this;
	}

	compaction(summary = "## Goal\nsummarized"): this {
		this.#entry({ type: "compaction", summary, tokensBefore: 150_000 });
		return this;
	}

	/** The journal so far, one entry per line. */
	text(): string {
		return `${this.#lines.join("\n")}\n`;
	}
}
