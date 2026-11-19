/**
 * Offline mock collab host: starts the local relay, opens a room as host, and
 * serves the canned fixture session to any collab-web guest that joins.
 *
 *   bun scripts/mock-host.ts [--port 7466]
 *
 * Replays a scripted streaming turn on every guest prompt, ticks subagent
 * progress on the bus every 2s, and answers fetch-transcript with byte slices
 * of the fixture JSONL — exactly the frames a real `omp /collab` host emits.
 */

import type { AgentSnapshot, HostFrame, SessionEntry, SessionState, WireFrame } from "@oh-my-pi/pi-wire";
import { generateRoomKey, importRoomKey, open, seal } from "../src/lib/codec";
import { COLLAB_PROTO, formatCollabLink, generateRoomId, packEnvelope, unpackEnvelope } from "../src/lib/link";
import {
	fixtureAgents,
	fixtureEntries,
	fixtureHeader,
	fixtureModel,
	HOST_DISPLAY_NAME,
	makeProbeProgress,
	makeScriptedTurn,
	type ScriptedStep,
	subagentTranscriptJsonl,
} from "./fixture";
import { startLocalRelay } from "./local-relay";

const DEFAULT_PORT = 7466;
const STEP_INTERVAL_MS = 40;
const TICK_INTERVAL_MS = 2_000;
const AGENTS_SNAPSHOT_EVERY = 5;

function parsePort(argv: string[]): number {
	let raw: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--port") raw = argv[i + 1];
		else if (arg.startsWith("--port=")) raw = arg.slice("--port=".length);
	}
	if (raw === undefined) return DEFAULT_PORT;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		console.error(`mock-host: invalid --port ${raw}`);
		process.exit(1);
	}
	return port;
}

const port = parsePort(Bun.argv.slice(2));
const relay = startLocalRelay(port);
const roomId = generateRoomId();
const rawKey = generateRoomKey();
const key = await importRoomKey(rawKey);
const link = formatCollabLink(relay.url, roomId, rawKey);

// ── mutable session state ────────────────────────────────────────────────────

const entries: SessionEntry[] = [...fixtureEntries];
const agents: AgentSnapshot[] = fixtureAgents.map(agent => ({ ...agent }));
const peers = new Map<number, string>();
const transcriptBytes = new TextEncoder().encode(subagentTranscriptJsonl);
const transcriptDecoder = new TextDecoder();

let lastEntryId: string | null = entries[entries.length - 1]?.id ?? null;
let streaming = false;
let queuedPrompts = 0;
let turnSeq = 0;
let liveEntrySeq = 0;
let replayQueue: ScriptedStep[] = [];
let replayTimer: Timer | null = null;
let tick = 0;
let shuttingDown = false;

// ── sealed transport (order-preserving, mirrors relay-client) ────────────────

const ws = new WebSocket(`${relay.url}/r/${roomId}?role=host`);
ws.binaryType = "arraybuffer";

let sendChain: Promise<void> = Promise.resolve();
let recvChain: Promise<void> = Promise.resolve();

/** Seal and send a frame; peerId 0 broadcasts, N targets that guest. */
function sendFrame(frame: HostFrame, targetPeer = 0): void {
	sendChain = sendChain
		.then(async () => {
			if (ws.readyState !== WebSocket.OPEN) return;
			const sealed = await seal(key, frame);
			ws.send(packEnvelope(targetPeer, sealed));
		})
		.catch((err: unknown) => {
			console.error("mock-host: send failed:", err);
		});
}

function buildState(): SessionState {
	const participants: SessionState["participants"] = [{ name: HOST_DISPLAY_NAME, role: "host" }];
	for (const name of peers.values()) participants.push({ name, role: "guest" });
	const tokens = 51_000 + entries.length * 120;
	return {
		isStreaming: streaming,
		queuedMessageCount: queuedPrompts,
		sessionName: fixtureHeader.title,
		cwd: fixtureHeader.cwd,
		model: fixtureModel,
		thinkingLevel: "medium",
		contextUsage: {
			tokens,
			contextWindow: fixtureModel.contextWindow,
			percent:
				fixtureModel.contextWindow !== null && fixtureModel.contextWindow > 0
					? (tokens / fixtureModel.contextWindow) * 100
					: null,
		},
		participants,
	};
}

function broadcastState(): void {
	sendFrame({ t: "state", state: buildState() });
}

function appendEntry(entry: SessionEntry): void {
	entries.push(entry);
	lastEntryId = entry.id;
	sendFrame({ t: "entry", entry });
}

function notice(level: "info" | "warning" | "error", message: string): void {
	sendFrame({ t: "event", event: { type: "notice", level, message, source: "collab" } });
}

// ── scripted turn replay ─────────────────────────────────────────────────────

function startReplay(): void {
	turnSeq++;
	replayQueue = makeScriptedTurn(turnSeq, lastEntryId);
	scheduleStep();
}

function scheduleStep(): void {
	replayTimer = setTimeout(() => {
		replayTimer = null;
		const step = replayQueue.shift();
		if (step) applyStep(step);
		if (replayQueue.length > 0) {
			scheduleStep();
			return;
		}
		if (queuedPrompts > 0) {
			queuedPrompts--;
			startReplay();
		}
	}, STEP_INTERVAL_MS);
}

function applyStep(step: ScriptedStep): void {
	switch (step.kind) {
		case "event":
			sendFrame({ t: "event", event: step.event });
			break;
		case "entry":
			appendEntry(step.entry);
			break;
		case "state":
			streaming = step.streaming;
			broadcastState();
			break;
	}
}

function cancelReplay(): void {
	if (replayTimer !== null) {
		clearTimeout(replayTimer);
		replayTimer = null;
	}
	replayQueue = [];
}

