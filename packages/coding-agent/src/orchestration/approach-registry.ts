/**
 * Blocked-route registry for orchestration portfolio tracking.
 */

import { createHash } from "node:crypto";

export type ApproachStatus =
	| "unexplored"
	| "active"
	| "promising"
	| "blocked"
	| "falsified"
	| "completed";

export interface ApproachRecord {
	readonly family: string;
	readonly mechanism: string;
	status: ApproachStatus;
	evidence: string[];
	blocker?: string;
	blockerFingerprint?: string;
	reopenCondition?: string;
}

export function computeBlockerFingerprint(family: string, blocker: string): string {
	return createHash("sha256").update(`${family}\0${blocker.trim()}`).digest("hex").slice(0, 16);
}

export class ApproachRegistry {
	readonly #records = new Map<string, ApproachRecord>();

	key(family: string, mechanism: string): string {
		return `${family.trim()}\0${mechanism.trim()}`;
	}

	get(family: string, mechanism: string): ApproachRecord | undefined {
		return this.#records.get(this.key(family, mechanism));
	}

	register(input: {
		readonly family: string;
		readonly mechanism: string;
		readonly status?: ApproachStatus;
		readonly evidence?: readonly string[];
	}): ApproachRecord {
		const key = this.key(input.family, input.mechanism);
		const existing = this.#records.get(key);
		if (existing) {
			if (input.status) existing.status = input.status;
			if (input.evidence) existing.evidence.push(...input.evidence);
			return existing;
		}
		const record: ApproachRecord = {
			family: input.family.trim(),
			mechanism: input.mechanism.trim(),
			status: input.status ?? "active",
			evidence: input.evidence ? [...input.evidence] : [],
		};
		this.#records.set(key, record);
		return record;
	}

	markBlocked(family: string, mechanism: string, blocker: string, reopenCondition?: string): ApproachRecord {
		const record = this.register({ family, mechanism });
		record.status = "blocked";
		record.blocker = blocker.trim();
		record.blockerFingerprint = computeBlockerFingerprint(family, blocker);
		if (reopenCondition) record.reopenCondition = reopenCondition.trim();
		return record;
	}

	hasBlockedFingerprint(family: string, fingerprint: string): boolean {
		for (const record of this.#records.values()) {
			if (record.family === family.trim() && record.blockerFingerprint === fingerprint) {
				return true;
			}
		}
		return false;
	}

	list(): readonly ApproachRecord[] {
		return [...this.#records.values()];
	}

	clear(): void {
		this.#records.clear();
	}
}

export function shouldRejectDuplicateBlockedSpawn(
	registry: ApproachRegistry,
	family: string | undefined,
	blockerFingerprint: string | undefined,
): boolean {
	if (!family?.trim() || !blockerFingerprint?.trim()) return false;
	return registry.hasBlockedFingerprint(family, blockerFingerprint);
}
