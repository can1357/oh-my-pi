/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A command or cell the user ran from the composer (`!cmd`, `$code`; `!!`/`$$`
 * when excluded from context), shown in the transcript as the agent's own
 * `tool` frame with a `you` badge: one run box (the source, the output as an
 * `ansi` terminal following its tail, the foot) and any images below it.
 *
 * {@link ExecRun} holds the run's state as the session reports it (output
 * chunks, PTY bytes, completion, expand state); {@link ExecRunBlock} is its
 * node. The terminal look is `src/ui/styles/transcript/exec-run.ts`.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { type Accessor, computed, type JSXNode, type KeyEvent, type Signal, signal, untrack } from "@oh-my-pi/pi-tui";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspCardStatus, TspTone } from "@oh-my-pi/pi-wire";
import type { MinimizedMeta, TruncationMeta } from "../../tools/output-meta-format";
import { formatArtifactErrorNotice, formatTruncationMetaNotice } from "../../tools/output-meta-format";
import { formatMinimized, RunBox, RunFoot, RunInput, RunOutput, type RunState } from "../tools/run";
import { imageBlob, ImageNode, imagePlaceholder } from "./messages/image";
import { ptyKeyBytes } from "../overlays/panels/pty-console";
import { PtyReplay, styleReplayedRow } from "./pty-replay";

/** Which runner produced the run. */
export type ExecKind = "bash" | "eval";

/** Eval cell languages. */
export type ExecLanguage = "python" | "js";

/** How a run ended (or that it still runs). */
export type ExecStatus = "running" | "complete" | "cancelled" | "error";

/** An image a run produced. */
export interface ExecImage {
	readonly data: string;
	readonly mimeType: string;
}

/** What completion reports beyond the exit code. */
export interface ExecCompletion {
	/** The final output, replacing what streamed. */
	readonly output?: string;
	readonly truncation?: TruncationMeta;
	readonly artifactError?: unknown;
	readonly minimized?: MinimizedMeta;
	readonly images?: readonly ExecImage[];
	readonly showImages?: boolean;
}

export interface ExecRunOptions {
	readonly kind: ExecKind;
	/** The command (bash) or cell source (eval). */
	readonly source: string;
	/** Excluded from context (`!!` / `$$`). */
	readonly excluded?: boolean;
	readonly language?: ExecLanguage;
	/** Application clock in ms. */
	readonly now?: () => number;
	/** The PTY's size: the frame's inner area. */
	readonly ptyViewport?: { readonly cols: number; readonly rows: number };
}

/** Terminal-only facts of a run (`term`), see the exec-run look. */
export type ExecRunTerm = {
	readonly look: "exec-run";
	readonly kind: ExecKind;
	/** Frame color key: `bashMode` / `pythonMode`, `dim` when excluded. */
	readonly color: string;
	/** Highlight language of an eval cell. */
	readonly lang?: string;
	/** The output rows arrive styled (a PTY replay): no muted wash. */
	readonly styled: boolean;
	/** Output rows, one per line. */
	readonly lines: readonly string[];
	/** Placeholders of images the terminal cannot show. */
	readonly images: readonly string[];
	/** The blob of each image (its placeholder links to the image's file). */
	readonly imageBlobs?: readonly string[];
	/** Notices under a settled run, in order: `{ text, color }`. */
	readonly notices: readonly { readonly text: string; readonly color: string }[];
};

/** Longest output line kept, in cells. */
const MAX_LINE_CELLS = 4000;
/** Output lines kept while a run streams (5 × the collapsed preview). */
const STREAMING_LINE_CAP = 100;
/** Collapsed output rows of the run box's `ansi` node. */
const OUTPUT_PREVIEW_LINES = 10;

/** A line clamped to {@link MAX_LINE_CELLS} with a note of what was cut. */
function clampLine(line: string): string {
	const width = visibleWidth(line);
	if (width <= MAX_LINE_CELLS) return line;
	return `${truncate(line, MAX_LINE_CELLS, "")}… [${width - MAX_LINE_CELLS} visible columns omitted]`;
}

const RUN_STATE: Record<ExecStatus, RunState> = {
	running: "running",
	complete: "done",
	cancelled: "cancelled",
	error: "failed",
};

const CARD_STATUS: Record<ExecStatus, TspCardStatus> = {
	running: "running",
	complete: "done",
	cancelled: "cancelled",
	error: "error",
};

