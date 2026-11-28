let segmenter: Intl.Segmenter | undefined;

/** Unicode grapheme boundaries, using one lazily initialized ICU segmenter per thread. */
export function segmentGraphemes(text: string): Intl.Segments {
	return (segmenter ??= new Intl.Segmenter()).segment(text);
}

/** Whether an edit inserts one grapheme, without enumerating a multi-grapheme insertion. */
export function isSingleGrapheme(text: string): boolean {
	return text.length === 1 || (text.length > 1 && segmentGraphemes(text).containing(0)?.segment === text);
}
