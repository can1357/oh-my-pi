/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The `/cleanse` sheet: a run that checks the workspace, repairs what the
 * checkers report with parallel agents, and verifies again.
 *
 * It shows a scrolling log (the latest {@link LOG_LIMIT} entries: plain lines,
 * checker verdicts, agent outcomes), the live area (the current phase,
 * running checkers, the repair head with its lane meter and the running
 * lanes), and the footer: escape cancels while running and dismisses once
 * the run ended. {@link CleanseRun} is the board the cleanse command drives.
 */
import { type JSXNode, signal } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { sanitizeDisplayText } from "../../../extensibility/inventory/display-text";
import type {
	CleanseAgentOutcome,
	CleanseAssignment,
	CleanseCheckerDescriptor,
	CleanseCheckResult,
	CleanseStatusBoard,
} from "../../../modes/view-model/apps/cleanse-board";
import type { AgentProgress } from "../../../task/task-details";
import "../../styles/panels/cleanse-panel";
import { Hints } from "./common";
import { matchesAppInterrupt } from "../../../config/keybindings/matchers";
import { interruptKbd } from "../../keys/hints";

/** Log entries kept on screen. */
export const LOG_LIMIT = 14;

/** A content-derived key, stable for one identity across renders. */
function stableKey(identity: string): string {
	return Bun.hash(identity).toString(36);
}

/** Duration as `850ms` / `1.2s` / `1m 5s`. */
function shortDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const s = Math.floor(ms / 1000);
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** One entry of a run's log. */
export interface CleanseLogEntry {
	readonly id: number;
	readonly spans: TspSpan[];
	readonly role?: string;
	readonly tone?: TspTone;
	/** A plain line (a `text` prop rather than spans). */
	readonly plain?: string;
}

interface RunningChecker {
	readonly id: string;
	readonly label: string;
	readonly startedAt: number;
}

interface Lane {
	readonly name: string;
	readonly assignment: CleanseAssignment;
	readonly startedAt: number;
	tokens: number;
	cost: number;
}

interface RepairState {
	readonly startedAt: number;
	readonly lanes: Lane[];
	finished: number;
	tokens: number;
	cost: number;
}

/** How a run ended. */
export type CleanseEnding = "clean" | "unresolved" | "unsupported" | "cancelled";

const ENDINGS: Readonly<Record<CleanseEnding | "error", { readonly tone: TspTone; readonly label: string }>> = {
	clean: { tone: "success", label: "✔ Clean" },
	unresolved: { tone: "warning", label: "⚠ Diagnostics remain" },
	unsupported: { tone: "warning", label: "⚠ No runnable checker" },
	cancelled: { tone: "warning", label: "⚠ Cancelled" },
	error: { tone: "error", label: "✘ Error" },
};

/** The files of an assignment as a lane names them: the first, `+N` more. */
function assignmentLabel(assignment: CleanseAssignment): string {
	const files = assignment.groups.map(group => group.file).filter((file): file is string => !!file);
	if (files.length === 0) return `group ${assignment.index + 1}`;
	return files.length > 1 ? `${files[0]} +${files.length - 1}` : files[0]!;
}

/** The live state of one cleanse run: the board the cleanse command drives. */
export class CleanseRun implements CleanseStatusBoard {
	readonly interactive = true;
	readonly log$ = signal<readonly CleanseLogEntry[]>([]);
	readonly phase$ = signal<string | undefined>(undefined);
	readonly checkers$ = signal<readonly RunningChecker[]>([]);
	readonly repair$ = signal<RepairState | undefined>(undefined);
	readonly ending$ = signal<CleanseEnding | "error" | undefined>(undefined);
	readonly error$ = signal("");
	#nextLog = 0;
	#closed = false;

	constructor(readonly now: () => number = Date.now) {}

	#push(entry: Omit<CleanseLogEntry, "id">): void {
		const next = [...this.log$(), { ...entry, id: this.#nextLog++ }];
		this.log$.set(next.slice(-LOG_LIMIT));
	}
	#touchRepair(): void {
		const repair = this.repair$();
		if (repair) this.repair$.set({ ...repair });
	}

