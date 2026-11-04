/**
 * Extension transcript presenters (`pi.registerTranscriptPresenter`). The host installs them with
 * {@link setTranscriptPresenters}; each presentable block draws from its
 * {@link TranscriptPresentationState}.
 */
import type { TspProps, TspSpan, TspText } from "@oh-my-pi/pi-wire";
import { type Component, Container, ownDescription } from "../tui";
import { theme } from "../theme";
import { truncateToWidth } from "../render";
import { card, col, node, span, text, withHidden } from "../native/describe";
import { type DescribeContext, type NativeNode, type NativeUiEvent, rootToggleExpanded } from "../native/node";
import { Memo } from "../native/memo";
import { plainLine, plainText, spansLine } from "../native/spans";
import type { AnimationFrame, CompactTranscriptBlock } from "../chrome/transcript-container";
import type { DaemonSnapshot } from "../tools/daemon";
import type { TranscriptBlock, TranscriptPresentation, TranscriptPresenter } from "./extension-types";
import type { LateDiagnosticsFile } from "./late-diagnostics-message";
import {
	type AdvisorMessageDetails,
	type BashExecutionMessage,
	type CustomMessage,
	type HookMessage,
	LAUNCH_COMPLETION_MESSAGE_TYPE,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	type PythonExecutionMessage,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "./messages";

/** A block's presentation once every presenter has answered. */
export type ResolvedPresentation =
	| { readonly mode: "full" }
	| { readonly mode: "hidden" }
	| { readonly mode: "compact"; readonly label?: TspText; readonly rows: readonly TspText[] };

export type CompactPresentation = Extract<ResolvedPresentation, { mode: "compact" }>;

const FULL: ResolvedPresentation = { mode: "full" };
const HIDDEN: ResolvedPresentation = { mode: "hidden" };
const COMPACT: ResolvedPresentation = { mode: "compact", rows: [] };

let presenters: readonly TranscriptPresenter[] = [];
const changeListeners = new Set<() => void>();

/**
 * Install the presenters the transcript draws with, in extension load order; true when the set
 * changed. They are called as given: the installer guards them (the extension runner reports a
 * throw or an unknown answer, and answers `"full"` instead).
 */
export function setTranscriptPresenters(next: readonly TranscriptPresenter[]): boolean {
	const changed =
		next.length !== presenters.length || next.some((presenter, index) => presenter !== presenters[index]);
	presenters = next;
	return changed;
}

/** An extension registered or disposed a presenter; the host installs the set again and refreshes. */
export function notifyTranscriptPresentersChanged(): void {
	for (const listener of changeListeners) listener();
}

/** Call `listener` on {@link notifyTranscriptPresentersChanged}; returns the unsubscribe. */
export function onTranscriptPresentersChanged(listener: () => void): () => void {
	changeListeners.add(listener);
	return () => changeListeners.delete(listener);
}

const redrawListeners = new Set<(owner: Component) => void>();

/**
 * Call `listener` when a block draws a presentation other than the one it last drew, outside a
 * refresh (a late result, say): the host replays the scrollback when that block has rows in it.
 * Returns the unsubscribe.
 */
export function onTranscriptPresentationRedrawn(listener: (owner: Component) => void): () => void {
	redrawListeners.add(listener);
	return () => redrawListeners.delete(listener);
}

function isTspText(value: unknown): value is TspText {
	return (
		typeof value === "string" ||
		(Array.isArray(value) &&
			value.every(part => typeof part === "object" && part !== null && typeof part.t === "string"))
	);
}

/** Presenter text as one sanitized line: ANSI and control characters stripped, tabs expanded, breaks as spaces. */
function singleLine(value: TspText): TspText {
	if (typeof value === "string") return plainText(value).replace(/[\r\n]+/g, " ");
	return value.flatMap(part => {
		const t = plainText(part.t).replace(/[\r\n]+/g, " ");
		return t ? [{ ...part, t }] : [];
	});
}

/** `value` copied to plain data when it is {@link TspText}, else `undefined`. */
function copyTspText(value: unknown): TspText | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const parts: unknown[] = value.map(part => (typeof part === "object" && part !== null ? { ...part } : part));
	return isTspText(parts) ? parts : undefined;
}

