/**
 * Contract: ordinary streaming never ends the room.
 *
 * A streaming `message_update` carries the whole accumulating assistant
 * message, so a guest only ever needs the newest one. When the host emits
 * updates faster than its uplink drains them, the still-queued older updates
 * for the same message must be superseded rather than piling up until the send
 * queue's admission cap ends sharing for every guest (#16956).
 *
 * Drives the production `CollabHost` over the in-memory relay.
 */
import { afterEach, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
} from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import {
	type HostObservations,
	instrumentRelay,
	makeHostContext,
	type Snapshot,
	waitFor,
} from "./helpers/throttled-host";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	uninstallInMemoryRelay();
});

function assistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "claude-haiku-5-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 0,
	};
}

function streamedUpdate(text: string, delta: string): AgentSessionEvent {
	const message = assistant(text);
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
	};
}

function textOf(event: AgentSessionEvent): string {
	if (event.type !== "message_update" || event.message.role !== "assistant") return "";
	const block = event.message.content[0];
	return block?.type === "text" ? block.text : "";
}

it("supersedes queued updates of a streaming message instead of ending the room", async () => {
	const relay = installInMemoryRelay();
	// Throttled: nothing drains the host socket until the test says so, so every
	// update past the high-water mark stays queued — a host out-streaming its uplink.
	const probe = instrumentRelay(relay, { throttle: true });
	const snapshot: Snapshot = {
		header: { type: "session", id: "stream", timestamp: "2026-10-24T00:00:00Z", cwd: "/tmp" },
		entries: [],
	};
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const ctx = makeHostContext(snapshot, seen);
	const listeners: AgentSessionEventListener[] = [];
	const subscribe = ctx.session.subscribe.bind(ctx.session);
	ctx.session.subscribe = listener => {
		listeners.push(listener);
		return subscribe(listener);
	};
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners.slice()) listener(event);
	};
	const host = new CollabHost(ctx);
	cleanups.push(() => void host.stop("test done"));

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const hostWs = probe.hostSocket();

	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	const events: AgentSessionEvent[] = [];
	const welcomed = Promise.withResolvers<void>();
	guest.onFrame = (frame: CollabFrame) => {
		if (frame.t === "welcome") welcomed.resolve();
		if (frame.t === "event") events.push(frame.event as AgentSessionEvent);
	};
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "watcher" });
	guest.connect();
	await welcomed.promise;
	await waitFor(() => seen.participantCounts.some(count => count > 0), "host never registered the guest");

	// One long answer: far more updates than the queue admits, each a cumulative
	// snapshot of the message so far. Two messages, so supersession must not
	// cross the message boundary.
	const chunk = "geology of the Carpathian basin ".repeat(4);
	let text = "";
	emit({ type: "message_start", message: assistant("") });
	for (let i = 0; i < 600; i++) {
		text += chunk;
		emit(streamedUpdate(text, chunk));
	}
	const first = text;
	emit({ type: "message_end", message: assistant(first) });
	emit({ type: "message_start", message: assistant("") });
	emit(streamedUpdate("second", "second"));
	emit({ type: "message_end", message: assistant("second") });
	// Admission refusal ends the room synchronously inside the emitting call.
	expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);

	// Unthrottle the uplink: every write drains at once from here on.
	const throttledSend = hostWs.send.bind(hostWs);
	hostWs.send = data => {
		throttledSend(data);
		hostWs.bufferedAmount = 0;
	};
	hostWs.bufferedAmount = 0;
	await waitFor(
		() => events.filter(event => event.type === "message_end").length === 2,
		"guest never received both message_end events",
	);

	const trace = events.flatMap((event): (number | string)[] => {
		if (event.type === "message_update") return [textOf(event).length];
		return event.type === "message_start" || event.type === "message_end" ? [event.type] : [];
	});
	const firstEnd = trace.indexOf("message_end");
	const delivered = trace.slice(1, firstEnd);
	// Order survives: each message's newest update lands right before its end,
	// and the second message's update never supersedes the first's.
	expect(trace[0]).toBe("message_start");
	expect(trace.slice(firstEnd - 1)).toEqual([first.length, "message_end", "message_start", 6, "message_end"]);
	// Only updates already on their way were sent; the rest were superseded.
	expect(delivered.length).toBeLessThan(20);
	expect(delivered).toEqual(delivered.toSorted((a, b) => Number(a) - Number(b)));
	expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);
}, 15_000);
