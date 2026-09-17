/**
 * Token-throughput calculator shared by the status line (main session tok/s
 * badge) and the vibe worker aggregation ({@link aggregateVibeWorkerTokensPerSecond}).
 * Lives in `utils/` so neither the render layer nor the vibe runtime has to
 * depend on the other for a pure arithmetic helper.
 */
const MIN_DURATION_MS = 100;

type AssistantUsage = {
	output: number;
};

type AssistantLikeMessage = {
	role: "assistant";
	timestamp: number;
	duration?: number;
	usage: AssistantUsage;
};

type MaybeAssistantMessage = {
	role?: string;
	timestamp?: number;
	duration?: number;
	usage?: {
		output?: number;
	};
};

function isAssistantMessage(message: MaybeAssistantMessage | undefined): message is AssistantLikeMessage {
	return (
		message?.role === "assistant" &&
		typeof message.timestamp === "number" &&
		message.usage !== undefined &&
		typeof message.usage.output === "number"
	);
}

function getLastAssistantMessage(messages: ReadonlyArray<MaybeAssistantMessage>): AssistantLikeMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isAssistantMessage(message)) {
			return message;
		}
	}
	return null;
}

export function calculateTokensPerSecond(
	messages: ReadonlyArray<MaybeAssistantMessage>,
	isStreaming: boolean,
	nowMs: number = Date.now(),
): number | null {
	const assistant = getLastAssistantMessage(messages);
	if (!assistant) return null;

	const outputTokens = assistant.usage.output;
	if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null;

	const resolvedDurationMs =
		typeof assistant.duration === "number" && Number.isFinite(assistant.duration) && assistant.duration > 0
			? assistant.duration
			: isStreaming
				? nowMs - assistant.timestamp
				: null;

	if (resolvedDurationMs === null || resolvedDurationMs < MIN_DURATION_MS) return null;

	const tokensPerSecond = (outputTokens * 1000) / resolvedDurationMs;
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null;

	return tokensPerSecond;
}

/**
 * Half-lives (ms of stream time) of the decayed-sum scales. Summing the
 * scales gives a kernel `Σ 2^(-age/τ)`: a long tail for inertia against
 * bursts, plus extra weight on the last few seconds so a sustained change
 * still shows within one scale or two.
 */
const METER_HALF_LIVES_MS = [5_000, 20_000, 80_000];
/**
 * Evidence gate on the longest scale: fewer decayed tokens, or less stream
 * time, than this is noise, not a rate — a provider's first buffered chunk
 * can carry hundreds of tokens in one delta.
 */
const METER_MIN_TOKENS = 200;
const METER_MIN_TIME_MS = 4_000;
/** Streamed text is batched and tokenized once per bucket. */
const METER_BUCKET_MS = 250;
/** Longest tail deferred to the next bucket so a token split across two buckets is counted once. */
const METER_CARRY_MAX_CHARS = 32;
/** Weight kept from earlier messages when a new billed count refines the hidden-token rate. */
const METER_HIDDEN_DECAY = 0.8;
/** Prior pulling the hidden-token rate toward zero, weighted like a message of this span. */
const METER_HIDDEN_PRIOR_MS = 10_000;
const LN2 = Math.LN2;

/**
 * Exponentially decayed token and time sums on one half-life. `time` is the
 * exact integral of the kernel over elapsed stream time, so `tokens / time`
 * is a kernel-weighted rate and `time` doubles as the effective window.
 */
class DecayedSums {
	tokens = 0;
	time = 0;

	constructor(readonly halfLifeMs: number) {}

	/**
	 * Age both sums by `dtMs` of stream time. The in-flight message also
	 * accumulates the kernel's integral into `time` and `hiddenRate` tokens per
	 * ms of it into `tokens`.
	 */
	advance(dtMs: number, inflight: boolean, hiddenRate: number): void {
		if (dtMs <= 0) return;
		const f = 2 ** (-dtMs / this.halfLifeMs);
		this.tokens *= f;
		this.time *= f;
		if (inflight) {
			const integral = (this.halfLifeMs / LN2) * (1 - f);
			this.time += integral;
			this.tokens += hiddenRate * integral;
		}
	}

