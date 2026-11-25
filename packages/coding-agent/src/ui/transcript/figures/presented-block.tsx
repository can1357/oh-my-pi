/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A transcript block (a message or an event) drawn the way the extension
 * transcript presenters ask: in full (its own face), as one compact tool row
 * (omp's summary, or the presenter's label and rows), or not at all.
 *
 * The compact form is an inline, collapsed `tool` node: a face that is
 * itself a `tool` lends its props and body to it; any other face becomes its
 * body. A block the user expanded is always drawn in full; hidden tool
 * activity hides the compact row.
 *
 * Terminal look of the compact row: `src/ui/styles/figures/presented.ts`.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { computed, type JSXNode, type Reactive, read, resolveChildren, type UiNode, untrack } from "@oh-my-pi/pi-tui";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import type { TspSpan, TspText, TspToolProps } from "@oh-my-pi/pi-wire";
import type { TranscriptBlock, TranscriptPresentation } from "../../../extensibility/extensions/render-types";

/** What a compact row says about a block. */
export interface PresentedFacts {
	readonly name: string;
	readonly title: string;
	/** Role of the compact tool node (the block's own look family). */
	readonly role?: string;
	/** What the block is about, one line (the native row's target). */
	readonly target?: string;
	/** The terminal row's summary (after the status glyph). */
	readonly summary: readonly TspSpan[];
}

/** Roles a compact presented row can carry (each has the compact terminal look). */
export const PRESENTED_ROLES = [
	"omp.presented",
	"omp.notice.ttsr",
	"omp.notice.todo",
	"omp.advisor",
	"omp.skill",
	"omp.diagnostics.late",
	"omp.notice.async",
] as const;

/** Terminal facts of a compact presented row. */
export type PresentedTerm = {
	readonly role: "omp.presented";
	/** The summary row (omp's), or undefined when the presenter gave a label. */
	readonly summary?: readonly TspSpan[];
};

