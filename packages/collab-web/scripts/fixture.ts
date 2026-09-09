/**
 * Canned session data for the offline collab harness.
 *
 * One realistic host session (header + ~14 entries covering every renderer
 * branch), an agent registry (main + a running sub with ticking progress + a
 * parked sub with a transcript), a subagent transcript JSONL blob, and a
 * scripted streaming turn the mock host replays on every guest prompt.
 */
import type {
	AgentEvent,
	AgentSnapshot,
	AssistantMessage,
	SessionEntry,
	SessionHeader,
	SubagentProgressPayload,
	ToolCallContent,
	ToolResultMessage,
	WireModel,
	WireUsage,
} from "@oh-my-pi/pi-wire";

export const HOST_DISPLAY_NAME = "kai";

export const fixtureModel: WireModel = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	provider: "anthropic",
	contextWindow: 200_000,
};

const NOW = Date.now();
const MIN = 60_000;

function iso(tsMs: number): string {
	return new Date(tsMs).toISOString();
}

function mkUsage(input: number, output: number, cacheRead: number, cost: number): WireUsage {
	return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { total: cost } };
}

export const fixtureHeader: SessionHeader = {
	type: "session",
	id: "mock-collab-session",
	title: "relay reconnect audit",
	timestamp: iso(NOW - 32 * MIN),
	cwd: "/Users/kai/Projects/pi",
};

const ASSISTANT_AUDIT_TEXT = `## Reconnect audit

Three things to verify before touching anything:

- backoff window (1s → 30s, exponential)
- fatal close codes that must *never* retry
- the resync \`hello\` → \`welcome\` handshake on reopen

\`\`\`ts
const FATAL = new Set([4001, 4004, 4009, 4029]);
const delay = Math.min(1000 * 2 ** attempt, 30_000);
\`\`\`

Checking the actual implementation now.`;

