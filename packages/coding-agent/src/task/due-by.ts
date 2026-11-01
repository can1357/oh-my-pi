/**
 * Due-by clock for dispatched subagents.
 *
 * The dispatcher states, per spawn, when it expects the result (`dueMinutes`),
 * or takes `task.dueMinutes`. The clock runs in the process, outside every
 * agent's turn: an owner inside a blocking `task` call reads nothing until the
 * call returns, so it cannot time its own child. At the due-by the owner is
 * told; at twice the time, the owner's owner is told (the agent that
 * dispatched the owner, or the person at the UI when the owner is the
 * top-level session). A child that settles first disarms its clock.
 *
 * Nothing is stopped. Passing a due-by says the expectation was wrong, not
 * the child, so the notices say "taking longer than you said".
 */
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { formatDuration, logger, prompt } from "@oh-my-pi/pi-utils";
import escalationTemplate from "../prompts/tools/subagent-overdue-escalation.md" with { type: "text" };
import ownerTemplate from "../prompts/tools/subagent-overdue.md" with { type: "text" };
import type { AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { CustomMessage } from "../session/messages";

/**
 * Due-by, in minutes, for a dispatch that names none (`task.dueMinutes`).
 *
 * Measured over one week of a busy multi-agent workload (22,531 completed
 * `task` runs, 2026-10-24 to 2026-10-31): median 18 min, p90 115 min. On a
 * median day 9% of runs took 2 h or longer and 2.5% took 4 h or longer. So
 * with this default, an owner that names no due-by hears about roughly one
 * normal run in ten, and its own owner about one in forty.
 */
export const DEFAULT_TASK_DUE_MINUTES = 120;

/** Custom message type of a due-by notice. */
export const SUBAGENT_OVERDUE_MESSAGE_TYPE = "subagent-overdue";

/** `setTimeout` fires at once past this delay; longer waits re-arm in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** One dispatch the clock watches. */
export interface SubagentDispatch {
	/** Registry id of the dispatched subagent. */
	childId: string;
	/** Registry id of the agent that dispatched it. */
	ownerId: string;
	/** Agent type of the child, for the notice. */
	agent: string;
	dispatchedAt: number;
	dueMs: number;
	/** The dispatcher named the due-by, rather than taking the default. */
	stated: boolean;
}

/** One rendered notice queued for an agent; dropped unread once the child settles. */
export interface SubagentOverdueEntry {
	childId: string;
	stage: "owner" | "escalation";
	text: string;
	isSettled(): boolean;
}

/** Batch the queued notices into one model-visible message. */
export function buildSubagentOverdueMessage(entries: SubagentOverdueEntry[]): CustomMessage {
	return {
		role: "custom",
		customType: SUBAGENT_OVERDUE_MESSAGE_TYPE,
		content: entries.map(entry => entry.text).join("\n\n"),
		display: true,
		attribution: "agent",
		details: { notices: entries.map(({ childId, stage }) => ({ childId, stage })) },
		timestamp: Date.now(),
	};
}

function isoMinute(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

export class SubagentDueClock {
	readonly #registry: AgentRegistry;
	readonly #timers = new Set<NodeJS.Timeout>();

	constructor(registry: AgentRegistry) {
		this.#registry = registry;
	}

	/**
	 * Watch one dispatch until `settled` settles (fulfilled or rejected). A
	 * non-positive due-by arms nothing.
	 */
	arm(dispatch: SubagentDispatch, settled: Promise<unknown>): void {
		if (!(dispatch.dueMs > 0)) return;
		let done = false;
		let ownerTold = false;
		const own = new Set<NodeJS.Timeout>();
		const at = (when: number, fire: () => void): void => {
			const delay = when - Date.now();
			const timer = setTimeout(
				() => {
					own.delete(timer);
					this.#timers.delete(timer);
					if (done) return;
					if (delay > MAX_TIMER_MS) at(when, fire);
					else fire();
				},
				Math.min(Math.max(0, delay), MAX_TIMER_MS),
			);
			timer.unref();
			own.add(timer);
			this.#timers.add(timer);
		};
		const isSettled = () => done;
		at(dispatch.dispatchedAt + dispatch.dueMs, () => {
			ownerTold = this.#tellOwner(dispatch, isSettled);
		});
		at(dispatch.dispatchedAt + 2 * dispatch.dueMs, () => {
			this.#escalate(dispatch, ownerTold, isSettled);
		});
		const disarm = () => {
			done = true;
			for (const timer of own) {
				clearTimeout(timer);
				this.#timers.delete(timer);
			}
			own.clear();
		};
		settled.then(disarm, disarm);
	}

	/** Clear every pending timer. */
	dispose(): void {
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
	}

	#childView(dispatch: SubagentDispatch, now: number): Record<string, unknown> {
		const child = this.#registry.get(dispatch.childId);
		return {
			childId: dispatch.childId,
			agent: dispatch.agent,
			ownerId: dispatch.ownerId,
			stated: dispatch.stated,
			dispatchedAt: isoMinute(dispatch.dispatchedAt),
			dueIn: formatDuration(dispatch.dueMs),
			dueAt: isoMinute(dispatch.dispatchedAt + dispatch.dueMs),
			activeAgo: child ? formatDuration(Math.max(1_000, now - child.lastActivity)) : undefined,
			activity: child?.activity,
		};
	}

	/** Returns whether a live owner session received the notice. */
	#tellOwner(dispatch: SubagentDispatch, isSettled: () => boolean): boolean {
		const owner = this.#registry.get(dispatch.ownerId);
		if (!owner?.session) {
			logger.debug("Subagent due-by passed with no live owner", {
				childId: dispatch.childId,
				ownerId: dispatch.ownerId,
			});
			return false;
		}
		const text = prompt.render(ownerTemplate, {
			...this.#childView(dispatch, Date.now()),
			escalateAt: isoMinute(dispatch.dispatchedAt + 2 * dispatch.dueMs),
			escalateTo: owner.parentId,
		});
		owner.session.notifySubagentOverdue({ childId: dispatch.childId, stage: "owner", text, isSettled });
		return true;
	}

	#escalate(dispatch: SubagentDispatch, ownerTold: boolean, isSettled: () => boolean): void {
		const now = Date.now();
		const owner = this.#registry.get(dispatch.ownerId);
		const text = prompt.render(escalationTemplate, {
			...this.#childView(dispatch, now),
			ownerBlocked: !!owner?.session && this.#registry.awaits.blocksOn(dispatch.ownerId, dispatch.childId, now),
			ownerTold,
		});
		// The owner's owner is the nearest live agent above the owner; past the
		// top-level session it is the person at that session's UI.
		const seen = new Set<string>([dispatch.ownerId]);
		let top: AgentRef | undefined = owner;
		for (let id = owner?.parentId; id !== undefined && !seen.has(id);) {
			seen.add(id);
			const ref = this.#registry.get(id);
			if (!ref) break;
			if (ref.session) {
				ref.session.notifySubagentOverdue({ childId: dispatch.childId, stage: "escalation", text, isSettled });
				return;
			}
			top = ref;
			id = ref.parentId;
		}
		const session = top?.session ?? this.#registry.get(MAIN_AGENT_ID)?.session;
		session?.emitNotice("warning", text, SUBAGENT_OVERDUE_MESSAGE_TYPE);
	}
}