/** A user-run command or cell. */
export class ExecRun {
	readonly kind: ExecKind;
	readonly source: string;
	readonly excluded: boolean;
	readonly language: ExecLanguage;
	readonly #now: () => number;
	readonly #startedAt: number;
	readonly #endedAt = signal<number | undefined>(undefined);
	readonly #lines: Signal<readonly string[]> = signal<readonly string[]>([]);
	readonly #status = signal<ExecStatus>("running");
	readonly #exitCode = signal<number | undefined>(undefined);
	readonly #completion = signal<ExecCompletion | undefined>(undefined);
	readonly #expanded = signal(false);
	readonly #pty = signal(false);
	readonly #ptyViewport: { readonly cols: number; readonly rows: number };
	#replay: PtyReplay | undefined;

	constructor(options: ExecRunOptions) {
		this.kind = options.kind;
		this.source = options.source;
		this.excluded = options.excluded ?? false;
		this.language = options.language ?? "python";
		this.#now = options.now ?? Date.now;
		this.#startedAt = this.#now();
		this.#ptyViewport = options.ptyViewport ?? { cols: 78, rows: 20 };
	}

	/** Output rows so far. */
	get lines(): Accessor<readonly string[]> {
		return this.#lines;
	}

	get status(): Accessor<ExecStatus> {
		return this.#status;
	}

	get exitCode(): Accessor<number | undefined> {
		return this.#exitCode;
	}

	get completion(): Accessor<ExecCompletion | undefined> {
		return this.#completion;
	}

	get expanded(): Accessor<boolean> {
		return this.#expanded;
	}

	get pty(): Accessor<boolean> {
		return this.#pty;
	}