export const fixtureEntries: SessionEntry[] = [
	{
		id: "e01",
		parentId: null,
		timestamp: iso(NOW - 31 * MIN),
		type: "message",
		message: {
			role: "user",
			content:
				"the guest socket sometimes stays dead after a relay redeploy — can you audit the reconnect path in relay-client.ts?",
			timestamp: NOW - 31 * MIN,
		},
	},
	{
		id: "e02",
		parentId: "e01",
		timestamp: iso(NOW - 30 * MIN),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking:
						"Reconnect semantics live in two places: the backoff loop in relay-client.ts and the fatal close codes in protocol.ts. I should read both before claiming anything — a redeploy closes with 1001, which must be treated as transient.",
				},
				{ type: "text", text: ASSISTANT_AUDIT_TEXT },
				{
					type: "toolCall",
					id: "call-bash-01",
					name: "bash",
					arguments: { command: 'rg -n "BACKOFF|MAX_PENDING" packages/coding-agent/src/collab/relay-client.ts' },
					intent: "Checking backoff constants",
				},
				{
					type: "toolCall",
					id: "call-read-01",
					name: "read",
					arguments: { path: "packages/coding-agent/src/collab/relay-clinet.ts", offset: 160, limit: 60 },
					intent: "Reading the close handler",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(2_410, 386, 18_200, 0.0119),
			stopReason: "toolUse",
			timestamp: NOW - 30 * MIN,
		},
	},
	{
		id: "e03",
		parentId: "e02",
		timestamp: iso(NOW - 30 * MIN + 4_000),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "call-bash-01",
			toolName: "bash",
			content: [
				{
					type: "text",
					text: "20:const BACKOFF_BASE_MS = 1_000;\n21:const BACKOFF_MAX_MS = 30_000;\n23:const MAX_PENDING_SENDS = 256;",
				},
			],
			isError: false,
			timestamp: NOW - 30 * MIN + 4_000,
		},
	},
	{
		id: "e04",
		parentId: "e03",
		timestamp: iso(NOW - 30 * MIN + 5_000),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "call-read-01",
			toolName: "read",
			content: [
				{
					type: "text",
					text: "ENOENT: no such file or directory\n  open 'packages/coding-agent/src/collab/relay-clinet.ts'\n    at open (node:internal/fs/promises:642:23)\n    at readRange (src/tools/read.ts:88:9)",
				},
			],
			isError: true,
			timestamp: NOW - 30 * MIN + 5_000,
		},
	},
	{
		id: "e05",
		parentId: "e04",
		timestamp: iso(NOW - 29 * MIN),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Typo on my end — the file is `relay-client.ts`. The backoff constants match the spec (1s base, 30s cap, 256-frame reconnect buffer); reading the close handler next.",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(3_080, 64, 20_540, 0.0124),
			stopReason: "stop",
			timestamp: NOW - 29 * MIN,
		},
	},
	{
		id: "e06",
		parentId: "e05",
		timestamp: iso(NOW - 26 * MIN),
		type: "message",
		message: {
			role: "user",
			content: "what about half-open sockets after a NAT rebind? do we ping at all?",
			timestamp: NOW - 26 * MIN,
		},
	},
	{
		id: "e07",
		parentId: "e06",
		timestamp: iso(NOW - 25 * MIN),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "The relay sends protocol-level pings, so a half-open socket dies within the idle window and lands in the normal close path. From there the client splits three ways:\n\n- transient drop → exponential retry, fresh `hello` on reopen\n- fatal close code (4001/4004/4009/4029) → surface the reason, stay down\n- decrypt failure → treated as fatal, since the key cannot heal",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(3_420, 142, 21_900, 0.0131),
			stopReason: "stop",
			timestamp: NOW - 25 * MIN,
		},
	},
	{
		id: "e08",
		parentId: "e07",
		timestamp: iso(NOW - 21 * MIN),
		type: "custom_message",
		customType: "collab-prompt",
		content:
			"also verify the relay drops the send buffer past 256 frames — we saw memory creep on a 6h session last week",
		details: { from: "ada" },
		display: true,
	},
	{
		id: "e09",
		parentId: "e08",
		timestamp: iso(NOW - 20 * MIN),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Good catch ada — `MAX_PENDING_SENDS` caps the reconnect buffer at 256 sealed envelopes and overflow is dropped (debug-logged), so no unbounded growth. The cost is silent frame loss, which the `welcome` resync on reopen covers.",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(3_900, 98, 23_400, 0.0138),
			stopReason: "stop",
			timestamp: NOW - 20 * MIN,
		},
	},
	{
		id: "e09-legacy-call",
		parentId: "e09",
		timestamp: iso(NOW - 19 * MIN),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Legacy transcript aliases should still render for old saved sessions." },
				{
					type: "toolCall",
					id: "legacy-search-01",
					name: "search",
					arguments: { pattern: "relay", paths: ["docs/collab.md"] },
					intent: "Legacy search alias sample",
				},
				{
					type: "toolCall",
					id: "legacy-find-01",
					name: "find",
					arguments: { paths: ["docs/**/*.md"] },
					intent: "Legacy find alias sample",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(4_020, 54, 23_500, 0.014),
			stopReason: "toolUse",
			timestamp: NOW - 19 * MIN,
		},
	},
	{
		id: "e09-legacy-search-result",
		parentId: "e09-legacy-call",
		timestamp: iso(NOW - 19 * MIN + 1_000),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "legacy-search-01",
			toolName: "search",
			content: [{ type: "text", text: "docs/collab.md:12:relay reconnect notes" }],
			isError: false,
			timestamp: NOW - 19 * MIN + 1_000,
		},
	},
	{
		id: "e09-legacy-find-result",
		parentId: "e09-legacy-call",
		timestamp: iso(NOW - 19 * MIN + 1_500),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "legacy-find-01",
			toolName: "find",
			content: [{ type: "text", text: "docs/collab.md\ndocs/collab-protocol.md" }],
			isError: false,
			timestamp: NOW - 19 * MIN + 1_500,
		},
	},
	{
		id: "e10",
		parentId: "e09",
		timestamp: iso(NOW - 14 * MIN),
		type: "compaction",
		summary:
			"Audited the collab reconnect path: exponential backoff 1s→30s confirmed; fatal close codes 4001/4004/4009/4029 never retry; decrypt failures are terminal; the reconnect buffer is capped at 256 sealed frames with drop-on-overflow, recovered by the welcome resync. Open question: ping cadence on idle relays behind aggressive NATs.",
		shortSummary: "reconnect audit findings",
		firstKeptEntryId: "e08",
		tokensBefore: 48_213,
	},
	{
		id: "e11",
		parentId: "e10",
		timestamp: iso(NOW - 13 * MIN),
		type: "model_change",
		model: fixtureModel.id,
	},
	{
		id: "e12",
		parentId: "e11",
		timestamp: iso(NOW - 13 * MIN + 5_000),
		type: "thinking_level_change",
		thinkingLevel: "medium",
	},
	{
		id: "e13",
		parentId: "e12",
		timestamp: iso(NOW - 9 * MIN),
		type: "message",
		message: {
			role: "user",
			content: "summarize what changed and what's left",
			timestamp: NOW - 9 * MIN,
		},
	},
	{
		id: "e14",
		parentId: "e13",
		timestamp: iso(NOW - 8 * MIN),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Done: backoff window verified, fatal-code table cross-checked against the relay, buffer cap documented. Left: an integration test that kills the relay mid-stream and asserts the guest resyncs from `welcome` without duplicated entries — RelayProbe is running that now, DocSweep already swept the docs.",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(12_640, 187, 31_780, 0.0212),
			stopReason: "stop",
			timestamp: NOW - 8 * MIN,
		},
	},
];

