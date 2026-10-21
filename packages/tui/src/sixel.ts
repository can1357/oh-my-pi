/**
 * Give an empty first band an explicit transparent width. Zellij derives the
 * decoded image width from its first pixel row, ignoring the raster minimum
 * for transparent images; an omitted band otherwise makes the image invisible.
 * Palette definitions stay before drawing so cropping can still parse them.
 */
export function ensureSixelRasterWidth(sequence: string): string {
	const prefix = /^(\x1bP[0-9;]*q"\d+;\d+;(\d+);\d+(?:#\d+(?:;[12];\d+;\d+;\d+)?|\$)*)(?=-)/.exec(sequence);
	if (!prefix) return sequence;
	return `${prefix[1]}!${prefix[2]}?$${sequence.slice(prefix[1]!.length)}`;
}

interface SixelRun {
	bits: number;
	count: number;
}

interface SixelBand {
	/** The selected register is inherited across graphics newlines. */
	color: number;
	tokens: (SixelRun | string)[];
}

function invalidSixel(reason: string): never {
	throw new Error(`Cannot crop SIXEL: ${reason}`);
}

function sixelInteger(value: string): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number)) invalidSixel("integer exceeds the safe range");
	return number;
}

function appendRun(output: string[], bits: number, count: number): void {
	const character = String.fromCharCode(63 + bits);
	// Keep repeats compressed, including long transparent gaps.
	output.push(count > 3 ? `!${count}${character}` : character.repeat(count));
}

function appendBand(output: string[], band: SixelBand | undefined, shift: number, mask: number): void {
	if (!band) return;
	output.push(`#${band.color}`);
	for (const token of band.tokens) {
		if (typeof token === "string") {
			output.push(token);
		} else {
			const bits = shift >= 0 ? token.bits >>> shift : token.bits << -shift;
			appendRun(output, bits & mask, token.count);
		}
	}
}

/**
 * Crop integer pixel rows from a raw (not tmux-wrapped) SIXEL DCS image.
 * Runs are shifted between adjacent six-pixel bands, never decoded to pixels.
 * Palette selections, overdraw order, transparent gaps and DCS background mode
 * are retained. A nonpositive crop returns the original sequence unchanged.
 *
 * The supported grammar is the native icy_sixel encoder's: one leading raster
 * declaration with positive dimensions and square pixels, prefix RGB/HLS palette
 * definitions, register selections, sixel characters, repeats, `$` and `-`.
 * ESC DCS/ST framing only, as the TUI emits it. Palette definitions after
 * drawing, additional raster declarations, other controls and malformed input
 * throw; forwarding an unsupported image uncropped would reintroduce raster
 * overflow.
 *
 * Without maxHeightPixels the crop is exact, including a partial final band with
 * zero padding bits and the exact declared raster height. Some terminals still
 * allocate all six rows of that final band. The TUI supplies its available pixel
 * height to cap the result at a whole-band boundary, matching the native encoder's
 * policy of dropping bottom pixels rather than overwriting the following row.
 */
