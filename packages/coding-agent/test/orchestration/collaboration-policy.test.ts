import { describe, expect, test } from "bun:test";
import {
	authorizeIrcDelivery,
	canDiscoverPeer,
	DEFAULT_COLLABORATION_POLICY,
	hydrateCollaborationPolicy,
	resolveCollaborationPolicy,
	serializeCollaborationPolicy,
} from "../../src/orchestration/collaboration-policy";

describe("collaboration-policy", () => {
	test("no-policy legacy defaults preserve independent swarm behavior", () => {
		const policy = resolveCollaborationPolicy(null);
		expect(policy).toEqual(DEFAULT_COLLABORATION_POLICY);
		expect(canDiscoverPeer(undefined, "Main", "LaneB")).toBe(true);
		expect(authorizeIrcDelivery(undefined, { fromId: "Main", toId: "LaneB", requiresWake: true }).allow).toBe(true);
	});

	test("report-only cannot discover/message/broadcast/wake outside parent", () => {
		const policy = resolveCollaborationPolicy({
			mode: "report-only",
			parentId: "Main",
		});

		expect(canDiscoverPeer(policy, "Child", "Main")).toBe(true);
		expect(canDiscoverPeer(policy, "Child", "Peer")).toBe(false);

		expect(authorizeIrcDelivery(policy, { fromId: "Child", toId: "*", isBroadcast: true }).reasonCode).toBe(
			"report-only-no-broadcast",
		);
		expect(authorizeIrcDelivery(policy, { fromId: "Child", toId: "Peer" }).reasonCode).toBe(
			"report-only-parent-only",
		);
		expect(authorizeIrcDelivery(policy, { fromId: "Child", toId: "Main", requiresWake: true }).reasonCode).toBe(
			"report-only-no-wake",
		);
		expect(authorizeIrcDelivery(policy, { fromId: "Child", toId: "Main", busyModelReply: true }).reasonCode).toBe(
			"report-only-no-busy-reply",
		);
		expect(authorizeIrcDelivery(policy, { fromId: "Child", toId: "Main" }).allow).toBe(true);
	});

	test("message-peers authorizes declared peers and checks wake budget before consume", () => {
		const policy = resolveCollaborationPolicy({
			mode: "message-peers",
			allowedPeers: ["LaneB", "LaneD"],
			parentId: "Main",
			wakeBudget: 2,
		});

		expect(canDiscoverPeer(policy, "LaneC", "LaneB")).toBe(true);
		expect(canDiscoverPeer(policy, "LaneC", "Stranger")).toBe(false);

		const allowed = authorizeIrcDelivery(policy, {
			fromId: "LaneC",
			toId: "LaneB",
			requiresWake: true,
			remainingWakeBudget: 2,
		});
		expect(allowed.allow).toBe(true);
		expect(allowed.wouldWake).toBe(true);

		const exhausted = authorizeIrcDelivery(policy, {
			fromId: "LaneC",
			toId: "LaneB",
			requiresWake: true,
			remainingWakeBudget: 0,
		});
		expect(exhausted.allow).toBe(false);
		expect(exhausted.reasonCode).toBe("wake-budget-exhausted");
	});

	test("self-coordinate preserves flat independent behavior unless narrowed", () => {
		const policy = resolveCollaborationPolicy({ mode: "self-coordinate" });
		expect(policy.peerScope).toBe("all");
		expect(policy.allowBusyModelReply).toBe(true);
		expect(canDiscoverPeer(policy, "A", "B")).toBe(true);
		expect(authorizeIrcDelivery(policy, { fromId: "A", toId: "B", requiresWake: true }).allow).toBe(true);
	});

	test("serialize/hydrate is lossless for cold revival", () => {
		const policy = resolveCollaborationPolicy({
			mode: "message-peers",
			peerScope: "family",
			allowedPeers: ["LaneB"],
			wakePolicy: "queue",
			wakeBudget: 3,
			allowBusyModelReply: false,
			parentId: "Main",
			familyIds: ["LaneB", "LaneD"],
		});

		const persisted = serializeCollaborationPolicy(policy);
		const restored = hydrateCollaborationPolicy(persisted);
		expect(restored).toEqual(policy);
		expect(persisted.version).toBe(1);
	});
});