function oneLine(text: string): string {
	return sanitizeText(stripEscapes(text)).replace(/\s+/g, " ").trim();
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Title and target of a compact row: the title bold, the target muted. */
function titled(title: string, target: string | undefined): TspSpan[] {
	return target
		? [
				{ t: title, s: "toolTitle strong" },
				{ t: ` ${target}`, s: "muted" },
			]
		: [{ t: title, s: "toolTitle strong" }];
}

/** A run's compact row: the command in its mode color, then a failing exit code. */
function runFacts(
	name: string,
	title: string,
	mode: string,
	prompt: string,
	code: string,
	exit: number | undefined,
): PresentedFacts {
	// A recorded command may carry control sequences (a terminal title, a bell): never draw them raw.
	const target = oneLine(code.split("\n")[0] ?? "");
	const summary: TspSpan[] = [{ t: `${prompt} ${target}`, s: `${mode} strong` }];
	if (exit !== undefined && exit !== 0) summary.push({ t: ` exit ${exit}`, s: "error" });
	return { name, title, target, summary };
}

/** omp's own compact facts of a block, or undefined for a block type it does not know. */
export function presentedFacts(block: TranscriptBlock): PresentedFacts | undefined {
	if (block.type === "event") {
		const event = block.event;
		if (event.type === "ttsr_triggered") {
			const target = event.rules.map(rule => oneLine(rule.name)).join(", ");
			return { name: "ttsr", title: "Rule", role: "omp.notice.ttsr", target, summary: titled("Rule", target) };
		}
		const open = event.todos.filter(todo => todo.status !== "completed").length;
		const target = `${plural(open, "open todo")} · attempt ${event.attempt}/${event.maxAttempts}`;
		return { name: "todo", title: "Todos", role: "omp.notice.todo", target, summary: titled("Todos", target) };
	}
	if (block.type !== "message") return undefined;
	const message = block.message;
	if (message.role === "bashExecution")
		return runFacts("bash", "Bash", "bashMode", "$", message.command, message.exitCode ?? undefined);
	if (message.role === "pythonExecution")
		return runFacts("eval", "Python", "pythonMode", ">>>", message.code, message.exitCode ?? undefined);
	const details = (message.details ?? {}) as Record<string, unknown>;
	switch (message.customType) {
		case "advisor": {
			const notes = Array.isArray(details.notes) ? (details.notes as { severity?: string }[]) : [];
			const blockers = notes.filter(note => note.severity === "blocker").length;
			const target = [plural(notes.length, "note"), ...(blockers > 0 ? [plural(blockers, "blocker")] : [])].join(
				" · ",
			);
			return { name: "advisor", title: "Advisor", role: "omp.advisor", target, summary: titled("Advisor", target) };
		}
		case "skill-prompt": {
			const target = oneLine(typeof details.name === "string" ? details.name : "");
			return { name: "skill", title: "Skill", role: "omp.skill", target, summary: titled("Skill", target) };
		}
		case "lsp-late-diagnostic":
			return {
				name: "diagnostics",
				title: "Diagnostics",
				role: "omp.diagnostics.late",
				summary: titled("Diagnostics", undefined),
			};
		default:
			return {
				name: message.customType,
				title: message.customType,
				role: "omp.notice.async",
				summary: titled(message.customType, undefined),
			};
	}
}

/** A presenter's text as spans. */
function spansOf(text: TspText): TspSpan[] {
	return typeof text === "string" ? [{ t: text }] : [...text];
}

/** A presenter row on one line: tabs as spaces, line breaks as one space. */
function flatRow(text: TspText): TspSpan[] {
	return spansOf(text).map(span => ({ ...span, t: span.t.replaceAll("\t", "   ").replace(/\r?\n/g, " ") }));
}

/**
 * A presenter's compact rows as the spans of one text node: each row on one line, a `\n` span
 * between rows, theme tokens kept. Terminal rows: `paintPresenterRows` (`ui/styles/figures/presented.ts`).
 */
export function presenterRows(rows: readonly TspText[]): TspSpan[] {
	return rows.flatMap((row, i) => (i === 0 ? flatRow(row) : [{ t: "\n" }, ...flatRow(row)]));
}

/**
 * How a presented block draws: in full while expanded, when no presenter answered or one said
 * `"full"`, and for a block omp has no compact facts of; else as the presenters answered.
 */
export function presentedMode(
	block: TranscriptBlock,
	answer: TranscriptPresentation,
	expanded: boolean,
): "full" | "hidden" | "compact" {
	if (expanded || answer === undefined || answer === "full" || !presentedFacts(block)) return "full";
	return answer === "hidden" ? "hidden" : "compact";
}

/** See the module docs. */
export function PresentedBlock(props: {
	readonly block: TranscriptBlock;
	/** The presenters' answer (undefined: none answered). */
	readonly presentation: Reactive<TranscriptPresentation>;
	/** The user expanded the block: it draws in full whatever the presenters say. */
	readonly expanded: Reactive<boolean>;
	readonly onToggle: (collapsed: boolean) => void;
	/** The transcript shows tool activity (default true). */
	readonly activityVisible?: Reactive<boolean>;
	/** The block's own face (one node). */
	readonly children: JSXNode;
}): JSXNode {
	const faces = resolveChildren(props.children);
	const facts = presentedFacts(props.block);
	const mode = computed(() => presentedMode(props.block, read(props.presentation), read(props.expanded)));
	const custom = computed(() => {
		const answer = read(props.presentation);
		return typeof answer === "object" ? answer.compact : undefined;
	});
	const hidden = (): true | undefined =>
		props.activityVisible === undefined || read(props.activityVisible) ? undefined : true;
	return () => {
		const face = faces()[0];
		const shown = mode();
		const spec = custom();
		if (!face || !facts || shown === "full") return face;
		return untrack(() => compactNode(face, facts, shown, spec, hidden, props.onToggle));
	};
}

type CompactSpec = Extract<TranscriptPresentation, { compact: unknown }>["compact"];

function compactNode(
	face: UiNode,
	facts: PresentedFacts,
	shown: "hidden" | "compact",
	spec: CompactSpec | undefined,
	hidden: () => true | undefined,
	onToggle: (collapsed: boolean) => void,
): JSXNode {
	const isTool = face.kind === "tool";
	// A tool face lends its live head; the presenter's label, else the face's target, else omp's wins the target.
	const head = computed(() => {
		const own = isTool ? (face.props() as Partial<TspToolProps>) : undefined;
		const target: { target?: TspText; targetKind?: TspToolProps["targetKind"] } =
			spec?.label !== undefined
				? { target: spansOf(spec.label), targetKind: "text" }
				: own?.target !== undefined
					? { target: own.target, targetKind: own.targetKind }
					: { target: facts.target, targetKind: facts.target === undefined ? undefined : "text" };
		return {
			name: own?.name ?? facts.name,
			title: typeof own?.title === "string" ? own.title : facts.title,
			status: own?.status ?? ("done" as const),
			...target,
		};
	});
	const term: PresentedTerm = {
		role: "omp.presented",
		...(spec?.label === undefined ? { summary: facts.summary } : {}),
	};
	const rows = spec?.rows ?? [];
	const body: JSXNode = spec
		? rows.length > 0 && <text spans={presenterRows(rows)} wrap="none" />
		: isTool
			? () => face.children()
			: face;
	if (shown === "hidden") {
		return (
			<tool
				name={() => head().name}
				title={() => head().title}
				status={() => head().status}
				role={facts.role}
				target={() => head().target}
				targetKind={() => head().targetKind}
				hidden
				term={term}
			>
				{body}
			</tool>
		);
	}
	return (
		<tool
			name={() => head().name}
			title={() => head().title}
			status={() => head().status}
			role={facts.role}
			target={() => head().target}
			targetKind={() => head().targetKind}
			frame="inline"
			collapsible
			collapsed
			onToggle={onToggle}
			preview={spec ? { lines: rows.length } : "none"}
			hidden={hidden}
			term={term}
		>
			{body}
		</tool>
	);
}
