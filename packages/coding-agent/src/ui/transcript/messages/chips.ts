/**
 * Composer tokens in a sent prompt: what the composer showed as chips stays a
 * chip in the transcript.
 *
 * - `[Image #N, WxH]` / `[Video #N]` markers collapse to `📷 #N` / `🎬 #N`
 *   (linked to the attachment's file when one is known).
 * - `<model agent="m1" name="x"/>` mention tags show as `⬢ x`.
 * - Skill chips (`✦ name` of a registered skill) are kept and linked to their SKILL.md.
 *
 * The glyphs are the active symbol preset's (`chip.*`, `icon.model`,
 * `icon.extensionSkill`), as the composer drew the chip; reading them
 * subscribes a reactive caller to preset switches.
 *
 * Natively each token is an `md` mark styled as the composer decorates it;
 * the terminal colors attachment chips with their composer identity color.
 */
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { type ChipKind, chipColor, chipLabel } from "../../composer/attachments";

const VISION_MARKER = /\[(Image|Video) #([1-9]\d*)(?:,[^\]\n]*)?\](?: attachment:\/\/\2)?/g;
const MODEL_MENTION = /<model agent="m\d+" name="([^"]*)"\/>/g;
/** A skill name after its chip glyph (`ns/name`, dotted segments). */
const SKILL_NAME = String.raw` ((?:[\w-]+\/)?[\w-]+(?:\.[\w-]+)*)(?![\w-])`;

/** The chip of skill `name`: the symbol preset's skill glyph and the name, as the composer shows an invocation. */
export function skillChipLabel(name: string): string {
	return `${currentTheme().symbols.symbol("icon.extensionSkill")} ${name}`;
}

/** Skill chips drawn with `glyph`; a word glyph (the ASCII preset's `SK`) does not continue a word before it. */
function skillChips(glyph: string): RegExp {
	const lead = /^[a-z]+$/i.test(glyph) ? `(?<![A-Za-z])${glyph}` : RegExp.escape(glyph);
	return new RegExp(`${lead}${SKILL_NAME}`, "gu");
}

/** One chip in the display text. */
export interface Chip {
	readonly label: string;
	readonly kind: ChipKind | "skill" | "mention";
	/** Attachment number (`#N`) of image and video chips. */
	readonly n?: number;
	/** File the chip opens (an attachment's materialized file, a skill's SKILL.md). */
	readonly path?: string;
}

/** A prompt as the transcript shows it. */
export interface ChipText {
	readonly text: string;
	readonly chips: readonly Chip[];
}

/** Collapse markers and mention tags of `text` and list its chips (one per distinct label). */
export function chipText(
	text: string,
	options: {
		readonly imageLinks?: readonly (string | undefined)[];
		/** SKILL.md path of a registered skill, by name. A name without a path stays plain text. */
		readonly skillPath?: (name: string) => string | undefined;
	} = {},
): ChipText {
	const chips = new Map<string, Chip>();
	const symbols = currentTheme().symbols;
	let out = text.replace(VISION_MARKER, (_match, kind: string, idx: string) => {
		const n = Number(idx);
		const chipKind: ChipKind = kind === "Video" ? "video" : "image";
		const label = chipLabel(chipKind, n, key => symbols.symbol(key));
		if (!chips.has(label))
			chips.set(label, {
				label,
				kind: chipKind,
				n,
				path: options.imageLinks?.[n - 1],
			});
		return label;
	});
	out = out.replace(MODEL_MENTION, (_match, name: string) => {
		const label = `${symbols.symbol("icon.model")} ${name}`;
		if (!chips.has(label)) chips.set(label, { label, kind: "mention" });
		return label;
	});
	const skillGlyph = symbols.symbol("icon.extensionSkill");
	// A theme without a skill glyph marks no chip apart from prose.
	for (const match of skillGlyph ? out.matchAll(skillChips(skillGlyph)) : []) {
		const label = match[0];
		const path = options.skillPath?.(match[1]!);
		// Only a registered skill (one with a SKILL.md path) is a chip; other skill-glyph prose stays plain.
		if (path !== undefined && !chips.has(label)) chips.set(label, { label, kind: "skill", path });
	}
	return { text: out, chips: [...chips.values()] };
}

function fileHref(path: string): string | undefined {
	try {
		return Bun.pathToFileURL(path).href;
	} catch {
		return undefined;
	}
}

/** The native style of a chip: attachments accent, skills and mentions their pill colors. */
function chipStyle(chip: Chip): string {
	if (chip.kind === "skill") return "customMessageLabel strong";
	if (chip.kind === "mention") return "statusLineModel strong";
	return "accent strong";
}

/** The `md` marks of `chips` (attachment chips link to their file). */
export function chipMarks(chips: readonly Chip[]): TspSpan[] {
	return chips.map(chip => {
		const href = chip.kind !== "skill" && chip.kind !== "mention" && chip.path ? fileHref(chip.path) : undefined;
		return href ? { t: chip.label, s: chipStyle(chip), href } : { t: chip.label, s: chipStyle(chip) };
	});
}

/** A chip as the terminal draws it: its label and color (a theme token or a hex attachment color). */
export interface TermChip {
	readonly t: string;
	/** `#rrggbb` for attachment chips, else TSP span tokens. */
	readonly color: string;
	/** Drawn as a soft pill (on the custom-message tint). */
	readonly pill?: boolean;
	/** The file the chip links to (a skill's SKILL.md at its first line, an attachment's file). */
	readonly link?: { readonly path: string; readonly line?: number };
}

/** Terminal chip looks. */
export function termChips(chips: readonly Chip[]): TermChip[] {
	return chips.map(chip => {
		if (chip.kind === "mention") return { t: chip.label, color: chipStyle(chip), pill: true };
		const link = chip.path
			? { link: chip.kind === "skill" ? { path: chip.path, line: 1 } : { path: chip.path } }
			: {};
		return chip.kind === "skill"
			? { t: chip.label, color: chipStyle(chip), pill: true, ...link }
			: { t: chip.label, color: chipColor(chip.kind, chip.n ?? 1), ...link };
	});
}
