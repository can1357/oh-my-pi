/**
 * Persisted collaboration authorization primitives.
 *
 * Pure decisions only — Lane E wires AgentRegistry visibility, IrcBus
 * pre-wake checks, AgentSession side-channel behavior, and cold revive.
 */

import type { CollaborationMode } from "./agent-execution-profile";
import type { ContextPolicy } from "./context-policy";

export type PeerScope = "parent" | "family" | "allowed" | "all";
export type WakePolicy = "deny" | "queue" | "allow";

export type CollaborationDecisionReason =
	| "allow"
	| "legacy-unrestricted"
	| "report-only-parent-only"
	| "report-only-no-broadcast"
	| "report-only-no-wake"
	| "report-only-no-busy-reply"
	| "peer-not-in-scope"
	| "wake-denied"
	| "wake-budget-exhausted"
	| "busy-reply-denied";

export interface CollaborationDecision {
	readonly allow: boolean;
	readonly reasonCode: CollaborationDecisionReason;
	/** True when a wake would be permitted; authorization never consumes budget. */
	readonly wouldWake: boolean;
}

export interface CollaborationPolicy {
	readonly mode: CollaborationMode;
	readonly peerScope: PeerScope;
	readonly allowedPeers: readonly string[];
	readonly wakePolicy: WakePolicy;
	readonly wakeBudget: number;
	readonly allowBusyModelReply: boolean;
	readonly parentId?: string;
	readonly familyIds: readonly string[];
}

export interface CollaborationPolicyInput {
	mode?: CollaborationMode;
	peerScope?: PeerScope;
	allowedPeers?: readonly string[];
	wakePolicy?: WakePolicy;
	/** Soft wake budget; `0` means unlimited. */
	wakeBudget?: number;
	allowBusyModelReply?: boolean;
	parentId?: string;
	familyIds?: readonly string[];
}

/** Wire format restored before cold-revived visibility. */
export interface PersistedCollaborationPolicy {
	readonly version: 1;
	readonly mode: CollaborationMode;
	readonly peerScope: PeerScope;
	readonly allowedPeers: readonly string[];
	readonly wakePolicy: WakePolicy;
	readonly wakeBudget: number;
	readonly allowBusyModelReply: boolean;
	readonly parentId?: string;
	readonly familyIds: readonly string[];
}

/** No-policy legacy defaults — preserve today's independent-swarm behavior. */
export const DEFAULT_COLLABORATION_POLICY: CollaborationPolicy = Object.freeze({
	mode: "self-coordinate",
	peerScope: "all",
	allowedPeers: Object.freeze([] as string[]),
	wakePolicy: "allow",
	wakeBudget: 0,
	allowBusyModelReply: true,
	familyIds: Object.freeze([] as string[]),
});

function freezeStringList(values: readonly string[] | undefined): readonly string[] {
	return Object.freeze([...(values ?? [])].map(value => value.trim()).filter(Boolean));
}

function defaultsForMode(
	mode: CollaborationMode,
): Omit<CollaborationPolicy, "mode" | "parentId" | "familyIds" | "allowedPeers"> {
	switch (mode) {
		case "report-only":
			return {
				peerScope: "parent",
				wakePolicy: "deny",
				wakeBudget: 0,
				allowBusyModelReply: false,
			};
		case "message-peers":
			return {
				peerScope: "allowed",
				wakePolicy: "queue",
				wakeBudget: 8,
				allowBusyModelReply: false,
			};
		case "self-coordinate":
			return {
				peerScope: "all",
				wakePolicy: "allow",
				wakeBudget: 0,
				allowBusyModelReply: true,
			};
	}
}

export function resolveCollaborationPolicy(input: CollaborationPolicyInput | undefined | null): CollaborationPolicy {
	if (!input || input.mode === undefined) {
		// Explicit no-policy path preserves independent swarm defaults.
		if (!input) {
			return DEFAULT_COLLABORATION_POLICY;
		}
	}

	const mode = input.mode ?? DEFAULT_COLLABORATION_POLICY.mode;
	const modeDefaults = defaultsForMode(mode);

	return Object.freeze({
		mode,
		peerScope: input.peerScope ?? modeDefaults.peerScope,
		allowedPeers: freezeStringList(input.allowedPeers),
		wakePolicy: input.wakePolicy ?? modeDefaults.wakePolicy,
		wakeBudget: input.wakeBudget ?? modeDefaults.wakeBudget,
		allowBusyModelReply: input.allowBusyModelReply ?? modeDefaults.allowBusyModelReply,
		parentId: input.parentId?.trim() || undefined,
		familyIds: freezeStringList(input.familyIds),
	});
}

/**
 * Mechanically narrow collaboration for lanes whose context withholds sibling
 * findings, regardless of a caller's requested collaboration breadth.
 */
export function clampCollaborationPolicyForContext(
	policy: CollaborationPolicy,
	contextPolicy: ContextPolicy | undefined,
	options?: { siblingFindingsRevealed?: boolean },
): CollaborationPolicy {
	const blindEffective =
		contextPolicy === "blind" || (contextPolicy === "staged" && !options?.siblingFindingsRevealed);
	if (!blindEffective) return policy;

	return Object.freeze({
		mode: "report-only",
		peerScope: "parent",
		allowedPeers: Object.freeze([] as string[]),
		wakePolicy: "deny",
		wakeBudget: 0,
		allowBusyModelReply: false,
		parentId: policy.parentId,
		familyIds: policy.familyIds,
	});
}

function peerInAllowedList(policy: CollaborationPolicy, peerId: string): boolean {
	return policy.allowedPeers.includes(peerId);
}