// ── guest frame handling ─────────────────────────────────────────────────────

function peerName(fromPeer: number): string {
	return peers.get(fromPeer) ?? `guest-${fromPeer}`;
}

function handleHello(name: string, proto: number, fromPeer: number): void {
	if (proto !== COLLAB_PROTO) {
		sendFrame(
			{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
			fromPeer,
		);
		return;
	}
	const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
	peers.set(fromPeer, cleanName);
	sendFrame(
		{
			t: "welcome",
			proto: COLLAB_PROTO,
			header: fixtureHeader,
			state: buildState(),
			agents: agents.map(agent => ({ ...agent })),
			entryCount: entries.length,
		},
		fromPeer,
	);
	sendFrame({ t: "snapshot-chunk", entries: [...entries], final: true }, fromPeer);
	console.log(`mock-host: ${cleanName} joined (peer ${fromPeer})`);
	broadcastState();
}

function handlePrompt(text: string, fromPeer: number): void {
	liveEntrySeq++;
	appendEntry({
		id: `live-${liveEntrySeq}`,
		parentId: lastEntryId,
		timestamp: new Date().toISOString(),
		type: "custom_message",
		customType: "collab-prompt",
		content: text,
		details: { from: peerName(fromPeer) },
		display: true,
	});
	if (replayTimer !== null || replayQueue.length > 0) {
		queuedPrompts++;
		broadcastState();
		return;
	}
	startReplay();
}

function handleAbort(fromPeer: number): void {
	const wasReplaying = replayTimer !== null || replayQueue.length > 0;
	cancelReplay();
	queuedPrompts = 0;
	notice("info", `${peerName(fromPeer)} interrupted`);
	if (wasReplaying) sendFrame({ t: "event", event: { type: "agent_end" } });
	streaming = false;
	broadcastState();
}

function handleAgentCmd(cmd: string, agentId: string, fromPeer: number): void {
	notice("info", `${peerName(fromPeer)} sent agent-cmd ${cmd} → ${agentId}`);
}

function handleFetchTranscript(reqId: number, fromByte: number, fromPeer: number): void {
	const total = transcriptBytes.byteLength;
	const start = Math.max(0, Math.min(fromByte, total));
	const text = start >= total ? "" : transcriptDecoder.decode(transcriptBytes.subarray(start));
	// We always serve to EOF, so the next offset base is the full size.
	sendFrame({ t: "transcript", reqId, text, newSize: total }, fromPeer);
}

function handleFrame(frame: WireFrame, fromPeer: number): void {
	switch (frame.t) {
		case "hello":
			handleHello(frame.name, frame.proto, fromPeer);
			break;
		case "prompt":
			handlePrompt(frame.text, fromPeer);
			break;
		case "abort":
			handleAbort(fromPeer);
			break;
		case "agent-cmd":
			handleAgentCmd(frame.cmd, frame.agentId, fromPeer);
			break;
		case "fetch-transcript":
			handleFetchTranscript(frame.reqId, frame.fromByte, fromPeer);
			break;
		default:
			// Host-frame echoes or unknown types: ignore.
			break;
	}
}

function handleControl(text: string): void {
	let msg: unknown;
	try {
		msg = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof msg !== "object" || msg === null) return;
	const control = msg as { t?: unknown; peer?: unknown };
	if (control.t === "peer-left" && typeof control.peer === "number") {
		const name = peers.get(control.peer);
		peers.delete(control.peer);
		if (name) console.log(`mock-host: ${name} left (peer ${control.peer})`);
		broadcastState();
	}
}

ws.onopen = () => {
	console.log("mock collab host ready");
	console.log(`join link: ${link}`);
	console.log("paste the link into the collab-web connect screen (bun ./index.html), Ctrl+C stops the host");
};

ws.onmessage = event => {
	const data: unknown = event.data;
	if (typeof data === "string") {
		handleControl(data);
		return;
	}
	if (!(data instanceof ArrayBuffer)) return;
	const envelope = unpackEnvelope(new Uint8Array(data));
	if (!envelope) return;
	recvChain = recvChain
		.then(async () => {
			const frame = await open(key, envelope.payload);
			handleFrame(frame, envelope.peerId);
		})
		.catch((err: unknown) => {
			console.error("mock-host: dropping undecryptable frame:", err);
		});
};

ws.onclose = event => {
	if (shuttingDown) return;
	console.error(`mock-host: relay socket closed (${event.code} ${event.reason || "no reason"})`);
	shutdown(1);
};

// ── progress ticker ──────────────────────────────────────────────────────────

const tickInterval: Timer = setInterval(() => {
	tick++;
	sendFrame({ t: "bus", channel: "task:subagent:progress", data: makeProbeProgress(tick) });
	const now = Date.now();
	for (const agent of agents) {
		if (agent.status === "running") agent.lastActivity = now;
	}
	if (tick % AGENTS_SNAPSHOT_EVERY === 0) {
		sendFrame({ t: "agents", agents: agents.map(agent => ({ ...agent })) });
	}
}, TICK_INTERVAL_MS);

// ── shutdown ─────────────────────────────────────────────────────────────────

function shutdown(code: number): void {
	if (shuttingDown) return;
	shuttingDown = true;
	cancelReplay();
	clearInterval(tickInterval);
	sendFrame({ t: "bye", reason: "mock host shutting down" });
	// Let the bye flush through the send chain before tearing the room down.
	void sendChain.finally(() => {
		try {
			ws.close(1000);
		} catch {
			// already closing
		}
		relay.stop();
		process.exit(code);
	});
}

process.on("SIGINT", () => {
	console.log("\nmock-host: shutting down");
	shutdown(0);
});
