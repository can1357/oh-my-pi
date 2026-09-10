import { type Component } from "../tui";
import { Disclosure } from "../components/disclosure";
import { visibleWidth } from "../utils";
import type { AdvisorMessageDetails, AdvisorNote, AdvisorSeverity } from "./messages";
import { formatBadge, replaceTabs, type ToolUIColor, wrapTextWithAnsi } from "../render/render-utils";
import { Ellipsis, truncateToWidth } from "../render";
import type { Theme } from "../theme";

const COLLAPSED_NOTES = 3;
const NOTE_LINE_WIDTH = 110;

function wrapVarying(text: string, w1: number, w2: number): string[] {
	if (text.length === 0) return [];
	const firstWrap = wrapTextWithAnsi(text, w1);
	if (firstWrap.length <= 1) {
		return firstWrap;
	}
	const firstLine = firstWrap[0];
	const idx = text.indexOf(firstLine);
	if (idx === -1) {
		return wrapTextWithAnsi(text, w2);
	}
	const remainder = text.slice(idx + firstLine.length).trimStart();
	const restWrap = wrapTextWithAnsi(remainder, w2);
	return [firstLine, ...restWrap];
}

function severityColor(severity: AdvisorSeverity | undefined): ToolUIColor {
	switch (severity) {
		case "blocker":
			return "error";
		case "concern":
			return "warning";
		default:
			return "muted";
	}
}

/** Always-visible header tag: `Advisor <n> notes [· <k> blockers]`. */
class AdvisorHeader implements Component {
	readonly #meta: readonly string[];
	readonly #uiTheme: Theme;
	#cache: { width: number; lines: readonly string[] } | undefined;

	constructor(meta: readonly string[], uiTheme: Theme) {
		this.#meta = meta;
		this.#uiTheme = uiTheme;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const uiTheme = this.#uiTheme;
		const tag = uiTheme.fg("customMessageLabel", uiTheme.bold(`${uiTheme.status.info} Advisor`));
		const lines = [
			truncateToWidth(`${tag} ${uiTheme.fg("dim", this.#meta.join(uiTheme.sep.dot))}`, width, Ellipsis.Unicode),
		];
		this.#cache = { width, lines };
		return lines;
	}
}

/** One branch of advisor notes: the entries plus an optional hidden-note count. */
class AdvisorNotes implements Component {
	readonly #entries: readonly AdvisorNote[];
	readonly #hidden: number;
	readonly #uiTheme: Theme;
	#cache: { width: number; lines: readonly string[] } | undefined;

	constructor(entries: readonly AdvisorNote[], hidden: number, uiTheme: Theme) {
		this.#entries = entries;
		this.#hidden = hidden;
		this.#uiTheme = uiTheme;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const lines: string[] = [];
		for (const entry of this.#entries) lines.push(...renderAdvisorNote(entry, width, this.#uiTheme));
		if (this.#hidden > 0) {
			const uiTheme = this.#uiTheme;
			const rail = uiTheme.fg("dim", uiTheme.symbol("advisor.rail"));
			const hidden = this.#hidden;
			lines.push(`  ${rail} ${uiTheme.fg("dim", `… +${hidden} more ${hidden === 1 ? "note" : "notes"}`)}`);
		}
		const rendered = lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		this.#cache = { width, lines: rendered };
		return rendered;
	}
}

/** Wrapped, truncated rail rows for a single note; shared by both branches. */
function renderAdvisorNote(entry: AdvisorNote, width: number, uiTheme: Theme): string[] {
	const badge = entry.severity ? `${formatBadge(entry.severity, severityColor(entry.severity), uiTheme)} ` : "";
	// Multi-advisor: attribute the note to its source. The implicit
	// single ("default") advisor renders unlabeled, as before.
	const who =
		entry.advisor && entry.advisor !== "default" ? `${uiTheme.fg("dim", `[${replaceTabs(entry.advisor)}]`)} ` : "";
	const age = entry.turnsAgo !== undefined ? `${uiTheme.fg("dim", `T-${entry.turnsAgo}`)} ` : "";
	const railGlyph = uiTheme.symbol("advisor.rail");
	const rail = uiTheme.fg(severityColor(entry.severity), railGlyph);
	const quoteWidth = visibleWidth(`  ${railGlyph} `);
	const badgeWidth = visibleWidth(badge);
	const ageWidth = visibleWidth(age);
	const whoWidth = visibleWidth(who);
	const w1 = Math.max(10, Math.min(NOTE_LINE_WIDTH, width) - quoteWidth - badgeWidth - ageWidth - whoWidth);
	const w2 = Math.max(10, Math.min(NOTE_LINE_WIDTH, width) - quoteWidth);

	const paragraphs = entry.note.split("\n").filter(p => p.trim());
	const bodyLines: string[] = [];
	for (let i = 0; i < paragraphs.length; i++) {
		const p = paragraphs[i];
		if (i === 0) {
			bodyLines.push(...wrapVarying(p, w1, w2));
		} else {
			bodyLines.push(...wrapTextWithAnsi(p, w2));
		}
	}

	return bodyLines.map(
		(line, index) =>
			`  ${rail} ${index === 0 ? `${badge}${age}${who}` : ""}${uiTheme.fg("customMessageText", replaceTabs(line))}`,
	);
}

/**
 * Display-only transcript card for advisor notes injected into the primary
 * session. Styled as a distinct voice so notes never blend into thinking
 * output (whose `thinkingText` color equals `toolOutput` in most themes):
 * a bold `customMessageLabel` header tag (skill-card convention), a heavy
 * rail tinted per-note severity, and the note body on the default text color.
 */
export function createAdvisorMessageCard(
	details: AdvisorMessageDetails | undefined,
	getExpanded: () => boolean,
	uiTheme: Theme,
): Component {
	const notes = details?.notes ?? [];
	const blockers = notes.filter(note => note.severity === "blocker").length;
	const meta: string[] = [`${notes.length} ${notes.length === 1 ? "note" : "notes"}`];
	if (blockers > 0) meta.push(uiTheme.fg("error", `${blockers} blocker${blockers === 1 ? "" : "s"}`));

	const shown = notes.slice(0, COLLAPSED_NOTES);
	const disclosure = new Disclosure({
		summary: new AdvisorHeader(meta, uiTheme),
		collapsedBody: () => new AdvisorNotes(shown, notes.length - shown.length, uiTheme),
		body: () => new AdvisorNotes(notes, 0, uiTheme),
		expanded: getExpanded(),
		paddingX: 1,
	});
	// The tool-output toggle owns expansion state; synchronize the controlled
	// disclosure from the callback on every render.
	return {
		render(width: number): readonly string[] {
			disclosure.setExpanded(getExpanded());
			return disclosure.render(width);
		},
		invalidate(): void {
			disclosure.invalidate();
		},
		dispose(): void {
			disclosure.dispose();
		},
		setIgnoreTight(ignore: boolean): void {
			disclosure.setIgnoreTight(ignore);
		},
	};
}
