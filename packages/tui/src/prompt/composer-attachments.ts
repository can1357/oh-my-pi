import { allowsModelMentions, allowsSkillTokens, SKILL_TOKEN_RE } from "./skill-tokens";
import { MODEL_MENTION_RE, modelMentionToken } from "./model-mention-syntax";
import { SYMBOL_PRESETS } from "../theme/symbols";
import { type ThemeColor, theme } from "../theme/theme";

/** Attachment chip kinds staged in the composer: images, video previews, and large text pastes. */
export type ChipKind = "image" | "video" | "paste";

/** Compact atomic composer token for an invoked skill in the active symbol preset. */
export function skillChipLabel(name: string): string {
	const icon =
		typeof theme === "undefined"
			? SYMBOL_PRESETS.unicode["icon.extensionSkill"]
			: theme.symbol("icon.extensionSkill");
	return `${icon} ${name}`;
}

/** Compact atomic composer token for a model mention in the active symbol preset. */
export function modelMentionChipLabel(name: string): string {
	const icon = typeof theme === "undefined" ? SYMBOL_PRESETS.unicode["icon.model"] : theme.symbol("icon.model");
	return `${icon} ${name}`;
}

/** Canonical `/skill:<name>` token a skill chip expands to on submit. */
export function skillToken(name: string): string {
	return `/skill:${name}`;
}

function chipPillStyle(label: string, color: ThemeColor, restore: string): string {
	if (typeof theme === "undefined") return label;
	return `${theme.getBgAnsi("customMessageBg")}${theme.getFgAnsi(color)}\x1b[1m${label}\x1b[22m${restore}`;
}

/**
 * Soft-pill styling for a skill chip: bold skill label color over the custom-message
 * tint. `restore` re-arms the surrounding foreground/background after the chip.
 */
export function skillChipStyle(label: string, restore = "\x1b[39m\x1b[49m"): string {
	return chipPillStyle(label, "customMessageLabel", restore);
}

/** Soft-pill styling for a model mention, restoring the surrounding colors afterward. */
export function modelChipStyle(label: string, restore = "\x1b[39m\x1b[49m"): string {
	return chipPillStyle(label, "statusLineModel", restore);
}

/** Every glyph a skill chip may start with, across all symbol presets. */
const SKILL_ICONS = [...new Set(Object.values(SYMBOL_PRESETS).map(m => m["icon.extensionSkill"]))];

/** Skill names as they appear in chips: word characters and dashes, dots only between segments,
 *  optionally behind one collision namespace (`<namespace>/<name>`). */
const SKILL_NAME_SEGMENT_SOURCE = "[\\w-]+(?:\\.[\\w-]+)*";
const SKILL_NAME_SOURCE = `${SKILL_NAME_SEGMENT_SOURCE}(?:/${SKILL_NAME_SEGMENT_SOURCE})?`;

/** Regex source for a chip glyph; word glyphs (ASCII preset) must not continue a preceding word. */
function glyphSource(icon: string): string {
	return /^[a-z]+$/i.test(icon) ? `(?<![A-Za-z])${RegExp.escape(icon)}` : RegExp.escape(icon);
}

const SKILL_CHIP_SOURCE = `(?:${SKILL_ICONS.map(glyphSource).join("|")}) (${SKILL_NAME_SOURCE})(?![\\w-])`;

/**
 * Replaces `/skill:<name>` tokens for known skills with compact chip labels and
 * registers each label's token as its atomic editor expansion. Leaves the text
 * untouched when skill tokens are not invocations in this draft (see
 * {@link allowsSkillTokens}).
 */
export function collapseSkillTokens(
	text: string,
	isKnown: (name: string) => boolean,
	register: (label: string, expansion: string) => void,
): string {
	if (!text.includes("/skill:") || !allowsSkillTokens(text)) return text;
	SKILL_TOKEN_RE.lastIndex = 0;
	return text.replace(SKILL_TOKEN_RE, (match, delimiter: string, name: string) => {
		if (!isKnown(name)) return match;
		const label = skillChipLabel(name);
		register(label, skillToken(name));
		return `${delimiter}${label}`;
	});
}

