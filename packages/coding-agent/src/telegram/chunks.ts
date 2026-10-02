/**
 * Tag-aware packing of Telegram HTML fragments.
 *
 * `wrapHtml` cuts a line into pieces no longer than a width while keeping every
 * tag opened before the cut closed at its end and reopened after it; `packLines`
 * packs many such lines into message-sized chunks, keeping a fence (a `<pre>`
 * block, a blockquote, a `<details>` box) open across the boundary.
 */

const TAG_LIMIT = 200;
const ENTITY_LIMIT = 12;

/** A fence that must be open for every line it wraps. */
export interface Fence {
	readonly open: string;
	readonly close: string;
}

/** One rendered HTML line, optionally fenced by an enclosing block. */
export interface HtmlLine {
	readonly fence: Fence | null;
	readonly html: string;
}

interface Tag {
	name: string;
	open: string;
}

interface Cut {
	cut: number;
	stack: Tag[];
}

function scanCut(text: string, width: number, carried: readonly Tag[]): Cut {
	const limit = Math.min(width, text.length);
	const stack: Tag[] = [...carried];
	let entity = 0;
	let clean = 0;
	let word = 0;
	let loose = 0;
	let looseStack: Tag[] = [];
	let index = 0;
	while (index < limit) {
		const char = text[index];
		if (entity > 0) {
			entity = char === ";" || entity >= ENTITY_LIMIT ? 0 : entity + 1;
			index += 1;
			continue;
		}
		if (char === "&") {
			entity = 1;
			index += 1;
			continue;
		}
		if (char === "<") {
			const close = text.indexOf(">", index + 1);
			if (close !== -1 && close - index <= TAG_LIMIT) {
				const raw = text.slice(index + 1, close);
				if (raw.startsWith("/")) stack.pop();
				else if (!raw.endsWith("/") && raw !== "") stack.push({ name: raw.split(/[\s/]/u)[0], open: `<${raw}>` });
				index = close + 1;
				continue;
			}
			index += 1;
			continue;
		}
		loose = index + 1;
		looseStack = stack.slice();
		if (stack.length === 0) {
			clean = index + 1;
			if (char === " ") word = index + 1;
		}
		index += 1;
	}
	if (clean >= Math.floor(limit / 2)) return { cut: word > clean / 2 ? word : clean, stack: [] };
	return loose > 0 ? { cut: loose, stack: looseStack } : { cut: Math.max(1, limit), stack: [...carried] };
}

/** Cuts `html` into pieces no longer than `width`, closing and reopening tags across cuts. */
export function wrapHtml(html: string, width: number): string[] {
	const pieces: string[] = [];
	let rest = html;
	let stack: Tag[] = [];
	while (rest !== "") {
		const prefix = stack.map(tag => tag.open).join("");
		if (prefix.length + rest.length <= width) {
			pieces.push(prefix + rest);
			break;
		}
		const found = scanCut(rest, width - prefix.length, stack);
		if (found.cut <= 0) {
			pieces.push(prefix + rest);
			break;
		}
		const closes = [...found.stack]
			.reverse()
			.map(tag => `</${tag.name}>`)
			.join("");
		pieces.push(prefix + rest.slice(0, found.cut) + closes);
		rest = rest.slice(found.cut);
		stack = found.stack;
	}
	return pieces;
}

function emitSlices(chunks: string[], line: HtmlLine, limit: number): boolean {
	const frame = line.fence === null ? { open: "", close: "" } : line.fence;
	const room = limit - frame.open.length - frame.close.length - (line.fence === null ? 0 : 1);
	if (room <= 0 || line.html.length <= room) return false;
	for (let at = 0; at < line.html.length; at += room) {
		const piece = line.html.slice(at, at + room);
		chunks.push(line.fence === null ? piece : `${frame.open}${piece}${frame.close}`);
	}
	return true;
}

/** Packs rendered lines into chunks no longer than `limit`, reopening fences across chunks. */
export function packLines(lines: readonly HtmlLine[], limit: number): string[] {
	const chunks: string[] = [];
	let buffer = "";
	let open: Fence | null = null;
	const flush = () => {
		chunks.push(buffer + (open === null ? "" : open.close));
		buffer = "";
		open = null;
	};
	for (const line of lines) {
		const entering = line.fence !== null && line.fence !== open;
		const leaving = open !== null && line.fence !== open;
		const cost =
			(buffer === "" ? 0 : 1) +
			(leaving && open !== null ? open.close.length : 0) +
			(entering && line.fence !== null ? line.fence.open.length : 0) +
			line.html.length +
			(line.fence === null ? 0 : line.fence.close.length);
		if (buffer !== "" && buffer.length + cost > limit) flush();
		if (buffer === "" && line.html !== "" && emitSlices(chunks, line, limit)) continue;
		const enters = line.fence !== null && line.fence !== open;
		const leaves = open !== null && line.fence !== open;
		if (buffer === "") {
			if (enters && line.fence !== null) {
				buffer = line.fence.open;
				open = line.fence;
			}
		} else {
			if (leaves && open !== null) {
				buffer += open.close;
				open = null;
			}
			buffer += "\n";
			if (enters && line.fence !== null) {
				buffer += line.fence.open;
				open = line.fence;
			}
		}
		buffer += line.html;
	}
	if (buffer !== "") flush();
	return chunks;
}
