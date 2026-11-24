/**
 * Composer tokens in a sent prompt: what the composer showed as chips stays a
 * chip in the transcript.
 *
 * - `[Image #N, WxH]` / `[Video #N]` markers collapse to `📷 #N` / `🎬 #N`
 *   (linked to the attachment's file when one is known).
 * - `<model agent="m1" name="x"/>` mention tags show as `⬢ x`.
 * - Skill chips (`✦ name`) are kept and linked to their SKILL.md.
 *
 * Natively each token is an `md` mark styled as the composer decorates it;
 * the terminal colors attachment chips with their composer identity color.
 */
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { type ChipKind, chipColor, chipLabel } from "../../composer/attachments";

const VISION_MARKER = /\[(Image|Video) #([1-9]\d*)(?:,[^\]\n]*)?\](?: attachment:\/\/\2)?/g;
const MODEL_MENTION = /<model agent="m\d+" name="([^"]*)"\/>/g;
/** Skill chip: the skill glyph, a space and a skill name (`ns/name`, dotted segments). */
const SKILL_CHIP = /✦ ((?:[\w-]+\/)?[\w-]+(?:\.[\w-]+)*)(?![\w-])/gu;
const MODEL_GLYPH = "⬢";

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
		readonly skillPath?: (name: string) => string | undefined;
	} = {},
): ChipText {
	const chips = new Map<string, Chip>();
	let out = text.replace(VISION_MARKER, (_match, kind: string, idx: string) => {
		const n = Number(idx);
		const chipKind: ChipKind = kind === "Video" ? "video" : "image";
		const label = chipLabel(chipKind, n);
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
		const label = `${MODEL_GLYPH} ${name}`;
		if (!chips.has(label)) chips.set(label, { label, kind: "mention" });
		return label;
	});
	for (const match of out.matchAll(SKILL_CHIP)) {
		const label = match[0];
		if (!chips.has(label))
			chips.set(label, {
				label,
				kind: "skill",
				path: options.skillPath?.(match[1]!),
			});
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