/**
 * Replaces mentionable model selectors with their display chips and registers
 * each chip's canonical selector as its atomic editor expansion.
 */
export function collapseModelMentions(
	text: string,
	labelFor: (selector: string) => string | undefined,
	register: (label: string, expansion: string) => void,
): string {
	if (!text.includes("^") || !allowsModelMentions(text)) return text;
	MODEL_MENTION_RE.lastIndex = 0;
	return text.replace(MODEL_MENTION_RE, (match, delimiter: string, selector: string) => {
		const label = labelFor(selector);
		if (label === undefined) return match;
		register(label, modelMentionToken(selector));
		return `${delimiter}${label}`;
	});
}

const CHIP_ICON_KEY = { image: "chip.image", video: "chip.video", paste: "chip.paste" } as const;

/** Chip glyph the active theme renders for `kind`, including `symbols.overrides`. */
function activeChipIcon(kind: ChipKind): string {
	return typeof theme === "undefined"
		? SYMBOL_PRESETS.unicode[CHIP_ICON_KEY[kind]]
		: theme.symbol(CHIP_ICON_KEY[kind]);
}

/** Compact atomic composer token for attachment `n` in the active symbol preset. */
export function chipLabel(kind: ChipKind, n: number): string {
	return `${activeChipIcon(kind)} #${n}`;
}

/** Every glyph a chip token may start with, across all symbol presets. */
const CHIP_ICONS: Record<ChipKind, readonly string[]> = {
	image: [...new Set(Object.values(SYMBOL_PRESETS).map(m => m[CHIP_ICON_KEY.image]))],
	video: [...new Set(Object.values(SYMBOL_PRESETS).map(m => m[CHIP_ICON_KEY.video]))],
	paste: [...new Set(Object.values(SYMBOL_PRESETS).map(m => m[CHIP_ICON_KEY.paste]))],
};

const CHIP_TOKEN_SOURCE = `(?:${[...CHIP_ICONS.image, ...CHIP_ICONS.video, ...CHIP_ICONS.paste]
	.map(glyphSource)
	.join("|")}) #[1-9]\\d*`;

/** Infers an attachment kind from a chip label emitted by any configured symbol preset. */
export function chipLabelKind(label: string): ChipKind {
	if (CHIP_ICONS.image.some(icon => label.startsWith(icon))) return "image";
	if (CHIP_ICONS.video.some(icon => label.startsWith(icon))) return "video";
	return "paste";
}

const ATTACHMENT_PALETTE: readonly [number, number, number][] = [
	[255, 179, 102],
	[125, 207, 255],
	[189, 147, 249],
	[105, 220, 158],
	[255, 141, 188],
	[240, 223, 120],
];

/** Stable RGB color assigned to attachment `n`; each attachment type uses a distinct palette offset. */
export function attachmentRgb(kind: ChipKind, n: number): readonly [number, number, number] {
	const index =
		kind === "image"
			? (n - 1) % ATTACHMENT_PALETTE.length
			: kind === "video"
				? (n + 1) % ATTACHMENT_PALETTE.length
				: (n + 2) % ATTACHMENT_PALETTE.length;
	return ATTACHMENT_PALETTE[index];
}

