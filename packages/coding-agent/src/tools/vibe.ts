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

/** Most recent killed ids named in `vibe_list`'s trailing line; older ones fold into `+N more`. */
const KILLED_IDS_LISTED = 8;

/**
 * TV-wall snapshot. Named `ids` show exactly those sessions. Otherwise
 * sessions the director killed are left off the wall and reported by id, so a
 * director that kills finished workers doesn't re-render every one on each
 * status check. Workers that died on their own stay visible. `keep` retains
 * ids already on the wall (a wait never drops a card mid-wait).
 */
function wallOf(
	session: ToolSession,
	ids?: string[],
	keep?: ReadonlySet<string>,
): Pick<VibeToolDetails, "screens" | "hiddenKilled"> {
	const all = VibeSessionRegistry.global().screens(session, ids);
	if (ids?.length) return { screens: all };
	const screens: VibeScreenSnapshot[] = [];
	const hiddenKilled: string[] = [];
	for (const screen of all) {
		if (screen.killed && !keep?.has(screen.id)) hiddenKilled.push(screen.id);
		else screens.push(screen);
	}
	return hiddenKilled.length > 0 ? { screens, hiddenKilled } : { screens };
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
			{ op: "spawn", ...wallOf(this.session), spawned: { id, cli: params.cli, jobId } },
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
		return textResult(ack, { op: "send", ...wallOf(this.session), send: outcome });
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
		// Cards on the wall when the wait starts stay for its duration, so a
		// worker killed mid-wait can't vanish from the frame that settles it.
		const shown = new Set(wallOf(this.session, params.sessions).screens.map(screen => screen.id));
		const emitProgress = (): void => {
			onUpdate?.({
				content: [{ type: "text", text: "" }],
				details: {
					op: "wait",
					...wallOf(this.session, params.sessions, shown),
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
		// A worker that died as its turn settled keeps its card for the settled footer.
		for (const entry of outcome.settled) shown.add(entry.id);
		const details: VibeToolDetails = {
			op: "wait",
			...wallOf(this.session, params.sessions, shown),
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
				...wallOf(this.session),
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
		const { screens, hiddenKilled } = wallOf(this.session);
		const details: VibeToolDetails = { op: "list", screens, hiddenKilled };
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
		if (lines.length === 0) {
			lines.push(hiddenKilled ? "No live vibe sessions." : "No vibe sessions. Spawn one with vibe_spawn.");
		}
		if (hiddenKilled) {
			const recent = hiddenKilled.slice(-KILLED_IDS_LISTED).map(id => `\`${id}\``);
			const older = hiddenKilled.length - recent.length;
			if (older > 0) recent.push(`+${older} more`);
			lines.push(`Killed (${hiddenKilled.length}, transcripts at history://<id>): ${recent.join(", ")}`);
		}
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
