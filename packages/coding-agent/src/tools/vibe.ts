import { type VibeToolDetails } from "@oh-my-pi/pi-tui/tools/vibe";
/**
 * Vibe mode tools — the director's entire non-read surface.
 *
 * Five thin tools over {@link VibeSessionRegistry}: spawn/send/wait/kill/list
 * persistent worker sessions ("fast"/"good" CLIs). Spawns and sends return
 * immediately; turn results self-deliver through the async job manager.
 *
 * The TUI renderers lean into the "you are driving little CLIs" fiction:
 * spawn/send draw a mini composer (a message typed into a tiny Claude-Code-like
 * terminal), and wait/list draw the "TV wall" — one live screen per worker,
 * stacked, each showing its tool calls and streamed text as it works.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";

import { prompt } from "@oh-my-pi/pi-utils";

import vibeKillDescription from "../prompts/tools/vibe-kill.md" with { type: "text" };
import vibeListDescription from "../prompts/tools/vibe-list.md" with { type: "text" };
import vibeSendDescription from "../prompts/tools/vibe-send.md" with { type: "text" };
import vibeSpawnDescription from "../prompts/tools/vibe-spawn.md" with { type: "text" };
import vibeWaitDescription from "../prompts/tools/vibe-wait.md" with { type: "text" };

import { type VibeScreenSnapshot, type VibeWaitOutcome } from "@oh-my-pi/pi-tui/tools/vibe";
import { VibeSessionRegistry } from "../vibe/runtime";
import type { VibeRosterEntry } from "../vibe/state";
import type { Tool, ToolSession } from "./index";

export const VIBE_TOOL_NAMES = ["vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"] as const;

const vibeSpawnSchema = type({
	cli: type("'fast' | 'good'").describe(
		"worker flavor: fast = low-latency model for mechanical work; good = strong model for hard work",
	),
	"name?": type("string <= 48").describe("optional session name; generated when omitted"),
	prompt: type("string > 0").describe("first instruction; the worker starts with no other context"),
});

const vibeSendSchema = type({
	session: type("string > 0").describe("session id from vibe_spawn / vibe_list"),
	message: type("string > 0").describe("message for the session; steers mid-turn, else runs as its next turn"),
});

const vibeWaitSchema = type({
	"sessions?": type("string[]").describe("session ids to watch; omit to watch every session with a turn in flight"),
	"timeout?": type("number > 0").describe("max seconds to wait (default 30)"),
});

const vibeKillSchema = type({
	session: type("string > 0").describe("session id to terminate"),
});

const vibeListSchema = type({});

function screensOf(session: ToolSession, ids?: string[]): VibeScreenSnapshot[] {
	return VibeSessionRegistry.global().screens(session, ids);
}

/** Cap on roster lines injected into the director's context message. */
const VIBE_ROSTER_MAX_LINES = 10;

/**
 * Pre-rendered live roster block for the director's rebuilt context message —
 * one line per actionable worker. Undefined when the roster is empty. Never
 * throws: without a stable parent session id there is no scope to list.
 */
export function vibeRosterText(session: ToolSession): string | undefined {
	let entries: VibeRosterEntry[];
	try {
		entries = VibeSessionRegistry.global().roster(session);
	} catch {
		return undefined;
	}
	if (entries.length === 0) return undefined;
	const lines = entries.slice(0, VIBE_ROSTER_MAX_LINES).map(entry => {
		const head = `- \`${entry.id}\` [${entry.cli}] ${entry.state} · ${entry.turns} turn${entry.turns === 1 ? "" : "s"}`;
		return entry.lastActivity ? `${head} · last: ${entry.lastActivity}` : head;
	});
	if (entries.length > VIBE_ROSTER_MAX_LINES) lines.push(`- … ${entries.length - VIBE_ROSTER_MAX_LINES} more`);
	return lines.join("\n");
}

function textResult(text: string, details: VibeToolDetails): AgentToolResult<VibeToolDetails> {
	return { content: [{ type: "text", text }], details };
}

export class VibeSpawnTool implements AgentTool<typeof vibeSpawnSchema, VibeToolDetails> {
	readonly name = "vibe_spawn";
	readonly approval = "exec" as const;
	readonly label = "Vibe Spawn";
	readonly summary = "Start a persistent fast/good worker session";
	readonly description: string;
	readonly parameters = vibeSpawnSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeSpawnDescription);
	}

	async execute(_toolCallId: string, params: typeof vibeSpawnSchema.infer): Promise<AgentToolResult<VibeToolDetails>> {
		const { id, jobId } = await VibeSessionRegistry.global().spawn(this.session, params);
		return textResult(
			`Spawned ${params.cli} session \`${id}\` (turn job \`${jobId}\`). The turn result will be delivered when it finishes — keep directing other sessions meanwhile. Continue this one with vibe_send \`${id}\`.`,
			{ op: "spawn", screens: screensOf(this.session), spawned: { id, cli: params.cli, jobId } },
		);
	}
}

export class VibeSendTool implements AgentTool<typeof vibeSendSchema, VibeToolDetails> {
	readonly name = "vibe_send";
	readonly approval = "exec" as const;
	readonly label = "Vibe Send";
	readonly summary = "Message a worker session (steer or next turn)";
	readonly description: string;
	readonly parameters = vibeSendSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeSendDescription);
	}

	async execute(_toolCallId: string, params: typeof vibeSendSchema.infer): Promise<AgentToolResult<VibeToolDetails>> {
		const outcome = await VibeSessionRegistry.global().send(this.session, params);
		const ack =
			outcome.mode === "turn"
				? `Started a new turn on \`${outcome.id}\` (job \`${outcome.jobId}\`). Its result will be delivered when the turn finishes.`
				: outcome.mode === "steered"
					? `Steered \`${outcome.id}\` mid-turn — the running turn sees your message at its next step.`
					: `\`${outcome.id}\` is mid-turn; your message is queued and runs automatically as the next turn.`;
		return textResult(ack, { op: "send", screens: screensOf(this.session), send: outcome });
	}
}

