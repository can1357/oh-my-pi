/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Advisor notes injected into the session: a callout tinted by its worst
 * note (that severity's icon and the tally head it, the advisor's name ends
 * the head; with several notes each leads with its own severity icon). More
 * than three notes collapse to a preview.
 *
 * Expansion follows the transcript-wide toggle; a toggle made on this card
 * in the terminal overrides it until the next transcript-wide change. A
 * collapsed card's note rows are capped at `collapsedLines`
 * (`display.advisorCollapsedLines`; 0 keeps the whole preview).
 *
 * Terminal look: `omp.advisor` (`src/ui/styles/messages/advisor.ts`): an
 * `ⓘ Advisor` tag with the note count, then each note on a rail tinted by
 * its severity.
 */
import { type JSXNode, type Reactive, read } from "@oh-my-pi/pi-tui";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import type { AdvisorMessageDetails, AdvisorNote, AdvisorSeverity } from "../../../session/transcript/messages";
import { cardExpansion } from "../expansion";

/** Notes a collapsed card shows. */
export const COLLAPSED_ADVISOR_NOTES = 3;

/** A note's rank: its severity, `note` when it has none. */
type Rank = AdvisorSeverity | "note";

/** Ranks worst first: the callout wears the worst rank among its notes. */
const RANKS: readonly Rank[] = ["blocker", "concern", "nit", "note"];

const RANK_LOOK: Readonly<Record<Rank, { tone: TspTone; icon: string; label: string; style: string }>> = {
	blocker: {
		tone: "error",
		icon: "octagon-alert",
		label: "Blocker",
		style: "error strong",
	},
	concern: {
		tone: "warning",
		icon: "warn",
		label: "Concern",
		style: "warning strong",
	},
	nit: { tone: "neutral", icon: "lightbulb", label: "Nit", style: "strong" },
	note: { tone: "neutral", icon: "info", label: "Note", style: "strong" },
};

const rankOf = (note: AdvisorNote): Rank => note.severity ?? "note";

/** The advisor a note came from; undefined for the implicit default advisor. */
export function noteSource(note: AdvisorNote): string | undefined {
	return note.advisor && note.advisor !== "default" ? note.advisor : undefined;
}

/** One note's rank (`Concern`), else a tally worst first (`1 blocker · 2 concerns`). */
function tally(notes: readonly AdvisorNote[]): TspSpan[] {
	if (notes.length === 1) {
		const { label, style } = RANK_LOOK[rankOf(notes[0]!)];
		return [{ t: label, s: style }];
	}
	const spans: TspSpan[] = [];
	for (const rank of RANKS) {
		const count = notes.filter(note => rankOf(note) === rank).length;
		if (count === 0) continue;
		if (spans.length > 0) spans.push({ t: " · ", s: "dim" });
		spans.push({
			t: `${count} ${rank}${count === 1 ? "" : "s"}`,
			s: RANK_LOOK[rank].style,
		});
	}
	return spans;
}

/** Advisor notes. */
export function AdvisorMessage(props: {
	details: AdvisorMessageDetails | undefined;
	/** The transcript-wide expansion. */
	expanded: Reactive<boolean>;
	onToggle?: (expanded: boolean) => void;
	/** Most note rows the terminal shows under a collapsed card's head; 0 or absent: no cap. */
	collapsedLines?: Reactive<number>;
}): JSXNode {
	const notes = props.details?.notes ?? [];
	const { expanded, toggle } = cardExpansion(props.expanded, props.onToggle);
	const look = RANK_LOOK[RANKS.find(rank => notes.some(note => rankOf(note) === rank)) ?? "note"];
	const sources = new Set(notes.map(noteSource));
	const [sole] = sources;
	const attribute = sources.size > 1;
	const collapsible = notes.length > COLLAPSED_ADVISOR_NOTES;
	const spansOf = (note: AdvisorNote): TspSpan[] => {
		const who = attribute ? noteSource(note) : undefined;
		const body = { t: stripEscapes(note.note).replaceAll("\t", "   ") };
		return who ? [{ t: `${who} · `, s: "dim" }, body] : [body];
	};
	return (
		<card
			role="omp.advisor"
			tone={look.tone}
			collapsible={collapsible}
			collapsed={() => (collapsible ? !expanded() : undefined)}
			preview={collapsible ? "auto" : undefined}
			term={() => ({ notes, expanded: expanded(), collapsedLines: read(props.collapsedLines) })}
			onToggle={toggle}
		>
			<row key="head" gap="sm" align="center" role="omp.advisor.head">
				<icon name={look.icon} tone={look.tone} />
				<text spans={tally(notes)} grow={1} />
				<text role="omp.advisor.source" spans={[{ t: sources.size === 1 && sole ? sole : "Advisor", s: "dim" }]} />
			</row>
			{notes.map((note, index) => {
				if (notes.length === 1) {
					return <text propKey={`n${index}`} role="omp.advisor.note" spans={spansOf(note)} wrap="word" />;
				}
				const { tone, icon, label } = RANK_LOOK[rankOf(note)];
				return (
					<row key={`n${index}`} gap="sm" align="start" role="omp.advisor.note" tone={tone}>
						<icon name={icon} tone={tone} aria={label} />
						<text spans={spansOf(note)} wrap="word" grow={1} shrink={1} />
					</row>
				);
			})}
		</card>
	);
}