export function cropSixelTop(sequence: string, pixels: number, maxHeightPixels?: number): string {
	if (pixels <= 0) return sequence;
	if (!Number.isSafeInteger(pixels)) throw new RangeError("SIXEL crop must be an integer pixel count");
	if (maxHeightPixels !== undefined && (!Number.isFinite(maxHeightPixels) || maxHeightPixels < 0)) {
		throw new RangeError("SIXEL height limit must be a nonnegative finite pixel count");
	}

	const header = /^\x1bP[0-9;]*q/.exec(sequence);
	if (!header) invalidSixel("missing DCS introducer");
	if (!sequence.endsWith("\x1b\\")) invalidSixel("missing string terminator");
	const end = sequence.length - 2;
	const tokenPattern = /[?-~]|!\d+[?-~]|#\d+(?:;\d+)*|"\d+(?:;\d+)*|[-$]/y;
	const palette: string[] = [];
	const bands: SixelBand[] = [];
	let band: SixelBand = { color: 0, tokens: [] };
	let color = 0;
	let drawing = false;
	let raster: string[] | undefined;
	let width = 0;
	let height = 0;
	let x = 0;
	let y = 0;
	let dataWidth = 0;
	let paintedHeight = 0;
	let cursor = header[0].length;

	while (cursor < end) {
		tokenPattern.lastIndex = cursor;
		const match = tokenPattern.exec(sequence);
		if (!match || tokenPattern.lastIndex > end) invalidSixel(`unsupported token at offset ${cursor}`);
		const token = match[0];
		cursor = tokenPattern.lastIndex;
		switch (token[0]) {
			case '"': {
				if (raster || drawing) invalidSixel("raster attributes must occur once before drawing");
				raster = token.slice(1).split(";");
				if (raster.length !== 4) invalidSixel("expected four raster attributes");
				const pan = sixelInteger(raster[0]!);
				const pad = sixelInteger(raster[1]!);
				width = sixelInteger(raster[2]!);
				height = sixelInteger(raster[3]!);
				if (pan === 0 || pan !== pad) invalidSixel("only square pixels are supported");
				if (width === 0 || height === 0) invalidSixel("raster dimensions must be positive");
				break;
			}
			case "#": {
				const parameters = token.slice(1).split(";");
				color = sixelInteger(parameters[0]!);
				if (parameters.length > 1) {
					if (drawing) invalidSixel("palette definitions must precede drawing");
					if (parameters.length !== 5 || (parameters[1] !== "1" && parameters[1] !== "2")) {
						invalidSixel("expected an RGB or HLS palette definition");
					}
					for (let index = 2; index < parameters.length; index++) sixelInteger(parameters[index]!);
					palette.push(token);
				}
				band.tokens.push(`#${color}`);
				break;
			}
			case "$":
				drawing = true;
				x = 0;
				band.tokens.push(token);
				break;
			case "-":
				drawing = true;
				bands.push(band);
				band = { color, tokens: [] };
				x = 0;
				y += 6;
				break;
			default: {
				drawing = true;
				const count = token[0] === "!" ? sixelInteger(token.slice(1, -1)) : 1;
				if (count === 0) invalidSixel("repeat count must be positive");
				const bits = token.charCodeAt(token.length - 1) - 63;
				x += count;
				if (!Number.isSafeInteger(x)) invalidSixel("run width exceeds the safe range");
				dataWidth = Math.max(dataWidth, x);
				if (bits !== 0) paintedHeight = Math.max(paintedHeight, y + 32 - Math.clz32(bits));
				band.tokens.push({ bits, count });
				break;
			}
		}
	}
	bands.push(band);
	if (!raster) invalidSixel("missing raster dimensions");
	// Raster attributes specify a minimum, not a clip rectangle. Account for
	// drawing beyond them rather than silently discarding those source pixels.
	width = Math.max(width, dataWidth);
	height = Math.max(height, paintedHeight);
	let croppedHeight = Math.max(0, height - pixels);
	if (maxHeightPixels !== undefined) {
		croppedHeight = Math.min(croppedHeight, Math.floor(maxHeightPixels / 6) * 6);
	}
	if (croppedHeight === 0) return "";

	const output = [header[0], `"${raster[0]};${raster[1]};${width};${croppedHeight}`, ...palette];
	const firstBand = Math.floor(pixels / 6);
	const shift = pixels % 6;
	const bandCount = Math.ceil(croppedHeight / 6);
	for (let index = 0; index < bandCount; index++) {
		if (index > 0) output.push("-");
		const mask = (1 << Math.min(6, croppedHeight - index * 6)) - 1;
		appendBand(output, bands[firstBand + index], shift, mask);
		if (shift !== 0) {
			output.push("$");
			appendBand(output, bands[firstBand + index + 1], shift - 6, mask);
		}
	}
	output.push("\x1b\\");
	return ensureSixelRasterWidth(output.join(""));
}
