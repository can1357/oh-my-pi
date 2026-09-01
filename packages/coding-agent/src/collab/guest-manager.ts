/**
 * Host-side guest state machine for collab sessions.
 *
 * {@link GuestRegistry} owns every {@link GuestIdentity} in the room: attach
 * on hello, detach on peer-left, role/permission mutations with an
 * append-only audit trail (capped), and pending invitations consumed by the
 * next matching hello. `CollabHost` maps registry events onto wire frames.
 *
 * Identity semantics: `guestId` is client-generated and survives reconnects
 * within the same host session (host memory only — no disk persistence);
 * `peerId` is the relay's ephemeral routing id and changes on reconnect.
 * Legacy proto-3 guests get a synthesized `peer-<peerId>` id and the exact
 * pre-4 permission surface, so upgrading the host never changes their
 * behavior.
 */
import {
	GUEST_PERMISSIONS,
	type GuestCapabilities,
	type GuestIdentity,
	type GuestPermissionSet,
	type GuestRole,
	type GuestStatus,
	LEGACY_FULL_PERMISSIONS,
	type PermissionAuditEntry,
	ROLE_DEFAULT_PERMISSIONS,
} from "@oh-my-pi/pi-wire";

const MAX_AUDIT_ENTRIES = 1000;
const GUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/** Every state change guests can observe, mirrored by the host as wire frames. */
export type GuestRegistryEvent =
	| { type: "guest-joined"; guest: GuestIdentity }
	| { type: "guest-left"; guestId: string; reason?: string }
	| { type: "guest-role-changed"; guestId: string; role: GuestRole; by: string }
	| { type: "guest-permission-changed"; guestId: string; permissionsSet: GuestPermissionSet }
	| { type: "guest-presence-changed"; guestId: string; status: GuestStatus };

interface PendingInvite {
	/** Matched case-insensitively against the joining guest's display name. */
	nameKey: string;
	role: GuestRole;
	permissionsOverride?: GuestPermissionSet;
	invitedBy: string;
	at: number;
}

interface GuestOverrides {
	grant: GuestPermissionSet;
	revoke: GuestPermissionSet;
}

/** `"PROMPT|AGENT_CHAT"`-style detail strings for audit entries. */
export function permissionNames(bits: GuestPermissionSet): string {
	return Object.entries(GUEST_PERMISSIONS)
		.filter(([, flag]) => (bits & flag) !== 0)
		.map(([name]) => name)
		.join("|");
}

export interface AttachResult {
	identity: GuestIdentity;
	/** True when this hello created a fresh identity (vs reattaching a known one). */
	created: boolean;
	/** True when the join consumed a pending invitation. */
	invited: boolean;
}

export type AttachError = { error: "kicked" };

export class GuestRegistry {
	#guests = new Map<string, GuestIdentity>();
	#peers = new Map<number, string>();
	/** Role → default-permission override (host-only, affects future effective sets). */
	#roleOverrides = new Map<GuestRole, GuestPermissionSet>();
	#overrides = new Map<string, GuestOverrides>();
	#invites = new Map<string, PendingInvite>();
	#kicked = new Set<string>();
	#audit: PermissionAuditEntry[] = [];
	#handlers = new Set<(event: GuestRegistryEvent) => void>();

	/** Subscribe to every registry event; returns an unsubscribe function. */
	on(handler: (event: GuestRegistryEvent) => void): () => void {
		this.#handlers.add(handler);
		return () => {
			this.#handlers.delete(handler);
		};
	}

	#emit(event: GuestRegistryEvent): void {
		for (const handler of this.#handlers) handler(event);
	}

	// ── Lookup ────────────────────────────────────────────────────────────────

	byId(guestId: string): GuestIdentity | undefined {
		return this.#guests.get(guestId);
	}

	byPeer(peerId: number): GuestIdentity | undefined {
		const guestId = this.#peers.get(peerId);
		return guestId ? this.#guests.get(guestId) : undefined;
	}

