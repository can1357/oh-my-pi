/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * History-collapse points: compaction, handoff and branch summaries. Each is
 * a collapsible `section` headed by its label with the summary under it; a
 * text terminal draws a slim labeled rule with the expansion hint and,
 * expanded, the summary in a filled box below it.
 *
 * Terminal look: `omp.compaction` / `omp.handoff` / `omp.branch`
 * (`src/ui/styles/messages/summary.ts`).
 */
import { type JSXNode, type Reactive, read } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { cardExpansion } from "../expansion";
import { Notice } from "./notices";

/** What a summary divider shows in a text terminal. */
export interface SummaryTerm {
	/** Symbol key of the label's glyph. */
	readonly glyph: string;
	readonly label: string;
	/** A warning glyph ends the label. */
	readonly warning?: boolean;
	/** The expanded detail, as Markdown. */
	readonly detail: string;
}

/** A collapsible history-collapse summary. */
export function SummaryDivider(props: {
	role: string;
	head: readonly TspSpan[];
	expanded: Reactive<boolean>;
	term: Reactive<SummaryTerm>;
	onToggle?: (expanded: boolean) => void;
	children: JSXNode;
}): JSXNode {
	const { expanded, toggle } = cardExpansion(props.expanded, props.onToggle);
	return (
		<section
			role={props.role}
			head={props.head}
			collapsible
			collapsed={() => !expanded()}
			term={() => ({ ...read(props.term) })}
			onToggle={toggle}
		>
			{props.children}
		</section>
	);
}

/** A compaction entry. */
export interface CompactionSummary {
	readonly summary: string;
	readonly tokensBefore: number;
	readonly tokensAfter?: number;
	readonly method?: string;
	readonly warning?: string;
	readonly images?: readonly unknown[];
}

/** Divider labels per compaction method; unknown or legacy methods read "compacted". */
const METHOD_LABELS: Readonly<Record<string, string>> = {
	remote: "remote-compacted",
	soft: "soft-compacted",
	handoff: "handed-off",
	snapcompact: "snap-compacted",
	shake: "shaken",
};

function compactionDetail(message: CompactionSummary): string {
	const before = message.tokensBefore.toLocaleString();
	const after = message.tokensAfter?.toLocaleString();
	const tokenLine =
		message.tokensBefore > 0
			? after !== undefined
				? `Compacted from ${before} to ${after} tokens`
				: `Compacted from ${before} tokens`
			: after !== undefined
				? `Compacted to ${after} tokens`
				: "Compacted context";
	const frames = message.images?.length ?? 0;
	const frameNote = frames > 0 ? `\n\n_${frames} snapcompact frame${frames === 1 ? "" : "s"} attached_` : "";
	const warning = message.warning
		? `\n\n${currentTheme().symbols.icon("status.warning")} **Warning:** ${message.warning}`
		: "";
	return `**${tokenLine}**${warning}\n\n${message.summary}${frameNote}`;
}

/** A compaction point: the method that fired and the before → after amounts. */
export function CompactionSummaryBlock(props: {
	message: CompactionSummary;
	expanded: Reactive<boolean>;
	onToggle?: (expanded: boolean) => void;
}): JSXNode {
	const message = props.message;
	const name = (message.method && METHOD_LABELS[message.method]) || "compacted";
	const amounts = message.tokensAfter !== undefined && message.tokensBefore > 0;
	const head: TspSpan[] = [{ t: `${name[0]!.toUpperCase()}${name.slice(1)}`, s: "muted" }];
	if (amounts) {
		head.push(
			{ t: ` · ${formatNumber(message.tokensBefore)}`, s: "muted mono" },
			{ t: " → ", s: "dim" },
			{ t: `${formatNumber(message.tokensAfter!)} tokens`, s: "muted mono" },
		);
	}
	if (message.warning)
		head.push({
			t: ` ${currentTheme().symbols.icon("status.warning")}`,
			s: "warning",
		});
	const frames = message.images?.length ?? 0;
	const caption =
		frames > 0
			? `Summary · ${frames} snapcompact frame${frames === 1 ? "" : "s"} attached`
			: "Summary of the earlier conversation";
	const label = amounts
		? `${name} · ${formatNumber(message.tokensBefore)}→${formatNumber(message.tokensAfter!)}`
		: name;
	return (
		<SummaryDivider
			role="omp.compaction"
			head={head}
			expanded={props.expanded}
			onToggle={props.onToggle}
			term={() => ({
				glyph: "icon.camera",
				label,
				warning: !!message.warning,
				detail: compactionDetail(message),
			})}
		>
			<text propKey="caption" role="omp.compaction.caption" spans={[{ t: caption, s: "dim" }]} />
			{message.warning && <Notice tone="warning" nodeKey="warning" message={message.warning} />}
			<md propKey="summary" text={message.summary} />
		</SummaryDivider>
	);
}

/** The text of a custom message's content (text parts joined by newlines). */
function contentText(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.flatMap(part => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n");
}

/** The document between `<handoff-context>` tags (the whole text when untagged). */
function handoffDocument(text: string): string {
	const open = "<handoff-context>";
	const at = text.indexOf(open);
	if (at === -1) return text.trim();
	const start = at + open.length;
	const end = text.indexOf("</handoff-context>", start);
	return (end === -1 ? text.slice(start) : text.slice(start, end)).trim();
}

/** A handoff (a compaction persisted as a custom message for the model's context). */
export function HandoffSummaryBlock(props: {
	content: string | readonly { readonly type: string; readonly text?: string }[];
	expanded: Reactive<boolean>;
	onToggle?: (expanded: boolean) => void;
}): JSXNode {
	const detail = `**Handoff context**\n\n${handoffDocument(contentText(props.content)) || "_No handoff content._"}`;
	return (
		<SummaryDivider
			role="omp.handoff"
			head={[{ t: "Handed off", s: "muted" }]}
			expanded={props.expanded}
			onToggle={props.onToggle}
			term={{ glyph: "icon.context", label: "handed-off", detail }}
		>
			<md text={detail} />
		</SummaryDivider>
	);
}

/** A side branch collapsed back into the main line. */
export function BranchSummaryBlock(props: {
	summary: string;
	expanded: Reactive<boolean>;
	onToggle?: (expanded: boolean) => void;
}): JSXNode {
	const detail = `**Branch summary**\n\n${props.summary}`;
	return (
		<SummaryDivider
			role="omp.branch"
			head={[{ t: "Branch summarized", s: "muted" }]}
			expanded={props.expanded}
			onToggle={props.onToggle}
			term={{ glyph: "icon.branch", label: "branch", detail }}
		>
			<md text={detail} />
		</SummaryDivider>
	);
}
