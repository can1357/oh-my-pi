/**
 * Arabic/RTL display for omp on Windows; no terminal settings or npm dependencies.
 * Uses Windows ICU for Arabic joining and Unicode bidi ordering. Logical editor,
 * conversation, model, and omp-copy text stay unchanged. Terminal drag-selection
 * necessarily copies visual glyphs; use omp's copy command for logical text.
 *
 * Composer has no supported output-transform hook: the two prototype wrappers
 * below cover transcript/history, the composer, and resize replay. Fullscreen
 * overlays and native Tern surfaces retain their own renderers. Wrapping is still
 * omp's word wrapping; Left/Right retain the editor's logical navigation.
 * Remove this file and restart omp to uninstall. Restart after omp upgrades if
 * these Composer interfaces change; do not apply this on a bidi-native terminal.
 */
import { dlopen, ptr, toArrayBuffer } from "bun:ffi";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@oh-my-pi/pi-tui";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";

const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
const MARK = /\p{Mark}/u;
const CELL_BORDER = /^[|│┃║┆┊]$/u;
const RESET = "\x1b[0m";
const CLOSE_LINK = "\x1b]8;;\x1b\\";
const ansi = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/y;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface Style {
	sgr: string;
	link: string;
}
interface Cluster extends Style {
	start: number;
	end: number;
	text: string;
	rtl: boolean;
}