	reset(): void {
		this.tokens = 0;
		this.time = 0;
	}
}

/**
 * Live generation throughput for the working row: a kernel-weighted rate over
 * recent stream time, `Σ_scales tokens / Σ_scales time` with the sums decayed
 * on {@link METER_HALF_LIVES_MS}. A burst (a write's args) therefore shifts
 * the reading in proportion to its token mass against the last minute or so,
 * instead of replacing it.
 *
 * Streamed deltas are tokenized locally per bucket for the in-flight message
 * and kept in a separate set of sums. What the provider bills but never
 * streams — hidden or summarized reasoning, the tool-call envelope — is
 * modelled as a *hidden-token rate*: tokens accruing per ms of message span
 * on top of the visible deltas, estimated from recent messages as
 * `Σ(billed − local) / Σ span`. The in-flight message credits that rate
 * live, including through its silent lead-in; once `usage.output` lands the
 * residual is spread uniformly over the span and the message merges into
 * history. Additive, not multiplicative: a fast burst of visible tokens is
 * never amplified by what earlier messages hid.
 *
 * Stream time runs from {@link begin} to {@link end}; callers pass the
 * message's own request-start timestamp and `timestamp + duration` (epoch ms,
 * the `Date.now()` clock) so dispatch latency never shortens a span. Tool
 * execution between messages neither ages the sums nor counts as time, so the
 * readout holds across it. {@link reset} blanks it on a session switch while
 * keeping the hidden-rate estimate.
 *
 * Whole-message averages come from {@link calculateTokensPerSecond} instead.
 */
export class TokenRateMeter {
	readonly #count: (text: string) => number;
	readonly #history = METER_HALF_LIVES_MS.map(ms => new DecayedSums(ms));
	readonly #inflight = METER_HALF_LIVES_MS.map(ms => new DecayedSums(ms));
	/** Wall time the in-flight message started, or null between messages. */
	#startedAt: number | null = null;
	/** Wall time the sums were last advanced to. */
	#advancedTo = 0;
	/** Local (visible) tokens of the in-flight message. */
	#inflightLocal = 0;
	/** Hidden-token rate (tokens/ms) credited to the in-flight message; fixed at {@link begin}. */
	#inflightHiddenRate = 0;
	#pendingIndex = -1;
	#pending = "";
	/** Decayed sums behind the hidden-token rate estimate. */
	#hiddenTokens = 0;
	#hiddenSpanMs = 0;

	constructor(count: (text: string) => number) {
		this.#count = count;
	}

	/** Open a message at wall time `nowMs`; a message still open is dropped unbilled. */
	begin(nowMs: number = Date.now()): void {
		this.#clearInflight();
		this.#startedAt = nowMs;
		this.#advancedTo = nowMs;
		this.#inflightHiddenRate = Math.max(0, this.#hiddenTokens / (this.#hiddenSpanMs + METER_HIDDEN_PRIOR_MS));
	}