// ─── agents ──────────────────────────────────────────────────────────────────

export const fixtureAgents: AgentSnapshot[] = [
	{
		id: "main",
		displayName: "Main",
		kind: "main",
		status: "running",
		hasSessionFile: true,
		createdAt: NOW - 32 * MIN,
		lastActivity: NOW - 5_000,
	},
	{
		id: "RelayProbe",
		displayName: "RelayProbe",
		kind: "sub",
		parentId: "main",
		status: "running",
		hasSessionFile: true,
		createdAt: NOW - 6 * MIN,
		lastActivity: NOW - 2_000,
	},
	{
		id: "DocSweep",
		displayName: "DocSweep",
		kind: "sub",
		parentId: "main",
		status: "parked",
		hasSessionFile: true,
		createdAt: NOW - 25 * MIN,
		lastActivity: NOW - 11 * MIN,
	},
];

const PROBE_TOOLS = ["bash", "read", "grep", "edit"] as const;
const PROBE_TOOL_ARGS: Record<(typeof PROBE_TOOLS)[number], string> = {
	bash: "bun test packages/coding-agent/test/collab --filter reconnect",
	read: "packages/coding-agent/src/collab/relay-client.ts:168-197",
	grep: "scheduleRetry|failFatal",
	edit: "packages/coding-agent/test/collab/reconnect.test.ts",
};

/** Progress payload for the running sub; `tick` advances the counters. */
export function makeProbeProgress(tick: number): SubagentProgressPayload {
	const tool = PROBE_TOOLS[tick % PROBE_TOOLS.length]!;
	const recentTools = [1, 2, 3].map(back => {
		const prior = PROBE_TOOLS[(tick + PROBE_TOOLS.length * back - back) % PROBE_TOOLS.length]!;
		return { tool: prior, args: PROBE_TOOL_ARGS[prior], endMs: Date.now() - back * 2_000 };
	});
	return {
		index: 0,
		agent: "task",
		task: "probe relay reconnect under packet loss",
		parentToolCallId: "call-task-01",
		assignment: "Kill the relay mid-stream and assert the guest resyncs from welcome without duplicate entries.",
		sessionFile: "/tmp/omp/agents/RelayProbe.jsonl",
		progress: {
			index: 0,
			id: "RelayProbe",
			agent: "task",
			status: "running",
			task: "probe relay reconnect under packet loss",
			description: "relay reconnect probe",
			lastIntent: "Replaying drop scenario",
			currentTool: tool,
			currentToolArgs: PROBE_TOOL_ARGS[tool],
			recentTools,
			recentOutput: ["3 sockets reconnected in 1.2s", "0 duplicate entries after resync"],
			toolCount: 9 + tick,
			requests: 4 + Math.floor(tick / 3),
			tokens: 18_400 + tick * 450,
			contextTokens: 22_300 + tick * 510,
			contextWindow: fixtureModel.contextWindow ?? undefined,
			cost: 0.041 + tick * 0.0012,
			durationMs: 95_000 + tick * 2_000,
			resolvedModel: fixtureModel.id,
		},
	};
}

// ─── subagent transcript ─────────────────────────────────────────────────────

const SUB_T0 = NOW - 25 * MIN;