/**
 * A presenter's answer as plain data when it is a {@link TranscriptPresentation}; `null` for
 * anything else (a misspelt mode, the Promise of an async presenter, a `compact` that is not a
 * plain object), which draws the block in full. It reads every field the transcript uses once,
 * so a throwing getter or Proxy in the answer throws here, inside the caller's guard, and never
 * while drawing. Labels and rows that are not `TspText` are dropped.
 */
export function readTranscriptPresentation(answer: unknown): TranscriptPresentation | null {
	if (answer === undefined || answer === "full" || answer === "hidden" || answer === "compact") return answer;
	if (typeof answer !== "object" || answer === null || !("compact" in answer)) return null;
	const { compact } = answer;
	if (typeof compact !== "object" || compact === null) return null;
	const prototype = Object.getPrototypeOf(compact);
	if (prototype !== Object.prototype && prototype !== null) return null;
	const label = "label" in compact ? compact.label : undefined;
	const rows = "rows" in compact ? compact.rows : undefined;
	return {
		compact: {
			label: copyTspText(label),
			rows: Array.isArray(rows) ? rows.map(copyTspText).filter(row => row !== undefined) : undefined,
		},
	};
}

/** `undefined` when the presenter defers. The answer is plain data (see {@link readTranscriptPresentation}). */
function normalize(answer: TranscriptPresentation): ResolvedPresentation | undefined {
	if (answer === undefined) return undefined;
	if (answer === "full") return FULL;
	if (answer === "hidden") return HIDDEN;
	if (answer === "compact") return COMPACT;
	const { label, rows = [] } = answer.compact;
	return { mode: "compact", label: label === undefined ? undefined : singleLine(label), rows: rows.map(singleLine) };
}

/** The first answer other than `undefined` wins. */
function resolve(block: TranscriptBlock): ResolvedPresentation {
	for (const presenter of presenters) {
		const answer = normalize(presenter(block));
		if (answer !== undefined) return answer;
	}
	return FULL;
}

function sameText(a: TspText | undefined, b: TspText | undefined): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a.length !== b.length) return false;
	return a.every((part, index) => {
		const other = b[index]!;
		return part.t === other.t && part.s === other.s && part.fx === other.fx && part.href === other.href;
	});
}

function samePresentation(a: ResolvedPresentation, b: ResolvedPresentation): boolean {
	if (a.mode !== b.mode) return false;
	if (a.mode !== "compact" || b.mode !== "compact") return true;
	return (
		sameText(a.label, b.label) &&
		a.rows.length === b.rows.length &&
		a.rows.every((row, index) => sameText(row, b.rows[index]))
	);
}

/**
 * One block's presentation, resolved lazily after {@link markStale}. The resolved object keeps
 * its identity while the answer is the same, so it can sit in render memo keys.
 */
export class TranscriptPresentationState {
	readonly #snapshot: () => TranscriptBlock | undefined;
	readonly #expanded: () => boolean;
	#current: ResolvedPresentation = FULL;
	#stale = true;
	/** What the block's last render or description drew; `undefined` before the first. */
	#drawn: ResolvedPresentation | undefined;
	/** Whether that drawing was the user's expansion rather than the presenters' answer. */
	#drawnExpanded = false;
	/** The answer changed while the block was still partial; reported once it settles. */
	#changedWhilePartial = false;
	readonly #owner: Component | undefined;

	/**
	 * `snapshot` is the block presenters see (`undefined`: always full); `expanded` tells whether
	 * the user expanded it, which always draws it in full. `owner` is the transcript block it draws
	 * ({@link onTranscriptPresentationRedrawn} names it).
	 */
	constructor(snapshot: () => TranscriptBlock | undefined, expanded: () => boolean, owner?: Component) {
		this.#snapshot = snapshot;
		this.#expanded = expanded;
		this.#owner = owner;
	}

	/** The block's data changed: ask again before the next draw. */
	markStale(): void {
		this.#stale = true;
	}

