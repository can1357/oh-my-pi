/**
 * Ingress guard on the hot path of {@link IrcBus.send}: per-sender rate
 * limiting, duplicate suppression, the hop-chain ceiling, and the backpressure
 * caps on the session's incoming queues.
 *
 * The guard is configured through the `irc.*` settings, so every case here
 * builds a bus with an isolated settings scope — the same way a host pins a
 * policy. Refusals must be receipts (`outcome: "failed"`), never throws, and
 * they must spend neither the sender's rate budget nor a dedup slot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus, type IrcBusApi } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { IrcIngressGuard } from "@oh-my-pi/pi-coding-agent/irc/ingress-guard";
import { executeSend } from "@oh-my-pi/pi-coding-agent/irc/messaging";
import { AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

interface FakeSession {
	session: AgentSession;
	/** Messages handed to this session through deliverIrcMessage. */
	delivered: IrcMessage[];
	/** Display-only relay cards emitted on this session. */
	relayed: CustomMessage[];
}

function makeFakeSession(settings?: Settings): FakeSession {
	const delivered: IrcMessage[] = [];
	const relayed: CustomMessage[] = [];
	const session = {
		isStreaming: true,
		...(settings ? { settings } : {}),
		deliverIrcMessage: async (msg: IrcMessage) => {
			delivered.push(msg);
			return "injected" as const;
		},
		emitIrcRelayObservation: (record: CustomMessage) => {
			relayed.push(record);
		},
	};
	return { session: session as unknown as AgentSession, delivered, relayed };
}

/** An `irc:incoming` record for the bridge queues. */
function incomingRecord(index: number, from = "0-Peer"): AgentMessage {
	return {
		role: "custom",
		customType: "irc:incoming",
		content: `[${index}] ${from}: queued`,
		display: true,
		details: { id: `msg-${index}`, from, message: `queued-${index}` },
		attribution: "agent",
		timestamp: index,
	} as unknown as AgentMessage;
}

/** A bridge host that reports a streaming turn and swallows every side effect. */
function makeBridgeHost(): IrcBridgeHost {
	return {
		agent: { steer: () => {}, appendMessage: () => {} } as never,
		sessionManager: { appendCustomMessageEntry: () => {} } as never,
		isDisposed: () => false,
		isStreaming: () => true,
		planModeEnabled: () => false,
		emitSessionEvent: async () => {},
		wakeForIrc: () => {},
	};
}

