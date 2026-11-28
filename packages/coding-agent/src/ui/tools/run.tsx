/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * One run of a command or code cell as one box (`omp.run`): its input, its
 * output, and a foot naming the state with the run time. Shared by the
 * shell and eval presenters; the terminal looks paint the box as a framed
 * card (`src/ui/styles/tools/run.ts`).
 */
import * as path from "node:path";
import { formatBytes, getProjectDir, parseSpillUrl, sanitizeText, spillUrl } from "@oh-my-pi/pi-utils";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import {
	formatArtifactErrorNotice,
	formatTruncationMetaNotice,
	type MinimizedMeta,
	type OutputMeta,
	RAW_SELECTOR,
	stripTrailingNotice,
} from "../../tools/output-meta-format";
import { shortenPath } from "../../utils/render-utils";

/** Drawn lines of a run's input before its "N more lines" button. */
export const RUN_INPUT_PREVIEW_LINES = 6;

/** What a run's foot names. */
export type RunState = "running" | "background" | "done" | "failed" | "cancelled" | "timed-out";

const RUN_STATE: Record<RunState, { readonly word: string; readonly tone: TspTone }> = {
	running: { word: "Running", tone: "pending" },
	background: { word: "In background", tone: "pending" },
	done: { word: "Done", tone: "success" },
	failed: { word: "Failed", tone: "error" },
	cancelled: { word: "Cancelled", tone: "muted" },
	"timed-out": { word: "Timed out", tone: "warning" },
};

/** Box tint per run state. */
export const RUN_BOX_TONE: Partial<Record<RunState, TspTone>> = { failed: "error", "timed-out": "warning" };

/** The truncation / artifact notices of `meta`, as plain sentences. */
export function outputNotices(meta: OutputMeta | undefined): string[] {
	const notices: string[] = [];
	if (meta?.truncation) notices.push(formatTruncationMetaNotice(meta.truncation, meta.source));
	if (meta?.artifactError) notices.push(formatArtifactErrorNotice(meta.artifactError));
	return notices;
}

/** Inputs of {@link RunFoot}. */
export interface RunFootProps {
	readonly state: RunState;
	/** Exit code of a `failed` run; a non-zero code names the state `exit N`. */
	readonly exitCode?: number;
	/** Ms run so far (live states) or in total; no clock when undefined. */
	readonly elapsedMs?: number;
	/** Quiet facts (job, service, artifact), muted and ` · `-joined. */
	readonly facts?: readonly string[];
	/** Truncation / artifact notices, appended in `warning`. */
	readonly meta?: OutputMeta;
}

/** The foot line of a run box: the state word in its tone, the run time, the quiet facts. */
export function RunFoot(props: RunFootProps): JSXNode {
	const failedWithCode = props.state === "failed" && props.exitCode !== undefined && props.exitCode !== 0;
	const state = failedWithCode
		? { word: `exit ${props.exitCode}`, tone: RUN_STATE.failed.tone }
		: RUN_STATE[props.state];
	const facts = (props.facts ?? []).map(fact => fact.trim()).filter(fact => fact.length > 0);
	const factSpans: TspSpan[] = [];
	if (facts.length > 0) factSpans.push({ t: facts.join(" · "), s: "muted" });
	for (const notice of outputNotices(props.meta)) {
		if (factSpans.length > 0) factSpans.push({ t: " · ", s: "muted" });
		factSpans.push({ t: notice, s: "warning" });
	}
	const ms = props.elapsedMs === undefined ? undefined : Math.max(0, Math.round(props.elapsedMs));
	const live = props.state === "running" || props.state === "background";
	return (
		<row key="foot" role="omp.run.foot" gap="sm" align="center">
			<text key="state" role="omp.run.state" spans={[{ t: state.word }]} tone={state.tone} />
			{ms !== undefined &&
				(live ? (
					<elapsed key="time" role="omp.run.time" age={ms} format="short" />
				) : (
					<elapsed key="time" role="omp.run.time" age={ms} stopped={ms} format="short" />
				))}
			{factSpans.length > 0 && <text key="facts" role="omp.run.facts" spans={factSpans} wrap="word" />}
		</row>
	);
}