	/** What the block draws now. */
	get shown(): ResolvedPresentation {
		if (this.#expanded()) return FULL;
		if (this.#stale) {
			this.#stale = false;
			const block = presenters.length === 0 ? undefined : this.#snapshot();
			const next = block === undefined ? FULL : resolve(block);
			if (!samePresentation(next, this.#current)) this.#current = next;
		}
		return this.#current;
	}

	/** The last answer {@link shown} resolved, without asking the presenters again. */
	get resolved(): ResolvedPresentation {
		return this.#expanded() ? FULL : this.#current;
	}

	/** {@link shown}, for the block's render or description: what {@link refresh} compares against. */
	draw(): ResolvedPresentation {
		const previous = this.#drawn;
		const expanded = this.#expanded();
		const next = this.shown;
		this.#report(previous !== undefined && next !== previous && !expanded && !this.#drawnExpanded);
		this.#drawn = next;
		this.#drawnExpanded = expanded;
		return next;
	}

	/**
	 * The block's data changed where nothing may draw it again (rows retired to scrollback): ask now,
	 * and report an answer other than the drawn one as {@link draw} would. What was drawn stays the
	 * baseline until the block draws again.
	 */
	recheck(): void {
		const drawn = this.#drawn;
		if (drawn === undefined || this.#drawnExpanded || this.#expanded()) return;
		this.#report(this.shown !== drawn);
	}

	/** Tell the redraw listeners about a change, once the block is no longer partial. */
	#report(changed: boolean): void {
		if ((!changed && !this.#changedWhilePartial) || !this.#owner) return;
		const block = this.#snapshot();
		if (block?.type === "toolCall" && block.isPartial) {
			this.#changedWhilePartial = true;
			return;
		}
		this.#changedWhilePartial = false;
		for (const listener of redrawListeners) listener(this.#owner);
	}

	/**
	 * Ask again now when `ids` selects this block (every block when `undefined`); true when the
	 * answer differs from what the block last drew. A block in terminal scrollback is not drawn
	 * again, so a change its data made since (a late result) still counts. A change it reports is
	 * the caller's to redraw, so the next draw does not report it again.
	 */
	refresh(ids?: ReadonlySet<string>): boolean {
		if (ids !== undefined) {
			const block = this.#snapshot();
			if (block === undefined || !ids.has(block.id)) return false;
		}
		this.#stale = true;
		const next = this.shown;
		if (this.#drawn === undefined || next === this.#drawn) return false;
		this.#drawn = next;
		this.#drawnExpanded = this.#expanded();
		this.#changedWhilePartial = false;
		return true;
	}
}

/** A transcript block whose display presenters choose. */
export interface TranscriptPresentable {
	/**
	 * Ask again for the parts whose id is in `ids` (all when `undefined`); true when the drawing
	 * changed. True obliges the caller to redraw the block (and replay scrollback holding its rows):
	 * the change is not reported again.
	 */
	refreshTranscriptPresentation(ids?: ReadonlySet<string>): boolean;
}

export function isTranscriptPresentable(component: Component): component is Component & TranscriptPresentable {
	return typeof (component as Partial<TranscriptPresentable>).refreshTranscriptPresentation === "function";
}

/**
 * A compact block's terminal rows: `• <head>` (the presenter's `label` replacing `head`), then one
 * indented row per presenter row. Plain strings arrive sanitized (see `normalize`) and keep their
 * spacing; span arrays are styled.
 */
export function compactRows(
	head: string,
	presentation: CompactPresentation,
	width: number,
	glyph: string = theme.fg("dim", "•"),
): string[] {
	const { label } = presentation;
	const shown = label === undefined ? head : typeof label === "string" ? label : spansLine(label);
	const rows = [truncateToWidth(`${glyph} ${shown}`, width)];
	for (const row of presentation.rows) {
		rows.push(truncateToWidth(`  ${typeof row === "string" ? row : spansLine(row)}`, width));
	}
	return rows;
}

/** omp's own one-row head: the bold title, then a muted detail (raw input, sanitized to one line). */
export function compactHead(title: string, detail?: string): string {
	const shown = detail === undefined ? undefined : plainLine(detail);
	return `${theme.fg("toolTitle", theme.bold(plainLine(title)))}${shown ? theme.fg("muted", ` ${shown}`) : ""}`;
}

/** The presenter's rows as ONE text node, so a `preview` of that many lines shows all of them. */
function compactRowsNode(rows: readonly TspText[]): NativeNode {
	const spans = rows.flatMap((row, index) => {
		const parts = typeof row === "string" ? [span(row)] : row.map(part => ({ ...part }));
		return index === 0 ? parts : [span("\n"), ...parts];
	});
	return text(spans, { wrap: "none" });
}

/** How a block names itself in a compact native card when its full drawing is not a `tool` node. */
export interface CompactNativeHead {
	readonly role: string;
	readonly title: string;
	readonly target?: TspText;
}

/**
 * A block's native drawing under `presentation`. Hidden stays mounted through the `hidden` prop.
 * Compact folds a `tool` node to one inline, collapsed row (its toggle asks for the full block);
 * any other drawing becomes the body of a collapsed card headed by `head`.
 */
export function presentNative(
	full: NativeNode,
	presentation: ResolvedPresentation,
	head: CompactNativeHead,
): NativeNode {
	if (presentation.mode === "full") return full;
	if (presentation.mode === "hidden") return withHidden(full, true);
	const rows = presentation.rows;
	if (full.k !== "tool" || full.p === undefined) {
		// The head's own target can be raw call input (a bash command): sanitized like a label.
		const own = head.target;
		const target =
			presentation.label ??
			(own === undefined ? undefined : typeof own === "string" ? plainLine(own) || undefined : singleLine(own));
		const spans: TspSpan[] = [span(plainLine(head.title), "toolTitle strong")];
		if (target !== undefined)
			spans.push(span(" "), ...(typeof target === "string" ? [span(target, "muted")] : target));
		return card(
			{
				role: head.role,
				head: spans,
				collapsible: true,
				collapsed: true,
				preview: rows.length > 0 ? { lines: rows.length } : undefined,
			},
			rows.length > 0 ? [compactRowsNode(rows)] : [full],
		);
	}
	const body = rows.length > 0 ? [compactRowsNode(rows)] : (full.c ?? []);
	const props = full.p;
	const label = presentation.label;
	return {
		...full,
		p: {
			...props,
			target: label ?? props.target,
			targetKind: label !== undefined ? "text" : props.targetKind,
			frame: "inline",
			// Toggleable even with no body: opening it is the only way back to the full drawing.
			collapsible: true,
			collapsed: true,
			preview: rows.length > 0 ? { lines: rows.length } : "none",
		} satisfies TspProps<"tool">,
		c: body,
	};
}

type WrappedTranscriptBlock = Exclude<TranscriptBlock, { type: "toolCall" }>;

/** The `message` block of a session message: its id is the decimal `timestamp`. */
export function messageBlock(
	message: CustomMessage | HookMessage | BashExecutionMessage | PythonExecutionMessage,
): WrappedTranscriptBlock {
	// A legacy `hookMessage` is a custom message under its old role name.
	const shown = message.role === "hookMessage" ? { ...message, role: "custom" as const } : message;
	return { type: "message", id: String(message.timestamp), message: shown };
}

let nextEventBlockId = 0;
/** A process-unique id for an `event` block. */
export function eventBlockId(kind: string): string {
	return `${kind}:${++nextEventBlockId}`;
}

/** How a compact block names itself: the terminal row after its glyph, and the native row. */
interface BlockHead extends CompactNativeHead {
	readonly terminal: string;
	readonly glyph?: string;
	/** Kind name for the native row's icon and role styles. */
	readonly name: string;
	readonly target?: string;
}

function countOf(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function plainHead(name: string, role: string, title: string, target?: string): BlockHead {
	// The native head and the tool row it folds into show the target as is: sanitize it like `compactHead` does.
	const shown = target === undefined ? undefined : plainLine(target);
	return { terminal: compactHead(title, target), name, role, title: plainLine(title), target: shown };
}

/** omp's own one-row summary of a wrapped block, from the block presenters see. */
function blockHead(block: WrappedTranscriptBlock): BlockHead {
	if (block.type === "event") {
		const { event } = block;
		if (event.type === "ttsr_triggered") {
			return plainHead("ttsr", "omp.notice.ttsr", "Rule", event.rules.map(rule => rule.name).join(", "));
		}
		const reminder = `${countOf(event.todos.length, "incomplete todo")} - reminder ${event.attempt}/${event.maxAttempts}`;
		return plainHead("todo", "omp.notice.todo", "Todos", reminder);
	}
	const { message } = block;
	if (message.role !== "custom") {
		const bash = message.role === "bashExecution";
		const source = plainLine((bash ? message.command : message.code).split("\n", 1)[0] ?? "");
		const color = message.excludeFromContext ? "dim" : bash ? "bashMode" : "pythonMode";
		let terminal = theme.fg(color, theme.bold(`${bash ? "$" : ">>>"} ${source}`));
		if (message.cancelled) terminal += theme.fg("muted", " cancelled");
		else if (message.exitCode !== undefined && message.exitCode !== 0) {
			terminal += theme.fg("error", ` exit ${message.exitCode}`);
		}
		return bash
			? { terminal, name: "bash", role: "omp.bash", title: "Bash", target: source }
			: { terminal, name: "eval", role: "omp.eval", title: "Python", target: source };
	}
	switch (message.customType) {
		case "advisor": {
			const notes = (message.details as AdvisorMessageDetails | undefined)?.notes ?? [];
			const blockers = notes.filter(note => note.severity === "blocker").length;
			const tally = `${countOf(notes.length, "note")}${blockers > 0 ? ` · ${countOf(blockers, "blocker")}` : ""}`;
			return plainHead("advisor", "omp.advisor", "Advisor", tally);
		}
		case SKILL_PROMPT_MESSAGE_TYPE: {
			const name = (message.details as SkillPromptDetails | undefined)?.name?.trim() || "unknown";
			return plainHead("skill", "omp.skill", "Skill", name);
		}
		case LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE: {
			const files = (message.details as { files?: LateDiagnosticsFile[] } | undefined)?.files ?? [];
			const count = files.reduce((sum, file) => sum + (file.messages?.length ?? 0), 0);
			const summary = files.flatMap(file => (file.summary ? [file.summary] : [])).join(", ");
			const errored = files.some(file => file.errored);
			return {
				...plainHead(
					"diagnostics",
					"omp.diagnostics.late",
					"Late diagnostics",
					`${countOf(count, "diagnostic")}${summary ? ` · ${summary}` : ""}`,
				),
				glyph: theme.fg(errored ? "error" : "warning", errored ? theme.status.error : theme.status.warning),
			};
		}
		case "async-result": {
			const details = message.details as { jobId?: string; jobs?: { jobId?: string }[] } | undefined;
			const jobs = details?.jobs?.length ? details.jobs : [details ?? {}];
			const ids = jobs.map(job => job.jobId ?? "unknown").join(", ");
			const title = jobs.length === 1 ? "Background job completed" : `${jobs.length} background jobs completed`;
			return { ...plainHead("job", "omp.activity", title, ids), glyph: theme.fg("success", theme.status.success) };
		}
		case LAUNCH_COMPLETION_MESSAGE_TYPE: {
			const daemons = (message.details as { daemons?: DaemonSnapshot[] } | undefined)?.daemons ?? [];
			const failed = daemons.some(
				daemon => daemon.state === "failed" || (daemon.exitCode !== undefined && daemon.exitCode !== 0),
			);
			const names = daemons.map(daemon => daemon.name).join(", ");
			const title = failed ? "Supervised process failed" : "Supervised process completed";
			return {
				...plainHead(
					"process",
					"omp.activity",
					title,
					names || (typeof message.content === "string" ? message.content : undefined),
				),
				glyph: failed ? theme.fg("error", theme.status.error) : theme.fg("success", theme.status.success),
			};
		}
	}
	return plainHead("message", "omp.custom", message.customType);
}

/** Transcript hooks a wrapped component may have; the wrapper forwards the ones it has. */
interface WrappedComponent extends Component, CompactTranscriptBlock {
	setExpanded?(expanded: boolean): void;
	/**
	 * Whether the user expanded it, including through a nested disclosure no root toggle reports
	 * (the skill's `prompt`). True forces the block full, so it must default to false.
	 */
	isExpanded?(): boolean;
	setToolActivityVisible?(visible: boolean): void;
	isTranscriptBlockFinalized?(): boolean;
	setTranscriptAllocation?(rows: number, frame: AnimationFrame): void;
}

/**
 * A non-tool transcript block (advisor, skill, late diagnostics, `!`/`$` run, background job,
 * supervised process, TTSR, todo reminder) with the presenters' answer applied around the
 * component that draws it. In full it draws and describes as `inner` does; expansion, native
 * events, tool-activity visibility and finalization reach `inner`.
 */
export class PresentedBlock<T extends WrappedComponent = WrappedComponent>
	extends Container
	implements TranscriptPresentable
{
	readonly inner: T;
	#block: WrappedTranscriptBlock;
	#head: BlockHead | undefined;
	readonly #presentation: TranscriptPresentationState;
	readonly #native = new Memo();
	#expanded = false;
	#toolActivityVisible = true;
	#allocation = Number.POSITIVE_INFINITY;
	/** Only where `inner` has it: the transcript container detects tool activity by its presence. */
	readonly setToolActivityVisible?: (visible: boolean) => void;

	constructor(inner: T, block: WrappedTranscriptBlock) {
		super();
		this.inner = inner;
		this.#block = block;
		this.#presentation = new TranscriptPresentationState(
			() => this.#block,
			() => this.#expanded || this.inner.isExpanded?.() === true,
			this,
		);
		this.addChild(inner);
		const setVisible = inner.setToolActivityVisible?.bind(inner);
		if (setVisible) {
			this.setToolActivityVisible = visible => {
				this.#toolActivityVisible = visible;
				setVisible(visible);
			};
		}
	}

	get block(): WrappedTranscriptBlock {
		return this.#block;
	}

	/**
	 * The block's data changed (a `!`/`$` run was recorded, TTSR rules merged in). A block already
	 * in scrollback is not drawn again, so a changed answer is reported now for a one-time replay.
	 */
	setBlock(block: WrappedTranscriptBlock): void {
		this.#block = block;
		this.#head = undefined;
		this.#presentation.markStale();
		this.#presentation.recheck();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.inner.setExpanded?.(expanded);
	}

	/** The compact row's toggle, or `inner`'s own root toggle, expands the block. */
	handleNativeEvent(event: NativeUiEvent): void {
		const expanded = rootToggleExpanded(event);
		if (expanded !== undefined) this.#expanded = expanded;
		this.inner.handleNativeEvent?.(event);
	}

	refreshTranscriptPresentation(ids?: ReadonlySet<string>): boolean {
		return this.#presentation.refresh(ids);
	}

	isTranscriptBlockFinalized(): boolean {
		return this.inner.isTranscriptBlockFinalized?.() ?? true;
	}

	/** A squeezed compact block keeps its head and as many rows as fit; in full, `inner` decides. */
	setTranscriptAllocation(rows: number, frame: AnimationFrame): void {
		this.#allocation = Math.max(0, Math.trunc(rows));
		this.inner.setTranscriptAllocation?.(rows, frame);
	}

	/** Compact while drawn as compact rows; in full, as compact as `inner` says. */
	isTranscriptBlockCompact(): boolean {
		const mode = this.#presentation.shown.mode;
		if (mode === "full") return this.inner.isTranscriptBlockCompact?.() === true;
		return mode === "compact" && this.#toolActivityVisible && this.#allocation > 0;
	}

	/** The cached head row carries theme colours and glyphs. */
	override invalidate(): void {
		this.#head = undefined;
		super.invalidate();
	}

	override render(width: number): readonly string[] {
		const shown = this.#presentation.draw();
		if (shown.mode === "full") return super.render(width);
		if (shown.mode === "hidden" || !this.#toolActivityVisible || this.#allocation === 0) return [];
		const head = (this.#head ??= blockHead(this.#block));
		return compactRows(head.terminal, shown, width, head.glyph).slice(0, this.#allocation);
	}

	override describe(cx: DescribeContext): NativeNode | null {
		const shown = this.#presentation.draw();
		// An inner that draws as rows stays a child component, so the reconciler renders it as rows.
		const inner = ownDescription(this.inner, cx) ?? super.describe(cx);
		if (shown.mode === "full") return inner;
		const dataFirst = cx.supports("tool");
		const full = inner ?? col([]);
		return this.#native.get([full, shown, dataFirst, this.#toolActivityVisible, this.#block], () => {
			const head = (this.#head ??= blockHead(this.#block));
			let own = full;
			if (full.k === "tool" && full.p !== undefined) {
				// Already a tool row (a `!`/`$` run): it keeps its status and exit code, and its
				// compact row names the command its full card shows in the body.
				if (full.p.target === undefined)
					own = { ...full, p: { ...full.p, target: head.target, targetKind: "text" } };
			} else if (dataFirst) {
				// A terminal that draws `tool` nodes folds the block into an inline tool row.
				own = node(
					"tool",
					{
						role: head.role,
						name: head.name,
						title: head.title,
						target: head.target,
						targetKind: "text",
						status: "done",
					},
					[full],
				);
			}
			return withHidden(presentNative(own, shown, head), !this.#toolActivityVisible);
		});
	}
}