function peerInFamily(policy: CollaborationPolicy, peerId: string): boolean {
	if (policy.parentId && peerId === policy.parentId) return true;
	return policy.familyIds.includes(peerId);
}

/**
 * Whether `viewerId` may discover `peerId` in roster/list APIs.
 */
export function canDiscoverPeer(
	policy: CollaborationPolicy | undefined | null,
	viewerId: string,
	peerId: string,
): boolean {
	if (!policy) return true;
	if (peerId === viewerId) return false;

	switch (policy.mode) {
		case "report-only":
			return Boolean(policy.parentId) && peerId === policy.parentId;
		case "message-peers":
			switch (policy.peerScope) {
				case "parent":
					return Boolean(policy.parentId) && peerId === policy.parentId;
				case "family":
					return peerInFamily(policy, peerId);
				case "allowed":
					return peerInAllowedList(policy, peerId) || (Boolean(policy.parentId) && peerId === policy.parentId);
				case "all":
					return true;
			}
			break;
		case "self-coordinate":
			switch (policy.peerScope) {
				case "parent":
					return Boolean(policy.parentId) && peerId === policy.parentId;
				case "family":
					return peerInFamily(policy, peerId);
				case "allowed":
					return peerInAllowedList(policy, peerId);
				case "all":
					return true;
			}
	}
	return false;
}

export interface IrcAuthorizationInput {
	fromId: string;
	toId: string | "*";
	/** True when delivery would require waking/reviving the recipient. */
	requiresWake?: boolean;
	/** Remaining wake budget before this decision; `0` means unlimited when policy.wakeBudget is 0. */
	remainingWakeBudget?: number;
	/** Recipient is mid-turn and would use busy-model auto-reply. */
	busyModelReply?: boolean;
	isBroadcast?: boolean;
}

function decidePeerReach(policy: CollaborationPolicy, fromId: string, toId: string): CollaborationDecision | null {
	if (canDiscoverPeer(policy, fromId, toId)) return null;
	return {
		allow: false,
		reasonCode: policy.mode === "report-only" ? "report-only-parent-only" : "peer-not-in-scope",
		wouldWake: false,
	};
}

/**
 * Authorize IRC delivery before any wake budget is consumed.
 * Decisions are deterministic and include a stable reason code.
 */
export function authorizeIrcDelivery(
	policy: CollaborationPolicy | undefined | null,
	input: IrcAuthorizationInput,
): CollaborationDecision {
	if (!policy) {
		return {
			allow: true,
			reasonCode: "legacy-unrestricted",
			wouldWake: Boolean(input.requiresWake),
		};
	}

	const isBroadcast = input.isBroadcast === true || input.toId === "*";

	if (policy.mode === "report-only") {
		if (isBroadcast) {
			return { allow: false, reasonCode: "report-only-no-broadcast", wouldWake: false };
		}
		if (input.busyModelReply) {
			return { allow: false, reasonCode: "report-only-no-busy-reply", wouldWake: false };
		}
		if (input.requiresWake) {
			return { allow: false, reasonCode: "report-only-no-wake", wouldWake: false };
		}
		if (!policy.parentId || input.toId !== policy.parentId) {
			return { allow: false, reasonCode: "report-only-parent-only", wouldWake: false };
		}
		return { allow: true, reasonCode: "allow", wouldWake: false };
	}

	if (isBroadcast) {
		if (policy.mode === "message-peers" && policy.peerScope !== "all") {
			return { allow: false, reasonCode: "peer-not-in-scope", wouldWake: false };
		}
	} else {
		const reach = decidePeerReach(policy, input.fromId, input.toId);
		if (reach) return reach;
	}

	if (input.busyModelReply && !policy.allowBusyModelReply) {
		return { allow: false, reasonCode: "busy-reply-denied", wouldWake: false };
	}

	if (input.requiresWake) {
		if (policy.wakePolicy === "deny") {
			return { allow: false, reasonCode: "wake-denied", wouldWake: false };
		}
		if (policy.wakeBudget > 0) {
			const remaining = input.remainingWakeBudget ?? policy.wakeBudget;
			if (remaining <= 0) {
				return { allow: false, reasonCode: "wake-budget-exhausted", wouldWake: false };
			}
		}
		return {
			allow: true,
			reasonCode: "allow",
			wouldWake: policy.wakePolicy === "allow" || policy.wakePolicy === "queue",
		};
	}

	return { allow: true, reasonCode: "allow", wouldWake: false };
}

export function serializeCollaborationPolicy(policy: CollaborationPolicy): PersistedCollaborationPolicy {
	return Object.freeze({
		version: 1 as const,
		mode: policy.mode,
		peerScope: policy.peerScope,
		allowedPeers: freezeStringList(policy.allowedPeers),
		wakePolicy: policy.wakePolicy,
		wakeBudget: policy.wakeBudget,
		allowBusyModelReply: policy.allowBusyModelReply,
		parentId: policy.parentId,
		familyIds: freezeStringList(policy.familyIds),
	});
}

export function hydrateCollaborationPolicy(
	persisted: PersistedCollaborationPolicy | null | undefined,
): CollaborationPolicy {
	if (!persisted) return DEFAULT_COLLABORATION_POLICY;
	return resolveCollaborationPolicy({
		mode: persisted.mode,
		peerScope: persisted.peerScope,
		allowedPeers: persisted.allowedPeers,
		wakePolicy: persisted.wakePolicy,
		wakeBudget: persisted.wakeBudget,
		allowBusyModelReply: persisted.allowBusyModelReply,
		parentId: persisted.parentId,
		familyIds: persisted.familyIds,
	});
}