const WAIT_PROGRESS_INTERVAL_MS = 500;

export class VibeWaitTool implements AgentTool<typeof vibeWaitSchema, VibeToolDetails> {
	readonly name = "vibe_wait";
	readonly approval = "read" as const;
	readonly label = "Vibe Wait";
	readonly summary = "Block until a worker session finishes its turn";
	readonly description: string;
	readonly parameters = vibeWaitSchema;
	readonly strict = true;
	readonly interruptible = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeWaitDescription);
	}

	async execute(
		_toolCallId: string,
		params: typeof vibeWaitSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<VibeToolDetails>,
	): Promise<AgentToolResult<VibeToolDetails>> {
		const registry = VibeSessionRegistry.global();
		// Live TV-wall frames while the wait blocks: each tick re-snapshots the
		// watched workers so their tool calls and streamed text play in place.
		const emitProgress = (): void => {
			onUpdate?.({
				content: [{ type: "text", text: "" }],
				details: {
					op: "wait",
					screens: screensOf(this.session, params.sessions),
					wait: { settled: [], stillRunning: [], timedOut: false, waiting: true },
				},
			});
		};
		const progressTimer = onUpdate ? setInterval(emitProgress, WAIT_PROGRESS_INTERVAL_MS) : undefined;
		emitProgress();
		let outcome: VibeWaitOutcome;
		try {
			outcome = await registry.wait(this.session, {
				sessions: params.sessions,
				timeoutMs: params.timeout !== undefined ? params.timeout * 1000 : undefined,
				signal,
			});
		} finally {
			clearInterval(progressTimer);
		}
		const details: VibeToolDetails = {
			op: "wait",
			screens: screensOf(this.session, params.sessions),
			wait: {
				settled: outcome.settled.map(({ id, jobId, status }) => ({ id, jobId, status })),
				stillRunning: outcome.stillRunning,
				timedOut: outcome.timedOut,
			},
		};
		if (outcome.settled.length === 0 && outcome.stillRunning.length === 0) {
			return { ...textResult("No turns in flight to wait for.", details), useless: true };
		}
		const lines: string[] = [];
		for (const entry of outcome.settled) {
			lines.push(`## \`${entry.id}\` — ${entry.status}`, entry.resultText, "");
		}
		if (outcome.stillRunning.length > 0) {
			lines.push(`Still running: ${outcome.stillRunning.map(id => `\`${id}\``).join(", ")}.`);
		}
		if (outcome.timedOut) {
			lines.push("Wait window elapsed before any turn settled — re-issue vibe_wait to keep waiting.");
		}
		const result = textResult(lines.join("\n").trimEnd(), details);
		// A pure "still waiting" frame is noise once a newer wait exists.
		return outcome.settled.length === 0 ? { ...result, useless: true } : result;
	}
}

export class VibeKillTool implements AgentTool<typeof vibeKillSchema, VibeToolDetails> {
	readonly name = "vibe_kill";
	readonly approval = "read" as const;
	readonly label = "Vibe Kill";
	readonly summary = "Terminate a worker session";
	readonly description: string;
	readonly parameters = vibeKillSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeKillDescription);
	}

	async execute(_toolCallId: string, params: typeof vibeKillSchema.infer): Promise<AgentToolResult<VibeToolDetails>> {
		const outcome = await VibeSessionRegistry.global().kill(this.session, params.session);
		const cancelNote = outcome.cancelledTurn ? " Its in-flight turn was cancelled." : "";
		return textResult(
			`Killed session \`${outcome.id}\`.${cancelNote} Transcript remains at history://${outcome.id}.`,
			{
				op: "kill",
				screens: screensOf(this.session),
				killed: outcome,
			},
		);
	}
}

export class VibeListTool implements AgentTool<typeof vibeListSchema, VibeToolDetails> {
	readonly name = "vibe_list";
	readonly approval = "read" as const;
	readonly label = "Vibe List";
	readonly summary = "List worker sessions and their states";
	readonly description: string;
	readonly parameters = vibeListSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeListDescription);
	}

	async execute(): Promise<AgentToolResult<VibeToolDetails>> {
		const screens = screensOf(this.session);
		const details: VibeToolDetails = { op: "list", screens };
		if (screens.length === 0) {
			return textResult("No vibe sessions. Spawn one with vibe_spawn.", details);
		}
		const lines = screens.map(screen => {
			const parts = [
				`- \`${screen.id}\` [${screen.cli}] ${screen.state}`,
				`${screen.turns} turn${screen.turns === 1 ? "" : "s"}`,
			];
			if (screen.queued > 0) parts.push(`${screen.queued} queued`);
			if (screen.model) parts.push(screen.model);
			if (screen.lastActivity) parts.push(`last: ${screen.lastActivity}`);
			return parts.join(" · ");
		});
		return textResult(lines.join("\n"), details);
	}
}

/** Creates the ephemeral tools installed while `/vibe` mode is active. */
export function createVibeTools(session: ToolSession): Tool[] {
	return [
		new VibeSpawnTool(session),
		new VibeSendTool(session),
		new VibeWaitTool(session),
		new VibeKillTool(session),
		new VibeListTool(session),
	];
}