	list(): GuestIdentity[] {
		return [...this.#guests.values()].sort((a, b) => a.joinedAt - b.joinedAt);
	}

	get size(): number {
		return this.#guests.size;
	}

	/** Guests currently holding a relay peer (connected right now). */
	onlineCount(): number {
		let count = 0;
		for (const identity of this.#guests.values()) {
			if (identity.peerId >= 0) count++;
		}
		return count;
	}

	isKicked(guestId: string): boolean {
		return this.#kicked.has(guestId);
	}

	hasPermissionForPeer(peerId: number, flag: GuestPermissionSet): boolean {
		const identity = this.byPeer(peerId);
		if (!identity) return false;
		return (this.effectivePermissions(identity) & flag) !== 0;
	}

	/** Role defaults (with host overrides) plus per-guest grant/revoke bits. */
	effectivePermissions(identity: GuestIdentity): GuestPermissionSet {
		// Legacy proto-3 guests keep the exact pre-4 surface regardless of role
		// plumbing: full-link = old mutating grammar, view-link = read-only.
		if (identity.capabilities.protocolVersion < 4) {
			return identity.canWrite ? LEGACY_FULL_PERMISSIONS : GUEST_PERMISSIONS.FETCH_TRANSCRIPT;
		}
		const base = this.#roleOverrides.get(identity.role) ?? ROLE_DEFAULT_PERMISSIONS[identity.role];
		const override = this.#overrides.get(identity.id);
		return (base | (override?.grant ?? 0)) & ~(override?.revoke ?? 0) & 0x1fffffff;
	}

	getRolePermissions(role: GuestRole): GuestPermissionSet {
		return this.#roleOverrides.get(role) ?? ROLE_DEFAULT_PERMISSIONS[role];
	}

	// ── Join / leave ─────────────────────────────────────────────────────────

	/**
	 * Attach a relay peer to a guest identity. Reattaches when the client
	 * presents a known `guestId` (reconnect: identity, role, and permission
	 * overrides survive), otherwise consults pending invitations by name and
	 * finally falls back to link-derived defaults (`member` for full links,
	 * `viewer` for view links). Both paths emit `guest-joined` with the
	 * final identity state, so subscribers never need to special-case
	 * reconnects.
	 */
	attach(opts: {
		peerId: number;
		name: string;
		proto: number;
		canWrite: boolean;
		guestId?: string;
		capabilities?: GuestCapabilities;
	}): AttachResult | AttachError {
		const now = Date.now();
		// No capability block in the hello: the client predates (or bypasses)
		// the proto-4 handshake, so serve the pre-4 legacy surface regardless
		// of the declared protocol version.
		const capabilities: GuestCapabilities = opts.capabilities ?? {
			protocolVersion: 3,
			supportsGuestChat: false,
			supportsPresence: false,
			supportsCursors: false,
		};
		const guestId = opts.guestId && GUEST_ID_RE.test(opts.guestId) ? opts.guestId : this.#syntheticId(opts.peerId);

		const existing = this.#guests.get(guestId);
		if (existing) {
			if (this.#kicked.has(guestId)) return { error: "kicked" };
			// Reconnect: same identity, new pipe. The guest-joined event doubles
			// as the "peer is back online" signal for other guests.
			this.#peers.delete(existing.peerId);
			existing.peerId = opts.peerId;
			existing.name = opts.name;
			existing.canWrite = opts.canWrite;
			existing.capabilities = capabilities;
			existing.status = "online";
			existing.lastActive = now;
			this.#peers.set(opts.peerId, guestId);
			this.#emit({ type: "guest-joined", guest: existing });
			return { identity: existing, created: false, invited: false };
		}

		const invite = this.#invites.get(opts.name.trim().toLowerCase());
		const role: GuestRole = invite ? invite.role : opts.canWrite ? "member" : "viewer";
		const identity: GuestIdentity = {
			id: guestId,
			peerId: opts.peerId,
			name: opts.name,
			role,
			status: "online",
			canWrite: opts.canWrite,
			capabilities,
			joinedAt: now,
			lastActive: now,
			...(invite?.invitedBy ? { invitedBy: invite.invitedBy } : {}),
		};
		this.#guests.set(guestId, identity);
		this.#peers.set(opts.peerId, guestId);
		if (invite) {
			this.#invites.delete(invite.nameKey);
			if (invite.permissionsOverride) {
				this.#overrides.set(guestId, { grant: invite.permissionsOverride, revoke: 0 });
			}
		}
		this.#emit({ type: "guest-joined", guest: identity });
		return { identity, created: true, invited: !!invite };
	}

	/** Detach a relay peer; the identity stays for reconnect (status offline). */
	detachPeer(peerId: number, reason?: string): GuestIdentity | null {
		const guestId = this.#peers.get(peerId);
		if (!guestId) return null;
		this.#peers.delete(peerId);
		const identity = this.#guests.get(guestId);
		if (!identity || identity.peerId !== peerId) return null;
		identity.peerId = -1;
		identity.status = "offline";
		identity.lastActive = Date.now();
		this.#emit({ type: "guest-left", guestId, reason });
		return identity;
	}

	/** Bump {@link GuestIdentity.lastActive} on any frame from the peer. */
	touch(peerId: number): void {
		const identity = this.byPeer(peerId);
		if (identity) identity.lastActive = Date.now();
	}

	// ── Invitations ──────────────────────────────────────────────────────────

	/**
	 * Record a pending invitation. The next hello whose display name matches
	 * (case-insensitive) joins with the invited role and permission bits.
	 */
	invite(name: string, role: GuestRole, actorId: string, permissionsOverride?: GuestPermissionSet): PendingInvite {
		const nameKey = name.trim().toLowerCase();
		const entry: PendingInvite = { nameKey, role, permissionsOverride, invitedBy: actorId, at: Date.now() };
		this.#invites.set(nameKey, entry);
		this.#pushAudit({ at: Date.now(), actorId, action: "invite", detail: `${name.trim()} as ${role}` });
		return entry;
	}

	get pendingInviteCount(): number {
		return this.#invites.size;
	}

	// ── Mutations ────────────────────────────────────────────────────────────

	/** Disconnect and permanently reject a guestId for this session. */
	kick(guestId: string, actorId: string, reason?: string): GuestIdentity | null {
		const identity = this.#guests.get(guestId);
		if (!identity) return null;
		this.#kicked.add(guestId);
		if (identity.peerId >= 0) this.detachPeer(identity.peerId, reason ?? "kicked");
		this.#pushAudit({ at: Date.now(), actorId, action: "kick", target: guestId, detail: reason ?? "kicked" });
		return identity;
	}

	setRole(guestId: string, role: GuestRole, actorId: string): GuestIdentity | null {
		const identity = this.#guests.get(guestId);
		if (!identity || identity.role === role) return identity ?? null;
		const previous = identity.role;
		identity.role = role;
		this.#pushAudit({
			at: Date.now(),
			actorId,
			action: "role-change",
			target: guestId,
			detail: `${previous} -> ${role}`,
		});
		this.#emit({ type: "guest-role-changed", guestId, role, by: actorId });
		this.#emitPermissions(guestId);
		return identity;
	}

