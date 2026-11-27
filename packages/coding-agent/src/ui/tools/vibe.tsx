/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Vibe (worker CLI sessions the director drives): spawn and send show a mini
 * composer (the message being typed, then the delivery outcome); wait and
 * list show the "TV wall", one inset card per worker session with its live
 * trace, current tool and output tail; kill is a head line.
 *
 * Terminal look: `vibe` (`src/ui/styles/tools/vibe.ts`). Views name the
 * frame (`term.frame`: `composer`, `line`, `wall`) and the line look's text
 * (`term.line`, `term.meta`); wall card texts name their part (`term.part`).
 */
import type { TspCardStatus, TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { toolIntentLabel } from "@oh-my-pi/pi-wire";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { ToolPresenter, ToolResult, ToolView } from "./contract";
import { cleanText, ErrorText, NoteText, oneLine } from "./agent-common";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";

export type VibeOp = "spawn" | "send" | "wait" | "kill" | "list";
export type VibeCli = "fast" | "good";
export type VibeSessionState = "starting" | "running" | "idle" | "dead";
type SettledStatus = "completed" | "failed" | "cancelled";

/** One worker session as the wall shows it. */
export interface VibeScreen {
	readonly id: string;
	readonly cli: VibeCli;
	readonly state: VibeSessionState;
	readonly killed?: boolean;
	readonly model?: string;
	readonly turns: number;
	readonly queued: number;
	readonly turnStartedAt?: number;
	readonly turnMessage?: string;
	readonly currentTool?: string;
	readonly currentToolArgs?: string;
	readonly lastIntent?: string;
	readonly trace: readonly string[];
	readonly outputTail: readonly string[];
	readonly lastActivity?: string;
	readonly lastActivityAt: number;
}

export interface VibeDetails {
	readonly op: VibeOp;
	readonly screens: readonly VibeScreen[];
	readonly hiddenKilled?: readonly string[];
	readonly spawned?: {
		readonly id: string;
		readonly cli: VibeCli;
		readonly jobId: string;
	};
	readonly send?: {
		readonly id: string;
		readonly mode: "turn" | "steered" | "queued";
		readonly jobId?: string;
	};
	readonly wait?: {
		readonly settled: readonly {
			readonly id: string;
			readonly jobId: string;
			readonly status: SettledStatus;
		}[];
		readonly stillRunning: readonly string[];
		readonly timedOut: boolean;
		readonly waiting?: boolean;
	};
	readonly killed?: { readonly id: string; readonly cancelledTurn: boolean };
}

export interface VibeArgs {
	readonly cli?: VibeCli;
	readonly prompt?: string;
	readonly name?: string;
	readonly session?: string;
	readonly message?: string;
	readonly sessions?: readonly string[];
}

/** Trace lines a card keeps (the collapsed look shows fewer). */
const TRACE_LINES = 6;
/** Output tail lines a card keeps. */
const OUTPUT_LINES = 3;
/** Card body rows while collapsed: message, two trace lines, the tool, one output line. */
const CARD_PREVIEW = 5;
/** Longest name or session in a terminal line. */
const NAME_MAX = 40;
/** Longest session list in a terminal line. */
const LIST_MAX = 60;

/** The call's head detail; `max` cuts names for the terminal line. */
function callLabel(op: VibeOp, args: VibeArgs | undefined, cut: boolean): string {
	const name = (text: string, max: number) => (cut ? oneLine(text, max) : text);
	switch (op) {
		case "spawn":
			return `spawn ${args?.cli ?? "?"}${args?.name ? ` · ${name(args.name, NAME_MAX)}` : ""}`;
		case "send":
			return `send → ${args?.session ? name(args.session, NAME_MAX) : "?"}`;
		case "wait":
			return args?.sessions?.length
				? `wait on ${name(args.sessions.join(", "), LIST_MAX)}`
				: "wait on running sessions";
		case "kill":
			return `kill ${args?.session ? name(args.session, NAME_MAX) : "?"}`;
		case "list":
			return "sessions";
	}
}

function vibeHead(detail: string, note?: string): TspSpan[] {
	const spans: TspSpan[] = [{ s: "toolTitle strong", t: "Vibe" }, { t: " " }, { s: "muted", t: detail }];
	if (note) spans.push({ t: " " }, { s: "muted", t: note });
	return spans;
}

function composerMessage(op: VibeOp, args: VibeArgs | undefined): string {
	return op === "spawn" ? (args?.prompt ?? "") : op === "send" ? (args?.message ?? "") : "";
}

function Composer(props: { readonly message: string }): JSXNode {
	const trimmed = cleanText(props.message).trim();
	if (!trimmed) return undefined;
	return (
		<text
			role="omp.vibe.composer"
			spans={[
				{ s: "accent", t: "> " },
				{ s: "toolOutput", t: trimmed },
			]}
			wrap="word"
			term={{ message: props.message }}
		/>
	);
}

function screenStatus(screen: VibeScreen, settled: SettledStatus | undefined): [TspCardStatus, TspTone] {
	if (settled === "failed") return ["error", "error"];
	if (settled === "cancelled") return ["cancelled", "warning"];
	if (settled === "completed") return ["done", "success"];
	switch (screen.state) {
		case "running":
			return ["running", "accent"];
		case "starting":
			return ["pending", "accent"];
		case "idle":
			return ["done", "success"];
		case "dead":
			return ["cancelled", "muted"];
	}
}

const SETTLED_TONE: Record<SettledStatus, string> = {
	completed: "success",
	failed: "error",
	cancelled: "warning",
};
const STATE_COLOR: Record<VibeSessionState, string> = {
	running: "accent",
	starting: "accent",
	idle: "success",
	dead: "muted",
};

/** One worker's "TV": identity head, cli badge and turn age, then its live trace or last activity. */
function ScreenCard(props: {
	readonly screen: VibeScreen;
	readonly settled?: SettledStatus;
	readonly now: number;
}): JSXNode {
	const { screen, settled } = props;
	const live = screen.state === "running" || screen.state === "starting";
	const [status, tone] = screenStatus(screen, settled);
	const head: TspSpan[] = [
		live ? { t: screen.id, s: "accent", fx: "shimmer" } : { t: screen.id, s: "toolOutput" },
		{ s: "dim", t: ` ${settled ?? screen.state}` },
		{
			s: "muted",
			t: ` ${screen.turns}t${screen.queued > 0 ? `+${screen.queued}q` : ""}`,
		},
	];
	if (screen.model) head.push({ s: "muted", t: ` ${cleanText(screen.model)}` });
	const age = screen.turnStartedAt === undefined ? undefined : props.now - screen.turnStartedAt;
	const body: JSXNode[] = [
		<row gap="sm">
			<badge text={screen.cli} tone={tone} term={{ color: STATE_COLOR[screen.state] }} />
			{age === undefined ? undefined : <elapsed age={age} format="short" stopped={live ? undefined : age} />}
		</row>,
	];
	const line = (spans: TspSpan[], part: string): JSXNode => <text spans={spans} truncate="end" term={{ part }} />;
	if (live) {
		const intent = screen.lastIntent ? toolIntentLabel(screen.lastIntent) : undefined;
		if (screen.turnMessage)
			body.push(
				line(
					[
						{ s: "accent", t: "> " },
						{ s: "dim", t: cleanText(screen.turnMessage) },
					],
					"message",
				),
			);
		for (const entry of screen.trace.slice(-TRACE_LINES))
			body.push(line([{ s: "dim", t: cleanText(entry) }], "trace"));
		const detail = intent ?? screen.currentToolArgs;
		if (screen.currentTool) {
			body.push(
				<shimmer
					mode="classic"
					palette={{ low: "dim", mid: "muted", high: "accent" }}
					spans={[
						{
							s: "muted",
							t: cleanText(`${screen.currentTool}${detail ? `: ${detail}` : ""}`),
						},
					]}
				/>,
			);
		} else if (intent) body.push(line([{ s: "muted", t: cleanText(intent) }], "intent"));
		for (const entry of screen.outputTail.slice(-OUTPUT_LINES)) {
			if (entry.trim()) body.push(line([{ s: "muted", t: cleanText(entry) }], "output"));
		}
	} else if (screen.lastActivity) body.push(line([{ s: "muted", t: cleanText(screen.lastActivity) }], "activity"));
	if (settled) {
		body.push(
			<text
				spans={[{ s: SETTLED_TONE[settled], t: `turn ${settled} — result delivered` }]}
				term={{ part: "settled" }}
			/>,
		);
	}
	return (
		<card
			key={screen.id}
			role="omp.vibe.screen"
			status={status}
			tone={tone}
			head={head}
			collapsible
			preview={{ lines: CARD_PREVIEW }}
			inset
		>
			{body}
		</card>
	);
}

function callView(op: VibeOp, args: VibeArgs): ToolView {
	const label = vibeHead(callLabel(op, args, false));
	const line = `vibe ${callLabel(op, args, true)}`;
	if (op !== "spawn" && op !== "send") return { label, term: { look: "vibe", frame: "line", line, call: true } };
	return {
		label,
		body: [
			<Composer message={composerMessage(op, args)} />,
			<spinner label={[{ s: "dim", t: op === "spawn" ? "booting CLI…" : "delivering…" }]} />,
		],
		preview: { lines: 3 },
		term: { look: "vibe", frame: "composer", line },
	};
}

function resultView(op: VibeOp, result: ToolResult<VibeDetails>, args: VibeArgs | undefined): ToolView {
	const details = result.details;
	const label = callLabel(op, args, false);
	const line = `vibe ${callLabel(op, args, true)}`;
	if (result.isError) {
		const message = resultText(result) || "vibe failed";
		return {
			label: vibeHead(label),
			tone: "error",
			body: <ErrorText message={message} />,
			term: { look: "vibe", frame: "line", line },
		};
	}
	if (!details) {
		const fallback = resultText(result).trim();
		return {
			label: vibeHead(label),
			body: fallback ? <NoteText message={fallback} /> : undefined,
			term: { look: "vibe", frame: "line", line },
		};
	}
	if (op === "spawn" || op === "send") {
		const head: TspSpan[] =
			op === "spawn"
				? [
						...vibeHead("spawn"),
						{ t: " " },
						{ s: "accent strong", t: details.spawned?.cli ?? args?.cli ?? "?" },
						{ t: " " },
						{
							s: "accent",
							t: cleanText(details.spawned?.id ?? args?.name ?? ""),
						},
					]
				: [...vibeHead("send →"), { t: " " }, { s: "accent", t: cleanText(args?.session ?? "?") }];
		const ack: TspSpan =
			op === "spawn"
				? {
						s: "success",
						t: `turn started${details.spawned ? ` (job ${details.spawned.jobId})` : ""}`,
					}
				: details.send?.mode === "steered"
					? { s: "success", t: "steered into the running turn" }
					: details.send?.mode === "queued"
						? { s: "warning", t: "mid-turn — queued as the next turn" }
						: {
								s: "success",
								t: `turn started${details.send?.jobId ? ` (job ${details.send.jobId})` : ""}`,
							};
		return {
			label: head,
			tone: details.send?.mode === "queued" ? "warning" : undefined,
			body: [<Composer message={composerMessage(op, args)} />, <text spans={[ack]} wrap="word" />],
			preview: { lines: 3 },
			term: { look: "vibe", frame: "composer" },
		};
	}
	if (op === "kill") {
		const id = details.killed?.id ?? args?.session ?? "?";
		const cancelled = details.killed?.cancelledTurn === true;
		return {
			label: vibeHead(`kill ${id}`, cancelled ? "in-flight turn cancelled" : undefined),
			term: {
				look: "vibe",
				frame: "line",
				line: `vibe kill ${oneLine(id, NAME_MAX)}${cancelled ? " (in-flight turn cancelled)" : ""}`,
			},
		};
	}
	const screens = details.screens;
	const hiddenKilled = details.hiddenKilled?.length ?? 0;
	const killedMeta: TspSpan | undefined =
		hiddenKilled > 0 ? { s: "dim", t: ` · ${hiddenKilled} killed hidden` } : undefined;
	if (screens.length === 0) {
		const gist = hiddenKilled > 0 ? "no live sessions" : resultText(result).trim() || "no sessions";
		const head = vibeHead(op, gist);
		if (killedMeta) head.push(killedMeta);
		return {
			label: head,
			tone: "warning",
			term: { look: "vibe", frame: "line", line: `vibe ${op}`, gist },
		};
	}
	const settledById = new Map(details.wait?.settled.map(entry => [entry.id, entry.status] as const) ?? []);
	const running = screens.filter(screen => screen.state === "running" || screen.state === "starting").length;
	const title =
		op === "wait"
			? details.wait?.waiting === true
				? "wait — watching the wall"
				: "wait"
			: `sessions (${screens.length})`;
	const head: TspSpan[] = [{ s: "toolTitle strong", t: "Vibe" }, { t: " " }, { s: "muted", t: title }];
	if (running > 0) head.push({ s: "accent", t: ` · ${running} on air` });
	if (settledById.size > 0) head.push({ s: "success", t: ` · ${settledById.size} settled` });
	if (details.wait?.timedOut) head.push({ s: "warning", t: " · timed out" });
	if (killedMeta) head.push(killedMeta);
	const now = Date.now();
	return {
		label: head,
		tone: details.wait?.timedOut ? "warning" : undefined,
		body: screens.map(screen => <ScreenCard screen={screen} settled={settledById.get(screen.id)} now={now} />),
		preview: "auto",
		term: { look: "vibe", frame: "wall", line: `vibe ${title}`, running },
	};
}

function vibePresenter(op: VibeOp): ToolPresenter<VibeArgs, VibeDetails> {
	return {
		inline: true,
		merge: true,
		call: args => callView(op, args),
		result: (result, _state, args) => resultView(op, result, args),
	};
}

export const vibeSpawnPresenter = vibePresenter("spawn");
export const vibeSendPresenter = vibePresenter("send");
export const vibeWaitPresenter = vibePresenter("wait");
export const vibeKillPresenter = vibePresenter("kill");
export const vibeListPresenter = vibePresenter("list");

registerToolPresenter("vibe_spawn", vibeSpawnPresenter);
registerToolPresenter("vibe_send", vibeSendPresenter);
registerToolPresenter("vibe_wait", vibeWaitPresenter);
registerToolPresenter("vibe_kill", vibeKillPresenter);
registerToolPresenter("vibe_list", vibeListPresenter);
