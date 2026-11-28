/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The pinned subagents HUD (`subagents` slot, text terminals only; a Tern
 * host shows running agents in the HUD pills or the tray).
 *
 * A blank row, a bold accent `Subagents · 2 running` header (the agent-hub
 * key right-aligned when it fits), then one tree row per running subagent —
 * `⟳ [model] Id ⟨type⟩: description` (or a muted preview of its assignment;
 * the `⟳` muted while the agent only waits on its own agents or jobs) —
 * at most three while collapsed, with a `… n more — expand` / `… show less`
 * row. With the live preview (`display.subagentLivePreview`) a row that has
 * called a tool carries a second row with that call: the one running, else
 * the one being written, else the last one marked with how it ended; an
 * elapsed marker joins a call that ran over five seconds.
 *
 * A click on an agent's rows focuses that agent (`onFocus`); one on the
 * expander toggles the list (`onToggle`). Terminal look:
 * `src/ui/styles/dock/subagents.ts`.
 */
import { type JSXNode, signal } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { toolIntentLabel } from "@oh-my-pi/pi-wire";
import type { ObservableSession } from "../../task/session-observer-registry";
import { formatTaskId, isWaitingOnOwnWork, labelEchoesHandle } from "../../task/task-details";
import { shortenEmbeddedPaths, shortenToolArgumentPaths } from "../../utils/render-utils";
import "../styles/dock";

/** The tool call a live-preview row shows. */
export interface SubagentCall {
	readonly tool: string;
	/** The call's intent, else its arguments, on one line. */
	readonly detail?: string;
	/** Running, or still being written; false for the last finished call. */
	readonly live: boolean;
	/** A finished call that failed. */
	readonly error?: boolean;
	/** Epoch ms a running call started (its elapsed marker). */
	readonly startedAt?: number;
}

/** One running subagent as the HUD lists it. */
export interface SubagentEntry {
	/** Registry id (the click target). */
	readonly id: string;
	/** `Anna>Bob` for nested ids. */
	readonly displayId: string;
	/** Agent type; a badge unless it is the generic `task`. */
	readonly agent?: string;
	/** The spawn description, when it says more than the id. */
	readonly description?: string;
	/** Without a description: the assignment's opening, muted. */
	readonly preview?: string;
	/** The resolved model (`display.feedModelBadge`), its thinking level and advisor. */
	readonly model?: {
		readonly identity: string;
		readonly thinking?: string;
		readonly advisor?: boolean;
	};
	readonly call?: SubagentCall;
	/** It runs, but only waits on its own agents or jobs ({@link isWaitingOnOwnWork}). */
	readonly waiting?: boolean;
}

/** What the HUD shows; the controller feeds it from the observer registry. */
export class SubagentHudModel {
	readonly entries = signal<readonly SubagentEntry[]>([]);
	/** Every agent listed, with a `… show less` row. */
	readonly expanded = signal(false);
	readonly livePreview = signal(false);
	/** The agent hub's key, shown right of the header. */
	readonly hubKey = signal<string | undefined>(undefined);
	/** A click on an agent's rows. */
	onFocus: ((id: string) => void) | undefined;
	/** A click on the expander row. */
	onToggle: (() => void) | undefined;
}

/** Item rows a collapsed list shows before the expander. */
export const SUBAGENT_HUD_COLLAPSED = 3;

/** How many agents to list and which expander row follows. */
export function subagentLayout(
	running: number,
	expanded: boolean,
): {
	readonly items: number;
	readonly toggle: "expand" | "collapse" | undefined;
} {
	if (running <= SUBAGENT_HUD_COLLAPSED) return { items: running, toggle: undefined };
	return expanded ? { items: running, toggle: "collapse" } : { items: SUBAGENT_HUD_COLLAPSED, toggle: "expand" };
}

function oneLine(text: string): string {
	return replaceTabs(text).replace(/\s*[\r\n]+\s*/g, " ↵ ");
}

/** The call a running agent's preview row shows, from its progress. */
function previewCall(session: ObservableSession): SubagentCall | undefined {
	const progress = session.progress;
	if (progress?.status !== "running") return undefined;
	const running = progress.currentTool;
	const writing = !running && progress.streaming?.kind === "call" ? progress.streaming : undefined;
	const recent = progress.recentTools[0];
	const call = running
		? {
				tool: running,
				intent: progress.currentToolIntent,
				args: progress.currentToolArgs,
				argsKey: progress.currentToolArgsKey,
			}
		: (writing ?? recent);
	if (!call) return undefined;
	const detail = call.intent
		? shortenEmbeddedPaths(replaceTabs(toolIntentLabel(call.intent)))
		: call.args
			? shortenToolArgumentPaths(replaceTabs(call.args), call.argsKey)
			: undefined;
	const live = running !== undefined || writing !== undefined;
	return {
		tool: replaceTabs(call.tool),
		...(detail ? { detail } : {}),
		live,
		...(!live && recent?.isError ? { error: true } : {}),
		...(running && progress.currentToolStartMs ? { startedAt: progress.currentToolStartMs } : {}),
	};
}

/** The HUD's entries: every active subagent in registry order (detached spawns and sync calls alike). */
export function subagentEntries(sessions: readonly ObservableSession[], modelBadge = false): SubagentEntry[] {
	const out: SubagentEntry[] = [];
	for (const session of sessions) {
		if (session.kind !== "subagent" || session.status !== "active") continue;
		const progress = session.progress;
		const description = session.description?.trim() || progress?.description?.trim();
		const distinct = description && !labelEchoesHandle(session.id, description) ? oneLine(description) : undefined;
		const assignment = distinct ? undefined : (progress?.assignment ?? progress?.task)?.trim();
		const preview =
			assignment && !labelEchoesHandle(session.id, assignment)
				? shortenEmbeddedPaths(replaceTabs(sanitizeText(assignment))).replace(/\s*[\r\n]+\s*/g, " ↵ ")
				: undefined;
		const identity = progress?.resolvedModelIdentity ?? progress?.resolvedModel;
		const agent = session.agent ?? progress?.agent;
		const call = previewCall(session);
		out.push({
			id: session.id,
			displayId: formatTaskId(session.id),
			...(agent ? { agent } : {}),
			...(distinct ? { description: distinct } : {}),
			...(preview ? { preview } : {}),
			...(modelBadge && identity
				? {
						model: {
							identity,
							...(progress?.resolvedThinkingLevel ? { thinking: progress.resolvedThinkingLevel } : {}),
							...(progress?.advisor ? { advisor: true } : {}),
						},
					}
				: {}),
			...(call ? { call } : {}),
			...(isWaitingOnOwnWork(progress) ? { waiting: true } : {}),
		});
	}
	return out;
}

/** See the module docs. */
export function SubagentHud(props: { readonly model: SubagentHudModel }): JSXNode {
	const model = props.model;
	return () => {
		if (model.entries().length === 0) return undefined;
		return (
			<col
				role="omp.hud.subagents"
				term={{ subagents: model }}
				onAction={act => {
					if (act === "subagents.toggle") model.onToggle?.();
					else if (act.startsWith("subagents.focus=")) model.onFocus?.(act.slice("subagents.focus=".length));
				}}
			/>
		);
	};
}
