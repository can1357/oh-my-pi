/**
 * Agents blocked on an agent whose turn ends with nothing left to wake it, and
 * the turn-end stall guard that continues that agent's run once per waiter. An
 * agent that promised another a later reply, or whose subagent waits for its
 * next message, would otherwise leave the waiter blocked until someone notices.
 */
import { formatDuration, prompt } from "@oh-my-pi/pi-utils";
import { IrcBus, type IrcBusApi } from "../irc/bus";
import stalledWaitersTemplate from "../prompts/system/stalled-waiters.md" with { type: "text" };
import type { AgentRegistryApi } from "../registry/agent-registry";

/** Most (waiter, ask) pairs a {@link StallGuard} remembers noticing; the oldest are forgotten first. */
const NOTICED_PAIRS_MAX = 256;

/** An agent blocked until a given agent acts; see {@link stalledWaiters}. */
export interface StalledWaiter {
	/** The blocked agent. */
	id: string;
	/** Agents between it and the agent it is blocked on, nearest it first; empty when it waits directly. */
	via: readonly string[];
	/** Opening text of what it asked, for a reply wait. */
	ask?: string;
	/** Opening text of the progress note that promised the reply. */
	promise?: string;
	/** When it started waiting: its ask went out, or its wait began. */
	since: number;
	/** Identity of the (waiter, ask) pair: one notice per pair. */
	key: string;
}

/**
 * Agents blocked until `agentId` acts, by waits only it can end: a reply wait
 * whose ask `agentId` answered with a progress note (a promise), a subagent's
 * wait for its parent's next message begun after the parent's latest message
 * to it, and waits blocked on those in turn. An unpromised ask is left out:
 * the asked agent's turn ending answers it (a woken subagent's output is
 * relayed) or tells the waiter it stopped.
 */
export function stalledWaiters(
	registry: AgentRegistryApi,
	agentId: string,
	bus: IrcBusApi = IrcBus.global(),
): StalledWaiter[] {
	const blocked = registry.awaits.waitersOn(agentId);
	const direct = new Map<string, StalledWaiter>();
	for (const { waiter, since, via } of blocked) {
		if (via.length > 0) continue;
		const ref = registry.get(waiter);
		const ask = bus.unansweredSends(waiter, ref?.session?.runStartedAt ?? 0).find(send => send.to === agentId);
		if (ask) {
			if (!ask.promised) continue;
			direct.set(waiter, {
				id: waiter,
				via,
				ask: ask.ask,
				promise: ask.promise,
				since: ask.sentAt,
				key: `${waiter}\0ask\0${ask.sentAt}`,
			});
			continue;
		}
		// A message the parent sent after the wait began is ending it.
		const lastMessageAt = bus.lastMessageAt(agentId, waiter) ?? 0;
		if (ref?.parentId !== agentId || since < lastMessageAt) continue;
		direct.set(waiter, { id: waiter, via, since, key: `${waiter}\0parent\0${lastMessageAt}` });
	}
	const waiters = [...direct.values()];
	for (const { waiter, since, via } of blocked) {
		const through = via.length > 0 ? direct.get(via[via.length - 1]) : undefined;
		if (through) waiters.push({ id: waiter, via, since, key: `${waiter}\0via\0${through.key}` });
	}
	return waiters;
}

/**
 * The turn-end stall guard: once an agent's run is about to settle with
 * nothing left to wake it, the notice naming the agents still blocked on it,
 * at most once per (waiter, ask) pair, so the guard never loops.
 */
export class StallGuard {
	readonly #noticed = new Set<string>();

	/**
	 * The notice listing `waiters` (see {@link stalledWaiters}) when at least
	 * one of them was not noticed before; undefined otherwise. Marks them all
	 * noticed.
	 */
	take(waiters: readonly StalledWaiter[], now = Date.now()): string | undefined {
		if (waiters.every(waiter => this.#noticed.has(waiter.key))) return undefined;
		for (const waiter of waiters) {
			this.#noticed.delete(waiter.key);
			this.#noticed.add(waiter.key);
		}
		for (const key of this.#noticed) {
			if (this.#noticed.size <= NOTICED_PAIRS_MAX) break;
			this.#noticed.delete(key);
		}
		return prompt.render(stalledWaitersTemplate, {
			waiters: waiters.map(waiter => ({ ...waiter, ago: formatDuration(now - waiter.since) })),
		});
	}
}
