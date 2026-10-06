import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { IdleSubscriptions } from "../../src/messaging/idle";
import { InboundGate } from "../../src/messaging/inbound";
import * as mailbox from "../../src/messaging/mailbox";
import {
	claimSessionName,
	defaultSessionName,
	encodeAddressForUrl,
	formatAddressForUrl,
	isReservedAddress,
	sessionAddress,
	sessionShortId,
} from "../../src/messaging/names";
import type { PermissionClass } from "../../src/messaging/policy";
import {
	ACCEPTED_QUEUE_CAP,
	HELD_CAP,
	IDLE_SUBSCRIPTION_TTL_MS,
	type InboxRequest,
	MAX_SERIALIZED_CHARS,
	MESSAGING_WIRE_VERSION,
	type SenderInfo,
} from "../../src/messaging/protocol";
import {
	formatSessionListing,
	type HeldMessageView,
	type MessagingHost,
	MessagingService,
	type RemoteDelivery,
	type RemoteSender,
	type SessionListing,
} from "../../src/messaging/service";
import {
	cfgMessagingDialogExpiry,
	cfgMessagingInbound,
	cfgMessagingList,
	cfgMessagingRateLimit,
	cfgMessagingSend,
} from "../../src/messaging/settings";
import * as transport from "../../src/messaging/transport";
import type { SessionTitleSource } from "../../src/session/session-entries";
import { renderOtherSessionsSection } from "../../src/session/messaging-host";

class FakeHost implements MessagingHost {
	directPrint = false;
	name: string | undefined;
	source: SessionTitleSource | undefined = "user";
	busy = false;
	permission: PermissionClass = "bypass";
	pending = 0;
	chain: string[] = [];
	finished = { finishedAt: new Date(2026, 9, 5, 14, 7).getTime(), status: "Finished the change." as string | null };
	readonly deliveries: RemoteDelivery[] = [];
	readonly notices: string[] = [];
	readonly display: string[] = [];
	readonly events: string[] = [];
	readonly listeners = new Set<() => void>();
	readonly noticeWaiters: Array<(text: string) => void> = [];
	askApproval: ((view: HeldMessageView, signal: AbortSignal) => Promise<"approve" | "deny" | undefined>) | undefined;
	constructor(
		public id: string,
		name = id,
	) {
		this.name = name;
	}
	sessionId(): string {
		return this.id;
	}
	cwd(): string {
		return "/project";
	}
	sessionName(): string | undefined {
		return this.name;
	}
	titleSource(): SessionTitleSource | undefined {
		return this.source;
	}
	isBusy(): boolean {
		return this.busy;
	}
	permissionClass(): PermissionClass {
		return this.permission;
	}
	onPolicyInputsChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}
	pendingRemoteCount(): number {
		return this.pending;
	}
	deliverRemote(delivery: RemoteDelivery): void {
		this.deliveries.push(delivery);
		this.events.push(delivery.body);
		this.pending++;
	}
	showNotice(text: string): void {
		this.display.push(text);
	}
	deliverNotice(_from: RemoteSender, text: string): void {
		this.notices.push(text);
		this.events.push(text);
		this.noticeWaiters.shift()?.(text);
	}
	currentRelayChain(): readonly string[] {
		return this.chain;
	}
	lastFinished(): { finishedAt: number; status: string | null } {
		return this.finished;
	}
	reapply(): void {
		for (const cb of this.listeners) cb();
	}
	nextNotice(): Promise<string> {
		const deferred = Promise.withResolvers<string>();
		this.noticeWaiters.push(deferred.resolve);
		return deferred.promise;
	}
}

const realRequestInbox = transport.requestInbox;
const realListInboxEntries = transport.listInboxEntries;
const services: MessagingService[] = [];
const gates: InboundGate[] = [];
const subscriptions: IdleSubscriptions[] = [];
let temp: TempDir | undefined;

afterEach(async () => {
	for (const gate of gates.splice(0)) gate.close();
	for (const subscription of subscriptions.splice(0)) await subscription.close();
	await Promise.all(services.splice(0).map(service => service.close()));
	vi.useRealTimers();
	setSystemTime();
	vi.restoreAllMocks();
	temp?.[Symbol.dispose]();
	temp = undefined;
});

async function pair(ready = true): Promise<{
	a: MessagingService;
	b: MessagingService;
	ah: FakeHost;
	bh: FakeHost;
	as: Settings;
	bs: Settings;
	target: SessionListing;
}> {
	temp = TempDir.createSync("@omp-messaging-service-");
	const dir = temp.path();
	const publish = transport.publishInbox;
	const list = transport.listInboxEntries;
	const request = transport.requestInbox;
	vi.spyOn(transport, "publishInbox").mockImplementation((handler, options) => publish(handler, { ...options, dir }));
	vi.spyOn(transport, "listInboxEntries").mockImplementation(options => list({ ...options, dir }));
	vi.spyOn(transport, "requestInbox").mockImplementation((entry, payload, options) =>
		request(entry, payload, { ...options, dir }),
	);
	const enqueue = mailbox.enqueueOffline;
	const drain = mailbox.drainOffline;
	vi.spyOn(mailbox, "enqueueOffline").mockImplementation((id, message, options) =>
		enqueue(id, message, { ...options, dir }),
	);
	vi.spyOn(mailbox, "drainOffline").mockImplementation((id, options) => drain(id, { ...options, dir }));
	vi.spyOn(mailbox, "listOfflineSessions").mockResolvedValue([]);
	const ah = new FakeHost("a", "alpha");
	const bh = new FakeHost("b", "beta");
	const as = Settings.isolated({});
	const bs = Settings.isolated({});
	const a = await MessagingService.start(ah, as);
	services.push(a);
	const b = await MessagingService.start(bh, bs);
	services.push(b);
	if (ready) {
		a.markReady();
		b.markReady();
	}
	const target = (await a.listSessions())[0];
	return { a, b, ah, bh, as, bs, target };
}

const sender: SenderInfo = {
	name: "alpha",
	shortId: "aaaaaaaa",
	cwd: "/project",
	entryId: "sender-entry",
	class: "bypass",
};
function gateFixture(): { gate: InboundGate; host: FakeHost; settings: Settings; replies: InboxRequest[] } {
	const host = new FakeHost("receiver");
	const settings = Settings.isolated({});
	const replies: InboxRequest[] = [];
	const gate = new InboundGate(
		host,
		settings,
		() => "bbbbbbbb",
		async (_sender, notice) => {
			replies.push({ ...notice, id: "notice", from: sender });
		},
	);
	gates.push(gate);
	return { gate, host, settings, replies };
}
function message(body: string, chain?: string[]): Extract<InboxRequest, { type: "message" }> {
	return { type: "message", id: crypto.randomUUID(), from: sender, body, ...(chain ? { chain } : {}) };
}