const subagentTranscriptLines: unknown[] = [
	{ type: "session", id: "mock-docsweep", timestamp: iso(SUB_T0), cwd: "/Users/kai/Projects/pi" },
	// Unknown entry type — guests must skip it (tolerant default branch).
	{ type: "session_init", id: "s00", parentId: null, timestamp: iso(SUB_T0), version: 3 },
	{
		id: "s01",
		parentId: null,
		timestamp: iso(SUB_T0 + 2_000),
		type: "message",
		message: {
			role: "user",
			content: "Sweep docs/collab.md for stale close-code references and report mismatches.",
			timestamp: SUB_T0 + 2_000,
		},
	},
	{
		id: "s02",
		parentId: "s01",
		timestamp: iso(SUB_T0 + 9_000),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Grep the doc for 4xxx codes, then diff against protocol.ts." },
				{ type: "text", text: "Scanning `docs/collab.md` for close-code mentions." },
				{
					type: "toolCall",
					id: "sub-call-01",
					name: "grep",
					arguments: { pattern: "40\\d\\d", paths: ["docs/collab.md"] },
					intent: "Finding close codes",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(1_180, 96, 0, 0.0021),
			stopReason: "toolUse",
			timestamp: SUB_T0 + 9_000,
		},
	},
	{
		id: "s03",
		parentId: "s02",
		timestamp: iso(SUB_T0 + 11_000),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "sub-call-01",
			toolName: "grep",
			content: [
				{
					type: "text",
					text: "docs/collab.md:41: 4001 room closed\ndocs/collab.md:42: 4004 no such room\ndocs/collab.md:43: 4009 host conflict\ndocs/collab.md:44: 4029 room full",
				},
			],
			isError: false,
			timestamp: SUB_T0 + 11_000,
		},
	},
	{
		id: "s04",
		parentId: "s03",
		timestamp: iso(SUB_T0 + 20_000),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "sub-call-02",
					name: "read",
					arguments: { path: "packages/coding-agent/src/collab/relay-client.ts", offset: 13, limit: 6 },
					intent: "Cross-checking the fatal table",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(1_460, 41, 980, 0.0024),
			stopReason: "toolUse",
			timestamp: SUB_T0 + 20_000,
		},
	},
	{
		id: "s05",
		parentId: "s04",
		timestamp: iso(SUB_T0 + 22_000),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "sub-call-02",
			toolName: "read",
			content: [
				{
					type: "text",
					text: '13:const FATAL_CLOSE_REASONS: Record<number, string> = {\n14:\t4001: "room closed",\n15:\t4004: "no such room",\n16:\t4009: "a host is already connected for this room",\n17:\t4029: "room is full",\n18:};',
				},
			],
			isError: false,
			timestamp: SUB_T0 + 22_000,
		},
	},
	{
		id: "s06",
		parentId: "s05",
		timestamp: iso(SUB_T0 + 30_000),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "All four close codes in `docs/collab.md` match `FATAL_CLOSE_REASONS` — no stale references. The doc could additionally mention that decrypt failures are fatal; flagged as a suggestion, not a mismatch.",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(1_720, 88, 1_240, 0.0029),
			stopReason: "stop",
			timestamp: SUB_T0 + 30_000,
		},
	},
];

/** DocSweep's session file, served by the mock host's fetch-transcript handler. */
export const subagentTranscriptJsonl: string = `${subagentTranscriptLines
	.map(line => JSON.stringify(line))
	.join("\n")}\n`;

// ─── scripted streaming turn ─────────────────────────────────────────────────

export type ScriptedStep =
	| { kind: "event"; event: AgentEvent }
	| { kind: "entry"; entry: SessionEntry }
	| { kind: "state"; streaming: boolean };

const TURN_THINKING_1 = "Guest wants a live check. ";
const TURN_THINKING_2 = "Guest wants a live check. I'll run the reconnect suite once and summarize the result.";
const TURN_TEXT_1 = "Kicking off a live reconnect probe ";
const TURN_TEXT_2 = "Kicking off a live reconnect probe — one suite run, then a verdict.";
const TURN_CLOSE_1 = "Probe passed: 3 reconnects, ";
const TURN_CLOSE_2 = "Probe passed: 3 reconnects, 0 duplicate entries after resync. The reconnect path holds.";

/**
 * One scripted streaming turn, replayed by the mock host at ~40ms cadence.
 *
 * `seq` keeps ids unique across replays; `parentId` chains the appended
 * entries onto the current transcript tail.
 */