	/** Record streamed text at wall time `nowMs`; opens the message if {@link begin} was not called. */
	push(text: string, nowMs: number = Date.now()): void {
		if (text.length === 0) return;
		if (this.#startedAt === null) this.begin(nowMs);
		const index = Math.floor((nowMs - (this.#startedAt ?? nowMs)) / METER_BUCKET_MS);
		if (index !== this.#pendingIndex) {
			this.#flushPending(true, nowMs);
			this.#pendingIndex = index;
		}
		this.#pending += text;
	}

	/**
	 * Close the in-flight message. `outputTokens` is the provider's billed
	 * output count; when absent or zero (aborted stream) the local estimate
	 * stands and the hidden-token rate is left untouched.
	 */
	end(outputTokens: number | undefined, nowMs: number = Date.now()): void {
		if (this.#startedAt === null) return;
		this.#flushPending(false, nowMs);
		this.#advance(nowMs);
		const spanMs = nowMs - this.#startedAt;
		const billed = outputTokens !== undefined && Number.isFinite(outputTokens) && outputTokens > 0;
		let extra = 0;
		if (billed) {
			const hidden = outputTokens - this.#inflightLocal;
			this.#hiddenTokens = this.#hiddenTokens * METER_HIDDEN_DECAY + hidden;
			this.#hiddenSpanMs = this.#hiddenSpanMs * METER_HIDDEN_DECAY + spanMs;
			extra = hidden - this.#inflightHiddenRate * spanMs;
		}
		for (let k = 0; k < this.#history.length; k++) {
			const live = this.#inflight[k];
			// `extra` spread uniformly over the span has kernel weight `time / span`.
			const corrected = live.tokens + (spanMs > 0 ? (extra * live.time) / spanMs : 0);
			this.#history[k].tokens += Math.max(0, corrected);
			this.#history[k].time += live.time;
		}
		this.#clearInflight();
	}

	/** Drop the window; the readout goes blank until a new run accumulates enough tokens. */
	reset(): void {
		this.#clearInflight();
		for (const sums of this.#history) sums.reset();
	}

	/** Tokens per second over the decayed window, or null until enough tokens have accumulated. */
	rate(nowMs: number = Date.now()): number | null {
		const dtMs = this.#startedAt === null ? 0 : nowMs - this.#advancedTo;
		const pendingTokens = this.#pending.length > 0 ? this.#count(this.#pending) : 0;
		let tokens = 0;
		let time = 0;
		let evidenceTokens = 0;
		let evidenceTime = 0;
		for (let k = 0; k < this.#history.length; k++) {
			const f = 2 ** (-dtMs / METER_HALF_LIVES_MS[k]);
			const integral = (METER_HALF_LIVES_MS[k] / LN2) * (1 - f);
			evidenceTokens =
				(this.#history[k].tokens + this.#inflight[k].tokens) * f +
				this.#inflightHiddenRate * integral +
				pendingTokens;
			evidenceTime = (this.#history[k].time + this.#inflight[k].time) * f + integral;
			tokens += evidenceTokens;
			time += evidenceTime;
		}
		if (evidenceTokens < METER_MIN_TOKENS || evidenceTime < METER_MIN_TIME_MS) return null;
		return (tokens * 1000) / time;
	}

	/** Age every sum to wall time `nowMs` (stream time only advances inside a message). */
	#advance(nowMs: number): void {
		const dtMs = nowMs - this.#advancedTo;
		if (dtMs <= 0) return;
		this.#advancedTo = nowMs;
		for (let k = 0; k < this.#history.length; k++) {
			this.#history[k].advance(dtMs, false, 0);
			this.#inflight[k].advance(dtMs, true, this.#inflightHiddenRate);
		}
	}

	#clearInflight(): void {
		for (const sums of this.#inflight) sums.reset();
		this.#startedAt = null;
		this.#inflightLocal = 0;
		this.#inflightHiddenRate = 0;
		this.#pendingIndex = -1;
		this.#pending = "";
	}

	/** Tokenize the pending bucket into the in-flight sums, optionally holding back the trailing partial word. */
	#flushPending(carry: boolean, nowMs: number): void {
		if (this.#pendingIndex < 0 || this.#pending.length === 0) return;
		let text = this.#pending;
		let tail = "";
		if (carry) {
			const cut = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"));
			if (cut > 0 && text.length - cut <= METER_CARRY_MAX_CHARS) {
				tail = text.slice(cut);
				text = text.slice(0, cut);
			}
		}
		this.#pending = tail;
		if (text.length === 0) return;
		this.#advance(nowMs);
		const tokens = this.#count(text);
		for (const sums of this.#inflight) sums.tokens += tokens;
		this.#inflightLocal += tokens;
	}
}