	setRolePermissions(role: GuestRole, permissions: GuestPermissionSet): void {
		this.#roleOverrides.set(role, permissions & 0x1fffffff);
		// Re-broadcast effective sets for every guest whose role defaults moved.
		for (const identity of this.#guests.values()) {
			if (identity.role === role && identity.capabilities.protocolVersion >= 4) {
				this.#emitPermissions(identity.id);
			}
		}
	}

	grantPermission(guestId: string, bits: GuestPermissionSet, actorId: string): GuestIdentity | null {
		const identity = this.#guests.get(guestId);
		if (!identity || bits === 0) return identity ?? null;
		const override = this.#overrides.get(guestId) ?? { grant: 0, revoke: 0 };
		override.grant |= bits;
		override.revoke &= ~bits;
		this.#overrides.set(guestId, override);
		this.#pushAudit({ at: Date.now(), actorId, action: "grant", target: guestId, detail: permissionNames(bits) });
		this.#emitPermissions(guestId);
		return identity;
	}

	revokePermission(guestId: string, bits: GuestPermissionSet, actorId: string): GuestIdentity | null {
		const identity = this.#guests.get(guestId);
		if (!identity || bits === 0) return identity ?? null;
		const override = this.#overrides.get(guestId) ?? { grant: 0, revoke: 0 };
		override.revoke |= bits;
		override.grant &= ~bits;
		this.#overrides.set(guestId, override);
		this.#pushAudit({ at: Date.now(), actorId, action: "revoke", target: guestId, detail: permissionNames(bits) });
		this.#emitPermissions(guestId);
		return identity;
	}

	/** Drop per-guest overrides; the guest falls back to its role defaults. */
	clearGuestOverrides(guestId: string, actorId: string): GuestIdentity | null {
		const identity = this.#guests.get(guestId);
		if (!identity || !this.#overrides.delete(guestId)) return identity ?? null;
		this.#pushAudit({ at: Date.now(), actorId, action: "revoke", target: guestId, detail: "overrides cleared" });
		this.#emitPermissions(guestId);
		return identity;
	}

	updateStatus(peerId: number, status: GuestStatus): GuestIdentity | null {
		const identity = this.byPeer(peerId);
		if (!identity) return null;
		if (identity.status === status) return identity;
		identity.status = status;
		identity.lastActive = Date.now();
		this.#emit({ type: "guest-presence-changed", guestId: identity.id, status });
		return identity;
	}

	// ── Audit ────────────────────────────────────────────────────────────────

	auditLog(guestId?: string, limit?: number): PermissionAuditEntry[] {
		let entries = this.#audit;
		if (guestId) entries = entries.filter(entry => entry.target === guestId || entry.actorId === guestId);
		return limit !== undefined && limit < entries.length ? entries.slice(-limit) : [...entries];
	}

	/** JSONL export, oldest first. */
	exportAuditLog(): string {
		return this.#audit.map(entry => JSON.stringify(entry)).join("\n");
	}

	/** Drop every guest, invite, override, and audit record (session teardown). */
	clear(): void {
		this.#guests.clear();
		this.#peers.clear();
		this.#roleOverrides.clear();
		this.#overrides.clear();
		this.#invites.clear();
		this.#kicked.clear();
		this.#audit = [];
	}

	// ── Internals ────────────────────────────────────────────────────────────

	#syntheticId(peerId: number): string {
		return `peer-${peerId}`;
	}

	#emitPermissions(guestId: string): void {
		const identity = this.#guests.get(guestId);
		if (!identity) return;
		this.#emit({ type: "guest-permission-changed", guestId, permissionsSet: this.effectivePermissions(identity) });
	}

	#pushAudit(entry: PermissionAuditEntry): void {
		this.#audit.push(entry);
		if (this.#audit.length > MAX_AUDIT_ENTRIES) {
			this.#audit.splice(0, this.#audit.length - MAX_AUDIT_ENTRIES);
		}
	}
}