/** ANSI truecolor foreground sequence for the color assigned by {@link attachmentRgb}. */
export function attachmentSgr(kind: ChipKind, n: number): string {
	const [r, g, b] = attachmentRgb(kind, n);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** Matches expanded image, video, and paste markers, including optional marker metadata. */
export const PLACEHOLDER_REGEX = /\[(Image|Video|Paste) #([1-9]\d*)(?:,[^\]\n]*)?\]/g;
/** Matches an expanded attachment marker, a compact attachment chip, or a skill chip. */
export const COMPOSER_TOKEN_REGEX = new RegExp(
	`${PLACEHOLDER_REGEX.source}|${CHIP_TOKEN_SOURCE}|${SKILL_CHIP_SOURCE}`,
	"gu",
);

/** Last compiled {@link referencedAttachments} scanner, keyed by its source (labels and glyphs rarely change). */
let cachedScanner: { source: string; scanner: RegExp } | undefined;

/**
 * Attachment indices referenced by a composer buffer, per kind. Image/video count compact chips
 * and expanded markers; paste counts compact chips only, since `[Paste #N]` markers number the
 * base editor's separate paste buffer. Registered labels take precedence over theme glyphs so
 * tokens created before a theme switch keep their kind; full numbers prevent `#1` matching `#10`.
 */
export function referencedAttachments(
	text: string,
	recorded: ReadonlyMap<string, ChipKind>,
): Record<ChipKind, Set<number>> {
	const kinds: readonly ChipKind[] = ["image", "video", "paste"];
	const kindByIcon = new Map<string, ChipKind>();
	for (const kind of kinds) for (const icon of CHIP_ICONS[kind]) kindByIcon.set(icon, kind);
	for (const kind of kinds) kindByIcon.set(activeChipIcon(kind), kind);
	const icons = [...kindByIcon.keys()].sort((a, b) => b.length - a.length).map(glyphSource);
	const labels = [...recorded.keys()].sort((a, b) => b.length - a.length).map(label => RegExp.escape(label));
	const recordedSource = labels.length > 0 ? labels.join("|") : "(?!)";
	const source = `${PLACEHOLDER_REGEX.source}|(${recordedSource})(?!\\d)|(${icons.join("|")}) #([1-9]\\d*)`;
	if (cachedScanner?.source !== source) cachedScanner = { source, scanner: new RegExp(source, "gu") };
	const { scanner } = cachedScanner;

	const refs: Record<ChipKind, Set<number>> = { image: new Set(), video: new Set(), paste: new Set() };
	for (const match of text.matchAll(scanner)) {
		if (match[1] === "Image") refs.image.add(Number(match[2]));
		else if (match[1] === "Video") refs.video.add(Number(match[2]));
		const label = match[3];
		if (label !== undefined) {
			const kind = recorded.get(label);
			if (kind !== undefined) refs[kind].add(Number(label.slice(label.lastIndexOf("#") + 1)));
		} else {
			const icon = match[4];
			const kind = icon === undefined ? undefined : kindByIcon.get(icon);
			if (kind !== undefined) refs[kind].add(Number(match[5]));
		}
	}
	return refs;
}

/** Add the registered model-chip labels to the composer placeholder matcher. */
export function composerTokenRegex(mentionLabels: Iterable<string>): RegExp {
	const labels = [...new Set(mentionLabels)].sort((a, b) => b.length - a.length);
	if (labels.length === 0) return COMPOSER_TOKEN_REGEX;
	return new RegExp(
		`${COMPOSER_TOKEN_REGEX.source}|(?<mention>${labels.map(label => RegExp.escape(label)).join("|")})`,
		"gu",
	);
}

const VISION_MARKER_REGEX = /\[(Image|Video) #([1-9]\d*)((?:,[^\]\n]*)?)\](?: attachment:\/\/(\2))?/g;

/** Marker for the Nth attached image or video preview: `[Image #N, WxH]`, or `[Image #N]` without dims. */
export function formatVisionMarker(
	kind: "image" | "video",
	n: number,
	dims?: { width: number; height: number },
): string {
	const label = `${kind === "video" ? "Video" : "Image"} #${n}`;
	return dims ? `[${label}, ${dims.width}x${dims.height}]` : `[${label}]`;
}

/**
 * Offsets image marker indices, including matching `attachment://` references. With `imageCount`,
 * markers above it are left alone: like `compactImageMarkers`, they are not this text's attachments.
 */
export function shiftImageMarkers(text: string, offset: number, imageCount?: number): string {
	if (offset === 0 || imageCount === 0) return text;
	return text.replace(
		VISION_MARKER_REGEX,
		(match, kind: string, idx: string, tail: string, attachmentIdx: string | undefined) => {
			if (imageCount !== undefined && Number(idx) > imageCount) return match;
			const marker = `[${kind} #${Number(idx) + offset}${tail}]`;
			return attachmentIdx === undefined ? marker : `${marker} attachment://${Number(attachmentIdx) + offset}`;
		},
	);
}

/**
 * Replaces valid expanded image markers with compact tokens and registers each
 * token's original marker as its atomic editor expansion.
 */
export function collapseImageMarkers(
	text: string,
	imageCount: number,
	register: (label: string, expansion: string) => void,
): string {
	if (imageCount === 0) return text;
	return text.replace(VISION_MARKER_REGEX, (match, kind: string, idx: string, tail: string) => {
		const n = Number(idx);
		if (n > imageCount) return match;
		const chipKind = kind === "Video" ? "video" : "image";
		const label = chipLabel(chipKind, n);
		register(label, `[${kind} #${n}${tail}]`);
		return label;
	});
}

/**
 * Drops unreferenced vision attachments from a submission and densely remaps
 * retained image/video markers. Returns `null` when no compaction is needed.
 * With `byAppearance`, retained markers are also renumbered in the order they first
 * appear, for editors whose images attach out of order (concurrent path loads).
 */
export function compactImageMarkers(
	text: string,
	imageCount: number,
	options?: { byAppearance?: boolean },
): { text: string; keep: number[] } | null {
	if (imageCount === 0) return null;
	const referenced = new Set<number>();
	const scanner = new RegExp(VISION_MARKER_REGEX.source, "g");
	for (;;) {
		const match = scanner.exec(text);
		if (match === null) break;
		const n = Number(match[2]);
		if (n <= imageCount) referenced.add(n);
	}
	const keep = options?.byAppearance ? [...referenced] : [...referenced].sort((a, b) => a - b);
	if (keep.length === imageCount && keep.every((n, i) => n === i + 1)) return null;
	const remap = new Map<number, number>(keep.map((n, i) => [n, i + 1]));
	const rewritten = text.replace(
		VISION_MARKER_REGEX,
		(match, kind: string, idx: string, tail: string, attachmentIdx: string | undefined) => {
			const mapped = remap.get(Number(idx));
			if (mapped === undefined) return match;
			const marker = `[${kind} #${mapped}${tail}]`;
			return attachmentIdx === undefined ? marker : `${marker} attachment://${mapped}`;
		},
	);
	return { text: rewritten, keep: keep.map(n => n - 1) };
}

/** Attachment kinds understood by placeholder renderers. */
export type PlaceholderKind = "image" | "video" | "paste";

/** Rendering callbacks for plain text and parsed attachment references. */
export interface PlaceholderRenderers {
	/** Renders text outside attachment references. */
	renderText: (text: string) => string;
	/** Renders one parsed marker or compact chip token. */
	renderReference: (label: string, kind: PlaceholderKind, index: number, form: "marker" | "chip") => string;
	/** Renders one skill chip (`<icon> <name>`). */
	renderSkill: (label: string, name: string) => string;
	/** Renders one registered model mention chip. */
	renderMention: (label: string) => string;
}

/** Renders text while treating expanded markers, attachment chips, skill chips, and model mentions as distinct references. */
export function renderPlaceholders(
	text: string,
	renderers: PlaceholderRenderers,
	tokenRegex: RegExp = COMPOSER_TOKEN_REGEX,
): string {
	tokenRegex.lastIndex = 0;
	let result = "";
	let last = 0;
	let matched = false;

	for (;;) {
		const match = tokenRegex.exec(text);
		if (match === null) break;
		matched = true;
		if (match.index > last) result += renderers.renderText(text.slice(last, match.index));
		const label = match[0];
		if (match.groups?.mention !== undefined) {
			result += renderers.renderMention(label);
		} else if (label.startsWith("[")) {
			const kind: PlaceholderKind = match[1] === "Paste" ? "paste" : match[1] === "Video" ? "video" : "image";
			result += renderers.renderReference(label, kind, Number(match[2]), "marker");
		} else if (match[3] !== undefined) {
			result += renderers.renderSkill(label, match[3]);
		} else {
			const index = Number(label.slice(label.lastIndexOf("#") + 1));
			result += renderers.renderReference(label, chipLabelKind(label), index, "chip");
		}
		last = match.index + match[0].length;
	}

	if (!matched) return renderers.renderText(text);
	if (last < text.length) result += renderers.renderText(text.slice(last));
	return result;
}