const dropText: Record<string, string> = {
	queue_full: "its queue of undelivered peer messages was full",
	rate: "you sent faster than that session accepts",
	repeat: "it repeated your previous message",
	relay_loop: "a relay loop between sessions was cut",
};

describe("session names", () => {
	it("hashes, slugs, follows manual titles, and claims collisions", () => {
		expect(sessionShortId("abc")).toBe("ba7816bf");
		expect(defaultSessionName("/home/Release NOTES!", "abc")).toBe("release-notes-ba");
		expect(defaultSessionName("/???", "abc")).toBe("session-ba");
		expect(defaultSessionName(`/home/${"x".repeat(40)}`, "abc")).toBe(`${"x".repeat(32)}-ba`);
		const identity = {
			cwd: "/project",
			sessionId: "abc",
			sessionName: "Release notes",
			titleSource: "auto" as SessionTitleSource,
			directPrint: false,
		};
		expect(sessionAddress(identity)).toBe("project-ba");
		expect(sessionAddress({ ...identity, directPrint: true })).toBeNull();
		expect(sessionAddress({ ...identity, titleSource: "user", directPrint: true })).toBe("Release notes");
		expect(claimSessionName("release", new Set())).toBe("release");
		expect(claimSessionName("release", new Set(["release"]))).toMatch(/^release-[a-z]+-[a-z]+$/);
		expect(formatAddressForUrl("release notes/#")).toBe("release%20notes%2F%23");
		expect(encodeAddressForUrl("release notes")).toBe("release%20notes");
		expect(isReservedAddress("@ns/name")).toBe(true);
		expect(isReservedAddress("name@host")).toBe(false);
		expect(claimSessionName.bind(null, "@reserved", new Set<string>())).toThrow(
			'Session names can\'t start with "@" (reserved for extension peer namespaces).',
		);
		expect(sessionAddress({ ...identity, sessionName: "@reserved", titleSource: "user" })).toBe("project-ba");
		expect(
			sessionAddress({ ...identity, sessionName: "@reserved", titleSource: "user", directPrint: true }),
		).toBeNull();
	});
});

describe("inbound gate", () => {
	it("returns every drop reason in the prescribed first-failure order", () => {
		const { gate, host, settings } = gateFixture();
		expect(
			gate.receive(message("x".repeat(MAX_SERIALIZED_CHARS), ["bbbbbbbb", "bbbbbbbb", "bbbbbbbb"]), sender, false),
		).toEqual({ ok: false, error: "too_large" });
		expect(gate.receive(message("loop", ["bbbbbbbb", "bbbbbbbb", "bbbbbbbb"]), sender, false)).toEqual({
			ok: true,
			outcome: "dropped",
			reason: "relay_loop",
		});
		expect(gate.receive(message("hop-limit", Array(8).fill("cccccccc")), sender, false)).toEqual({
			ok: true,
			outcome: "dropped",
			reason: "relay_loop",
		});
		expect(gate.receive(message("first"), sender, false)).toEqual({ ok: true, outcome: "delivered" });
		expect(gate.receive(message("first"), sender, false)).toEqual({ ok: true, outcome: "dropped", reason: "repeat" });
		for (let i = 1; i < 30; i++)
			expect(gate.receive(message(`message-${i}`), sender, false)).toEqual({ ok: true, outcome: "delivered" });
		expect(gate.receive(message("31st"), sender, false)).toEqual({ ok: true, outcome: "dropped", reason: "rate" });
		cfgMessagingRateLimit.override(settings, 100);
		host.pending = ACCEPTED_QUEUE_CAP;
		expect(gate.receive(message("full"), sender, false)).toEqual({
			ok: true,
			outcome: "dropped",
			reason: "queue_full",
		});
		cfgMessagingInbound.override(settings, "refuse");
		expect(gate.receive(message("refusal-before-queue"), sender, false)).toEqual({ ok: true, outcome: "refused" });
	});

	it("accepts authenticated own children but treats unidentified peers as unknown", () => {
		const { gate, host } = gateFixture();
		const script: Extract<InboxRequest, { type: "message" }> = {
			type: "message",
			id: "script",
			body: "script content",
		};
		expect(gate.receive(script, sender, true)).toEqual({ ok: true, outcome: "delivered" });
		expect(gate.receive({ ...script, id: "peer", body: "unknown peer content" }, sender, false)).toEqual({
			ok: true,
			outcome: "held",
		});
		expect(host.deliveries).toHaveLength(1);
		expect(host.display).toEqual([]);
	});

	it.each(["peer", "own-child", "offline"] as const)("uses pre-delivery busy state for %s admissions", source => {
		const { gate, host } = gateFixture();
		const deliver = host.deliverRemote.bind(host);
		vi.spyOn(host, "deliverRemote").mockImplementation(delivery => {
			host.busy = true;
			deliver(delivery);
		});
		const request = message("wake receiver");
		const result =
			source === "offline"
				? gate.receiveOffline({
						id: request.id,
						from: sender,
						body: request.body,
						chain: [],
						sentAt: Date.now(),
					})
				: gate.receive(request, sender, source === "own-child");
		expect(result).toEqual({ ok: true, outcome: "delivered" });
		expect(host.busy).toBe(true);
		expect(host.deliveries).toHaveLength(1);
		expect(gate.receive(message("already busy"), sender, source === "own-child")).toEqual({
			ok: true,
			outcome: "queued",
		});
	});

	it.each([false, true])("drops nonconsecutive repeats when busy=%s without mixing senders", busy => {
		const { gate, host } = gateFixture();
		host.busy = busy;
		const outcome = busy ? "queued" : "delivered";
		expect(gate.receive(message("hello"), sender, false)).toEqual({ ok: true, outcome });
		expect(gate.receive(message("different"), sender, false)).toEqual({ ok: true, outcome });
		const otherSender = { ...sender, shortId: "cccccccc" };
		expect(gate.receive({ ...message("hello"), from: otherSender }, otherSender, false)).toEqual({
			ok: true,
			outcome,
		});
		expect(gate.receive(message("hello"), sender, false)).toEqual({
			ok: true,
			outcome: "dropped",
			reason: "repeat",
		});
		expect(host.deliveries.map(delivery => delivery.body)).toEqual(["hello", "different", "hello"]);
	});

	it("expires repeat and rate windows, including own-child's shared bucket", () => {
		vi.useFakeTimers();
		setSystemTime(1_000);
		const { gate, host } = gateFixture();
		gate.receive(message("same"), sender, false);
		vi.advanceTimersByTime(30_000);
		expect(gate.receive(message("same"), sender, false)).toEqual({ ok: true, outcome: "delivered" });
		host.pending = 0;
		for (let i = 0; i < 30; i++)
			gate.receive(message(`child-${i}`), { ...sender, shortId: i.toString(16).padStart(8, "0") }, true);
		expect(gate.receive(message("child-last"), sender, true)).toEqual({
			ok: true,
			outcome: "dropped",
			reason: "rate",
		});
		vi.advanceTimersByTime(60_000);
		expect(gate.receive(message("child-last-again"), sender, true)).toEqual({ ok: true, outcome: "delivered" });
	});

	it("bounds held FIFO and releases explicit hold without an expiry", () => {
		vi.useFakeTimers();
		const { gate, host, settings, replies } = gateFixture();
		cfgMessagingInbound.override(settings, "hold");
		cfgMessagingRateLimit.override(settings, 200);
		const first = message("first\nsecond line");
		expect(gate.receive(first, sender, false)).toEqual({ ok: true, outcome: "held" });
		expect(host.display[0]).toBe("Held message from @alpha: first");
		for (let i = 0; i < HELD_CAP; i++) gate.receive(message(`held-${i}`), sender, false);
		expect(replies).toEqual([
			{ type: "notice", kind: "dropped", reason: "queue_full", aboutId: first.id, id: "notice", from: sender },
		]);
		vi.advanceTimersByTime(IDLE_SUBSCRIPTION_TTL_MS);
		expect(replies).toHaveLength(1);
		cfgMessagingInbound.override(settings, "accept");
		gate.reapplyPolicy();
		expect(host.deliveries).toHaveLength(ACCEPTED_QUEUE_CAP);
		expect(host.deliveries[0].body).toBe("held-0");
		expect(host.display.at(-1)).toBe("Re-applied inbound rules: delivered 50 held message(s).");
		expect(replies).toHaveLength(51);
	});

	it("approves, denies, dismisses, and aborts default dialogs on expiry", async () => {
		vi.useFakeTimers();
		const { gate, host, settings, replies } = gateFixture();
		host.permission = "prompting";
		cfgMessagingDialogExpiry.override(settings, "60s");
		for (const answer of ["approve", "deny", undefined] as const) {
			host.askApproval = async () => answer;
			gate.receive(message(`answer-${answer}`), sender, false);
			await Promise.resolve();
		}
		expect(host.deliveries).toHaveLength(1);
		let signal: AbortSignal | undefined;
		host.askApproval = async (_view, abort) => {
			signal = abort;
			return Promise.withResolvers<"approve">().promise;
		};
		const expiring = message("expires");
		gate.receive(expiring, sender, false);
		vi.advanceTimersByTime(60_000);
		expect(signal?.aborted).toBe(true);
		expect(replies[0]).toMatchObject({ kind: "expired", aboutId: expiring.id });
		cfgMessagingDialogExpiry.override(settings, "never");
		gate.receive(message("never"), sender, false);
		vi.advanceTimersByTime(IDLE_SUBSCRIPTION_TTL_MS);
		expect(replies).toHaveLength(1);
		cfgMessagingInbound.override(settings, "refuse");
		gate.reapplyPolicy();
		expect(signal?.aborted).toBe(true);
	});
});

