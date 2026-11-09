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
	/** Highest send time seen; see {@link IrcIngressGuard.check}. */
	#lastNow = 0;

	/** Sender windows currently retained; bounded by {@link MAX_RATE_SENDERS}. */
	get rateWindowCount(): number {
		return this.#rates.size;
	}

	/**
	 * Refuse `message` under `limits`, or return `undefined` to let it through.
	 * Only an accepted send spends its caller's rate budget and claims its
	 * dedup key; a refusal of any kind leaves both untouched.
	 *
	 * Order: hops (a chain over the ceiling never reaches anyone), then dedup
	 * (a repeat never reaches its recipient, so it must not charge the sender's
	 * rate window), then rate. The three checks are pure; {@link #accept}
	 * commits both pieces of state only once every check has passed.
	 *
	 * Windows run on send time, clamped to the highest time already seen: a
	 * backward wall-clock step (NTP correction, resume from sleep) must not
	 * leave future-dated entries that keep a sender refused — or stop dedup
	 * keys from expiring — until the clock catches up again.
	 */
	check(message: IrcMessage, limits: IrcIngressLimits): IrcIngressRefusal | undefined {
		const now = Math.max(message.ts, this.#lastNow);
		this.#lastNow = now;
		const hopped = this.#checkHops(message, limits.maxHops);
		if (hopped) return hopped;
		const dedupKey = this.#dedupKey(message, limits.dedupWindowMs);
		const duplicate = this.#checkDedup(message, dedupKey, limits.dedupWindowMs, now);
		if (duplicate) return duplicate;
		const rate = this.#checkRate(message, limits.rateLimitTokens, now);
		if (rate) return rate;
		this.#accept(message, dedupKey, limits, now);
		return undefined;
	}

	#checkHops(message: IrcMessage, maxHops: number): IrcIngressRefusal | undefined {
		const hops = message.hops?.length ?? 0;
		if (maxHops <= 0 || hops <= maxHops) return undefined;
		return {
			reason: "hop-limit",
			error: `hop limit: the message chain reached ${hops} hops (max ${maxHops}) — answer the sender you were asked by instead of relaying further`,
		};
	}

	/** `undefined` when dedup does not apply to this message (disabled or exempt). */
	#dedupKey(message: IrcMessage, windowMs: number): string | undefined {
		// Progress notes and automated wake relays are meant to repeat: an agent
		// may send the same interim line twice, and two wake turns can end with
		// identical output. Neither is the repetition loop dedup exists to stop.
		// An external bridge request is identified by its own A2A `messageId`, so
		// the same text twice is two requests, not a loop.
		if (windowMs <= 0 || message.progress || message.wakeRelay || message.external) return undefined;
		return `${message.from}\u0000${message.to}\u0000${createHash("sha256").update(message.body).digest("hex")}`;
	}

	#checkDedup(
		message: IrcMessage,
		key: string | undefined,
		windowMs: number,
		now: number,
	): IrcIngressRefusal | undefined {
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
		if (key === undefined) return undefined;
		if (this.#dedup.has(key)) {
			// A refusal spends nothing: do not restart the window on the repeat,
			// so the original key still expires on schedule.
			return {
				reason: "duplicate",
				error: `duplicate: "${message.from}" already sent this text to "${message.to}" within ${windowMs} ms - change the message or wait`,
			};
		}
		return undefined;
	}

	#checkRate(message: IrcMessage, limit: number, now: number): IrcIngressRefusal | undefined {
		if (limit <= 0) return undefined;
		// A broadcast is one authored message the tool fans out, and a wake relay is
		// the runtime answering a woken turn: charging every leg would refuse a
		// legitimate announcement to more peers than a sender's budget covers.
		// Repeated authored sends and progress notes stay charged. This exemption
		// leans on the upstream invariant that only the main agent broadcasts
		// (`irc/messaging.ts`: "Only the main agent can broadcast"); if subagents
		// ever regain broadcast, charge its legs again.
		// Bridge deliveries are external client requests, not agent-loop traffic:
		// they have no shared sender budget to spend.
		// Team control is runtime-authored team traffic (control and notices on
		// behalf of members), not agent-loop traffic.
		if (message.broadcast || message.wakeRelay || message.external || message.teamControl) return undefined;
		const window = this.#rates.get(message.from);
		if (window) {
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
		}
		// A message costs its body length in characters / 4, at least one token.
		const cost = Math.max(1, Math.ceil(message.body.length / CHARS_PER_TOKEN));
		// An empty window always admits one message, however expensive: a single
		// long report (a subagent's answer, a 500-character summary) must never be
		// refused by a budget it alone exceeds. Flood semantics are unchanged -
		// the message spends the whole window, so the rest of the burst is cut
		// until the window slides past it.
		const total = window?.total ?? 0;
		if (total > 0 && total + cost > limit) {
			return {
				reason: "rate-limited",
				error: `rate limited: "${message.from}" may send ${limit} tokens per ${IRC_RATE_WINDOW_MS} ms and this message costs ${cost} - wait a moment or send less`,
			};
		}
		return undefined;
	}

	/** Commit an accepted send: claim the dedup key and charge the rate window. */
	#accept(message: IrcMessage, dedupKey: string | undefined, limits: IrcIngressLimits, now: number): void {
		if (dedupKey !== undefined) {
			this.#dedup.set(dedupKey, now);
			this.#dedupOrder.push({ key: dedupKey, ts: now });
		}
		if (
			limits.rateLimitTokens <= 0 ||
			message.broadcast ||
			message.wakeRelay ||
			message.external ||
			message.teamControl
		)
			return;
		let window = this.#rates.get(message.from);
		if (!window) {
			// Agent ids are unique per spawn, so a long-lived process would keep one
			// window per agent ever seen. Sweep senders that left the window first;
			// when every window is still live (a burst of 256+ distinct senders),
			// evict the oldest anyway — the map stays bounded either way, at the
			// cost of a reset budget for that one sender.
			if (this.#rates.size >= MAX_RATE_SENDERS) {
				for (const [sender, idle] of this.#rates) {
					if (now - (idle.times.at(-1) ?? 0) >= IRC_RATE_WINDOW_MS) this.#rates.delete(sender);
				}
				if (this.#rates.size >= MAX_RATE_SENDERS) {
					let oldestSender: string | undefined;
					let oldestSent = Number.POSITIVE_INFINITY;
					for (const [sender, idle] of this.#rates) {
						const lastSent = idle.times.at(-1) ?? 0;
						if (lastSent < oldestSent) {
							oldestSent = lastSent;
							oldestSender = sender;
						}
					}
					if (oldestSender !== undefined) this.#rates.delete(oldestSender);
				}
			}
			window = { times: [], costs: [], head: 0, total: 0 };
			this.#rates.set(message.from, window);
		}
		const cost = Math.max(1, Math.ceil(message.body.length / CHARS_PER_TOKEN));
		window.times.push(now);
		window.costs.push(cost);
		window.total += cost;
	}
}
