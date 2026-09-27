/**
 * `/status` and `/sessions` rendering: bridge markdown built from session
 * getters plus the registry entry. Everything dynamic goes through
 * `mdText`/`mdCode` so a directory or topic name can never break the markup.
 */
import { clip } from "./markdown";
import { mdCode, mdText } from "./rich";
import type { TopicEntry, TopicStatus } from "./types";

/** Snapshot of a session rendered by {@link statusText}. */
export interface TelegramStatusState {
	model?: { provider?: string | null; id?: string | null } | null;
	thinkingLevel?: string | null;
	isStreaming?: boolean;
	isCompacting?: boolean;
	queuedMessageCount?: number;
	contextUsage?: { percent?: number; tokens?: number; contextWindow?: number } | null;
	todoPhases?:
		| readonly { name?: string | null; tasks?: readonly { content?: string | null; status?: string }[] }[]
		| null;
	sessionName?: string | null;
}

const STATE_MARKS: Record<TopicStatus, { mark: string; text: string }> = {
	running: { mark: "🟢", text: "running" },
	idle: { mark: "💤", text: "waiting" },
	closed: { mark: "⚫", text: "closed" },
	mirror: { mark: "🖥", text: "runs in the terminal" },
};
const UNKNOWN_MARK = "⚪";
const BAR_CELLS = 10;
const TASK_LIMIT = 120;

const stateOf = (status: TopicStatus | undefined): { mark: string; text: string } => {
	const known = status === undefined ? undefined : STATE_MARKS[status];
	return known ?? { mark: UNKNOWN_MARK, text: clip(status ?? "—", 40) };
};

const spaced = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, " ");

const text = (value: unknown, width: number): string => mdText(clip(value ?? "", width));

function barOf(percent: number): string {
	const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS)));
	return `${"▰".repeat(filled)}${"▱".repeat(BAR_CELLS - filled)}`;
}

function contextLine(usage: TelegramStatusState["contextUsage"]): string {
	if (usage === null || typeof usage !== "object" || !Number.isFinite(usage.percent)) return "- **Context:** —";
	const percentage = usage.percent as number;
	const share = Math.round(percentage * 10) / 10;
	const tokens =
		Number.isFinite(usage.tokens) && Number.isFinite(usage.contextWindow)
			? ` (${spaced(usage.tokens as number)} / ${spaced(usage.contextWindow as number)})`
			: "";
	return `- **Context:** ${barOf(percentage)} ${share}%${tokens}`;
}

function moveLine(state: TelegramStatusState): string {
	if (state.isStreaming === true) return "- **Turn:** running";
	if (state.isCompacting === true) return "- **Turn:** compacting the context";
	return "- **Turn:** none";
}

function todoBlocks(state: TelegramStatusState): string[] {
	return (state.todoPhases ?? []).flatMap(phase => {
		const tasks = phase.tasks ?? [];
		if (tasks.length === 0) return [];
		return [
			[
				`### ${text(phase.name ?? "Tasks", 60)}`,
				...tasks.map(
					task => `${task.status === "completed" ? "- [x]" : "- [ ]"} ${text(task.content ?? "", TASK_LIMIT)}`,
				),
			].join("\n"),
		];
	});
}

/** `/status` in a topic: the registry entry's identity plus the session snapshot. */
export function statusText(state: TelegramStatusState | null, entry: TopicEntry | Partial<TopicEntry>): string {
	const session: TelegramStatusState = state ?? {};
	const record: Partial<TopicEntry> = entry ?? {};
	const model = session.model !== null && typeof session.model === "object" ? session.model : {};
	const status = stateOf(record.status);
	const lines = [
		`## ${status.mark} ${text(record.name ?? session.sessionName ?? "session", 80)}`,
		"",
		`- **State:** ${status.text}`,
		`- **Directory:** ${mdCode(clip(record.cwd ?? "—", 120))}`,
		`- **Model:** ${mdCode(model.provider ? `${model.provider}/${model.id ?? "?"}` : "—")}`,
		`- **Thinking:** ${text(session.thinkingLevel ?? "—", 40)}`,
		moveLine(session),
		contextLine(session.contextUsage),
		`- **Queue:** ${Number.isInteger(session.queuedMessageCount) ? session.queuedMessageCount : 0}`,
	];
	const blocks = todoBlocks(session);
	if (blocks.length > 0) lines.push("", ...blocks.flatMap((block, at) => (at === 0 ? [block] : ["", block])));
	return lines.join("\n");
}

const codeCell = (value: unknown, width: number): string => mdCode(clip(value ?? "—", width)).replace(/\|/gu, "\\|");

/** `/sessions`: the registry as a GFM table. */
export function sessionListText(entries: readonly Partial<TopicEntry>[]): string {
	const list = Array.isArray(entries) ? entries : [];
	if (list.length === 0) return "No sessions yet: write to the bot to create the first one.";
	const rows = list.map((entry, index) => {
		const status = stateOf(entry?.status);
		return `| ${index + 1} | ${text(entry?.name ?? "—", 60)} | ${status.mark} ${status.text} | ${codeCell(entry?.cwd, 120)} |`;
	});
	return ["| # | Session | State | Directory |", "| --- | --- | --- | --- |", ...rows].join("\n");
}
