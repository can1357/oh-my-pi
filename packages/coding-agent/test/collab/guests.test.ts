/**
 * End-to-end contract for the proto-4 guest system over the in-memory relay:
 * welcome identity/roster/permissions, permission-gated mutations, guest chat
 * routing, invites, kicks, role/permission changes, the audit frame, legacy
 * proto-3 interop (old surface, never sent guest frames), and reconnect
 * identity stability. Real CollabHost + raw wire guests — only the TUI
 * context and the network transport are stubbed. No wall-clock waits: the
 * fake transport delivers on microtasks, so tests await real frames and
 * reason about causal order instead of sleeping.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import {
	COLLAB_PROTO,
	type CollabFrame,
	type CollabHostFrame,
	GUEST_PERMISSIONS,
	parseCollabLink,
	ROLE_DEFAULT_PERMISSIONS,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// ── Host harness (mirrors read-only.test.ts) ────────────────────────────────

interface HostHarness {
	ctx: InteractiveModeContext;
	prompts: { from?: string }[];
	nextPrompt(): Promise<{ from?: string }>;
}

function makeHostContext(): HostHarness {
	const prompts: { from?: string }[] = [];
	const promptWaiters: ((details: { from?: string }) => void)[] = [];
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "sess-guests",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-guests", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: (message: { details?: { from?: string } }) => {
				const details = message.details ?? {};
				prompts.push(details);
				for (const waiter of promptWaiters.splice(0)) waiter(details);
				return Promise.resolve();
			},
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		prompts,
		nextPrompt(): Promise<{ from?: string }> {
			const { promise, resolve } = Promise.withResolvers<{ from?: string }>();
			promptWaiters.push(resolve);
			return promise;
		},
	};
}

// ── Raw guest ───────────────────────────────────────────────────────────────

const FILTERED_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

interface TestGuest {
	socket: CollabSocket;
	guestId: string;
	next<T extends CollabHostFrame["t"]>(type: T): Promise<Extract<CollabHostFrame, { t: T }>>;
	/** Frames of `type` collected so far (inspect after a causally-later await). */
	ofType<T extends CollabHostFrame["t"]>(type: T): Extract<CollabHostFrame, { t: T }>[];
}

function makeGuest(socket: CollabSocket, guestId: string): TestGuest {
	const frames: CollabFrame[] = [];
	const waiters: { type: string; resolve: (frame: CollabFrame) => void }[] = [];
	socket.onFrame = frame => {
		if (FILTERED_FRAME_TYPES[frame.t]) return;
		const waiterIdx = waiters.findIndex(waiter => waiter.type === frame.t);
		if (waiterIdx >= 0) waiters.splice(waiterIdx, 1)[0].resolve(frame);
		else frames.push(frame);
	};
	return {
		socket,
		guestId,
		next<T extends CollabHostFrame["t"]>(type: T): Promise<Extract<CollabHostFrame, { t: T }>> {
			const idx = frames.findIndex(frame => frame.t === type);
			if (idx >= 0) return Promise.resolve(frames.splice(idx, 1)[0] as Extract<CollabHostFrame, { t: T }>);
			const { promise, resolve } = Promise.withResolvers<Extract<CollabHostFrame, { t: T }>>();
			waiters.push({ type, resolve: frame => resolve(frame as Extract<CollabHostFrame, { t: T }>) });
			return promise;
		},
		ofType<T extends CollabHostFrame["t"]>(type: T): Extract<CollabHostFrame, { t: T }>[] {
			return frames.filter((frame): frame is Extract<CollabHostFrame, { t: T }> => frame.t === type);
		},
	};
}

async function joinGuest(
	link: string,
	name: string,
	opts: { guestId?: string; proto?: number } = {},
): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const proto = opts.proto ?? COLLAB_PROTO;
	// Modern guests declare a stable client-generated id; legacy clients omit both fields.
	const guestId =
		proto >= 4 ? (opts.guestId ?? `g-${name.toLowerCase().replace(/[^a-z0-9_-]/g, "")}-0001`) : undefined;
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const guest = makeGuest(socket, guestId ?? name);
	socket.onOpen = () => {
		socket.send({
			t: "hello",
			proto,
			name,
			writeToken,
			...(proto >= 4
				? {
						guestId,
						capabilities: {
							protocolVersion: proto,
							supportsGuestChat: true,
							supportsPresence: true,
							supportsCursors: false,
						},
					}
				: {}),
		});
	};
	socket.connect();
	return guest;
}

// ── Shared host/relay ───────────────────────────────────────────────────────

let harness: HostHarness;
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	harness = makeHostContext();
	host = new CollabHost(harness.ctx);
	await host.start("ws://localhost:8788");
});

