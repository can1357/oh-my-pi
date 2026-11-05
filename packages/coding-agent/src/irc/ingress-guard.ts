/**
 * Ingress guard for {@link IrcBus.send}: per-sender rate limiting, duplicate
 * suppression, and a hop-chain ceiling.
 *
 * The guard sits on the send path only — `wait`, broadcast expansion, and the
 * display-only relay to the main UI are unaffected. Every refusal is a value
 * the caller turns into a `failed` receipt; the guard never throws, so a
 * guarded bus keeps the fire-and-forget contract of `send`.
 *
 * State is per bus instance and bounded by the configured windows: rate
 * entries expire after {@link IRC_RATE_WINDOW_MS}, dedup keys after
 * `dedupWindowMs`, and both are pruned in amortized O(1) from a FIFO.
 */
import { createHash } from "node:crypto";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

/** Sliding window a sender's token budget refills over. */
const IRC_RATE_WINDOW_MS = 500;

/** Characters one rate-limit token pays for; every message costs at least one token. */
const CHARS_PER_TOKEN = 4;

/** How many pruned entries may accumulate before the FIFO buffers are compacted. */
const COMPACT_THRESHOLD = 64;

/** Senders whose rate windows are kept before idle ones are swept (agent ids are per spawn). */
const MAX_RATE_SENDERS = 256;

/** Limits resolved from settings once per settings revision; see {@link IrcIngressGuard.check}. */
export interface IrcIngressLimits {
	/** Tokens one sender may spend per {@link IRC_RATE_WINDOW_MS}; `<= 0` disables rate limiting. */
	rateLimitTokens: number;
	/** Window in which an identical (sender, recipient, body) send is refused; `<= 0` disables dedup. */
	dedupWindowMs: number;
	/** Longest accepted hop chain; `<= 0` disables the ceiling. */
	maxHops: number;
}

/** Why the guard refused a send; {@link IrcIngressRefusal.error} is the receipt text. */
export interface IrcIngressRefusal {
	reason: "rate-limited" | "duplicate" | "hop-limit";
	error: string;
}

interface RateWindow {
	/** Send timestamps still inside the window, oldest first, from `head` on. */
	times: number[];
	/** Token cost of each send in {@link times}. */
	costs: number[];
	head: number;
	total: number;
}

interface DedupEntry {
	key: string;
	ts: number;
}

export class IrcIngressGuard {
	readonly #rates = new Map<string, RateWindow>();
	readonly #dedup = new Map<string, number>();
	readonly #dedupOrder: DedupEntry[] = [];
	#dedupHead = 0;

	/**
	 * Refuse `message` under `limits`, or return `undefined` to let it through.
	 * An accepted send spends its caller's rate budget and claims its dedup key.
	 *
	 * Order: hops (a chain over the ceiling never reaches anyone), then rate
	 * (flooding costs the recipient the most), then dedup. Refusals spend
	 * nothing, so a refused message is not counted against the next attempt.
	 */
	check(message: IrcMessage, limits: IrcIngressLimits): IrcIngressRefusal | undefined {
		const hopped = this.#checkHops(message, limits.maxHops);
		if (hopped) return hopped;
		const rate = this.#checkRate(message, limits.rateLimitTokens);
		if (rate) return rate;
		return this.#checkDedup(message, limits.dedupWindowMs);
	}

	#checkHops(message: IrcMessage, maxHops: number): IrcIngressRefusal | undefined {
		const hops = message.hops?.length ?? 0;
		if (maxHops <= 0 || hops <= maxHops) return undefined;
		return {
			reason: "hop-limit",
			error: `hop limit: the message chain reached ${hops} hops (max ${maxHops}) — answer the sender you were asked by instead of relaying further`,
		};
	}

	#checkRate(message: IrcMessage, limit: number): IrcIngressRefusal | undefined {
		if (limit <= 0) return undefined;
		// A broadcast is one authored message the tool fans out, and a wake relay is
		// the runtime answering a woken turn: charging every leg would refuse a
		// legitimate announcement to more peers than a sender's budget covers.
		// Repeated authored sends and progress notes stay charged.
		if (message.broadcast || message.wakeRelay) return undefined;
		const now = message.ts;
		let window = this.#rates.get(message.from);
		if (!window) {
			// Agent ids are unique per spawn, so a long-lived process would keep one
			// window per agent ever seen. Sweep senders that left the window first.
			if (this.#rates.size >= MAX_RATE_SENDERS) {
				for (const [sender, idle] of this.#rates) {
					if (now - (idle.times.at(-1) ?? 0) >= IRC_RATE_WINDOW_MS) this.#rates.delete(sender);
				}
			}
			window = { times: [], costs: [], head: 0, total: 0 };
			this.#rates.set(message.from, window);
		}
		// Drop sends that left the sliding window, then compact the arrays.
		while (window.head < window.times.length && now - window.times[window.head]! >= IRC_RATE_WINDOW_MS) {
			window.total -= window.costs[window.head]!;
			window.head++;
		}
		if (window.head >= COMPACT_THRESHOLD) {
			window.times = window.times.slice(window.head);
			window.costs = window.costs.slice(window.head);
			window.head = 0;
		}
		// A message costs its body length in characters / 4, at least one token.
		const cost = Math.max(1, Math.ceil(message.body.length / CHARS_PER_TOKEN));
		if (window.total + cost > limit) {
			return {
				reason: "rate-limited",
				error: `rate limited: "${message.from}" may send ${limit} tokens per ${IRC_RATE_WINDOW_MS} ms and this message costs ${cost} — wait a moment or send less`,
			};
		}
		window.times.push(now);
		window.costs.push(cost);
		window.total += cost;
		return undefined;
	}

	#checkDedup(message: IrcMessage, windowMs: number): IrcIngressRefusal | undefined {
		// Progress notes and automated wake relays are meant to repeat: an agent
		// may send the same interim line twice, and two wake turns can end with
		// identical output. Neither is the repetition loop dedup exists to stop.
		if (windowMs <= 0 || message.progress || message.wakeRelay) return undefined;
		const now = message.ts;
		while (this.#dedupHead < this.#dedupOrder.length) {
			const entry = this.#dedupOrder[this.#dedupHead]!;
			if (now - entry.ts < windowMs) break;
			// A refreshed key has a newer entry later in the FIFO; only drop the
			// mapping when this is still the entry it belongs to.
			if (this.#dedup.get(entry.key) === entry.ts) this.#dedup.delete(entry.key);
			this.#dedupHead++;
		}
		if (this.#dedupHead >= COMPACT_THRESHOLD) {
			this.#dedupOrder.splice(0, this.#dedupHead);
			this.#dedupHead = 0;
		}
		const key = `${message.from}\u0000${message.to}\u0000${createHash("sha256").update(message.body).digest("hex")}`;
		if (this.#dedup.has(key)) {
			// Keep a repeat offender blocked: the window restarts on the repeat.
			this.#dedup.set(key, now);
			this.#dedupOrder.push({ key, ts: now });
			return {
				reason: "duplicate",
				error: `duplicate: "${message.from}" already sent this text to "${message.to}" within ${windowMs} ms — change the message or wait`,
			};
		}
		this.#dedup.set(key, now);
		this.#dedupOrder.push({ key, ts: now });
		return undefined;
	}
}