describe("IrcBus ingress guard", () => {
	let registry: AgentRegistryApi;
	let clock: { now: number };

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		// A frozen wall clock keeps the windows deterministic: the guard reads
		// `message.ts`, so advancing `clock.now` is how a test lets a window lapse.
		clock = { now: 1_760_000_000_000 };
		vi.spyOn(Date, "now").mockImplementation(() => clock.now);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makeBus(overrides: Record<string, unknown> = {}): IrcBusApi {
		return new IrcBus(registry, undefined, {
			settings: Settings.isolated({ "compaction.enabled": false, ...overrides }),
		});
	}

	/** Registers the main agent, a sender and a sink that records what it receives. */
	function registerPeers(): { main: FakeSession; sender: FakeSession; sink: FakeSession } {
		const main = makeFakeSession();
		const sender = makeFakeSession();
		const sink = makeFakeSession();
		registry.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: main.session });
		registry.register({ id: "0-Sender", displayName: "sender", kind: "sub", session: sender.session });
		registry.register({ id: "0-Sink", displayName: "sink", kind: "sub", session: sink.session });
		return { main, sender, sink };
	}

	it("exempts team control rate charging without exempting ordinary traffic, dedup, or hops", async () => {
		const bus = makeBus();
		const { sink } = registerPeers();
		const ordinary = { from: "0-Sender", to: "0-Sink", body: "ordinary".padEnd(120, "x") };
		expect((await bus.send(ordinary)).outcome).toBe("injected");
		const control = { from: "0-Sender", to: "0-Sink", body: "stop-request-1".padEnd(120, "x"), teamControl: true };
		expect((await bus.send(control)).outcome).toBe("injected");
		expect((await bus.send({ ...control, body: "stop-request-2".padEnd(120, "x") })).outcome).toBe("injected");
		const refused = await bus.send({ ...ordinary, body: "another ordinary message" });
		expect(refused.error).toStartWith("rate limited");
		expect((await bus.send(control)).error).toStartWith("duplicate");
		expect((await bus.send({ ...control, body: "hop overflow", hops: Array(28).fill("peer") })).error).toStartWith(
			"hop limit",
		);
		expect(bus.unansweredSends("0-Sender", 0)).toEqual([expect.objectContaining({ to: "0-Sink", promised: false })]);
		expect(sink.delivered).toHaveLength(3);
		expect(
			sink.delivered.slice(1).every(message => !message.progress && !message.wakeRelay && !message.broadcast),
		).toBe(true);
	});

	it("an agent-authored send cannot claim teamControl", async () => {
		// The public messaging path (`write agent://<id>`) builds its messages
		// from explicit fields. An agent must not be able to smuggle the
		// runtime-only exemptions (teamControl/teamNotice) into its own send
		// through extra params — a future `...params` spread in executeSend
		// would reopen that hole, and this test would catch it. executeSend uses
		// the process-global bus, so the guarded policy must be installed there.
		IrcBus.installGlobal(
			new IrcBus(registry, undefined, {
				settings: Settings.isolated({ "compaction.enabled": false, "irc.rateLimitTokens": 3 }),
			}),
		);
		registerPeers();
		const sink = makeFakeSession();
		registry.register({ id: "0-Target", displayName: "target", kind: "sub", session: sink.session });

		// Extra fields an agent cannot normally pass through the typed params;
		// executeSend must drop them.
		await executeSend(
			{ registry, senderId: "0-Sender" },
			{
				to: "0-Target",
				message: "12 characters",
				...({ teamControl: true, teamNotice: true } as Record<string, unknown>),
			},
		);
		// The delivered message carries no runtime-only flags.
		expect(sink.delivered[0]?.teamControl).not.toBe(true);
		expect(sink.delivered[0]?.teamNotice).not.toBe(true);

		// The send was charged like ordinary traffic: a distinct second send in
		// the same window exceeds the 3-token budget (each body costs 4 tokens).
		const second = await executeSend(
			{ registry, senderId: "0-Sender" },
			{ to: "0-Target", message: "13 characters" },
		);
		expect(second.isError).toBe(true);
		expect(second.details?.receipts?.[0]?.error).toStartWith("rate limited");
	});

	it("refuses a sender's flood past 30 tokens per 500 ms, and lets it through after the window", async () => {
		const bus = makeBus();
		const { sink } = registerPeers();

		// 40 chars = 10 tokens: three fit a 30-token budget, the fourth does not.
		const receipts = [];
		for (let i = 0; i < 5; i++) {
			receipts.push(await bus.send({ from: "0-Sender", to: "0-Sink", body: `${i}`.padEnd(40, "x") }));
		}

		expect(receipts.map(receipt => receipt.outcome)).toEqual([
			"injected",
			"injected",
			"injected",
			"failed",
			"failed",
		]);
		expect(receipts[3]?.error).toStartWith("rate limited");
		expect(sink.delivered).toHaveLength(3);

		clock.now += 501;
		const afterWindow = await bus.send({ from: "0-Sender", to: "0-Sink", body: "fresh".padEnd(40, "y") });
		expect(afterWindow.outcome).toBe("injected");
		expect(sink.delivered).toHaveLength(4);
	});

	it("delivers a lone message larger than the whole rate budget, then cuts the burst", async () => {
		const bus = makeBus();
		const { sink } = registerPeers();
		// 500 chars = 125 tokens, more than four times the 30-token budget. A
		// single long report from a subagent must never be refused by a budget it
		// alone exceeds: an empty window always admits one message.
		const longBody = "a".repeat(500);
		const first = await bus.send({ from: "0-Sender", to: "0-Sink", body: longBody });
		expect(first.outcome).toBe("injected");
		expect(sink.delivered[0]?.body).toBe(longBody);

		// Flood semantics stay intact: the long message spent the window, so the
		// rest of the burst is refused until the window slides past it.
		const followUp = await bus.send({ from: "0-Sender", to: "0-Sink", body: "short follow-up" });
		expect(followUp.outcome).toBe("failed");
		expect(followUp.error).toStartWith("rate limited");

		clock.now += 501;
		const afterWindow = await bus.send({ from: "0-Sender", to: "0-Sink", body: "after the window" });
		expect(afterWindow.outcome).toBe("injected");
		expect(sink.delivered.map(message => message.body)).toEqual([longBody, "after the window"]);
	});

	it("counts the rate budget per sender: two senders under the limit both pass", async () => {
		const bus = makeBus();
		registerPeers();
		const other = makeFakeSession();
		registry.register({ id: "0-Other", displayName: "other", kind: "sub", session: other.session });

		const receipts = [];
		for (let i = 0; i < 3; i++) {
			receipts.push(await bus.send({ from: "0-Sender", to: "0-Sink", body: `a${i}`.padEnd(40, "x") }));
			receipts.push(await bus.send({ from: "0-Other", to: "0-Sink", body: `b${i}`.padEnd(40, "x") }));
		}

		expect(receipts.every(receipt => receipt.outcome === "injected")).toBe(true);
	});

	it("does not spend budget on a refused message, so the window still has room for what fits", async () => {
		const bus = makeBus();
		const { sink } = registerPeers();

		// One 30-token window: 40 chars = 10 tokens, 100 chars = 25, 48 chars = 12.
		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body: "ten".padEnd(40, "x") })).outcome).toBe(
			"injected",
		);
		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body: "twentyfive".padEnd(100, "x") })).outcome).toBe(
			"failed",
		);
		// Still inside the same window (the first send is 200 ms old). Had the
		// refusal been charged, 35 tokens would be spent and this 12-token send
		// (47 total) refused; charged nothing, 10 + 12 = 22 fits.
		clock.now += 200;
		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body: "twelve".padEnd(48, "x") })).outcome).toBe(
			"injected",
		);
		expect(sink.delivered).toHaveLength(2);
	});

	it("cuts a flood spread over several recipients: the rate key is the sender, not the pair", async () => {
		const bus = makeBus();
		registerPeers();
		const peers: FakeSession[] = [];
		for (let index = 0; index < 4; index++) {
			const peer = makeFakeSession();
			registry.register({ id: `0-Peer${index}`, displayName: `peer${index}`, kind: "sub", session: peer.session });
			peers.push(peer);
		}

		const receipts = [];
		for (let index = 0; index < 4; index++) {
			receipts.push(
				await bus.send({ from: "0-Sender", to: `0-Peer${index}`, body: `msg-${index}`.padEnd(40, "x") }),
			);
		}

		// Three 10-token sends exhaust the 30-token budget however many recipients
		// they are spread over; the fourth peer never sees its message.
		expect(receipts.slice(0, 3).every(receipt => receipt.outcome === "injected")).toBe(true);
		expect(receipts[3]?.outcome).toBe("failed");
		expect(receipts[3]?.error).toStartWith("rate limited");
		expect(peers[3]?.delivered).toHaveLength(0);
	});

	it("neither refills the budget nor lets a flood through after a backward wall-clock step", async () => {
		const bus = makeBus({ "irc.rateLimitTokens": 20 });
		const { sink } = registerPeers();

		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body: "first".padEnd(40, "x") })).outcome).toBe(
			"injected",
		);
		// A backward NTP correction must not make the first send look newer than it
		// is: the second send is still charged against the same window.
		clock.now -= 10_000;
		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body: "second".padEnd(40, "x") })).outcome).toBe(
			"injected",
		);
		clock.now += 10_000;
		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body: "third".padEnd(40, "x") })).outcome).toBe(
			"failed",
		);
		expect(sink.delivered).toHaveLength(2);
	});

	it("refuses an identical body to the same recipient within the dedup window", async () => {
		const bus = makeBus();
		const { sink } = registerPeers();

		const first = await bus.send({ from: "0-Sender", to: "0-Sink", body: "the same text" });
		const repeat = await bus.send({ from: "0-Sender", to: "0-Sink", body: "the same text" });
		const different = await bus.send({ from: "0-Sender", to: "0-Sink", body: "a different text" });
		// Same body to another recipient is a different message.
		const otherRecipient = makeFakeSession();
		registry.register({ id: "0-Third", displayName: "third", kind: "sub", session: otherRecipient.session });
		const elsewhere = await bus.send({ from: "0-Sender", to: "0-Third", body: "the same text" });

		expect(first.outcome).toBe("injected");
		expect(repeat.outcome).toBe("failed");
		expect(repeat.error).toStartWith("duplicate");
		expect(different.outcome).toBe("injected");
		expect(elsewhere.outcome).toBe("injected");
		expect(sink.delivered.map(msg => msg.body)).toEqual(["the same text", "a different text"]);

		clock.now += 30_001;
		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body: "the same text" })).outcome).toBe("injected");
	});

	it("a duplicate refusal spends no rate budget, so a later distinct message is not rate-limited", async () => {
		const bus = makeBus({ "irc.rateLimitTokens": 20, "irc.dedupWindowMs": 60_000 });
		const { sink } = registerPeers();
		const body = "d".repeat(40); // 10 tokens

		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body })).outcome).toBe("injected");
		const duplicate = await bus.send({ from: "0-Sender", to: "0-Sink", body });
		expect(duplicate.outcome).toBe("failed");
		expect(duplicate.error).toStartWith("duplicate");

		// Before the fix the duplicate still charged 10 tokens (20 total), so this
		// distinct 10-token send tripped the 20-token ceiling. Refusals now spend
		// nothing: only the accepted first send is charged, leaving room.
		const different = await bus.send({ from: "0-Sender", to: "0-Sink", body: "e".repeat(40) });
		expect(different.outcome).toBe("injected");
		expect(sink.delivered.map(msg => msg.body)).toEqual([body, "e".repeat(40)]);
	});

	it("does not claim a dedup key when rate limiting refuses a message", async () => {
		const bus = makeBus({ "irc.rateLimitTokens": 10, "irc.dedupWindowMs": 60_000 });
		const { sink } = registerPeers();
		const first = "a".repeat(40);
		const refused = "b".repeat(40);
		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body: first })).outcome).toBe("injected");
		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body: refused })).error).toStartWith("rate limited");
		clock.now += 501;
		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body: refused })).outcome).toBe("injected");
		expect(sink.delivered.map(message => message.body)).toEqual([first, refused]);
	});

	it("never dedupes progress notes or automated wake relays, which legitimately repeat", async () => {
		const bus = makeBus();
		const { sink } = registerPeers();

		const progress = await Promise.all([
			bus.send({ from: "0-Sender", to: "0-Sink", body: "still working", progress: true }),
			bus.send({ from: "0-Sender", to: "0-Sink", body: "still working", progress: true }),
		]);
		const relays = await Promise.all([
			bus.send({ from: "0-Sender", to: "0-Sink", body: "same output", wakeRelay: true, replyTo: "a" }),
			bus.send({ from: "0-Sender", to: "0-Sink", body: "same output", wakeRelay: true, replyTo: "b" }),
		]);

		expect(progress.map(receipt => receipt.outcome)).toEqual(["injected", "injected"]);
		expect(relays.map(receipt => receipt.outcome)).toEqual(["injected", "injected"]);
		expect(sink.delivered).toHaveLength(4);
	});

	it("refuses a hop chain longer than 28 and records the sender as the newest hop", async () => {
		const bus = makeBus();
		const { sink } = registerPeers();
		const chain = Array.from({ length: 28 }, (_, index) => `hop-${index}`);

		const tooLong = await bus.send({ from: "0-Sender", to: "0-Sink", body: "loop", hops: chain });
		expect(tooLong.outcome).toBe("failed");
		expect(tooLong.error).toStartWith("hop limit");
		expect(sink.delivered).toHaveLength(0);

		const atLimit = await bus.send({ from: "0-Sender", to: "0-Sink", body: "relay", hops: chain.slice(0, 27) });
		expect(atLimit.outcome).toBe("injected");
		expect(sink.delivered[0]?.hops).toEqual([...chain.slice(0, 27), "0-Sender"]);

		const fresh = await bus.send({ from: "0-Sender", to: "0-Sink", body: "direct" });
		expect(fresh.outcome).toBe("injected");
		expect(sink.delivered[1]?.hops).toEqual(["0-Sender"]);
	});

	it("relays only accepted messages to the main UI and records no send for a refusal", async () => {
		const bus = makeBus({ "irc.rateLimitTokens": 10 });
		const { main } = registerPeers();

		const accepted = await bus.send({ from: "0-Sender", to: "0-Sink", body: "one".padEnd(40, "x") });
		const refused = await bus.send({ from: "0-Sender", to: "0-Sink", body: "two".padEnd(40, "x") });

		expect(accepted.outcome).toBe("injected");
		expect(refused.outcome).toBe("failed");
		// The display-only relay follows delivery, so a refused send never shows up there.
		expect(main.relayed.map(record => record.content)).toHaveLength(1);
		expect(main.relayed[0]?.content).toContain("one");

		// A recipient that only ever saw refusals has no send mark at all: a refusal
		// is not a send, so `sentSince`/`unansweredSends` cannot read it as one.
		const quiet = makeFakeSession();
		registry.register({ id: "0-Quiet", displayName: "quiet", kind: "sub", session: quiet.session });
		expect((await bus.send({ from: "0-Sender", to: "0-Quiet", body: "three".padEnd(40, "x") })).outcome).toBe(
			"failed",
		);
		expect((await bus.send({ from: "0-Sender", to: "0-Quiet", body: "four".padEnd(40, "x") })).outcome).toBe(
			"failed",
		);
		expect(bus.sentSince("0-Sender", "0-Quiet", 0)).toBe(false);
		expect(bus.sentSince("0-Sender", "0-Sink", 0)).toBe(true);
	});

	it("does not charge a broadcast's legs against the sender's rate budget", async () => {
		const bus = makeBus();
		registerPeers();
		const recipients: FakeSession[] = [];
		for (let index = 0; index < 10; index++) {
			const recipient = makeFakeSession();
			registry.register({
				id: `0-Peer${index}`,
				displayName: `peer${index}`,
				kind: "sub",
				session: recipient.session,
			});
			recipients.push(recipient);
		}

		// One authored announcement the tool fans out to 10 peers: 50 tokens per leg
		// would exhaust the budget were each leg charged.
		const legs = await Promise.all(
			recipients.map((_, index) =>
				bus.send({
					from: "0-Sender",
					to: `0-Peer${index}`,
					body: "announcement".padEnd(200, "x"),
					broadcast: true,
				}),
			),
		);
		expect(legs.every(receipt => receipt.outcome === "injected")).toBe(true);

		// The broadcast spent no budget, so a direct message still fits, and the
		// next one does not.
		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body: "direct one".padEnd(120, "x") })).outcome).toBe(
			"injected",
		);
		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body: "direct two".padEnd(120, "x") })).outcome).toBe(
			"failed",
		);
	});

	it("does nothing when the guard is disabled by settings", async () => {
		const bus = makeBus({ "irc.ingressGuard": false });
		const { sink } = registerPeers();

		const receipts = [];
		for (let index = 0; index < 40; index++) {
			receipts.push(await bus.send({ from: "0-Sender", to: "0-Sink", body: "identical body" }));
		}

		expect(receipts.every(receipt => receipt.outcome === "injected")).toBe(true);
		expect(sink.delivered).toHaveLength(40);
	});

	it("takes the policy from the sending agent's live session when the bus carries none", async () => {
		// The production bus has no explicit scope: a session holds the settings it
		// was created with, and that is the policy its sends run under.
		const sender = makeFakeSession(Settings.isolated({ "irc.rateLimitTokens": 10 }));
		const sink = makeFakeSession();
		registry.register({ id: "0-Sender", displayName: "sender", kind: "sub", session: sender.session });
		registry.register({ id: "0-Sink", displayName: "sink", kind: "sub", session: sink.session });
		const bus = new IrcBus(registry);

		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body: "one".padEnd(40, "x") })).outcome).toBe(
			"injected",
		);
		expect((await bus.send({ from: "0-Sender", to: "0-Sink", body: "two".padEnd(40, "x") })).outcome).toBe("failed");
	});

	it("falls back to the main session's policy so a worker-proxied sender is guarded too", async () => {
		// A worker's ref in main's registry carries no local settings; the main
		// session's process-wide policy is what its proxied send runs under.
		const main = makeFakeSession(Settings.isolated({ "irc.rateLimitTokens": 10 }));
		const proxied = makeFakeSession();
		const sink = makeFakeSession();
		registry.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: main.session });
		registry.register({ id: "0-Worker", displayName: "worker", kind: "sub", session: proxied.session });
		registry.register({ id: "0-Sink", displayName: "sink", kind: "sub", session: sink.session });
		const bus = new IrcBus(registry);

		expect((await bus.send({ from: "0-Worker", to: "0-Sink", body: "one".padEnd(40, "x") })).outcome).toBe(
			"injected",
		);
		expect((await bus.send({ from: "0-Worker", to: "0-Sink", body: "two".padEnd(40, "x") })).outcome).toBe("failed");
	});

	it("returns a failed receipt for the 51st send to a full recipient queue and keeps the earlier records", async () => {
		const bus = makeBus({ "irc.ingressGuard": false });
		const { sink } = registerPeers();
		// A real streaming bridge replaces the sink's fake delivery so its
		// interrupts queue actually fills. Disabling the ingress guard keeps all
		// 51 sends on the delivery path (no rate/dedup refusal in the way).
		const bridge = new IrcBridge(makeBridgeHost());
		Object.assign(sink.session, { deliverIrcMessage: (msg: IrcMessage) => bridge.deliver(msg) });

		const receipts = [];
		for (let index = 1; index <= 51; index++) {
			receipts.push(await bus.send({ from: "0-Sender", to: "0-Sink", body: `queued-${index}` }));
		}
		expect(receipts.slice(0, 50).every(receipt => receipt.outcome === "injected")).toBe(true);
		expect(receipts[50]?.outcome).toBe("failed");
		expect(receipts[50]?.error).toContain("recipient queue full");
		expect(bus.unreadCount("0-Sink")).toBe(0);
		expect(bus.take("0-Sink")).toBeUndefined();
		const drained = bridge.drainPending();
		expect(drained).toHaveLength(50);
		expect("details" in drained[0]! ? drained[0]!.details : undefined).toMatchObject({ message: "queued-1" });
		expect("details" in drained[49]! ? drained[49]!.details : undefined).toMatchObject({ message: "queued-50" });
	});
});

