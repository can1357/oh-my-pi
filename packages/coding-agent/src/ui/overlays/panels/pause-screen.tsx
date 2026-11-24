/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The pause screen: the session is held (every agent stops at its next
 * step) until the user resumes. Shows how long it has been paused, whether
 * outstanding work has settled, what pausing means, and a Resume button
 * (escape, enter or space in the terminal).
 *
 * The native tree is written once when the screen opens; the clock counts
 * on from there and the terminal redraws its own look from the live state.
 */
import { type Accessor, type JSXNode, untrack } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { PauseWorkStatus } from "../../../modes/view-model/overlays/pause-screen";
import "../../styles/panels/pause-screen";
import { appInterruptKeys, matchesAppInterrupt } from "../../../config/keybindings/matchers";
import { kbdOf } from "../../keys/hints";
import { keyTitle } from "../../styles/panels/common";
import { ActionButton } from "./common";
import { rowsRole, type SheetAttributes } from "../sheet";

/** Tern's sheet: a centered medium one titled Paused (the transcript stays visible, frozen, behind it). */
export const PAUSE_SHEET: SheetAttributes = {
	role: "omp.overlay.pause",
	size: "md",
	anchor: "center",
	head: "Paused",
};

export interface PauseScreenProps {
	/** The session's name, if it has one. */
	readonly sessionName?: string;
	/** When the pause started (ms since epoch). */
	readonly since: Accessor<number>;
	/** Outstanding turns and jobs (the controller polls until settled). */
	readonly work: Accessor<PauseWorkStatus>;
	onResume(): void;
}

const FACTS: ReadonlyArray<readonly [icon: string, head: string, body: string]> = [
	["users", "Every agent holds", "Main agent, subagents and advisor stop at their next step."],
	["activity", "Running calls finish", "A reply or tool already under way completes; nothing new starts."],
	["message", "Queued messages wait", "Steering and follow-ups already queued send after you resume."],
	["pen", "The repo is yours", "Edit files freely, then tell the agent what changed."],
];

/** Whether no turn or job is outstanding. */
export function isSettled(work: PauseWorkStatus): boolean {
	return work.unsettledTurns === 0 && work.unfinishedJobs === 0;
}

/** Keys that resume; Ctrl+C resumes too, never aborts and stays paused. */
const RESUME_KEYS: ReadonlySet<string> = new Set(["enter", "space", "ctrl+c"]);

export function PauseScreen(props: PauseScreenProps): JSXNode {
	const work = untrack(props.work);
	const settled = isSettled(work);
	const interruptKey = appInterruptKeys()[0] ?? "escape";
	const settlement: TspSpan = settled
		? { s: "success", t: "Paused — ready to suspend" }
		: { s: "warning", t: "Pausing — waiting for work to settle" };
	return (
		<col
			role={rowsRole("omp.pause")}
			gap="md"
			term={() => ({ since: props.since(), session: props.sessionName, work: props.work() })}
			onKey={key => {
				if (!RESUME_KEYS.has(key.id) && !matchesAppInterrupt(key)) return false;
				props.onResume();
				return true;
			}}
			onAction={act => {
				if (act === "resume") props.onResume();
			}}
		>
			<row key="hero" role="omp.pause.hero" align="center" gap="md">
				<icon key="glyph" role="omp.pause.glyph" name="pause" />
				<col gap="none" grow={1} shrink={1}>
					<elapsed key="clock" role="omp.pause.clock" age={0} format="clock" title="Paused for" />
					<text
						key="session"
						role="omp.pause.session"
						wrap="none"
						truncate="end"
						spans={[{ s: "muted", t: props.sessionName ?? "Every agent in this session" }]}
					/>
				</col>
			</row>
			<col key="settlement-status" role="omp.pause.settlement-status" gap="sm">
				<text key="settlement" role="omp.pause.settlement" spans={[settlement]} />
				{!settled && (
					<text
						key="unsettled-turns"
						role="omp.pause.unsettled-turn-count"
						spans={[{ s: "muted", t: `Unsettled turns: ${work.unsettledTurns}` }]}
					/>
				)}
				{!settled && (
					<text
						key="unfinished-jobs"
						role="omp.pause.unfinished-job-count"
						spans={[{ s: "muted", t: `Unfinished jobs: ${work.unfinishedJobs}` }]}
					/>
				)}
			</col>
			<col key="facts" role="omp.pause.facts" gap="md">
				{FACTS.map(([icon, head, body], index) => (
					<row key={`fact-${index}`} role="omp.pause.fact" align="start" gap="md">
						<icon name={icon} />
						<col gap="none" grow={1} shrink={1}>
							<text spans={[{ s: "strong", t: head }]} />
							<text wrap="word" spans={[{ s: "muted", t: body }]} />
						</col>
					</row>
				))}
			</col>
			<row key="actions" role="omp.actions" align="center" gap="sm">
				<spacer grow={1} />
				<ActionButton
					id="resume"
					label="Resume"
					title={`Resume  ${keyTitle(interruptKey)} ·   ⏎ ·   ␣`}
					tone="accent"
					keys={kbdOf(interruptKey)}
				/>
			</row>
		</col>
	);
}
