/**
 * Unit contract for the host-side {@link GuestRegistry}: identity attach /
 * reconnect semantics, kick quarantine, invitation consumption, role and
 * permission mutations with their event trail, and the legacy proto-3
 * permission surface. Pure state machine — no transport involved.
 */
import { describe, expect, it } from "bun:test";
import type { GuestRegistryEvent } from "@oh-my-pi/pi-coding-agent/collab/guest-manager";
import { GuestRegistry } from "@oh-my-pi/pi-coding-agent/collab/guest-manager";
import {
	GUEST_PERMISSIONS,
	LEGACY_FULL_PERMISSIONS,
	ROLE_DEFAULT_PERMISSIONS,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";

/** Minimal attach helper: modern chat-capable member by default. */
function attach(
	registry: GuestRegistry,
	peerId: number,
	name: string,
	opts: { proto?: number; canWrite?: boolean; guestId?: string } = {},
) {
	return registry.attach({
		peerId,
		name,
		proto: opts.proto ?? 4,
		canWrite: opts.canWrite ?? true,
		guestId: opts.guestId,
		capabilities: {
			protocolVersion: opts.proto ?? 4,
			supportsGuestChat: true,
			supportsPresence: true,
			supportsCursors: false,
		},
	});
}

/** Collect registry events while `run` executes. */
function collect(registry: GuestRegistry, run: () => unknown): GuestRegistryEvent[] {
	const events: GuestRegistryEvent[] = [];
	const off = registry.on(event => events.push(event));
	try {
		run();
	} finally {
		off();
	}
	return events;
}

describe("guest registry", () => {
	it("attaches fresh identities with link-derived roles and emits guest-joined", () => {
		const registry = new GuestRegistry();
		const result = attach(registry, 11, "alice");
		if ("error" in result) throw new Error("attach failed");
		expect(result.created).toBe(true);
		expect(result.identity.role).toBe("member");
		expect(result.identity.peerId).toBe(11);
		expect(result.identity.status).toBe("online");

		const events = collect(registry, () => {
			const view = attach(registry, 12, "bob", { canWrite: false });
			if ("error" in view) throw new Error("attach failed");
			expect(view.identity.role).toBe("viewer");
		});
		expect(events).toEqual([{ type: "guest-joined", guest: expect.objectContaining({ name: "bob" }) }]);
	});

	it("reattaches a known guestId: same identity, new pipe, guest-joined signal", () => {
		const registry = new GuestRegistry();
		const first = attach(registry, 11, "alice", { guestId: "alice-guest-01" });
		if ("error" in first) throw new Error("attach failed");
		const joinedAt = first.identity.joinedAt;

		const events = collect(registry, () => {
			const second = attach(registry, 42, "alice", { guestId: "alice-guest-01" });
			if ("error" in second) throw new Error("attach failed");
			expect(second.created).toBe(false);
			expect(second.identity.peerId).toBe(42);
			expect(second.identity.joinedAt).toBe(joinedAt);
			expect(registry.byPeer(11)).toBeUndefined();
			expect(registry.byPeer(42)?.id).toBe("alice-guest-01");
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "guest-joined", guest: { peerId: 42 } });
	});

	it("keeps role and permission overrides across reconnect", () => {
		const registry = new GuestRegistry();
		attach(registry, 11, "alice", { guestId: "alice-guest-01" });
		registry.setRole("alice-guest-01", "viewer", "host");
		registry.grantPermission("alice-guest-01", GUEST_PERMISSIONS.PROMPT, "host");
		registry.detachPeer(11);

		const again = attach(registry, 12, "alice", { guestId: "alice-guest-01" });
		if ("error" in again) throw new Error("attach failed");
		expect(again.identity.role).toBe("viewer");
		expect(registry.effectivePermissions(again.identity) & GUEST_PERMISSIONS.PROMPT).toBe(GUEST_PERMISSIONS.PROMPT);
	});

	it("quarantines kicked ids across reconnects", () => {
		const registry = new GuestRegistry();
		attach(registry, 11, "alice", { guestId: "alice-guest-01" });
		const events = collect(registry, () => registry.kick("alice-guest-01", "host", "spam"));
		expect(events).toEqual([{ type: "guest-left", guestId: "alice-guest-01", reason: "spam" }]);
		expect(registry.isKicked("alice-guest-01")).toBe(true);
		expect(attach(registry, 12, "alice", { guestId: "alice-guest-01" })).toEqual({ error: "kicked" });
	});

	it("consumes a pending invite when the named guest joins", () => {
		const registry = new GuestRegistry();
		expect(collect(registry, () => registry.invite("Alice", "admin", "host"))).toEqual([]);
		expect(registry.pendingInviteCount).toBe(1);

		const joined = attach(registry, 11, "  alice ");
		if ("error" in joined) throw new Error("attach failed");
		expect(joined.created).toBe(true);
		expect(joined.invited).toBe(true);
		expect(joined.identity.role).toBe("admin");
		expect(registry.pendingInviteCount).toBe(0);
	});

	it("serves legacy proto-3 guests the exact pre-4 permission surface", () => {
		const registry = new GuestRegistry();
		const full = attach(registry, 11, "writer", { proto: 3 });
		const view = attach(registry, 12, "watcher", { proto: 3, canWrite: false });
		if ("error" in full || "error" in view) throw new Error("attach failed");
		expect(registry.effectivePermissions(full.identity)).toBe(LEGACY_FULL_PERMISSIONS);
		expect(registry.effectivePermissions(view.identity)).toBe(GUEST_PERMISSIONS.FETCH_TRANSCRIPT);
		// Role mutations must not leak into the legacy surface.
		registry.setRole(full.identity.id, "viewer", "host");
		expect(registry.effectivePermissions(full.identity)).toBe(LEGACY_FULL_PERMISSIONS);
	});

	it("emits role and permission changes with re-broadcast effective sets", () => {
		const registry = new GuestRegistry();
		const alice = attach(registry, 11, "alice", { guestId: "alice-guest-01" });
		if ("error" in alice) throw new Error("attach failed");

		const events = collect(registry, () => {
			registry.setRole("alice-guest-01", "viewer", "host");
			registry.grantPermission("alice-guest-01", GUEST_PERMISSIONS.PROMPT, "admin-1");
			registry.revokePermission("alice-guest-01", GUEST_PERMISSIONS.GUEST_CHAT, "admin-1");
		});
		// setRole emits the role change plus a re-broadcast of the effective set;
		// each grant/revoke re-broadcasts too.
		expect(events.map(event => event.type)).toEqual([
			"guest-role-changed",
			"guest-permission-changed",
			"guest-permission-changed",
			"guest-permission-changed",
		]);
		const effective = registry.effectivePermissions(alice.identity);
		expect(effective & GUEST_PERMISSIONS.PROMPT).toBe(GUEST_PERMISSIONS.PROMPT);
		expect(effective & GUEST_PERMISSIONS.GUEST_CHAT).toBe(0);

		registry.clearGuestOverrides("alice-guest-01", "host");
		expect(registry.effectivePermissions(alice.identity)).toBe(ROLE_DEFAULT_PERMISSIONS.viewer);
	});

	it("tracks presence and detaches peers without dropping identity", () => {
		const registry = new GuestRegistry();
		const alice = attach(registry, 11, "alice");
		if ("error" in alice) throw new Error("attach failed");
		expect(registry.onlineCount()).toBe(1);

		const events = collect(registry, () => {
			expect(registry.updateStatus(11, "away")).not.toBeNull();
			const detached = registry.detachPeer(11, "bye");
			expect(detached?.id).toBe(alice.identity.id);
		});
		expect(events).toEqual([
			{ type: "guest-presence-changed", guestId: alice.identity.id, status: "away" },
			{ type: "guest-left", guestId: alice.identity.id, reason: "bye" },
		]);
		expect(registry.onlineCount()).toBe(0);
		expect(registry.byId(alice.identity.id)?.status).toBe("offline");
		expect(registry.size).toBe(1);
	});

	it("keeps an append-only audit trail for permission-affecting actions", () => {
		const registry = new GuestRegistry();
		attach(registry, 11, "alice", { guestId: "alice-guest-01" });
		const bob = attach(registry, 12, "bob", { canWrite: false });
		if ("error" in bob) throw new Error("attach failed");

		registry.invite("carol", "member", "alice-guest-01");
		registry.setRole("alice-guest-01", "admin", "host");
		registry.grantPermission("alice-guest-01", GUEST_PERMISSIONS.ABORT, "host");
		registry.kick(bob.identity.id, "alice-guest-01", "noise");

		const entries = registry.auditLog();
		expect(entries.map(entry => entry.action)).toEqual(["invite", "role-change", "grant", "kick"]);
		expect(entries[2]).toMatchObject({ actorId: "host", target: "alice-guest-01", detail: "ABORT" });
		expect(entries[3]).toMatchObject({ actorId: "alice-guest-01", target: bob.identity.id, detail: "noise" });
		// Per-guest view: entries where alice is actor or target.
		expect(registry.auditLog("alice-guest-01")).toHaveLength(4);
	});
});