	log(text: string): void {
		if (!this.#closed) this.#push({ spans: [], plain: sanitizeDisplayText(text) });
	}
	logError(text: string): void {
		if (!this.#closed) this.#push({ spans: [{ s: "error", t: sanitizeDisplayText(text) }] });
	}
	phase(text: string | undefined): void {
		if (!this.#closed) this.phase$.set(text);
	}
	checkerStarted(checker: CleanseCheckerDescriptor): void {
		if (this.#closed) return;
		this.checkers$.set([...this.checkers$(), { id: checker.id, label: checker.label, startedAt: this.now() }]);
	}
	checkerFinished(check: CleanseCheckResult, durationMs: number): void {
		if (this.#closed) return;
		this.checkers$.set(this.checkers$().filter(checker => checker.id !== check.id));
		const issues = check.diagnostics.length;
		const verdict: TspSpan[] =
			issues > 0
				? [
						{ s: "warning", t: "● " },
						{ t: `${check.label} ` },
						{ s: "warning", t: `${issues} ${issues === 1 ? "issue" : "issues"}` },
					]
				: [{ s: "success", t: "✓ " }, { t: `${check.label} ` }, { s: "success", t: "clean" }];
		verdict.push({ s: "dim", t: ` · ${shortDuration(durationMs)}` });
		this.#push({ spans: verdict, role: "omp.cleanse.verdict" });
	}
	repairFinished(): void {
		if (!this.#closed) this.repair$.set(undefined);
	}
	agentStarted(name: string, assignment: CleanseAssignment): void {
		if (this.#closed) return;
		const repair = this.repair$() ?? { startedAt: this.now(), lanes: [], finished: 0, tokens: 0, cost: 0 };
		repair.lanes.push({ name, assignment, startedAt: this.now(), tokens: 0, cost: 0 });
		this.repair$.set({ ...repair });
	}
	agentProgress(name: string, progress: AgentProgress): void {
		const lane = this.repair$()?.lanes.find(l => l.name === name);
		if (!lane || this.#closed) return;
		const p = progress as { tokens?: number; cost?: number };
		lane.tokens = p.tokens ?? lane.tokens;
		lane.cost = p.cost ?? lane.cost;
	}
	agentFinished(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): void {
		if (this.#closed) return;
		const repair = this.repair$();
		const lane = repair?.lanes.find(l => l.name === outcome.name);
		const files = assignmentLabel(assignment);
		if (repair && lane) {
			repair.lanes.splice(repair.lanes.indexOf(lane), 1);
			repair.finished++;
			repair.tokens += lane.tokens;
			repair.cost += lane.cost;
			this.#touchRepair();
		}
		if (outcome.success) {
			const facts = [
				...(lane?.tokens ? [`${formatNumber(lane.tokens)} tok`] : []),
				shortDuration(this.now() - (lane?.startedAt ?? this.now())),
			];
			this.#push({
				role: "omp.cleanse.outcome",
				spans: [
					{ s: "success", t: "✓ " },
					{ t: `${outcome.name} ` },
					{ s: "path", t: files },
					{ s: "dim", t: ` · ${facts.join(" · ")}` },
				],
			});
		} else {
			const error = sanitizeDisplayText(outcome.error ?? "failed")
				.replace(/\s+/g, " ")
				.trim();
			this.#push({
				role: "omp.cleanse.outcome",
				tone: "error",
				spans: [
					{ s: "error", t: "✗ " },
					{ t: `${outcome.name} ` },
					{ s: "path", t: files },
					{ s: "error", t: ` ${error}` },
				],
			});
		}
	}
	/** The run ended. */
	finish(ending: CleanseEnding): void {
		if (!this.#closed) this.ending$.set(ending);
	}
	markError(message: string): void {
		if (this.#closed) return;
		this.error$.set(sanitizeDisplayText(message));
		this.ending$.set("error");
	}
	/** Freeze the sheet: later updates are ignored. */
	close(): void {
		this.#closed = true;
	}
}

function RepairHead(props: { readonly repair: RepairState; readonly now: number }): JSXNode {
	const { repair } = props;
	const total = repair.finished + repair.lanes.length;
	const facts: string[] = [];
	if (repair.lanes.length > 0) facts.push(`${repair.lanes.length} running`);
	if (repair.tokens > 0) facts.push(`${formatNumber(repair.tokens)} tok`);
	if (repair.cost > 0) facts.push(`$${repair.cost.toFixed(3)}`);
	return (
		<row key="repair" role="omp.cleanse.head" align="center" gap="sm">
			<spinner tone="accent" label="Repairing" />
			<meter
				role="omp.cleanse.meter"
				style="bar"
				size="md"
				value={total > 0 ? repair.finished / total : 0}
				label={`${repair.finished}/${total} lanes`}
				title={`${repair.finished} of ${total} repair lanes finished`}
			/>
			{facts.length > 0 && <text spans={[{ s: "muted", t: facts.join(" · ") }]} />}
			<elapsed format="short" age={props.now - repair.startedAt} />
		</row>
	);
}

/** One log entry of a run: a plain line, a checker verdict or an agent outcome. */
export function CleanseLogLine(props: { readonly entry: CleanseLogEntry }): JSXNode {
	const entry = props.entry;
	return entry.plain !== undefined ? (
		<text key={`log-${entry.id}`} wrap="word" text={entry.plain} />
	) : (
		<text key={`log-${entry.id}`} role={entry.role} tone={entry.tone} wrap="word" spans={entry.spans} />
	);
}

/** The run's live area: the phase, running checkers, the repair head and its lanes; nothing while idle. */
export function CleanseLive(props: { readonly run: CleanseRun }): JSXNode {
	const { run } = props;
	return () => {
		const phase = run.phase$();
		const checkers = run.checkers$();
		const repair = run.repair$();
		if (phase === undefined && checkers.length === 0 && !repair) return null;
		const now = run.now();
		return (
			<col key="live" role="omp.cleanse.live" gap="sm">
				{phase !== undefined && <spinner key="phase" tone="warning" label={phase} />}
				{checkers.map(checker => (
					<row key={`checker-${stableKey(checker.id)}`} gap="sm">
						<spinner tone="warning" label={checker.label} />
						<elapsed format="short" age={now - checker.startedAt} />
					</row>
				))}
				{repair && <RepairHead repair={repair} now={now} />}
				{repair && (
					<col key="lanes" role="omp.cleanse.lanes" gap="sm">
						{repair.lanes.map(lane => (
							<agent
								key={`agent-${stableKey(lane.name)}`}
								role="omp.cleanse.lane"
								name={lane.name}
								status="running"
								task={[{ s: "path", t: assignmentLabel(lane.assignment) }]}
								tool={null}
								retry={null}
								stats={{ age: now - lane.startedAt }}
							/>
						))}
					</col>
				)}
			</col>
		);
	};
}

export interface CleansePanelProps {
	readonly run: CleanseRun;
	/** The user's request (absent for checker-discovery runs). */
	readonly request?: string;
	/** Escape while running. */
	onCancel?(): void;
	/** Escape once ended. */
	onDismiss?(): void;
}

export function CleansePanel(props: CleansePanelProps): JSXNode {
	const { run } = props;
	const request = props.request === undefined ? undefined : sanitizeDisplayText(props.request);
	const head: TspSpan[] = [{ s: "accent", t: "/cleanse" }];
	if (request) head.push({ t: ` ${request}` });
	const ending = () => {
		const end = run.ending$();
		return end ? ENDINGS[end] : undefined;
	};
	return (
		<col
			role="omp.overlay.cleanse"
			gap="sm"
			tone={() => ending()?.tone}
			term={{ title: `/cleanse${request?.trim() ? ` ${request.replace(/\s+/g, " ").trim()}` : ""}` }}
			onKey={key => {
				if (!matchesAppInterrupt(key)) return false;
				if (run.ending$()) props.onDismiss?.();
				else props.onCancel?.();
				return true;
			}}
		>
			<row key="head" role="omp.sheet.head" align="center" gap="sm">
				{() => !run.ending$() && <spinner />}
				<text lines={1} truncate="end" spans={head} />
			</row>
			{() =>
				run.log$().length > 0 && (
					<col key="log">
						{run.log$().map(entry => (
							<CleanseLogLine entry={entry} />
						))}
					</col>
				)
			}
			<CleanseLive run={run} />
			{() => run.ending$() === "error" && <text key="error" wrap="word" spans={[{ s: "error", t: run.error$() }]} />}
			{() => {
				const end = ending();
				if (!end) return <Hints nodeKey="footer" hints={[{ keys: interruptKbd(), label: "cancel /cleanse" }]} />;
				return (
					<row key="footer" align="center" gap="md" wrap>
						<text spans={[{ s: end.tone, t: end.label }]} />
						<Hints hints={[{ keys: interruptKbd(), label: "dismiss" }]} />
					</row>
				);
			}}
		</col>
	);
}