/** One renderer per process; ASCII rows never call ICU or allocate row caches. */
export function createArabicRowRenderer(): (row: string) => string {
	const { symbols: icu } = dlopen("icu.dll", {
		u_shapeArabic: { args: ["ptr", "i32", "ptr", "i32", "u32", "ptr"], returns: "i32" },
		ubidi_open: { args: [], returns: "ptr" },
		ubidi_setPara: { args: ["ptr", "ptr", "i32", "u8", "ptr", "ptr"], returns: "void" },
		ubidi_getVisualMap: { args: ["ptr", "ptr", "ptr"], returns: "void" },
		ubidi_getLevels: { args: ["ptr", "ptr"], returns: "ptr" },
		ubidi_close: { args: ["ptr"], returns: "void" },
		u_charMirror: { args: ["i32"], returns: "i32" },
	});
	const cache = new Map<string, string>();

	return function renderArabicRow(row: string): string {
		if (!RTL.test(row)) return row;
		const cached = cache.get(row);
		if (cached !== undefined) return cached;

		let plain = "";
		let style: Style = { sgr: "", link: "" };
		const styles: Style[] = [];
		let cursor = -1;
		for (let i = 0; i < row.length;) {
			if (row.startsWith(CURSOR_MARKER, i)) {
				cursor = plain.length;
				i += CURSOR_MARKER.length;
			} else if (row.charCodeAt(i) === 27) {
				ansi.lastIndex = i;
				const match = ansi.exec(row);
				// Images, sized spans, and nontext terminal commands are opaque, not bidi text.
				if (!match) return row;
				const sequence = match[0];
				if (sequence.startsWith("\x1b[") && sequence.endsWith("m")) {
					const params = sequence.slice(2, -1);
					style = {
						...style,
						sgr: params === "" || params === "0" ? "" : params.startsWith("0;") ? sequence : style.sgr + sequence,
					};
				} else if (sequence.startsWith("\x1b]8;")) {
					const end = sequence.endsWith("\x07") ? 1 : 2;
					const urlStart = sequence.indexOf(";", 4) + 1;
					style = { ...style, link: urlStart === sequence.length - end ? "" : sequence };
				} else {
					return row;
				}
				i += sequence.length;
			} else {
				const code = row.codePointAt(i)!;
				const character = String.fromCodePoint(code);
				plain += character;
				for (let unit = 0; unit < character.length; unit++) styles.push(style);
				i += character.length;
			}
		}
		if (plain.length === 0) return row;

		// Avoid lam-alef ligature contraction: both original letters must keep their
		// cells and cursor offsets. An inserted ZWJ prevents contraction but retains
		// joining; only the joiners inserted here are removed after shaping.
		const input: number[] = [];
		const originalIndices: number[] = [];
		for (let i = 0; i < plain.length; i++) {
			const unit = plain.charCodeAt(i);
			if (unit === 0x0622 || unit === 0x0623 || unit === 0x0625 || unit === 0x0627) {
				let previous = i - 1;
				while (previous >= 0 && MARK.test(plain[previous])) previous--;
				if (previous >= 0 && plain.charCodeAt(previous) === 0x0644) input.push(0x200d);
			}
			originalIndices.push(input.length);
			input.push(unit);
		}
		const source = new Uint16Array(input);
		const shaped = new Uint16Array(source.length + 16);
		const error = new Int32Array(1);
		const shapedLength = icu.u_shapeArabic(ptr(source), source.length, ptr(shaped), shaped.length, 8, ptr(error));
		if (error[0] > 0 || shapedLength !== source.length) {
			throw new Error(`Arabic shaping changed cell associations (ICU ${error[0]})`);
		}
		let joined = "";
		for (let i = 0; i < plain.length; i++) {
			// ICU's spacing presentation forms for harakat would change terminal width.
			joined += MARK.test(plain[i]) ? plain[i] : String.fromCharCode(shaped[originalIndices[i]]);
		}

		const logical: Cluster[] = [];
		for (const part of segmenter.segment(plain)) {
			logical.push({
				start: part.index,
				end: part.index + part.segment.length,
				text: joined.slice(part.index, part.index + part.segment.length),
				...styles[part.index],
				rtl: false,
			});
		}
		const visual: Cluster[] = [];
		// Layout cell separators are not prose: never reorder separate table cells.
		for (let first = 0; first < logical.length;) {
			if (CELL_BORDER.test(logical[first].text)) {
				visual.push(logical[first++]);
				continue;
			}
			let last = first + 1;
			while (last < logical.length && !CELL_BORDER.test(logical[last].text)) last++;
			const cellStart = logical[first].start;
			const cellEnd = logical[last - 1].end;
			const cell = plain.slice(cellStart, cellEnd);
			if (!RTL.test(cell)) {
				visual.push(...logical.slice(first, last));
				first = last;
				continue;
			}
			// Padding and list markers belong to the UI, not the paragraph. Keeping
			// them outside UAX #9 also prevents RTL paragraphs moving the input gutter.
			const prefix = /^\s*(?:(?:[-*+•]|\d+[.)])\s+)?/.exec(cell)![0].length;
			const suffix = /\s*$/.exec(cell)![0].length;
			let runFirst = first;
			while (runFirst < last && logical[runFirst].end <= cellStart + prefix) visual.push(logical[runFirst++]);
			let runLast = last;
			while (runLast > runFirst && logical[runLast - 1].start >= cellEnd - suffix) runLast--;
			if (runFirst === runLast) {
				visual.push(...logical.slice(runLast, last));
				first = last;
				continue;
			}
			const start = logical[runFirst].start;
			const end = logical[runLast - 1].end;
			const text = new Uint16Array(end - start);
			const clusterAt = new Uint32Array(text.length);
			for (let cluster = runFirst; cluster < runLast; cluster++) {
				for (let offset = logical[cluster].start; offset < logical[cluster].end; offset++) {
					text[offset - start] = plain.charCodeAt(offset);
					clusterAt[offset - start] = cluster;
				}
			}
			const bidi = icu.ubidi_open();
			if (!bidi) throw new Error("Could not allocate the ICU bidi paragraph");
			try {
				error[0] = 0;
				// UBIDI_DEFAULT_LTR chooses the first strong character's direction,
				// including Arabic paragraphs containing English paths and numbers.
				icu.ubidi_setPara(bidi, ptr(text), text.length, 0xfe, null, ptr(error));
				if (error[0] > 0) throw new Error(`ICU bidi paragraph failed (${error[0]})`);
				const mapping = new Int32Array(text.length);
				icu.ubidi_getVisualMap(bidi, ptr(mapping), ptr(error));
				const levelsPointer = icu.ubidi_getLevels(bidi, ptr(error));
				if (error[0] > 0 || !levelsPointer) throw new Error(`ICU bidi mapping failed (${error[0]})`);
				const levels = new Uint8Array(toArrayBuffer(levelsPointer, 0, text.length));
				const emitted = new Set<number>();
				for (const offset of mapping) {
					const index = clusterAt[offset];
					if (emitted.has(index)) continue;
					emitted.add(index);
					const cluster = logical[index];
					cluster.rtl = (levels[cluster.start - start] & 1) !== 0;
					if (cluster.rtl) {
						let mirrored = "";
						for (const character of cluster.text)
							mirrored += String.fromCodePoint(icu.u_charMirror(character.codePointAt(0)!));
						cluster.text = mirrored;
					}
					visual.push(cluster);
				}
			} finally {
				icu.ubidi_close(bidi);
			}
			visual.push(...logical.slice(runLast, last));
			first = last;
		}

		// The sentinel is a logical insertion boundary, not a bidi character. Move
		// it with the adjacent grapheme so omp computes the hardware cursor column
		// from visual text. Original editor offsets and key handling are untouched.
		let caret: Cluster | undefined;
		let caretAfter = false;
		if (cursor >= 0) {
			const next = logical.findIndex(cluster => cluster.end > cursor);
			const after = next < 0 ? undefined : logical[next];
			const before = next < 0 ? logical[logical.length - 1] : logical[next - 1];
			if (after?.rtl) {
				caret = after;
				caretAfter = true;
			} else if (before?.rtl) {
				caret = before;
			} else if (before) {
				caret = before;
				caretAfter = true;
			} else {
				caret = after;
			}
		}

		let output = "";
		let sgr = "";
		let link = "";
		for (const cluster of visual) {
			if (cluster.link !== link) {
				if (link) output += CLOSE_LINK;
				if (cluster.link) output += cluster.link;
				link = cluster.link;
			}
			if (cluster.sgr !== sgr) {
				output += RESET + cluster.sgr;
				sgr = cluster.sgr;
			}
			if (caret === cluster && !caretAfter) output += CURSOR_MARKER;
			output += cluster.text;
			if (caret === cluster && caretAfter) output += CURSOR_MARKER;
		}
		if (cursor >= 0 && !caret) output += CURSOR_MARKER;
		if (link) output += CLOSE_LINK;
		output += RESET;
		if (visibleWidth(output) !== visibleWidth(row)) {
			throw new Error("Arabic rendering must preserve the terminal row width");
		}
		if (cache.size >= 256) cache.delete(cache.keys().next().value!);
		cache.set(row, output);
		return output;
	};
}

const installed = Symbol.for("omp.arabic-rtl.composer.v1");
type PatchedComposer = typeof Composer.prototype & { [installed]?: true };

export default function arabicRtlExtension(_pi: ExtensionAPI): void {
	// WT_SESSION is not reliably inherited by launchers; it is not a renderer capability check.
	if (process.platform !== "win32") return;
	const prototype: PatchedComposer = Composer.prototype;
	if (prototype[installed]) return;
	const renderRow = createArabicRowRenderer();
	const renderFrame = prototype.renderFrame;
	const renderResizeFrame = prototype.renderResizeFrame;
	prototype.renderFrame = function (viewport) {
		const plan = renderFrame.call(this, viewport);
		return {
			...plan,
			viewport: plan.viewport.map(renderRow),
			...(plan.history ? { history: { ...plan.history, rows: plan.history.rows.map(renderRow) } } : {}),
		};
	};
	prototype.renderResizeFrame = function (viewport) {
		return renderResizeFrame.call(this, viewport).map(renderRow);
	};
	prototype[installed] = true;
}
