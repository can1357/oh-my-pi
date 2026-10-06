import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as dirs from "@oh-my-pi/pi-utils/dirs";
import { FileSessionStorage } from "../../src/session/session-storage";
import { SessionManager } from "../../src/session/session-manager";
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
	RESERVED_SESSION_NAME_ERROR,
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
	askApproval: MessagingHost["askApproval"];
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
	isReceivingSuspended(): boolean {
		return false;
	}
	isSessionTransitioning(): boolean {
		return false;
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
	async deliverRemote(deliveries: readonly RemoteDelivery[]): Promise<boolean> {
		this.deliveries.push(...deliveries);
		this.events.push(...deliveries.map(delivery => delivery.body));
		this.pending += deliveries.length;
		return true;
	}
	showNotice(text: string): void {
		this.display.push(text);
	}
	async deliverNotice(_from: RemoteSender, text: string, _recipientSessionId: string): Promise<boolean> {
		this.notices.push(text);
		this.events.push(text);
		this.pending++;
		this.noticeWaiters.shift()?.(text);
		return true;
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
const realPublishInbox = transport.publishInbox;
const realListInboxEntries = transport.listInboxEntries;
const realListOfflineSessions = mailbox.listOfflineSessions;
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
	await fs.writeFile(path.join(dir, "a.jsonl"), '{"type":"session","id":"a"}\n');
	await fs.writeFile(path.join(dir, "b.jsonl"), '{"type":"session","id":"b"}\n');
	const publish = transport.publishInbox;
	const list = transport.listInboxEntries;
	const request = transport.requestInbox;
	vi.spyOn(transport, "publishInbox").mockImplementation((handler, options) => publish(handler, { ...options, dir }));
	vi.spyOn(transport, "listInboxEntries").mockImplementation(options => list({ ...options, dir }));
	vi.spyOn(transport, "requestInbox").mockImplementation((entry, payload, options) =>
		request(entry, payload, { ...options, dir }),
	);
	vi.spyOn(transport, "messagingRegistryDir").mockReturnValue(dir);
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
	sessionId: "a",
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
		expect(claimSessionName.bind(null, "@reserved", new Set<string>())).toThrow(RESERVED_SESSION_NAME_ERROR);
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
			return deliver(delivery);
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
			host.askApproval = async (_view, _signal, onPresented) => {
				onPresented();
				return answer;
			};
			gate.receive(message(`answer-${answer}`), sender, false);
			await Promise.resolve();
		}
		expect(host.deliveries).toHaveLength(1);
		let signal: AbortSignal | undefined;
		let present: (() => void) | undefined;
		host.askApproval = async (_view, abort, onPresented) => {
			signal = abort;
			present = onPresented;
			return Promise.withResolvers<"approve">().promise;
		};
		const expiring = message("expires");
		gate.receive(expiring, sender, false);
		vi.advanceTimersByTime(120_000);
		expect(signal?.aborted).toBe(false);
		expect(replies).toEqual([]);
		present!();
		present!();
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
		expect(await a.send(target, "suspended", { notifyWhenIdle: false })).toEqual({
			ok: true,
			text: "Queued for beta (it will read this when receiving resumes).",
		});
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
			expect(await a.resolve("beta")).toEqual(
				source === "metadata" && process.platform === "win32"
					? { kind: "none" }
					: { kind: "incompatible", name: "beta" },
			);
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
			path: path.join(temp!.path(), "stopped.jsonl"),
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
			path: path.join(temp!.path(), "b.jsonl"),
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
		bh.askApproval = (_view, abort, onPresented) => {
			signal = abort;
			onPresented();
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
		expect(retained.map(item => ("body" in item.message ? item.message.body : undefined))).toEqual(["saved-49"]);
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
			path: path.join(temp!.path(), "b.jsonl"),
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
		expect(await mailbox.drainOffline("b")).toEqual([]);
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
		expect(await mailbox.drainOffline("b")).toEqual([]);
	});

	it("reserves offline burst slots while enqueueing and does not count full-inbox failures", async () => {
		const { a, as } = await pair();
		cfgMessagingRateLimit.override(as, 1);
		const stopped: mailbox.OfflineSession = {
			sessionId: "stopped",
			path: path.join(temp!.path(), "stopped.jsonl"),
			shortId: sessionShortId("stopped"),
			name: "stopped",
			cwd: "/elsewhere",
			title: null,
			modified: Date.now(),
		};
		await fs.writeFile(stopped.path, '{"type":"session","id":"stopped"}\n');
		for (let i = 0; i < mailbox.OFFLINE_INBOX_CAP; i++)
			await mailbox.enqueueOffline(stopped.sessionId, {
				id: `fill-${i}`,
				from: sender,
				body: `full-${i}`,
				chain: [],
				sentAt: Date.now(),
			});
		expect(await a.send(stopped, "full first", { notifyWhenIdle: false })).toEqual({
			ok: false,
			text: "Not sent: stopped's offline inbox is full (50 messages).",
		});
		const drained = await mailbox.drainOffline(stopped.sessionId);
		await Promise.all(drained.map(item => item.ack()));
		const results = await Promise.all([
			a.send(stopped, "queued", { notifyWhenIdle: false }),
			a.send(stopped, "burst", { notifyWhenIdle: false }),
		]);
		expect(results[0]).toEqual({
			ok: true,
			text: "Queued for stopped (not running); it will see this when resumed.",
		});
		expect(results[1].text).toContain("Too many messages to this session just now");
		expect(
			(await mailbox.drainOffline(stopped.sessionId)).map(item =>
				"body" in item.message ? item.message.body : undefined,
			),
		).toEqual(["queued"]);
	});

	it("delivers offline send receipts through resume and retains correlation for held-message expiry", async () => {
		const { a, ah, b, bh, bs, target } = await pair();
		await b.close();
		bh.permission = "prompting";
		cfgMessagingDialogExpiry.override(bs, "60s");
		const stopped: mailbox.OfflineSession = {
			sessionId: "b",
			path: path.join(temp!.path(), "b.jsonl"),
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
		() => undefined,
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
	const idle = new IdleSubscriptions(
		host,
		() => decision,
		reply,
		() => undefined,
	);
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
		() => undefined,
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
			() => undefined,
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

describe("offline handoff regressions", () => {
	async function stoppedBeta() {
		const fixture = await pair();
		await fixture.b.close();
		const stopped: mailbox.OfflineSession = {
			sessionId: "b",
			path: path.join(temp!.path(), "b.jsonl"),
			shortId: fixture.target.shortId,
			name: "beta",
			cwd: "/project",
			title: "beta",
			modified: Date.now(),
		};
		return { ...fixture, stopped };
	}

	it("does not suppress or promote a saved session whose display hash collides with another live session", async () => {
		const { a } = await pair();
		const id = "collision-session-101974";
		const otherId = "collision-session-119643";
		const file = path.join(temp!.path(), "collision.jsonl");
		await fs.writeFile(file, JSON.stringify({ type: "session", id }) + "\n");
		const saved: mailbox.OfflineSession = {
			sessionId: id,
			path: file,
			shortId: sessionShortId(id),
			name: "saved-collision",
			cwd: "/project",
			title: null,
			modified: Date.now(),
		};
		vi.spyOn(mailbox, "listOfflineSessions").mockResolvedValue([saved]);
		const otherHost = new FakeHost(otherId, "other-collision");
		const other = await MessagingService.start(otherHost, Settings.isolated({}));
		services.push(other);
		other.markReady();
		expect(sessionShortId(otherId)).toBe(saved.shortId);
		expect(await a.resolve(saved.name)).toEqual({ kind: "offline", target: saved });
		expect((await a.send(saved, "COLLISION_MARKER", { notifyWhenIdle: false })).ok).toBe(true);
		expect(otherHost.deliveries).toEqual([]);
		expect(
			(await mailbox.drainOffline(id)).map(item => ("body" in item.message ? item.message.body : undefined)),
		).toEqual(["COLLISION_MARKER"]);
	});

	it("rejects duplicate live full identities with the existing ambiguity receipt", async () => {
		const { a, stopped, bh, bs } = await stoppedBeta();
		for (const host of [bh, new FakeHost("b", "beta-copy")]) {
			const live = await MessagingService.start(host, bs);
			services.push(live);
			live.markReady();
		}
		const result = await a.send(stopped, "DO_NOT_ROUTE", { notifyWhenIdle: false });
		expect(result.ok).toBe(false);
		expect(result.text).toContain('Not sent: "beta" matches more than one agent:');
		expect(result.text).toEndWith("Address one by its session short id.");
		expect(bh.deliveries).toEqual([]);
		expect(await mailbox.drainOffline("b")).toEqual([]);
	});

	it("drains a successful send whose atomic mailbox write overlaps receiver startup", async () => {
		const { a, stopped, bh, bs } = await stoppedBeta();
		const writing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const published = Promise.withResolvers<void>();
		const rename = nodeFs.promises.rename;
		vi.spyOn(nodeFs.promises, "rename").mockImplementation(async (from, to) => {
			if (String(from).includes(".message-")) {
				writing.resolve();
				await release.promise;
			}
			return rename(from, to);
		});
		const publish = realPublishInbox;
		vi.spyOn(transport, "publishInbox").mockImplementation(async (handler, options) => {
			const result = await publish(handler, { ...options, dir: temp!.path() });
			published.resolve();
			return result;
		});
		const send = a.send(stopped, "STARTUP_RACE_MARKER", { notifyWhenIdle: false });
		await writing.promise;
		const starting = MessagingService.start(bh, bs);
		await published.promise;
		release.resolve();
		expect((await send).ok).toBe(true);
		const resumed = await starting;
		services.push(resumed);
		resumed.markReady();
		expect(bh.deliveries.map(item => item.body)).toEqual(["STARTUP_RACE_MARKER"]);
		expect(await mailbox.drainOffline("b")).toEqual([]);
	});

	it("routes a send live when startup owns the drain lock first", async () => {
		const { a, stopped, bh, bs } = await stoppedBeta();
		const draining = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const drain = mailbox.drainOfflineUnlocked;
		vi.spyOn(mailbox, "drainOfflineUnlocked").mockImplementation(async (id, options) => {
			draining.resolve();
			await release.promise;
			return drain(id, options);
		});
		const starting = MessagingService.start(bh, bs);
		await draining.promise;
		const sending = a.send(stopped, "STARTUP_FIRST_MARKER", { notifyWhenIdle: false });
		release.resolve();
		const resumed = await starting;
		services.push(resumed);
		resumed.markReady();
		expect((await sending).ok).toBe(true);
		expect(bh.deliveries.map(item => item.body)).toEqual(["STARTUP_FIRST_MARKER"]);
		expect(await mailbox.drainOffline("b")).toEqual([]);
	});

	it("rechecks a replacement receiver after the selected live endpoint fails instead of stranding mail", async () => {
		const { a, stopped, bh, bs } = await stoppedBeta();
		const old = await MessagingService.start(bh, bs);
		services.push(old);
		old.markReady();
		let replaced = false;
		vi.spyOn(transport, "requestInbox").mockImplementation(async (entry, request, options) => {
			if (request.type === "message" && !replaced) {
				replaced = true;
				await old.close();
				const replacement = await MessagingService.start(bh, bs);
				services.push(replacement);
				replacement.markReady();
				return { ok: false, error: "unreachable" };
			}
			return realRequestInbox(entry, request, options);
		});
		expect((await a.send(stopped, "REPLACEMENT_MARKER", { notifyWhenIdle: false })).ok).toBe(true);
		expect(bh.deliveries.map(item => item.body)).toEqual(["REPLACEMENT_MARKER"]);
		expect(await mailbox.drainOffline("b")).toEqual([]);
	});

	it("answers a snapshot issued while visible publication metadata is still awaiting initialization", async () => {
		await pair();
		const visible = Promise.withResolvers<void>();
		const requested = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(transport, "publishInbox").mockImplementation(async (handler, options) => {
			const publication = await realPublishInbox(
				(request, auth) => {
					requested.resolve();
					return handler(request, auth);
				},
				{ ...options, dir: temp!.path() },
			);
			visible.resolve();
			await release.promise;
			return publication;
		});
		const started = MessagingService.start(new FakeHost("visible", "visible"), Settings.isolated({}));
		try {
			await visible.promise;
			const entry = (await transport.listInboxEntries()).find(item => item.sessionId === "visible")!;
			const snapshot = transport.requestInbox(entry, { type: "snapshot" });
			await requested.promise;
			release.resolve();
			services.push(await started);
			expect(await snapshot).toMatchObject({
				ok: true,
				snapshot: { sessionId: "visible", name: "visible", shortId: sessionShortId("visible") },
			});
		} finally {
			release.resolve();
		}
	});

	it("addresses registered custom-session-dir transcripts offline by name and short id", async () => {
		const { a } = await pair();
		vi.spyOn(dirs, "getSessionsDir").mockReturnValue(path.join(temp!.path(), "managed"));
		vi.spyOn(dirs, "getCustomSessionFilesDir").mockReturnValue(path.join(temp!.path(), "custom-markers"));
		vi.spyOn(mailbox, "listOfflineSessions").mockImplementation(realListOfflineSessions);
		const manager = SessionManager.create(temp!.path(), path.join(temp!.path(), "custom-session-dir"));
		try {
			await manager.setSessionName("custom-stopped", "user");
			await manager.ensureOnDisk();
			const named = await a.resolve("custom-stopped");
			expect(named.kind).toBe("offline");
			if (named.kind !== "offline") throw new Error("Custom session absent offline");
			expect(named.target.sessionId).toBe(manager.getSessionId());
			expect(await a.resolve(named.target.shortId)).toEqual(named);
			expect((await a.send(named.target, "CUSTOM_MARKER", { notifyWhenIdle: false })).ok).toBe(true);
			expect(
				(await mailbox.drainOffline(named.target.sessionId)).map(item =>
					"body" in item.message ? item.message.body : undefined,
				),
			).toEqual(["CUSTOM_MARKER"]);
		} finally {
			await manager.close();
		}
	});

	it.each([true, false])("notifies a refused offline message's %s-live sender without waking it", async liveSender => {
		const { a, ah, stopped, bh, bs, as } = await stoppedBeta();
		expect((await a.send(stopped, "REFUSE_MARKER", { notifyWhenIdle: false })).ok).toBe(true);
		if (!liveSender) await a.close();
		cfgMessagingInbound.override(bs, "refuse");
		const receiver = await MessagingService.start(bh, bs);
		services.push(receiver);
		receiver.markReady();
		if (!liveSender) {
			const pending = await mailbox.drainOffline("a");
			expect(pending).toHaveLength(1);
			expect(pending[0].message.id).toStartWith("refused-");
			cfgMessagingInbound.override(as, "refuse");
			const resumed = await MessagingService.start(ah, as);
			services.push(resumed);
			resumed.markReady();
		}
		expect(ah.display).toContain("Your offline message to beta was refused.");
		expect(ah.deliveries).toEqual([]);
		expect(ah.notices).toEqual([]);
		expect(bh.deliveries).toEqual([]);
		expect(await mailbox.drainOffline("b")).toEqual([]);
		expect(await mailbox.drainOffline("a")).toEqual([]);
	});

	it("acknowledges a refused original even when its stopped sender's mailbox is full", async () => {
		const { a, stopped, bh, bs } = await stoppedBeta();
		await a.send(stopped, "REFUSE_FULL_MARKER", { notifyWhenIdle: false });
		await a.close();
		for (let i = 0; i < mailbox.OFFLINE_INBOX_CAP; i++)
			await mailbox.enqueueOffline("a", {
				id: `full-${i}`,
				from: sender,
				body: `full-${i}`,
				chain: [],
				sentAt: Date.now(),
			});
		cfgMessagingInbound.override(bs, "refuse");
		const receiver = await MessagingService.start(bh, bs);
		services.push(receiver);
		receiver.markReady();
		expect(await mailbox.drainOffline("b")).toEqual([]);
		expect(await mailbox.drainOffline("a")).toHaveLength(mailbox.OFFLINE_INBOX_CAP);
	});

	it("does not show a refusal notice addressed to another persistent conversation", async () => {
		const { ah } = await pair();
		const own = (await transport.listInboxEntries()).find(entry => entry.sessionId === "a")!;
		await transport.requestInbox(own, {
			type: "notice",
			id: "refused-wrong",
			from: sender,
			kind: "refused",
			subject: "message",
			aboutId: "original",
			toSessionId: "wrong-conversation",
		});
		expect(ah.display).toEqual([]);
		expect(ah.deliveries).toEqual([]);
	});

	it("does not recreate an inbox after the saved transcript was deleted", async () => {
		const { a, stopped } = await stoppedBeta();
		await fs.unlink(stopped.path);
		expect(await a.send(stopped, "DO_NOT_RECREATE", { notifyWhenIdle: false })).toEqual({
			ok: false,
			text: "Not sent: beta is no longer available.",
		});
		expect(await mailbox.drainOffline("b")).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"starts and resumes using the publication's fallback root, not an unsafe canonical root",
		async () => {
			temp = TempDir.createSync("@omp-messaging-fallback-");
			const canonical = path.join(temp.path(), "unsafe");
			await fs.symlink(temp.path(), canonical, "dir");
			const publish = transport.publishInbox;
			vi.spyOn(transport, "publishInbox").mockImplementation((handler, options) =>
				publish(handler, { ...options, dir: canonical }),
			);
			const ah = new FakeHost(`fallback-sender-${crypto.randomUUID()}`, "fallback-sender");
			const bh = new FakeHost(`fallback-receiver-${crypto.randomUUID()}`, "fallback-receiver");
			const settings = Settings.isolated({});
			const a = await MessagingService.start(ah, settings);
			services.push(a);
			a.markReady();
			const file = path.join(temp.path(), "receiver.jsonl");
			await fs.writeFile(file, JSON.stringify({ type: "session", id: bh.id }) + "\n");
			const saved: mailbox.OfflineSession = {
				sessionId: bh.id,
				path: file,
				shortId: sessionShortId(bh.id),
				name: bh.name!,
				cwd: "/project",
				title: bh.name!,
				modified: Date.now(),
			};
			expect((await a.send(saved, "FALLBACK_MARKER", { notifyWhenIdle: false })).ok).toBe(true);
			const b = await MessagingService.start(bh, settings);
			services.push(b);
			b.markReady();
			expect(bh.deliveries.map(item => item.body)).toEqual(["FALLBACK_MARKER"]);
			expect(await mailbox.drainOffline(bh.id, { dir: `/tmp/omp-socks-${process.getuid!()}` })).toEqual([]);
			await b.close();
			expect((await a.send(saved, "FALLBACK_DELETE_MARKER", { notifyWhenIdle: false })).ok).toBe(true);
			vi.spyOn(transport, "messagingRegistryDir").mockReturnValue(canonical);
			await new FileSessionStorage().deleteSessionWithArtifacts(file);
			expect(await mailbox.drainOffline(bh.id, { dir: `/tmp/omp-socks-${process.getuid!()}` })).toEqual([]);
		},
	);
});

it("keeps the original local identity published while a suspended receiver temporarily adopts a replica", async () => {
	const { a, b, bh, target } = await pair();
	const originalEnv = { ...b.env };
	const resume = b.suspendReceiving();
	bh.id = "temporary-collab-replica";
	bh.name = "remote-host-name";
	await b.retireConversation();
	const listed = (await a.listSessions()).find(peer => peer.sessionId === target.sessionId);
	expect(listed).toMatchObject({ sessionId: "b", name: "beta", shortId: target.shortId, title: "beta" });
	expect(b.ownAddress()).toBe("beta");
	expect(b.ownShortId()).toBe(target.shortId);
	expect(b.env).toEqual(originalEnv);
	expect((await a.send(listed!, "MAIL_FOR_LOCAL_CONVERSATION", { notifyWhenIdle: false })).ok).toBe(true);
	expect(bh.deliveries).toEqual([]);
	bh.id = "b";
	bh.name = "beta";
	resume();
	expect(bh.deliveries.map(delivery => delivery.body)).toEqual(["MAIL_FOR_LOCAL_CONVERSATION"]);
	expect(b.env).toEqual(originalEnv);
});

it("retires suspended original-conversation mail and notices instead of delivering to a successor", async () => {
	const { a, b, ah, bh, target } = await pair();
	const resume = b.suspendReceiving();
	const nestedResume = b.suspendReceiving();
	await a.send(target, "ORIGINAL_OWNER_MAIL", { notifyWhenIdle: false });
	const reverse = (await b.listSessions())[0]!;
	ah.busy = true;
	const requests = vi.spyOn(transport, "requestInbox");
	await b.send(reverse, "", { notifyWhenIdle: true });
	const subscription = requests.mock.calls
		.map(call => call[1])
		.find(
			(request): request is Extract<InboxRequest, { type: "subscribe" }> =>
				request.type === "subscribe" && request.from.sessionId === "b",
		);
	expect(subscription).toBeDefined();
	await transport.requestInbox(target.entry, {
		type: "notice",
		id: "buffered-notice",
		kind: "idle",
		aboutId: subscription!.id,
		from: { ...sender, shortId: a.ownShortId(), entryId: reverse.entry.entryId },
	});
	bh.id = "successor";
	bh.name = "successor-name";
	await b.retireConversation();
	expect(bh.deliveries).toEqual([]);
	const retired = ah.nextNotice();
	resume();
	resume();
	expect(bh.deliveries).toEqual([]);
	nestedResume();
	expect(await retired).toBe(
		"Your message to @beta was dropped unread: that session switched to a different conversation.",
	);
	expect(bh.deliveries).toEqual([]);
	expect(bh.notices).toEqual([]);
});

it("retires a batch rejected after asynchronous host handoff with the captured old receiver", async () => {
	const { a, bh, ah, target } = await pair();
	const entered = Promise.withResolvers<void>();
	const disposition = Promise.withResolvers<boolean>();
	vi.spyOn(bh, "deliverRemote").mockImplementation(async () => {
		entered.resolve();
		return disposition.promise;
	});
	await a.send(target, "HANDOFF_MAIL", { notifyWhenIdle: false });
	await entered.promise;
	const retired = ah.nextNotice();
	bh.id = "new-owner";
	bh.name = "new-name";
	disposition.resolve(false);
	expect(await retired).toBe(
		"Your message to @beta was dropped unread: that session switched to a different conversation.",
	);
	expect(bh.deliveries).toEqual([]);
});

it.each(["count", "size"] as const)("globally bounds repeat history by %s without retaining rejected bodies", bound => {
	const { gate, host, settings } = gateFixture();
	cfgMessagingRateLimit.override(settings, 10_000);
	const count = bound === "count" ? 4097 : 10;
	const body = (index: number) => `${index}:${bound === "size" ? "x".repeat(500_000) : "small"}`;
	for (let index = 0; index < count; index++) {
		host.pending = 0;
		const from = { ...sender, shortId: index.toString(16).padStart(8, "0") };
		expect(gate.receive({ ...message(body(index)), from }, from, false)).toEqual({ ok: true, outcome: "delivered" });
	}
	host.pending = 0;
	const first = { ...sender, shortId: "00000000" };
	expect(gate.receive({ ...message(body(0)), from: first }, first, false)).toEqual({ ok: true, outcome: "delivered" });
});

it("does not remember refused, rate-rejected or queue-full bodies", () => {
	const { gate, host, settings } = gateFixture();
	cfgMessagingInbound.override(settings, "refuse");
	expect(gate.receive(message("refused"), sender, false)).toEqual({ ok: true, outcome: "refused" });
	cfgMessagingInbound.override(settings, "accept");
	expect(gate.receive(message("refused"), sender, false)).toEqual({ ok: true, outcome: "delivered" });
	cfgMessagingRateLimit.override(settings, 1);
	expect(gate.receive(message("rate"), sender, false)).toEqual({ ok: true, outcome: "dropped", reason: "rate" });
	cfgMessagingRateLimit.override(settings, 100);
	expect(gate.receive(message("rate"), sender, false)).toEqual({ ok: true, outcome: "delivered" });
	host.pending = ACCEPTED_QUEUE_CAP;
	expect(gate.receive(message("full"), sender, false)).toEqual({ ok: true, outcome: "dropped", reason: "queue_full" });
	host.pending = 0;
	expect(gate.receive(message("full"), sender, false)).toEqual({ ok: true, outcome: "delivered" });
});

it("ignores unsolicited idle and exited notices at the real inbox", async () => {
	const { a, ah } = await pair();
	const own = (await transport.listInboxEntries()).find(entry => entry.endpoint === a.env.OMP_MESSAGING_SOCKET)!;
	for (let index = 0; index < 55; index++)
		expect(
			await transport.requestInbox(own, {
				type: "notice",
				id: `unsolicited-${index}`,
				from: sender,
				kind: index % 2 ? "idle" : "exited",
				...(index % 3 ? { aboutId: "stale" } : {}),
			}),
		).toEqual({ ok: true, outcome: "delivered" });
	expect(ah.notices).toEqual([]);
	expect(ah.deliveries).toEqual([]);
	expect(ah.display).toEqual([]);
});

it("consumes only matching idle subscriptions once and enforces notice queue capacity", () => {
	const { gate, host, settings } = gateFixture();
	cfgMessagingRateLimit.override(settings, 100);
	const idle = new IdleSubscriptions(
		host,
		() => "accept",
		async () => {},
		(from, key) => gate.checkTraffic(from, false, key),
	);
	subscriptions.push(idle);
	const from = { name: sender.name, shortId: sender.shortId, address: "alpha", cwd: sender.cwd };
	const notice: Extract<InboxRequest, { type: "notice" }> = {
		type: "notice",
		id: "reply",
		from: sender,
		kind: "idle",
		aboutId: "current",
	};
	idle.arm(sender.entryId, from, "current");
	idle.receive({ ...notice, aboutId: "old" });
	idle.receive({ ...notice, from: { ...sender, entryId: "wrong" } });
	expect(host.notices).toEqual([]);
	expect(idle.receive(notice)).toEqual({ ok: true, outcome: "delivered" });
	idle.receive(notice);
	expect(host.notices).toHaveLength(1);
	idle.arm(sender.entryId, from, "full");
	host.pending = ACCEPTED_QUEUE_CAP;
	expect(idle.receive({ ...notice, aboutId: "full" })).toEqual({ ok: true, outcome: "dropped", reason: "queue_full" });
	host.pending = 0;
	idle.receive({ ...notice, aboutId: "full" });
	expect(host.notices).toHaveLength(1);
});

it("shares message and subscription rate accounting and bounds watched senders", () => {
	const { gate, host, settings } = gateFixture();
	host.busy = true;
	const idle = new IdleSubscriptions(
		host,
		() => "accept",
		async () => {},
		(from, key) => gate.checkTraffic(from, false, key),
	);
	subscriptions.push(idle);
	cfgMessagingRateLimit.override(settings, 1);
	gate.receive(message("body"), sender, false);
	expect(idle.subscribe(sender, "rate-limited")).toEqual({ ok: true, outcome: "dropped", reason: "rate" });
	cfgMessagingRateLimit.override(settings, 100);
	for (let index = 0; index < ACCEPTED_QUEUE_CAP; index++) {
		const from = { ...sender, entryId: `entry-${index}`, shortId: index.toString(16).padStart(8, "0") };
		expect(idle.subscribe(from, `watch-${index}`)).toEqual({ ok: true, outcome: "subscribed" });
	}
	expect(idle.subscribe({ ...sender, entryId: "overflow" }, "overflow")).toEqual({
		ok: true,
		outcome: "dropped",
		reason: "queue_full",
	});
	expect(idle.subscribe({ ...sender, entryId: "entry-0" }, "replacement")).toEqual({
		ok: true,
		outcome: "subscribed",
	});
	expect(host.display).toHaveLength(ACCEPTED_QUEUE_CAP + 1);
});

it("counts suspended idle notice buffers toward the accepted queue cap", async () => {
	const { a, b, ah, bh, as, bs, target } = await pair();
	cfgMessagingRateLimit.override(as, 200);
	cfgMessagingRateLimit.override(bs, 200);
	ah.busy = true;
	const resume = b.suspendReceiving();
	const reverse = (await b.listSessions())[0];
	let subscription: Extract<InboxRequest, { type: "subscribe" }> | undefined;
	vi.spyOn(transport, "requestInbox").mockImplementation((entry, payload, options) => {
		if (payload.type === "subscribe") subscription = payload;
		return realRequestInbox(entry, payload, { ...options, dir: temp!.path() });
	});
	for (let index = 0; index <= ACCEPTED_QUEUE_CAP; index++) {
		expect((await b.send(reverse, "", { notifyWhenIdle: true })).ok).toBe(true);
		expect(
			await transport.requestInbox(target.entry, {
				type: "notice",
				id: `notice-${index}`,
				from: { ...sender, entryId: reverse.entry.entryId, shortId: a.ownShortId() },
				kind: "idle",
				aboutId: subscription!.id,
			}),
		).toEqual(
			index < ACCEPTED_QUEUE_CAP
				? { ok: true, outcome: "delivered" }
				: { ok: true, outcome: "dropped", reason: "queue_full" },
		);
	}
	expect(bh.notices).toEqual([]);
	resume();
	expect(bh.notices).toHaveLength(ACCEPTED_QUEUE_CAP);
});

it("permanently cuts off new inbound while snapshots, outbound and accepted buffered work survive", async () => {
	const { a, b, ah, bh, bs, target } = await pair(false);
	a.markReady();
	expect((await a.send(target, "accepted", { notifyWhenIdle: false })).ok).toBe(true);
	b.stopReceiving();
	b.stopReceiving();
	expect((await transport.requestInbox(target.entry, { type: "snapshot" })).ok).toBe(true);
	for (const request of [
		message("too late"),
		{ type: "subscribe", id: "late", from: sender },
		{ type: "notice", id: "late", from: sender, kind: "idle" },
		{ type: "message", id: "child", body: "late child" },
	] as InboxRequest[])
		expect(await transport.requestInbox(target.entry, request)).toEqual({ ok: false, error: "unreachable" });
	const reverse = (await b.listSessions())[0];
	expect((await b.send(reverse, "outbound during drain", { notifyWhenIdle: false })).ok).toBe(true);
	expect(ah.deliveries.map(item => item.body)).toEqual(["outbound during drain"]);
	cfgMessagingInbound.override(bs, "accept");
	bh.reapply();
	b.markReady();
	expect(bh.deliveries.map(item => item.body)).toEqual(["accepted"]);
	expect(bh.notices).toEqual([]);
});

it("cutoff aborts unapproved holds and ignores late approval and presentation", async () => {
	const { a, b, bh, bs, target } = await pair();
	await b.close();
	bh.permission = "prompting";
	cfgMessagingDialogExpiry.override(bs, "60s");
	const answer = Promise.withResolvers<"approve">();
	let signal: AbortSignal | undefined;
	let present: (() => void) | undefined;
	bh.askApproval = (_view, abort, onPresented) => {
		signal = abort;
		present = onPresented;
		return answer.promise;
	};
	const receiver = await MessagingService.start(bh, bs);
	services.push(receiver);
	receiver.markReady();
	const updated = (await a.listSessions()).find(session => session.sessionId === target.sessionId)!;
	expect((await a.send(updated, "held before cutoff", { notifyWhenIdle: false })).ok).toBe(true);
	receiver.stopReceiving();
	expect(signal?.aborted).toBe(true);
	vi.useFakeTimers();
	present!();
	answer.resolve("approve");
	await answer.promise;
	cfgMessagingInbound.override(bs, "accept");
	bh.reapply();
	vi.advanceTimersByTime(IDLE_SUBSCRIPTION_TTL_MS);
	expect(bh.deliveries).toEqual([]);
	expect(bh.notices).toEqual([]);
});

it("rejects authenticated own-child sends after cutoff", async () => {
	const { b } = await pair();
	b.stopReceiving();
	const received = Promise.withResolvers<unknown>();
	const socket = net.createConnection(b.env.OMP_MESSAGING_SOCKET);
	socket.on("error", received.reject);
	socket.once("data", data => {
		socket.destroy();
		received.resolve(JSON.parse(data.toString()));
	});
	socket.once("connect", () => {
		socket.write(
			`${JSON.stringify({ type: "auth", token: b.env.OMP_MESSAGING_TOKEN })}\n${JSON.stringify({
				type: "message",
				id: "own-child-after-cutoff",
				body: "late",
			})}\n`,
		);
	});
	try {
		expect(await received.promise).toEqual({ ok: false, error: "unreachable" });
	} finally {
		socket.destroy();
	}
});

it("cutoff during an offline acknowledgement preserves the remaining mail and accepted work", async () => {
	const { b, bh } = await pair();
	const first: mailbox.StoredMessage = {
		id: "first-offline",
		from: sender,
		body: "already admitted",
		chain: [],
		sentAt: Date.now(),
	};
	const untouched = vi.fn(async () => {});
	vi.spyOn(mailbox, "drainOffline").mockResolvedValueOnce([
		{
			message: first,
			ack: async () => {
				b.stopReceiving();
			},
		},
		{ message: { ...first, id: "second-offline", body: "not yet admitted" }, ack: untouched },
	]);
	await b.retireConversation();
	expect(bh.deliveries.map(item => item.body)).toEqual(["already admitted"]);
	expect(untouched).not.toHaveBeenCalled();
});

it("bounds accepted-send receipt correlation while preserving recent retirement authentication", async () => {
	const { a, b, ah, target, as } = await pair();
	cfgMessagingRateLimit.override(as, 2000);
	const senderTarget = (await b.listSessions())[0]!;
	const sentIds: string[] = [];
	vi.spyOn(transport, "requestInbox").mockImplementation(async (entry, request, options) => {
		if (request.type === "message") {
			sentIds.push(request.id);
			return { ok: true, outcome: "delivered" };
		}
		return realRequestInbox(entry, request, { ...options, dir: temp!.path() });
	});
	for (let i = 0; i < 1025; i++)
		expect((await a.send(target, `RECEIPT_CACHE_${i}`, { notifyWhenIdle: false })).ok).toBe(true);
	const from: SenderInfo = {
		sessionId: target.sessionId,
		name: target.name,
		shortId: target.shortId,
		cwd: target.cwd,
		entryId: target.entry.entryId,
		class: "bypass",
	};
	await transport.requestInbox(senderTarget.entry, {
		type: "notice",
		id: "evicted-receipt",
		kind: "retired",
		subject: "message",
		aboutId: sentIds[0],
		from,
	});
	expect(ah.notices).toEqual([]);
	await transport.requestInbox(senderTarget.entry, {
		type: "notice",
		id: "wrong-receiver-receipt",
		kind: "retired",
		subject: "message",
		aboutId: sentIds.at(-1),
		from: { ...from, entryId: "unrelated-entry" },
	});
	expect(ah.notices).toEqual([]);
	await transport.requestInbox(senderTarget.entry, {
		type: "notice",
		id: "recent-receipt",
		kind: "retired",
		subject: "message",
		aboutId: sentIds.at(-1),
		from,
	});
	expect(ah.notices).toEqual([
		"Your message to @beta was dropped unread: that session switched to a different conversation.",
	]);
}, 20_000);
