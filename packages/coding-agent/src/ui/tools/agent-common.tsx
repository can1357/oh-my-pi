/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Body pieces the agent tools share (yield, todo, vibe, wait, task…): clean
 * display text, the error text, a toned note, count wording and the resolved
 * model badge of subagent rows.
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { stripControl } from "@oh-my-pi/pi-tui/text/sanitize";
import { replaceTabs, truncateMiddle, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { thinkingLevelGlyph } from "../../utils/render-utils";

/** Untrusted text as a row shows it: escapes and controls dropped, tabs expanded. */
export function cleanText(text: string): string {
	return replaceTabs(stripControl(text));
}

/** A failure message (`omp.tool.error`): JSON-looking multi-line errors as code, others as error text. */
export function ErrorText(props: { readonly message: string }): JSXNode {
	const body = cleanText(props.message).trim();
	if (body.includes("\n") && /^[{[]/.test(body))
		return <code text={body} lang="json" tone="error" role="omp.tool.error" />;
	return <text role="omp.tool.error" spans={[{ s: "error", t: body }]} wrap="word" />;
}

/** A subagent's resolved model as its row badges it. */
export interface FeedModel {
	readonly identity: string;
	/** The resolved thinking level (`high`, `auto`, …). */
	readonly thinking?: string;
	/** A live advisor watches the run. */
	readonly advisor?: boolean;
}

/** Model metadata of a snapshot as a {@link FeedModel}; undefined without a non-blank string identity (malformed snapshots draw no badge). */
export function feedModel(identity: unknown, thinking: unknown, advisor: unknown): FeedModel | undefined {
	if (typeof identity !== "string") return undefined;
	const clean = cleanText(identity).replace(/\s+/g, " ").trim();
	if (!clean) return undefined;
	return {
		identity: clean,
		...(typeof thinking === "string" ? { thinking } : {}),
		...(advisor === true ? { advisor: true } : {}),
	};
}

/**
 * A row's model badge in at most `width` cells: `lead` (accent) is the
 * thinking glyph and its space, `rest` (dim) the identity cut in the middle
 * then the advisor eye. Too narrow for any identity: the glyphs that fit;
 * undefined when none does.
 */
export function feedModelBadge(
	glyph: (key: string) => string,
	model: FeedModel,
	width: number,
): { readonly lead: string; readonly rest: string } | undefined {
	const room = Math.max(0, Math.floor(width));
	if (room === 0) return undefined;
	const thinking = thinkingLevelGlyph(glyph, model.thinking);
	const advisor = model.advisor ? glyph("icon.advisor") : "";
	const lead = thinking ? `${thinking} ` : "";
	const suffix = advisor ? ` ${advisor}` : "";
	const identityRoom = room - visibleWidth(lead) - visibleWidth(suffix);
	if (identityRoom >= 1) return { lead, rest: `${truncateMiddle(model.identity, identityRoom)}${suffix}` };
	const advisorWidth = visibleWidth(advisor);
	if (advisor && advisorWidth <= room)
		return { lead: thinking && visibleWidth(lead) + advisorWidth <= room ? lead : "", rest: advisor };
	return thinking && visibleWidth(thinking) <= room ? { lead: thinking, rest: "" } : undefined;
}

/** A one-token note (`muted` by default). */
export function NoteText(props: {
	readonly message: string;
	readonly token?: string;
	readonly lines?: number;
}): JSXNode {
	return <text spans={[{ s: props.token ?? "muted", t: cleanText(props.message) }]} wrap="word" lines={props.lines} />;
}

/** `1 field`, `3 fields`. */
export function countText(count: number, noun: string, plural = `${noun}s`): string {
	return `${count} ${count === 1 ? noun : plural}`;
}

/** `text` on one line, control and whitespace runs collapsed, cut to `max` code points with `…`. */
export function oneLine(text: string, max: number): string {
	const flat = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
	const chars = [...flat];
	return chars.length > max ? `${chars.slice(0, Math.max(1, max) - 1).join("")}…` : flat;
}
