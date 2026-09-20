import type { OmpTokenomicsBridge } from "../rlm/tokenomics-bridge";
import type { RlmMetrics } from "../rlm/store";
import { getContextFlowRegistry } from "./registry";

export interface ContextFlowEmitterHost {
	getTokenomicsBridge?: () => OmpTokenomicsBridge | undefined;
}

const snapshotTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();

/** Coalesced mid-turn Tokenomics context snapshot (no JSONL polling). */
export function scheduleContextSnapshot(
	owner: object,
	metrics: Partial<RlmMetrics> & { grantedBytes?: number },
	bridge?: OmpTokenomicsBridge,
	delayMs = 50,
): void {
	const existing = snapshotTimers.get(owner);
	if (existing) clearTimeout(existing);
	if (!bridge?.enabled) return;
	const timer = setTimeout(() => {
		snapshotTimers.delete(owner);
		void bridge.emitContextSnapshot(metrics).catch(() => {});
	}, delayMs);
	snapshotTimers.set(owner, timer);
}

export function flushContextSnapshot(
	owner: ContextFlowEmitterHost,
	metrics: Partial<RlmMetrics> & { grantedBytes?: number },
): void {
	const pending = snapshotTimers.get(owner);
	if (pending) {
		clearTimeout(pending);
		snapshotTimers.delete(owner);
	}
	const bridge = owner.getTokenomicsBridge?.();
	if (!bridge?.enabled) return;
	void bridge.emitContextSnapshot(metrics).catch(() => {});
}

export function notifyContextFlowRevision(owner: object): number {
	return getContextFlowRegistry(owner).revision;
}