describe("messaging service with real inboxes", () => {
	it("lists, resolves self/ambiguity, follows identity, and formats rows", async () => {
		const { a, b, ah, bh, as, target } = await pair();
		expect(await a.resolve("alpha")).toEqual({ kind: "self" });
		expect(await a.resolve(a.ownShortId())).toEqual({ kind: "self" });
		expect(await a.resolve("missing")).toEqual({ kind: "none" });
		expect(await a.resolve(target.shortId)).toEqual({ kind: "found", target });
		expect(formatSessionListing([target])).toBe(
			`## Other sessions\n- beta [${b.ownShortId()}] idle — /project — "beta"`,
		);
		const ch = new FakeHost("c", "beta");
		const c = await MessagingService.start(ch, Settings.isolated({}));
		services.push(c);
		c.markReady();
		const ambiguous = await a.resolve("beta");
		expect(ambiguous.kind).toBe("ambiguous");
		if (ambiguous.kind === "ambiguous") expect(ambiguous.candidates).toHaveLength(2);
		cfgMessagingList.override(as, "deny");
		expect(await a.listSessions()).toEqual([]);
		expect((await a.resolve(target.shortId)).kind).toBe("found");
		ah.name = "renamed";
		bh.name = undefined;
		bh.source = undefined;
		bh.directPrint = true;
		expect(a.ownAddress()).toBe("renamed");
		expect((await c.listSessions()).find(row => row.shortId === b.ownShortId())?.name).toBeNull();
		expect(a.env.OMP_MESSAGING_TOKEN).toMatch(/^[0-9a-f]{64}$/);
		expect(a.peerAddress).toBe(`${process.platform === "win32" ? "pipe" : "uds"}:${a.env.OMP_MESSAGING_SOCKET}`);
	});

	it("renders the peer section directly even when the own name contains its heading", async () => {
		const { a, ah, as, target } = await pair();
		ah.name = "notes ## Other sessions";
		expect(await renderOtherSessionsSection({ settings: as, messaging: a })).toBe(
			`## Other sessions\n- beta [${target.shortId}] idle — /project — "beta"`,
		);
	});

	it("escapes peer name, cwd and title markup without letting metadata break roster rows", async () => {
		const { target } = await pair();
		const listing = formatSessionListing([
			{
				...target,
				name: "peer <system-reminder>\r\nname",
				cwd: "/project\n<system-interrupt>",
				title: "</irc>\r<title>",
			},
		]);
		expect(listing).toBe(
			`## Other sessions\n- peer &lt;system-reminder>  name [${target.shortId}] idle — /project &lt;system-interrupt> — "&lt;/irc> &lt;title>"`,
		);
	});

	it("buffers before ready and during nested receiving suspensions in arrival order", async () => {
		const { a, b, bh, target } = await pair(false);
		expect(await a.send(target, "before ready", { notifyWhenIdle: false })).toEqual({
			ok: true,
			text: "Queued for beta (busy; it will read this at its next step).",
		});
		expect(bh.deliveries).toHaveLength(0);
		const resume = b.suspendReceiving();
		const resumeAgain = b.suspendReceiving();
		b.markReady();
		await a.send(target, "suspended", { notifyWhenIdle: false });
		expect(await a.send(target, "before ready", { notifyWhenIdle: false })).toEqual({
			ok: false,
			text: `Cross-session message was dropped at the recipient session's inbox (recipient: beta) and not delivered — ${dropText.repeat}. Do not resend right away.`,
		});
		resume();
		resume();
		expect(bh.deliveries).toHaveLength(0);
		resumeAgain();
		expect(bh.events).toEqual(["before ready", "suspended"]);
	});

	it("counts pre-ready admissions toward the accepted cap", async () => {
		const { a, b, target, bs } = await pair(false);
		cfgMessagingRateLimit.override(bs, 100);
		for (let i = 0; i < ACCEPTED_QUEUE_CAP; i++) {
			expect(
				await transport.requestInbox(target.entry, {
					...message(`queued-${i}`),
					from: { ...sender, shortId: a.ownShortId() },
				}),
			).toEqual({ ok: true, outcome: "queued" });
		}
		expect(await transport.requestInbox(target.entry, message("51st"))).toEqual({
			ok: true,
			outcome: "dropped",
			reason: "queue_full",
		});
		await b.close();
	});

	it("returns exact delivered, held, refused and dropped receipts", async () => {
		const { a, ah, bh, target, bs } = await pair();
		expect(await a.send(target, "hello", { notifyWhenIdle: false })).toEqual({
			ok: true,
			text: "Delivered to beta.",
		});
		bh.busy = true;
		expect(await a.send(target, "busy", { notifyWhenIdle: false })).toEqual({
			ok: true,
			text: "Queued for beta (busy; it will read this at its next step).",
		});
		bh.busy = false;
		expect(bh.deliveries[0].chain).toEqual([a.ownShortId()]);
		expect(bh.deliveries[0].from.address).toBe("alpha");
		expect(await a.send(target, "hello", { notifyWhenIdle: false })).toEqual({
			ok: false,
			text: `Cross-session message was dropped at the recipient session's inbox (recipient: beta) and not delivered — ${dropText.repeat}. Do not resend right away.`,
		});
		cfgMessagingInbound.override(bs, "hold");
		expect(await a.send(target, "held", { notifyWhenIdle: false })).toEqual({
			ok: true,
			text: "Held by beta for its user's approval.",
		});
		expect(bh.display).toContain("Held message from @alpha: held");
		cfgMessagingInbound.override(bs, "accept");
		bh.reapply();
		expect(bh.deliveries.at(-1)?.body).toBe("held");
		expect(bh.display).toContain("Re-applied inbound rules: delivered 1 held message(s).");
		cfgMessagingInbound.override(bs, "refuse");
		expect(await a.send(target, "refused", { notifyWhenIdle: false })).toEqual({
			ok: false,
			text: "Not sent: beta refused the message.",
		});
		cfgMessagingInbound.override(bs, "accept");
		bh.pending = 50;
		expect((await a.send(target, "queue", { notifyWhenIdle: false })).text).toBe(
			`Cross-session message was dropped at the recipient session's inbox (recipient: beta) and not delivered — ${dropText.queue_full}. Do not resend right away.`,
		);
		ah.chain = [target.shortId, target.shortId, target.shortId];
		expect((await a.send(target, "loop", { notifyWhenIdle: false })).text).toBe(
			`Cross-session message was dropped at the recipient session's inbox (recipient: beta) and not delivered — ${dropText.relay_loop}. Do not resend right away.`,
		);
		ah.chain = [];
		cfgMessagingRateLimit.override(bs, 1);
		expect((await a.send(target, "rate", { notifyWhenIdle: false })).text).toBe(
			`Cross-session message was dropped at the recipient session's inbox (recipient: beta) and not delivered — ${dropText.rate}. Do not resend right away.`,
		);
	});

	it("returns exact send-denied, size, burst, unsafe-target and unreachable failures", async () => {
		const { a, as, b, target } = await pair();
		cfgMessagingSend.override(as, "deny");
		expect(await a.send(target, "blocked", { notifyWhenIdle: false })).toEqual({
			ok: false,
			text: "Not sent: sending to other sessions is turned off (messaging.send).",
		});
		cfgMessagingSend.override(as, "allow");
		expect(await a.send(target, " \n ", { notifyWhenIdle: false })).toEqual({ ok: false, text: "empty" });
		const large = await a.send(target, "x".repeat(MAX_SERIALIZED_CHARS), { notifyWhenIdle: false });
		expect(large.ok).toBe(false);
		expect(large.text).toMatch(
			/^Failed to send to beta: Message too large for cross-session delivery: the serialized message is \d+ characters and the limit is 1,048,576\. Shorten the message text — put bulk content in a file the recipient can read rather than in the message — or split it into smaller messages\.$/,
		);
		cfgMessagingRateLimit.override(as, 1);
		await a.send(target, "one", { notifyWhenIdle: false });
		expect(await a.send(target, "two", { notifyWhenIdle: false })).toEqual({
			ok: false,
			text: "Failed to send to beta: Too many messages to this session just now: 1 were sent recently and more would be dropped by its rate limit, so this one was not sent. Batch what remains into one message, or wait a little before sending more.",
		});
		cfgMessagingRateLimit.override(as, 100);
		vi.spyOn(transport, "requestInbox").mockResolvedValueOnce({
			ok: false,
			error: "Refusing to send: reply target is a symlink",
		});
		expect((await a.send(target, "unsafe", { notifyWhenIdle: false })).text).toBe(
			"Failed to send to beta: Refusing to send: reply target is a symlink",
		);
		await b.close();
		expect(await a.send(target, "gone", { notifyWhenIdle: false })).toEqual({
			ok: false,
			text: "Failed to send to beta: the session is no longer running.",
		});
		expect(await a.listSessions()).toEqual([]);
	});

	it("expires a held default message and ignores unknown aboutIds", async () => {
		const { a, ah, bh, bs, target } = await pair();
		bh.permission = "prompting";
		cfgMessagingDialogExpiry.override(bs, "60s");
		vi.useFakeTimers();
		const expired = ah.nextNotice();
		expect(await a.send(target, "needs approval", { notifyWhenIdle: false })).toEqual({
			ok: true,
			text: "Held by beta for its user's approval.",
		});
		expect(bh.display).toEqual([]);
		vi.advanceTimersByTime(60_000);
		expect(await expired).toBe("Your message to @beta expired before its user approved it.");
		const own = (await transport.listInboxEntries()).find(entry => entry.endpoint === a.env.OMP_MESSAGING_SOCKET)!;
		await transport.requestInbox(own, {
			type: "notice",
			id: "unknown",
			from: { ...sender, name: "beta", shortId: target.shortId, entryId: target.entry.entryId },
			kind: "expired",
			aboutId: "not-sent",
		});
		expect(ah.notices).toHaveLength(1);
	});

	it("notifies immediately while idle and once after a busy turn settles", async () => {
		const { a, b, ah, bh, target } = await pair();
		const immediate = ah.nextNotice();
		expect(await a.send(target, "", { notifyWhenIdle: true })).toEqual({
			ok: true,
			text: "Will notify you when beta is next idle.",
		});
		expect(await immediate).toBe("@beta is idle (turn finished 14:07): Finished the change.");
		expect(bh.display).toContain("@alpha asked to be told when this session is next idle.");
		bh.busy = true;
		const settled = ah.nextNotice();
		expect(await a.send(target, "with notification", { notifyWhenIdle: true })).toEqual({
			ok: true,
			text: "Queued for beta (busy; it will read this at its next step).",
		});
		expect(ah.notices).toHaveLength(1);
		b.turnSettledIdle();
		expect(await settled).toBe("@beta is idle (turn finished 14:07): Finished the change.");
		b.turnSettledIdle();
		expect(ah.notices).toHaveLength(2);
	});

	it("rejects a refusing requester's subscription but still sends a non-empty body without watching", async () => {
		const { a, b, ah, bh, as, target } = await pair();
		bh.busy = true;
		cfgMessagingInbound.override(as, "refuse");
		vi.useFakeTimers();
		const request = vi.spyOn(transport, "requestInbox").mockClear();
		const subscription = await a.send(target, "", { notifyWhenIdle: true });
		expect(subscription.ok).toBe(false);
		expect(subscription.text).toContain("refuses inbound messages");
		expect(request).not.toHaveBeenCalled();
		const receipt = await a.send(target, "send without watching", { notifyWhenIdle: true });
		expect(receipt.ok).toBe(true);
		expect(receipt.text).toContain("Queued for beta");
		expect(receipt.text).toContain("No idle notification was requested");
		expect(bh.deliveries.map(delivery => delivery.body)).toEqual(["send without watching"]);
		expect(bh.display).toEqual([]);
		request.mockClear();
		b.turnSettledIdle();
		expect(request).not.toHaveBeenCalled();
		cfgMessagingInbound.override(as, "accept");
		vi.advanceTimersByTime(IDLE_SUBSCRIPTION_TTL_MS);
		expect(ah.notices).toEqual([]);
	});

	it.each(["hold", "refuse"] as const)(
		"applies current asking-side %s policy to subscription expiry",
		async policy => {
			const { a, ah, bh, as, target } = await pair();
			bh.busy = true;
			vi.useFakeTimers();
			await a.send(target, "", { notifyWhenIdle: true });
			cfgMessagingInbound.override(as, policy);
			vi.advanceTimersByTime(IDLE_SUBSCRIPTION_TTL_MS);
			expect(ah.notices).toEqual([]);
			expect(ah.display).toEqual(
				policy === "hold" ? ["No idle notice from @beta within 12 hours; the subscription was dropped."] : [],
			);
		},
	);

	it("omits held subscription status, holds incoming notices and ignores refused notices", async () => {
		const { a, b, ah, bh, as, bs, target } = await pair();
		cfgMessagingInbound.override(bs, "hold");
		const held = ah.nextNotice();
		await a.send(target, "", { notifyWhenIdle: true });
		expect(await held).toBe("@beta is idle (turn finished 14:07).");
		cfgMessagingInbound.override(as, "hold");
		bh.busy = true;
		await a.send(target, "", { notifyWhenIdle: true });
		// The reply transport is real; observe its request settling before asserting display-only delivery.
		const observed = Promise.withResolvers<void>();
		vi.spyOn(transport, "requestInbox").mockImplementation(async (entry, payload, options) => {
			const result = await realRequestInbox(entry, payload, { ...options, dir: temp!.path() });
			if (payload.type === "notice") observed.resolve();
			return result;
		});
		b.turnSettledIdle();
		await observed.promise;
		expect(ah.display).toContain("@beta is idle (turn finished 14:07).");
		expect(ah.notices).toHaveLength(1);
		await a.send(target, "", { notifyWhenIdle: true });
		cfgMessagingInbound.override(as, "refuse");
		const ignored = Promise.withResolvers<void>();
		vi.spyOn(transport, "requestInbox").mockImplementation(async (entry, payload, options) => {
			const result = await realRequestInbox(entry, payload, { ...options, dir: temp!.path() });
			if (payload.type === "notice") ignored.resolve();
			return result;
		});
		b.turnSettledIdle();
		await ignored.promise;
		expect(ah.notices).toHaveLength(1);
		expect(ah.display).toHaveLength(1);
	});

	it("expires asking-side subscriptions after 12 hours and refuses watched subscriptions", async () => {
		const { a, b, ah, bh, bs, target } = await pair();
		bh.busy = true;
		cfgMessagingInbound.override(bs, "refuse");
		vi.useFakeTimers();
		await a.send(target, "", { notifyWhenIdle: true });
		expect(bh.display).toEqual([]);
		b.turnSettledIdle();
		vi.advanceTimersByTime(IDLE_SUBSCRIPTION_TTL_MS - 1);
		expect(ah.notices).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(ah.notices).toEqual(["No idle notice from @beta within 12 hours; the subscription was dropped."]);
	});

	it("sends exited before unpublishing and makes close idempotent", async () => {
		const { a, b, ah, bh, target } = await pair();
		bh.busy = true;
		const resume = b.suspendReceiving();
		await a.send(target, "discard on exit", { notifyWhenIdle: false });
		const exited = ah.nextNotice();
		await a.send(target, "", { notifyWhenIdle: true });
		const allowExit = Promise.withResolvers<void>();
		vi.spyOn(transport, "requestInbox").mockImplementation(async (entry, payload, options) => {
			if (payload.type === "notice" && payload.kind === "exited") await allowExit.promise;
			return realRequestInbox(entry, payload, { ...options, dir: temp!.path() });
		});
		const firstClose = b.close();
		expect(b.close()).toBe(firstClose);
		resume();
		const rejected = await transport.requestInbox(target.entry, message("arrived during close"));
		allowExit.resolve();
		expect(rejected).toEqual({ ok: false, error: "unreachable" });
		expect(bh.deliveries).toEqual([]);
		await firstClose;
		expect(await exited).toBe("@beta exited.");
		expect(bh.listeners.size).toBe(0);
	});

	it("reserves @ addresses before looking up peers or offline sessions", async () => {
		const { a } = await pair();
		const list = vi.spyOn(transport, "listInboxEntries").mockClear();
		const offline = vi.spyOn(mailbox, "listOfflineSessions").mockClear();
		expect(await a.resolve("@x")).toEqual({ kind: "none" });
		expect(list).not.toHaveBeenCalled();
		expect(offline).not.toHaveBeenCalled();
	});

	it.each(["metadata", "snapshot"] as const)(
		"excludes incompatible %s versions and reports their names",
		async source => {
			const { a, target } = await pair();
			if (source === "metadata") {
				vi.spyOn(transport, "listInboxEntries").mockImplementation(async options =>
					(await realListInboxEntries({ ...options, dir: temp!.path() })).map(entry =>
						entry.entryId === target.entry.entryId ? { ...entry, version: MESSAGING_WIRE_VERSION + 1 } : entry,
					),
				);
			} else {
				vi.spyOn(transport, "requestInbox").mockImplementation(async (entry, request, options) => {
					const result = await realRequestInbox(entry, request, { ...options, dir: temp!.path() });
					return entry.entryId === target.entry.entryId && result.ok && "snapshot" in result
						? { ok: true, snapshot: { ...result.snapshot, v: MESSAGING_WIRE_VERSION + 1 } }
						: result;
				});
			}
			expect(await a.listSessions()).toEqual([]);
			expect(await a.resolve("beta")).toEqual({ kind: "incompatible", name: "beta" });
			expect(await a.resolve(target.shortId)).toEqual({ kind: "incompatible", name: target.shortId });
			expect(
				await a.send({ ...target, entry: { ...target.entry, version: MESSAGING_WIRE_VERSION + 1 } }, "no", {
					notifyWhenIdle: false,
				}),
			).toEqual({ ok: false, text: "Not sent: beta runs an incompatible omp version." });
			expect(await transport.listInboxEntries()).toHaveLength(2);
		},
	);

	it("falls back to offline names/short ids, excludes self/live sessions, and reports ambiguity", async () => {
		const { a, b, target } = await pair();
		const stopped: mailbox.OfflineSession = {
			sessionId: "stopped",
			shortId: sessionShortId("stopped"),
			name: "stopped",
			cwd: "/elsewhere",
			title: null,
			modified: Date.now(),
		};
		vi.spyOn(mailbox, "listOfflineSessions").mockResolvedValue([
			stopped,
			{ ...stopped, sessionId: "a", shortId: a.ownShortId(), name: "self-alias" },
			{ ...stopped, sessionId: "b", shortId: b.ownShortId(), name: "live-alias" },
		]);
		expect(await a.resolve("stopped")).toEqual({ kind: "offline", target: stopped });
		expect(await a.resolve(stopped.shortId)).toEqual({ kind: "offline", target: stopped });
		expect(await a.resolve("self-alias")).toEqual({ kind: "none" });
		expect(await a.resolve("live-alias")).toEqual({ kind: "none" });
		vi.spyOn(mailbox, "listOfflineSessions").mockResolvedValue([stopped, { ...stopped, name: "beta" }]);
		expect(await a.resolve("beta")).toEqual({ kind: "found", target });
		const duplicate = { ...stopped, sessionId: "duplicate", shortId: sessionShortId("duplicate") };
		vi.spyOn(mailbox, "listOfflineSessions").mockResolvedValue([stopped, duplicate]);
		expect(await a.resolve("stopped")).toEqual({ kind: "ambiguous", candidates: [stopped, duplicate] });
	});

	it("queues offline sends with the usual deny, size and burst guards, and refuses notify/full", async () => {
		const { a, as, b, target } = await pair();
		await b.close();
		const stopped: mailbox.OfflineSession = {
			sessionId: "b",
			shortId: target.shortId,
			name: "beta",
			cwd: target.cwd,
			title: target.title,
			modified: Date.now(),
		};
		vi.spyOn(mailbox, "listOfflineSessions").mockResolvedValue([stopped]);
		expect(await a.resolve("beta")).toEqual({ kind: "offline", target: stopped });
		expect(await a.send(stopped, "", { notifyWhenIdle: true })).toEqual({
			ok: false,
			text: "Not sent: notify=idle needs a running session; beta is not running.",
		});
		cfgMessagingSend.override(as, "deny");
		expect(await a.send(stopped, "blocked", { notifyWhenIdle: false })).toEqual({
			ok: false,
			text: "Not sent: sending to other sessions is turned off (messaging.send).",
		});
		cfgMessagingSend.override(as, "allow");
		expect((await a.send(stopped, "x".repeat(MAX_SERIALIZED_CHARS), { notifyWhenIdle: false })).text).toMatch(
			/^Failed to send to beta: Message too large for cross-session delivery:/,
		);
		cfgMessagingRateLimit.override(as, 1);
		expect(await a.send(stopped, "saved", { notifyWhenIdle: false })).toEqual({
			ok: true,
			text: "Queued for beta (not running); it will see this when resumed.",
		});
		expect(await a.send(stopped, "too soon", { notifyWhenIdle: false })).toEqual({
			ok: false,
			text: "Failed to send to beta: Too many messages to this session just now: 1 were sent recently and more would be dropped by its rate limit, so this one was not sent. Batch what remains into one message, or wait a little before sending more.",
		});
		cfgMessagingRateLimit.override(as, 100);
		for (let i = 1; i < mailbox.OFFLINE_INBOX_CAP; i++)
			await a.send(stopped, `saved-${i}`, { notifyWhenIdle: false });
		expect(await a.send(stopped, "full", { notifyWhenIdle: false })).toEqual({
			ok: false,
			text: "Not sent: beta's offline inbox is full (50 messages).",
		});
		const stored = await mailbox.drainOffline("b");
		expect(stored).toHaveLength(50);
		expect(stored[0].message).toMatchObject({
			body: "saved",
			from: { name: "alpha", class: "bypass" },
			chain: [a.ownShortId()],
		});
	});

	it("retires held messages and subscriptions using the old address, aborts dialogs, and clears timers", async () => {
		const { a, b, ah, bh, target, bs } = await pair();
		vi.useFakeTimers();
		bh.busy = true;
		bh.permission = "prompting";
		cfgMessagingDialogExpiry.override(bs, "60s");
		let signal: AbortSignal | undefined;
		bh.askApproval = (_view, abort) => {
			signal = abort;
			return Promise.withResolvers<"approve">().promise;
		};
		// The service captures askApproval at startup; create a receiver with the dialog already wired.
		await b.close();
		const receiver = await MessagingService.start(bh, bs);
		services.push(receiver);
		receiver.markReady();
		const live = (await a.listSessions())[0];
		await a.send(live, "held until switch", { notifyWhenIdle: true });
		ah.busy = true;
		const reverse = (await receiver.listSessions())[0];
		await receiver.send(reverse, "", { notifyWhenIdle: true });
		bh.id = "new-conversation";
		bh.name = "new-name";
		await receiver.retireConversation();
		expect(signal?.aborted).toBe(true);
		expect(ah.notices).toContain(
			"Your message to @beta was dropped unread: that session switched to a different conversation.",
		);
		const cancellation = "@beta switched to a different conversation; the idle notice was cancelled.";
		// Alpha is bypass while the saved beta sender is prompting, so default inbound holds the notice.
		expect(ah.display).toContain(cancellation);
		expect(ah.notices).not.toContain(cancellation);
		cfgMessagingInbound.override(bs, "accept");
		bh.reapply();
		expect(bh.deliveries).toEqual([]);
		vi.advanceTimersByTime(IDLE_SUBSCRIPTION_TTL_MS);
		expect(ah.notices).toHaveLength(1);
		expect(ah.display.filter(text => text === cancellation)).toHaveLength(1);
		expect(bh.notices).toEqual([]);
		expect(await a.resolve(target.shortId)).toEqual({ kind: "none" });
	});

	it.each(["accept", "hold", "refuse"] as const)(
		"drains resumed mail through %s policy and reports admitted batches",
		async policy => {
			const { b, bh, bs } = await pair();
			await b.close();
			cfgMessagingInbound.override(bs, policy);
			for (const [id, body, chain] of [
				["first", "saved", []],
				["second", "saved", []],
				["loop", "relay rejected", [sessionShortId("b"), sessionShortId("b"), sessionShortId("b")]],
			] as const)
				await mailbox.enqueueOffline("b", { id, from: sender, body, chain: [...chain], sentAt: Date.now() });
			const resumed = await MessagingService.start(bh, bs);
			services.push(resumed);
			expect(bh.deliveries).toEqual([]);
			resumed.markReady();
			if (policy === "refuse") {
				expect(bh.deliveries).toEqual([]);
				expect(bh.display).toEqual([]);
			} else {
				expect(bh.display).toContain(
					"2 message(s) from other sessions arrived while this session was not running.",
				);
				if (policy === "hold") {
					expect(bh.deliveries).toEqual([]);
					expect(bh.display.filter(text => text === "Held message from @alpha: saved")).toHaveLength(2);
					cfgMessagingInbound.override(bs, "accept");
					bh.reapply();
				}
				expect(bh.deliveries.map(delivery => delivery.body)).toEqual(["saved", "saved"]);
			}
			expect(await mailbox.drainOffline("b")).toEqual([]);
		},
	);

	it("keeps queue-full offline mail on disk and delivers it once capacity is available at the next drain", async () => {
		const { b, bh, bs } = await pair();
		await b.close();
		for (let i = 0; i < mailbox.OFFLINE_INBOX_CAP; i++)
			expect(
				await mailbox.enqueueOffline("b", {
					id: `offline-${i}`,
					from: sender,
					body: `saved-${i}`,
					chain: [],
					sentAt: Date.now() + i,
				}),
			).toBe("queued");
		// One live pending message already occupies capacity when resume drains the durable inbox.
		bh.pending = 1;
		const resumed = await MessagingService.start(bh, bs);
		services.push(resumed);
		resumed.markReady();
		expect(bh.deliveries).toHaveLength(mailbox.OFFLINE_INBOX_CAP - 1);
		const retained = await mailbox.drainOffline("b");
		expect(retained.map(item => item.message.body)).toEqual(["saved-49"]);
		bh.pending = 0;
		await resumed.retireConversation();
		expect(bh.deliveries.map(delivery => delivery.body)).toEqual(
			Array.from({ length: mailbox.OFFLINE_INBOX_CAP }, (_, i) => `saved-${i}`),
		);
		expect(await mailbox.drainOffline("b")).toEqual([]);
	});

	it("rechecks offline targets and sends to newly live peers even when listing is denied", async () => {
		const { a, as, b, bh, bs, target } = await pair();
		await b.close();
		const stopped: mailbox.OfflineSession = {
			sessionId: "b",
			shortId: target.shortId,
			name: "beta",
			cwd: target.cwd,
			title: target.title,
			modified: Date.now(),
		};
		vi.spyOn(mailbox, "listOfflineSessions").mockResolvedValue([stopped]);
		expect(await a.resolve("beta")).toEqual({ kind: "offline", target: stopped });
		bh.name = "resumed-beta";
		const resumed = await MessagingService.start(bh, bs);
		services.push(resumed);
		resumed.markReady();
		cfgMessagingList.override(as, "deny");
		const enqueue = vi.spyOn(mailbox, "enqueueOffline").mockClear();
		expect(await a.send(stopped, "send to current inbox", { notifyWhenIdle: false })).toEqual({
			ok: true,
			text: "Delivered to resumed-beta.",
		});
		expect(bh.deliveries.map(delivery => delivery.body)).toEqual(["send to current inbox"]);
		vi.spyOn(transport, "requestInbox").mockImplementation(async (entry, request, options) => {
			const result = await realRequestInbox(entry, request, { ...options, dir: temp!.path() });
			return result.ok && "snapshot" in result
				? { ok: true, snapshot: { ...result.snapshot, v: MESSAGING_WIRE_VERSION + 1 } }
				: result;
		});
		expect(await a.send(stopped, "incompatible now", { notifyWhenIdle: false })).toEqual({
			ok: false,
			text: "Not sent: beta runs an incompatible omp version.",
		});
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("reserves offline burst slots while enqueueing and does not count full-inbox failures", async () => {
		const { a, as } = await pair();
		cfgMessagingRateLimit.override(as, 1);
		const stopped: mailbox.OfflineSession = {
			sessionId: "stopped",
			shortId: sessionShortId("stopped"),
			name: "stopped",
			cwd: "/elsewhere",
			title: null,
			modified: Date.now(),
		};
		const queued = Promise.withResolvers<"queued">();
		const entered = Promise.withResolvers<void>();
		vi.spyOn(mailbox, "enqueueOffline")
			.mockResolvedValueOnce("full")
			.mockImplementationOnce(() => {
				entered.resolve();
				return queued.promise;
			});
		expect(await a.send(stopped, "full first", { notifyWhenIdle: false })).toEqual({
			ok: false,
			text: "Not sent: stopped's offline inbox is full (50 messages).",
		});
		const sending = a.send(stopped, "queued", { notifyWhenIdle: false });
		await entered.promise;
		const burst = await a.send(stopped, "burst", { notifyWhenIdle: false });
		queued.resolve("queued");
		expect(await sending).toEqual({
			ok: true,
			text: "Queued for stopped (not running); it will see this when resumed.",
		});
		expect(burst.text).toBe(
			"Failed to send to stopped: Too many messages to this session just now: 1 were sent recently and more would be dropped by its rate limit, so this one was not sent. Batch what remains into one message, or wait a little before sending more.",
		);
	});

	it("delivers offline send receipts through resume and retains correlation for held-message expiry", async () => {
		const { a, ah, b, bh, bs, target } = await pair();
		await b.close();
		bh.permission = "prompting";
		cfgMessagingDialogExpiry.override(bs, "60s");
		const stopped: mailbox.OfflineSession = {
			sessionId: "b",
			shortId: target.shortId,
			name: "beta",
			cwd: target.cwd,
			title: target.title,
			modified: Date.now(),
		};
		expect(await a.send(stopped, "offline approval", { notifyWhenIdle: false })).toEqual({
			ok: true,
			text: "Queued for beta (not running); it will see this when resumed.",
		});
		vi.useFakeTimers();
		const resumed = await MessagingService.start(bh, bs);
		services.push(resumed);
		resumed.markReady();
		expect(bh.deliveries).toEqual([]);
		expect(bh.display).toContain("1 message(s) from other sessions arrived while this session was not running.");
		const expired = ah.nextNotice();
		vi.advanceTimersByTime(60_000);
		expect(await expired).toBe("Your message to @beta expired before its user approved it.");
	});

	it("drains mail on conversation changes with the stored sender class and the held-message lifecycle", async () => {
		const { a, b, ah, bh, bs } = await pair();
		cfgMessagingDialogExpiry.override(bs, "60s");
		bh.id = "resumed";
		await mailbox.enqueueOffline("resumed", {
			id: "stored",
			from: { ...sender, class: "prompting" },
			body: "class mismatch",
			chain: [],
			sentAt: Date.now(),
		});
		await b.retireConversation();
		expect(bh.deliveries).toEqual([]);
		expect(bh.display).toContain("1 message(s) from other sessions arrived while this session was not running.");
		bh.permission = "prompting";
		bh.reapply();
		expect(bh.deliveries.map(delivery => delivery.body)).toEqual(["class mismatch"]);
		expect(await mailbox.drainOffline("resumed")).toEqual([]);
		// Asking-side notices with unknown correlation ids must not reach a new conversation.
		const own = (await transport.listInboxEntries()).find(entry => entry.endpoint === a.env.OMP_MESSAGING_SOCKET)!;
		for (const subject of ["message", "subscription"] as const)
			await transport.requestInbox(own, {
				type: "notice",
				id: crypto.randomUUID(),
				from: sender,
				kind: "retired",
				subject,
				aboutId: "unknown",
			});
		expect(ah.notices).toEqual([]);
	});
});

it("deduplicates subscriptions and cancels superseded expiry timers", async () => {
	vi.useFakeTimers();
	const host = new FakeHost("watcher");
	host.busy = true;
	const replies: InboxRequest[] = [];
	const idle = new IdleSubscriptions(
		host,
		() => "accept",
		async (_sender, notice) => {
			replies.push({ ...notice, id: "notice", from: sender });
		},
	);
	subscriptions.push(idle);
	idle.subscribe(sender, "old");
	idle.subscribe(sender, "latest");
	idle.turnSettledIdle();
	await Promise.resolve();
	expect(replies).toHaveLength(1);
	expect(replies[0]).toMatchObject({ kind: "idle", aboutId: "latest", status: "Finished the change." });
	const target = { name: "alpha", address: "alpha", shortId: "aaaaaaaa", cwd: "/project" };
	idle.arm(sender.entryId, target, "old");
	vi.advanceTimersByTime(1_000);
	idle.arm(sender.entryId, target, "new");
	vi.advanceTimersByTime(IDLE_SUBSCRIPTION_TTL_MS - 1_000);
	expect(host.notices).toEqual([]);
	idle.receive({
		type: "notice",
		id: "idle",
		from: sender,
		kind: "idle",
		aboutId: "new",
		finishedAt: host.finished.finishedAt,
		status: "done",
	});
	vi.advanceTimersByTime(2_000);
	expect(host.notices).toEqual(["@alpha is idle (turn finished 14:07): done"]);
});

it.each(["idle", "exited"] as const)("suppresses %s notices when watched policy tightens to refuse", async kind => {
	const host = new FakeHost("watched");
	host.busy = true;
	let decision: "accept" | "refuse" = "accept";
	const reply = vi.fn(async () => {});
	const idle = new IdleSubscriptions(host, () => decision, reply);
	subscriptions.push(idle);
	idle.subscribe(sender, "watch");
	decision = "refuse";
	if (kind === "exited") await idle.close();
	else {
		idle.turnSettledIdle();
		await Promise.resolve();
	}
	expect(reply).not.toHaveBeenCalled();
});

it("redacts idle status after watched policy tightens to hold and restores it after acceptance", async () => {
	const host = new FakeHost("watched");
	host.busy = true;
	let decision: "accept" | "hold-explicit" = "accept";
	const replies: InboxRequest[] = [];
	const idle = new IdleSubscriptions(
		host,
		() => decision,
		async (_sender, notice) => {
			replies.push({ ...notice, id: "notice", from: sender });
		},
	);
	subscriptions.push(idle);
	idle.subscribe(sender, "held-watch");
	decision = "hold-explicit";
	idle.turnSettledIdle();
	await Promise.resolve();
	expect(replies).toHaveLength(1);
	expect(replies[0]).toMatchObject({ kind: "idle", aboutId: "held-watch" });
	expect(replies[0]).not.toHaveProperty("status");
	idle.subscribe(sender, "accepted-watch");
	decision = "accept";
	idle.turnSettledIdle();
	await Promise.resolve();
	expect(replies).toHaveLength(2);
	expect(replies[1]).toMatchObject({
		kind: "idle",
		aboutId: "accepted-watch",
		status: "Finished the change.",
	});
});

it.each(["accept", "hold-explicit", "refuse"] as const)(
	"applies current %s policy to cancellation notices and still clears the subscription",
	policy => {
		vi.useFakeTimers();
		const host = new FakeHost("requester");
		let decision: "accept" | "hold-explicit" | "refuse" = "accept";
		const idle = new IdleSubscriptions(
			host,
			() => decision,
			vi.fn(async () => {}),
			() => sender,
		);
		subscriptions.push(idle);
		idle.arm(sender.entryId, { ...sender, address: sender.name! }, "watch");
		decision = policy;
		idle.receive({
			type: "notice",
			id: "cancelled",
			from: sender,
			kind: "retired",
			subject: "subscription",
			aboutId: "watch",
		});
		const text = "@alpha switched to a different conversation; the idle notice was cancelled.";
		expect(host.notices).toEqual(policy === "accept" ? [text] : []);
		expect(host.display).toEqual(policy === "hold-explicit" ? [text] : []);
		decision = "accept";
		vi.advanceTimersByTime(IDLE_SUBSCRIPTION_TTL_MS);
		expect(host.notices).toEqual(policy === "accept" ? [text] : []);
		expect(host.display).toEqual(policy === "hold-explicit" ? [text] : []);
	},
);