afterEach(() => {
	harness.prompts.length = 0;
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
});

/** Welcome-frame accessor with a narrowing guard. */
async function welcomeOf(guest: TestGuest): Promise<Extract<CollabHostFrame, { t: "welcome" }>> {
	const frame = await guest.next("welcome");
	if (frame.t !== "welcome") throw new Error(`expected welcome, got ${frame.t}`);
	return frame;
}

describe("collab proto-4 guests", () => {
	it("welcomes guests with identity, roster, and effective permissions", async () => {
		const alice = await joinGuest(host.link, "alice");
		const welcome = await welcomeOf(alice);
		expect(welcome.readOnly).toBeUndefined();
		expect(welcome.self?.name).toBe("alice");
		expect(welcome.self?.role).toBe("member");
		expect(welcome.permissionsSet).toBe(ROLE_DEFAULT_PERMISSIONS.member);
		expect(welcome.guests?.some(identity => identity.id === welcome.self?.id)).toBe(true);
		expect(host.participants.find(p => p.name === "alice")?.readOnly).toBeUndefined();
	});

	it("denies viewer prompts but still allows guest chat", async () => {
		const viewer = await joinGuest(host.viewLink, "vera");
		const welcome = await welcomeOf(viewer);
		expect(welcome.self?.role).toBe("viewer");
		expect(welcome.permissionsSet).toBe(ROLE_DEFAULT_PERMISSIONS.viewer);

		// The chat goes out first; a prompt denial is the causally-later reply,
		// so any chat error would have been queued before it.
		viewer.socket.send({ t: "guest-message", to: "broadcast", text: "anyone there?" });
		viewer.socket.send({ t: "prompt", text: "let me in" });
		const denial = await viewer.next("error");
		expect(denial.message).toContain("PROMPT");
		expect(viewer.ofType("error")).toEqual([]);
		expect(harness.prompts).toHaveLength(0);
	});

	it("routes guest chat without echoing the sender", async () => {
		const alice = await joinGuest(host.link, "alicia");
		const bob = await joinGuest(host.link, "bruno");
		const aliceId = (await welcomeOf(alice)).self?.id;
		const bobId = (await welcomeOf(bob)).self?.id;
		if (!aliceId || !bobId) throw new Error("missing identities");
		// alice also observes bruno's join broadcast.
		expect((await alice.next("guest-joined")).guest.id).toBe(bobId);

		alice.socket.send({ t: "guest-message", to: "broadcast", text: "hello room" });
		const broadcast = await bob.next("guest-message");
		expect(broadcast.from.name).toBe("alicia");
		expect(broadcast.text).toBe("hello room");
		expect(broadcast.kind).toBe("chat");
		// bob's copy proves the host fanned the broadcast out; alice got none.
		expect(alice.ofType("guest-message")).toEqual([]);

		bob.socket.send({ t: "guest-message", to: aliceId, text: "hi alice" });
		const direct = await alice.next("guest-message");
		expect(direct.from.id).toBe(bobId);
		expect(direct.to).toBe(aliceId);
	});

	it("applies a pending invite when the named guest joins", async () => {
		host.inviteGuest("cara", "admin");
		const cara = await joinGuest(host.link, "cara");
		const welcome = await welcomeOf(cara);
		expect(welcome.self?.role).toBe("admin");
		expect(welcome.permissionsSet).toBe(ROLE_DEFAULT_PERMISSIONS.admin);
		// Admins can kick: the frame is accepted past the permission gate.
		cara.socket.send({ t: "guest-kick", guestId: "nobody-here-1" });
		expect((await cara.next("error")).message).toContain("no such guest");
	});

	it("kicks guests, notifies the room, and quarantines the id", async () => {
		const dave = await joinGuest(host.link, "dave");
		const erin = await joinGuest(host.link, "erin");
		const daveId = (await welcomeOf(dave)).self?.id;
		await welcomeOf(erin);
		if (!daveId) throw new Error("missing dave identity");

		expect(host.kickGuest("dave", "spam")).toBe(daveId);
		const bye = await dave.next("bye");
		expect(bye.reason).toContain("removed by the host");
		expect(bye.reason).toContain("spam");
		const left = await erin.next("guest-left");
		expect(left.guestId).toBe(daveId);

		// Same id trying to rejoin is refused outright.
		dave.socket.close();
		const dave2 = await joinGuest(host.link, "dave", { guestId: daveId });
		const refused = await dave2.next("bye");
		expect(refused.reason).toBe("removed from this session");
	});

	it("propagates role changes and enforces them", async () => {
		const frank = await joinGuest(host.link, "frank");
		await welcomeOf(frank);
		expect(host.setGuestRole("frank", "viewer")).not.toBeNull();

		const roleFrame = await frank.next("guest-role-changed");
		expect(roleFrame.role).toBe("viewer");
		expect(roleFrame.by).toBe("host");
		const permsFrame = await frank.next("guest-permission-changed");
		expect(permsFrame.permissionsSet).toBe(ROLE_DEFAULT_PERMISSIONS.viewer);

		frank.socket.send({ t: "prompt", text: "still allowed?" });
		expect((await frank.next("error")).message).toContain("PROMPT");
		expect(harness.prompts).toHaveLength(0);
	});

	it("grants and revokes individual permission bits", async () => {
		const gina = await joinGuest(host.viewLink, "gina");
		await welcomeOf(gina);

		host.grantGuestPermissions("gina", GUEST_PERMISSIONS.PROMPT);
		const granted = await gina.next("guest-permission-changed");
		expect(granted.permissionsSet & GUEST_PERMISSIONS.PROMPT).toBe(GUEST_PERMISSIONS.PROMPT);

		const prompted = harness.nextPrompt();
		gina.socket.send({ t: "prompt", text: "granted prompt" });
		expect(await prompted).toEqual({ from: "gina" });

		host.revokeGuestPermissions("gina", GUEST_PERMISSIONS.PROMPT);
		const revoked = await gina.next("guest-permission-changed");
		expect(revoked.permissionsSet & GUEST_PERMISSIONS.PROMPT).toBe(0);
		gina.socket.send({ t: "prompt", text: "revoked again" });
		expect((await gina.next("error")).message).toContain("PROMPT");
	});

	it("serves the permission audit only to PERMISSION_MANAGE holders", async () => {
		const hank = await joinGuest(host.link, "hank");
		await welcomeOf(hank);

		hank.socket.send({ t: "permission-audit", reqId: 1 });
		expect((await hank.next("error")).message).toContain("PERMISSION_MANAGE");

		host.grantGuestPermissions("hank", GUEST_PERMISSIONS.PERMISSION_MANAGE);
		await hank.next("guest-permission-changed");
		hank.socket.send({ t: "permission-audit", reqId: 2 });
		const audit = await hank.next("permission-audit");
		expect(audit.reqId).toBe(2);
		expect(audit.entries.length).toBeGreaterThanOrEqual(1);
	});

	it("broadcasts presence updates to other guests", async () => {
		const iris = await joinGuest(host.link, "iris");
		const jack = await joinGuest(host.link, "jack");
		const irisId = (await welcomeOf(iris)).self?.id;
		await welcomeOf(jack);
		if (!irisId) throw new Error("missing iris identity");

		iris.socket.send({ t: "guest-presence", status: "away" });
		const presence = await jack.next("guest-presence");
		expect(presence.guestId).toBe(irisId);
		expect(presence.status).toBe("away");
	});

	it("gives legacy proto-3 guests the old surface and never guest frames", async () => {
		const kate = await joinGuest(host.link, "kate", { proto: 3 });
		const welcome = await welcomeOf(kate);
		expect(welcome.self).toBeUndefined();
		expect(welcome.guests).toBeUndefined();
		expect(welcome.permissionsSet).toBeUndefined();
		expect(welcome.readOnly).toBeUndefined();

		// A modern guest joins after her; the legacy guest must not observe it.
		const leo = await joinGuest(host.link, "leo");
		await welcomeOf(leo);

		// Legacy full-link guests keep the pre-4 mutating surface. The prompt
		// reply is causally after leo's hello, so its arrival also proves no
		// guest-joined frame was ever routed to the legacy peer.
		const prompted = harness.nextPrompt();
		kate.socket.send({ t: "prompt", text: "legacy prompt" });
		expect(await prompted).toEqual({ from: "kate" });
		expect(kate.ofType("guest-joined")).toEqual([]);
	});

	it("keeps identity and role across reconnects", async () => {
		const mia = await joinGuest(host.link, "mia");
		const welcome = await welcomeOf(mia);
		const miaId = welcome.self?.id;
		if (!miaId) throw new Error("missing mia identity");

		const nick = await joinGuest(host.link, "nick");
		await welcomeOf(nick);

		mia.socket.close();
		expect(host.setGuestRole("mia", "admin")).not.toBeNull();

		const mia2 = await joinGuest(host.link, "mia", { guestId: miaId });
		const rejoin = await welcomeOf(mia2);
		expect(rejoin.self?.id).toBe(miaId);
		expect(rejoin.self?.role).toBe("admin");
		// The room learns she is back online.
		const back = await nick.next("guest-joined");
		expect(back.guest.id).toBe(miaId);
	});
});
