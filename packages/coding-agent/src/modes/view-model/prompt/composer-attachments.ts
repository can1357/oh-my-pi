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

/** `[from, to)` of each image/video marker in `text` that names one of the first `count` attachments. */
export function visionMarkerRanges(text: string, count: number): { from: number; to: number }[] {
	const ranges: { from: number; to: number }[] = [];
	if (count === 0) return ranges;
	const scanner = new RegExp(VISION_MARKER_REGEX.source, "g");
	for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
		if (Number(match[2]) <= count) ranges.push({ from: match.index, to: match.index + match[0].length });
	}
	return ranges;
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