	/** Ms run so far, or in total once settled (read untracked: the terminal counts on). */
	elapsedMs(): number {
		return Math.max(0, Math.round((this.#endedAt() ?? untrack(() => this.#now())) - this.#startedAt));
	}

	/** A chunk of plain output: continues the last line, adds the rest. */
	appendOutput(chunk: string): void {
		if (this.#pty.peek()) return;
		const incoming = chunk.split("\n").map(clampLine);
		const lines = [...this.#lines.peek()];
		if (lines.length > 0 && incoming.length > 0)
			lines[lines.length - 1] = clampLine(`${lines[lines.length - 1]}${incoming.shift()}`);
		lines.push(...incoming);
		this.#lines.set(lines.length > STREAMING_LINE_CAP ? lines.slice(-STREAMING_LINE_CAP) : lines);
	}

	/** Raw terminal bytes of a PTY run; resolves once they are on screen. */
	async appendPtyChunk(chunk: string): Promise<void> {
		if (this.#status.peek() !== "running") return;
		this.#pty.set(true);
		this.#replay ??= new PtyReplay(this.#ptyViewport);
		await this.#replay.write(chunk);
		this.#lines.set(this.#replay.rows(false));
	}

	/** The bytes `key` sends the run's PTY (cursor keys follow the program's application-cursor mode). */
	ptyInput(key: KeyEvent): string {
		return ptyKeyBytes(key, this.#replay?.applicationCursorKeys() ?? false);
	}

	/** The run ended: exit code (none when cancelled), final output and notes. */
	setComplete(exitCode: number | undefined, cancelled: boolean, completion?: ExecCompletion): void {
		this.#exitCode.set(exitCode);
		this.#status.set(cancelled ? "cancelled" : exitCode !== undefined && exitCode !== 0 ? "error" : "complete");
		if (this.#endedAt.peek() === undefined) this.#endedAt.set(this.#now());
		// Eval runs report only their output and its truncation notes.
		this.#completion.set(
			this.kind === "eval" && completion
				? { output: completion.output, truncation: completion.truncation, artifactError: completion.artifactError }
				: completion,
		);
		if (this.#replay) {
			this.#lines.set(this.#replay.rows(true));
			this.#replay.dispose();
			this.#replay = undefined;
		} else if (completion?.output !== undefined) {
			const clean = sanitizeText(completion.output);
			this.#lines.set(clean ? clean.split("\n").map(clampLine) : []);
		}
	}

	setExpanded(expanded: boolean): void {
		this.#expanded.set(expanded);
	}

	/** A native fold toggle. */
	toggle(collapsed: boolean): void {
		this.#expanded.set(!collapsed);
	}
}

/** The notes under a settled run. */
function runNotices(run: ExecRun): ExecRunTerm["notices"] {
	const completion = run.completion();
	const notices: { text: string; color: string }[] = [];
	if (completion?.truncation)
		notices.push({ text: formatTruncationMetaNotice(completion.truncation), color: "warning" });
	if (completion?.artifactError !== undefined)
		notices.push({ text: formatArtifactErrorNotice(String(completion.artifactError) as never), color: "warning" });
	if (completion?.minimized)
		notices.push({ text: `Minimized: ${formatMinimized(completion.minimized)}`, color: "dim" });
	return notices;
}

/** The transcript node of a user run. */
export function ExecRunBlock(props: { readonly run: ExecRun }): JSXNode {
	const { run } = props;
	const shell = run.kind === "bash";
	const lang = shell ? "bash" : run.language === "js" ? "javascript" : "python";
	const title = shell ? "Bash" : run.language === "js" ? "JavaScript" : "Python";
	const color = run.excluded ? "dim" : shell ? "bashMode" : "pythonMode";
	const badges: { text: string; tone?: TspTone; title?: string }[] = [{ text: "you", tone: "user" }];
	if (run.excluded) badges.push({ text: "not sent", title: "Not sent to the model", tone: "muted" });
	const facts = computed(() => {
		const status = run.status();
		const ms = run.elapsedMs();
		const running = status === "running";
		return { status, ms, running };
	});
	// PTY rows are replayed onto the theme's output color.
	const lines = computed(() => {
		const rows = run.lines();
		if (!run.pty()) return rows;
		const base = currentTheme().fgSgr("muted");
		return rows.map(row => (row ? styleReplayedRow(row, base) : ""));
	});
	const output = computed(() => lines().join("\n"));
	const images = computed(() => {
		const completion = run.completion();
		const list = completion?.images ?? [];
		const show = completion?.showImages ?? true;
		return { list, show };
	});
	const term = computed((): ExecRunTerm => ({
		look: "exec-run",
		kind: run.kind,
		color,
		...(shell ? {} : { lang }),
		styled: run.pty(),
		lines: lines(),
		images: images().list.map(image => imagePlaceholder(image)),
		imageBlobs: images().list.map(image => imageBlob(image)),
		notices: run.status() === "running" ? [] : runNotices(run),
	}));
	return (
		<tool
			role={shell ? "omp.bash" : "omp.eval"}
			name={run.kind}
			title={title}
			command={run.source}
			badges={badges}
			status={() => CARD_STATUS[facts().status]}
			age={() => (facts().running ? facts().ms : undefined)}
			took={() => (facts().running ? undefined : facts().ms)}
			exit={() => (facts().status === "error" ? run.exitCode() : undefined)}
			note={() => (facts().status === "cancelled" ? "cancelled" : undefined)}
			frame="card"
			collapsible
			collapsed={() => !run.expanded()}
			preview="children"
			term={term}
			onToggle={collapsed => run.toggle(collapsed)}
		>
			{() => {
				const state = RUN_STATE[facts().status];
				const completion = untrack(() => run.completion());
				const text = output();
				return [
					<RunBox nodeKey="run" tone={state === "failed" ? "error" : undefined}>
						<RunInput
							source={run.source}
							role={shell ? "omp.tool.bash.command" : "omp.tool.eval.input"}
							lang={lang}
							wrap={shell}
						/>
						{text.length > 0 && (
							<RunOutput
								output={text}
								role={shell ? "omp.tool.bash.output" : "omp.tool.eval.output"}
								previewLines={OUTPUT_PREVIEW_LINES}
							/>
						)}
						<RunFoot
							state={state}
							exitCode={run.exitCode()}
							elapsedMs={facts().ms}
							facts={completion?.minimized ? [`Minimized ${formatMinimized(completion.minimized)}`] : undefined}
							meta={
								completion
									? { truncation: completion.truncation, artifactError: completion.artifactError as never }
									: undefined
							}
						/>
					</RunBox>,
					images().list.map((image, index) =>
						images().show ? (
							<ImageNode nodeKey={`img${index}`} image={image} alt={image.mimeType} />
						) : (
							<text spans={[{ t: imagePlaceholder(image), s: "muted" }]} />
						),
					),
				];
			}}
		</tool>
	);
}