export function makeScriptedTurn(seq: number, parentId: string | null): ScriptedStep[] {
	const ts = Date.now();
	const a1Id = `turn${seq}-a1`;
	const callId = `turn${seq}-call1`;
	const r1Id = `turn${seq}-r1`;
	const a2Id = `turn${seq}-a2`;
	const command = "bun test packages/coding-agent/test/collab --filter reconnect";
	const toolResultText =
		"3 tests passed (reconnect.test.ts)\n3 sockets reconnected in 1.2s\n0 duplicate entries after resync";

	const partial = (content: AssistantMessage["content"]): AssistantMessage => ({
		role: "assistant",
		content,
		model: fixtureModel.id,
		usage: mkUsage(0, 0, 0, 0),
		stopReason: "stop",
		timestamp: ts,
	});

	const toolCall: ToolCallContent = {
		type: "toolCall",
		id: callId,
		name: "bash",
		arguments: { command },
		intent: "Running the reconnect suite",
	};

	const a1Final: AssistantMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking: TURN_THINKING_2 }, { type: "text", text: TURN_TEXT_2 }, toolCall],
		model: fixtureModel.id,
		usage: mkUsage(4_310, 164, 24_800, 0.0147),
		stopReason: "toolUse",
		timestamp: ts,
	};

	const r1Message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text", text: toolResultText }],
		isError: false,
		timestamp: ts,
	};

	const a2Final: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: TURN_CLOSE_2 }],
		model: fixtureModel.id,
		usage: mkUsage(4_690, 52, 25_400, 0.0153),
		stopReason: "stop",
		timestamp: ts,
	};

	return [
		{ kind: "event", event: { type: "agent_start" } },
		{ kind: "state", streaming: true },
		{ kind: "event", event: { type: "turn_start" } },
		{ kind: "event", event: { type: "message_start", message: partial([]) } },
		{
			kind: "event",
			event: { type: "message_update", message: partial([{ type: "thinking", thinking: TURN_THINKING_1 }]) },
		},
		{
			kind: "event",
			event: { type: "message_update", message: partial([{ type: "thinking", thinking: TURN_THINKING_2 }]) },
		},
		{
			kind: "event",
			event: {
				type: "message_update",
				message: partial([
					{ type: "thinking", thinking: TURN_THINKING_2 },
					{ type: "text", text: TURN_TEXT_1 },
				]),
			},
		},
		{
			kind: "event",
			event: {
				type: "message_update",
				message: partial([
					{ type: "thinking", thinking: TURN_THINKING_2 },
					{ type: "text", text: TURN_TEXT_2 },
				]),
			},
		},
		{
			kind: "event",
			event: {
				type: "message_update",
				message: partial([
					{ type: "thinking", thinking: TURN_THINKING_2 },
					{ type: "text", text: TURN_TEXT_2 },
					toolCall,
				]),
			},
		},
		{ kind: "event", event: { type: "message_end", message: a1Final } },
		{ kind: "entry", entry: { id: a1Id, parentId, timestamp: iso(ts), type: "message", message: a1Final } },
		{
			kind: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: callId,
				toolName: "bash",
				args: { command },
				intent: "Running the reconnect suite",
			},
		},
		{
			kind: "event",
			event: {
				type: "tool_execution_update",
				toolCallId: callId,
				toolName: "bash",
				args: { command },
				partialResult: "3 sockets reconnected in 1.2s",
			},
		},
		{
			kind: "event",
			event: {
				type: "tool_execution_end",
				toolCallId: callId,
				toolName: "bash",
				result: toolResultText,
				isError: false,
			},
		},
		{ kind: "entry", entry: { id: r1Id, parentId: a1Id, timestamp: iso(ts), type: "message", message: r1Message } },
		{ kind: "event", event: { type: "message_start", message: partial([]) } },
		{ kind: "event", event: { type: "message_update", message: partial([{ type: "text", text: TURN_CLOSE_1 }]) } },
		{ kind: "event", event: { type: "message_update", message: partial([{ type: "text", text: TURN_CLOSE_2 }]) } },
		{ kind: "event", event: { type: "message_end", message: a2Final } },
		{ kind: "entry", entry: { id: a2Id, parentId: r1Id, timestamp: iso(ts), type: "message", message: a2Final } },
		{ kind: "event", event: { type: "turn_end" } },
		{ kind: "event", event: { type: "agent_end" } },
		{ kind: "state", streaming: false },
	];
}