describe("IrcIngressGuard sender-window cap", () => {
	const limits = { rateLimitTokens: 30, dedupWindowMs: 0, maxHops: 0 };

	it("evicts the oldest window when a sweep cannot free a slot", () => {
		const guard = new IrcIngressGuard();
		// 300 senders all inside one 500 ms window: the idle sweep cannot free
		// anything, so the cap must evict the oldest window rather than grow.
		for (let index = 0; index < 300; index++) {
			expect(
				guard.check(
					{ id: `m-${index}`, from: `sender-${index}`, to: "sink", body: `x${index}`, ts: index },
					limits,
				),
			).toBeUndefined();
		}
		expect(guard.rateWindowCount).toBe(256);
	});

	it("sweeps idle senders first, keeping the live ones", () => {
		const guard = new IrcIngressGuard();
		for (let index = 0; index < 256; index++) {
			guard.check({ id: `m-${index}`, from: `sender-${index}`, to: "sink", body: `x${index}`, ts: 0 }, limits);
		}
		// Every window above is 600 ms old: a new sender's sweep frees them all.
		expect(
			guard.check({ id: "late", from: "late-sender", to: "sink", body: "late", ts: 600 }, limits),
		).toBeUndefined();
		expect(guard.rateWindowCount).toBe(1);
	});
});