/** A run's input: the command or cell source, clamped to {@link RUN_INPUT_PREVIEW_LINES}. */
export function RunInput(props: {
	readonly source: string;
	readonly role: string;
	readonly lang: string;
	readonly wrap: boolean;
}): JSXNode {
	return (
		<code
			key="input"
			role={props.role}
			lang={props.lang}
			wrap={props.wrap}
			preview={{ lines: RUN_INPUT_PREVIEW_LINES }}
			text={props.source.trimEnd()}
		/>
	);
}

/** A run's terminal output: follows its tail, clamped to the last `previewLines` lines while folded. */
export function RunOutput(props: {
	readonly output: string;
	readonly role: string;
	readonly previewLines: number;
	readonly nodeKey?: string;
}): JSXNode {
	return (
		<ansi
			key={props.nodeKey ?? "output"}
			role={props.role}
			follow
			preview={{ lines: props.previewLines }}
			text={props.output}
		/>
	);
}

/** One run as one box: children in order, tinted for failed and timed-out runs. */
export function RunBox(props: {
	readonly nodeKey: string;
	readonly tone?: TspTone;
	readonly children?: JSXNode;
}): JSXNode {
	return (
		<col key={props.nodeKey} role="omp.run" gap="none" tone={props.tone}>
			{props.children}
		</col>
	);
}

/** Muted placeholder (`(no output)`), word-wrapped. */
export function NoteText(props: { readonly text: string; readonly token?: string }): JSXNode {
	return <text spans={[{ t: props.text, s: props.token ?? "muted" }]} wrap="word" />;
}

/** A working directory as a call shows it: relative inside the project, `~`-shortened outside, none for the project itself. */
export function displayWorkdir(workdir: string | undefined, projectDir: string = getProjectDir()): string | undefined {
	if (!workdir) return undefined;
	const root = path.resolve(projectDir);
	const resolved = path.resolve(projectDir, workdir);
	if (resolved === root) return undefined;
	const relative = path.relative(root, resolved);
	const inside = relative.length > 0 && !path.isAbsolute(relative) && !relative.startsWith("..");
	return replaceTabs(inside ? relative : shortenPath(resolved));
}

/** Text as one plain line for a shell command preview. */
export function shellLineText(text: string): string {
	return replaceTabs(sanitizeText(text)).replace(/[\r\n]/g, " ");
}

const RAW_OUTPUT_PREFIX = "[raw output: ";
const RAW_OUTPUT_SUFFIX = "]";

/** Output without its trailing `[raw output: <spill>]` footer, and the spill it named. */
export function stripRawOutputNotice(text: string): { text: string; artifactId?: string } {
	let artifactId: string | undefined;
	const stripped = stripTrailingNotice(text, line => {
		if (!line.startsWith(RAW_OUTPUT_PREFIX) || !line.endsWith(RAW_OUTPUT_SUFFIX)) return false;
		const url = line.slice(RAW_OUTPUT_PREFIX.length, line.length - RAW_OUTPUT_SUFFIX.length);
		const id = parseSpillUrl(url);
		if (id === undefined) return false;
		const bare = spillUrl(id);
		if (url !== bare && url !== `${bare}${RAW_SELECTOR}`) return false;
		artifactId = String(id);
		return true;
	});
	return artifactId === undefined ? { text } : { text: stripped, artifactId };
}

/** `git 120.4KB → 3.2KB`: the minimizer that ran and the bytes it took the output from and to. */
export function formatMinimized(minimized: MinimizedMeta): string {
	const label = sanitizeText(minimized.filter).replace(/\s+/g, " ").trim();
	return `${label} ${formatBytes(minimized.inputBytes)} → ${formatBytes(minimized.outputBytes)}`;
}