describe("IrcBridge incoming queue backpressure", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps every queued aside instead of silently dropping records past the cap", () => {
		const bridge = new IrcBridge(makeBridgeHost());

		for (let index = 1; index <= 61; index++) bridge.queueAside([incomingRecord(index)]);

		const drained = bridge.drainPending();
		expect(drained).toHaveLength(61);
		expect("details" in drained[0]! ? drained[0]!.details : undefined).toMatchObject({ message: "queued-1" });
		expect("details" in drained[60]! ? drained[60]!.details : undefined).toMatchObject({ message: "queued-61" });
	});

	it("restorePending keeps the whole rolled-back snapshot even when it exceeds the cap", () => {
		const bridge = new IrcBridge(makeBridgeHost());
		bridge.queueAside(Array.from({ length: 55 }, (_, index) => incomingRecord(index + 1)));
		const snapshot = bridge.clearPending();
		bridge.restorePending(snapshot);
		expect(bridge.drainPending()).toHaveLength(55);
	});

	it("restores older queued records ahead of arrivals and refuses until the combined queues drain", async () => {
		const bridge = new IrcBridge(makeBridgeHost());
		bridge.queueAside(Array.from({ length: 30 }, (_, index) => incomingRecord(index + 1)));
		const snapshot = bridge.clearPending();
		bridge.queueAside(Array.from({ length: 20 }, (_, index) => incomingRecord(index + 31)));
		bridge.queueDeferredWake([incomingRecord(51)]);
		bridge.restorePending(snapshot);
		const message: IrcMessage = { id: "new", from: "0-Peer", to: "0-Busy", body: "new", ts: 52 };
		await expect(bridge.deliver(message)).rejects.toThrow("recipient queue full");
		const drained = bridge.drainPending();
		expect(drained).toEqual(Array.from({ length: 50 }, (_, index) => incomingRecord(index + 1)));
		expect(bridge.drainDeferredWakes()).toHaveLength(1);
		expect(await bridge.deliver(message)).toBe("injected");
	});

	it("refuses the 51st delivery to a full queue instead of dropping an acknowledged record", async () => {
		const registry = AgentRegistry.global();
		const main = makeFakeSession();
		const busy = makeFakeSession();
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		registry.register({
			id: "0-Busy",
			displayName: "busy",
			kind: "sub",
			parentId: "0-Main",
			session: busy.session,
		});
		registry.register({ id: "0-Peer", displayName: "peer", kind: "sub", session: makeFakeSession().session });
		const bridge = new IrcBridge(makeBridgeHost());

		const deliver = (index: number) =>
			bridge.deliver({
				id: `irc-${index}`,
				from: "0-Peer",
				to: "0-Busy",
				body: `queued-${index}`,
				ts: index,
			});
		for (let index = 1; index <= 50; index++) expect(await deliver(index)).toBe("injected");
		await expect(deliver(51)).rejects.toThrow("recipient queue full");

		const drained = bridge.drainPending();
		expect(drained).toHaveLength(50);
		expect("details" in drained[0]! ? drained[0]!.details : undefined).toMatchObject({ message: "queued-1" });
		expect("details" in drained[49]! ? drained[49]!.details : undefined).toMatchObject({ message: "queued-50" });
	});
});
