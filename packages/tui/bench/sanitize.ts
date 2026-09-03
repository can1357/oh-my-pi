import { sanitizeText as currentSanitizeText } from "@oh-my-pi/pi-utils/sanitize-text";
import { makeBench } from "./_harness";

const STRIP_RE = new RegExp(
	[
		"\\x1B\\[[\\x30-\\x3F]*[\\x20-\\x2F]*[\\x40-\\x7E]",
		"\\x1B\\][\\s\\S]*?(?:\\x07|\\x1B\\\\)",
		"\\x1B[PX^_][\\s\\S]*?\\x1B\\\\",
		"\\x1B[\\x20-\\x2F]+[\\x30-\\x7E]",
		"\\x1B[\\x40-\\x7E]",
		"[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F\\x80-\\x9F\\r]",
		"[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])",
		"(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]",
	].join("|"),
	"g",
);

function regexSanitizeText(text: string): string {
	return text.replace(STRIP_RE, "");
}

// Character-class regex: any code unit that might trigger removal.
// ESC (0x1B) is inside \x00-\x1F.
const NEEDS_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F\r\uD800-\uDFFF]/;
const NEEDS_RE_G = /[\x00-\x08\x0B-\x1F\x7F-\x9F\r\uD800-\uDFFF]/g;
const ESC = 0x1b;

function ansiSeqLen(text: string, pos: number): number {
	const len = text.length;
	if (pos + 1 >= len) return 0;
	const c1 = text.charCodeAt(pos + 1);
	if (c1 === 0x5b) {
		for (let i = pos + 2; i < len; i++) {
			const b = text.charCodeAt(i);
			if (b >= 0x40 && b <= 0x7e) return i - pos + 1;
		}
		return 0;
	}
	if (c1 === 0x5d) {
		for (let i = pos + 2; i < len; i++) {
			const b = text.charCodeAt(i);
			if (b === 0x07) return i - pos + 1;
			if (b === ESC && i + 1 < len && text.charCodeAt(i + 1) === 0x5c) {
				return i - pos + 2;
			}
		}
		return 0;
	}
	if (c1 === 0x50 || c1 === 0x58 || c1 === 0x5e || c1 === 0x5f) {
		for (let i = pos + 2; i < len; i++) {
			const b = text.charCodeAt(i);
			if (b === ESC && i + 1 < len && text.charCodeAt(i + 1) === 0x5c) {
				return i - pos + 2;
			}
		}
		return 0;
	}
	if (c1 >= 0x20 && c1 <= 0x2f) {
		for (let i = pos + 2; i < len; i++) {
			const b = text.charCodeAt(i);
			if (b >= 0x30 && b <= 0x7e) return i - pos + 1;
		}
		return 0;
	}
	if (c1 >= 0x40 && c1 <= 0x7e) return 2;
	return 0;
}

// Variant A: cheap regex gate, then fall back to currentSanitizeText logic inline.
function gatedSanitizeText(text: string): string {
	if (!NEEDS_RE.test(text)) return text;
	return currentSanitizeText(text);
}

// Variant B: drive iteration via regex.exec, skipping clean runs wholesale.
function skipRunSanitizeText(text: string): string {
	NEEDS_RE_G.lastIndex = 0;
	let m = NEEDS_RE_G.exec(text);
	if (m === null) return text;
	const len = text.length;
	let out = "";
	let last = 0;
	while (m !== null) {
		const i = m.index;
		const u = text.charCodeAt(i);
		let removeLen = 0;
		if (u === ESC) {
			removeLen = ansiSeqLen(text, i);
		}
		if (removeLen === 0) {
			if (u >= 0xd800 && u <= 0xdbff) {
				// High surrogate: keep if followed by valid low surrogate.
				if (i + 1 < len) {
					const lo = text.charCodeAt(i + 1);
					if (lo >= 0xdc00 && lo <= 0xdfff) {
						NEEDS_RE_G.lastIndex = i + 2;
						m = NEEDS_RE_G.exec(text);
						continue;
					}
				}
				removeLen = 1;
			} else {
				// CR / C0 (excl. \t \n) / DEL / C1 / lone low surrogate.
				removeLen = 1;
			}
		}
		if (last !== i) out += text.slice(last, i);
		last = i + removeLen;
		NEEDS_RE_G.lastIndex = last;
		m = NEEDS_RE_G.exec(text);
	}
	if (last < len) out += text.slice(last);
	return out;
}

const REMOVAL_START_RE =
	/[\x00-\x08\x0B-\x1F\x7F-\x9F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Variant C: regex only matches real removal starts, not valid surrogate pairs.
function removalStartSanitizeText(text: string): string {
	REMOVAL_START_RE.lastIndex = 0;
	let m = REMOVAL_START_RE.exec(text);
	if (m === null) return text;
	const len = text.length;
	let out = "";
	let last = 0;
	while (m !== null) {
		const i = m.index;
		let removeLen = 1;
		if (text.charCodeAt(i) === ESC) {
			const ansiLen = ansiSeqLen(text, i);
			if (ansiLen !== 0) removeLen = ansiLen;
		}
		if (last !== i) out += text.slice(last, i);
		last = i + removeLen;
		REMOVAL_START_RE.lastIndex = last;
		m = REMOVAL_START_RE.exec(text);
	}
	if (last < len) out += text.slice(last);
	return out;
}

const CONTROL_RE_G = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

// Variant D: avoid valid-surrogate matches when the string is well-formed.
function wellFormedControlSanitizeText(text: string): string {
	if (!text.isWellFormed()) return skipRunSanitizeText(text);
	CONTROL_RE_G.lastIndex = 0;
	let m = CONTROL_RE_G.exec(text);
	if (m === null) return text;
	const len = text.length;
	let out = "";
	let last = 0;
	while (m !== null) {
		const i = m.index;
		let removeLen = 1;
		if (text.charCodeAt(i) === ESC) {
			const ansiLen = ansiSeqLen(text, i);
			if (ansiLen !== 0) removeLen = ansiLen;
		}
		if (last !== i) out += text.slice(last, i);
		last = i + removeLen;
		CONTROL_RE_G.lastIndex = last;
		m = CONTROL_RE_G.exec(text);
	}
	if (last < len) out += text.slice(last);
	return out;
}

// Variant E: broad scan first; only use isWellFormed when a valid pair is hit.
function lazyWellFormedSanitizeText(text: string): string {
	NEEDS_RE_G.lastIndex = 0;
	let m = NEEDS_RE_G.exec(text);
	if (m === null) return text;
	const first = m.index;
	const firstCode = text.charCodeAt(first);
	if (firstCode >= 0xd800 && firstCode <= 0xdbff && first + 1 < text.length) {
		const lo = text.charCodeAt(first + 1);
		if (lo >= 0xdc00 && lo <= 0xdfff && text.isWellFormed()) {
			CONTROL_RE_G.lastIndex = first + 2;
			m = CONTROL_RE_G.exec(text);
			if (m === null) return text;
			return sanitizeWellFormedControlFrom(text, m);
		}
	}
	return sanitizeNeedsFrom(text, m);
}

function sanitizeWellFormedControlFrom(text: string, firstMatch: RegExpExecArray): string {
	const len = text.length;
	let out = "";
	let last = 0;
	let m: RegExpExecArray | null = firstMatch;
	while (m !== null) {
		const i = m.index;
		let removeLen = 1;
		if (text.charCodeAt(i) === ESC) {
			const ansiLen = ansiSeqLen(text, i);
			if (ansiLen !== 0) removeLen = ansiLen;
		}
		if (last !== i) out += text.slice(last, i);
		last = i + removeLen;
		CONTROL_RE_G.lastIndex = last;
		m = CONTROL_RE_G.exec(text);
	}
	if (last < len) out += text.slice(last);
	return out;
}

function sanitizeNeedsFrom(text: string, firstMatch: RegExpExecArray): string {
	const len = text.length;
	let out = "";
	let last = 0;
	let m: RegExpExecArray | null = firstMatch;
	while (m !== null) {
		const i = m.index;
		const u = text.charCodeAt(i);
		let removeLen = 0;
		if (u === ESC) {
			removeLen = ansiSeqLen(text, i);
		}
		if (removeLen === 0) {
			if (u >= 0xd800 && u <= 0xdbff) {
				if (i + 1 < len) {
					const lo = text.charCodeAt(i + 1);
					if (lo >= 0xdc00 && lo <= 0xdfff) {
						NEEDS_RE_G.lastIndex = i + 2;
						m = NEEDS_RE_G.exec(text);
						continue;
					}
				}
				removeLen = 1;
			} else {
				removeLen = 1;
			}
		}
		if (last !== i) out += text.slice(last, i);
		last = i + removeLen;
		NEEDS_RE_G.lastIndex = last;
		m = NEEDS_RE_G.exec(text);
	}
	if (last < len) out += text.slice(last);
	return out;
}

function sanitizeBinaryOutput(str: string): string {
	let out: string[] | undefined;
	let last = 0;

	for (let i = 0; i < str.length;) {
		const code = str.codePointAt(i)!;
		const width = code > 0xffff ? 2 : 1;
		const next = i + width;

		// Allow tab, newline, carriage return.
		const isAllowedControl = code === 0x09 || code === 0x0a || code === 0x0d;
		if (isAllowedControl) {
			i = next;
			continue;
		}

		// Filter out characters that crash `Bun.stringWidth()` or cause display issues:
		// - ASCII control chars (C0)
		// - DEL + C1 control block
		// - Lone surrogates
		const isControl = code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		const isSurrogate = code >= 0xd800 && code <= 0xdfff;
		if (isControl || isSurrogate) {
			out ??= [];
			if (last !== i) out.push(str.slice(last, i));
			last = next;
		}

		i = next;
	}

	if (!out) return str;
	if (last < str.length) out.push(str.slice(last));
	return out.join("");
}
function jsSanitizeText(text: string): string {
	return sanitizeBinaryOutput(Bun.stripANSI(text)).replaceAll("\r", "");
}

const ITERATIONS = 2000;

const bigPlain = "hello world ".repeat(500);
const bigAnsi = `\x1b[31mred\x1b[0m ${"lorem ipsum dolor ".repeat(20)}`.repeat(5);
const samples = {
	plain: "hello world this is a plain ASCII string with some words",
	ansi: "\x1b[31mred text\x1b[0m and \x1b[4munderlined content\x1b[24m with emoji 😅😅",
	links: "prefix \x1b]8;;https://example.com\x07link\x1b]8;;\x07 suffix",
	wide: "日本語のテキストとemoji 🚀✨ mixed with ascii",
	wrapped:
		"This is a long line that should wrap multiple times when rendered with ANSI \x1b[32mcolors\x1b[0m and tabs\tbetween words.",
	bigPlain,
	bigAnsi,
};

const bench = makeBench(ITERATIONS);

console.log(`Text layout benchmark (${ITERATIONS} iterations)\n`);

for (const name in samples) {
	const text = samples[name as keyof typeof samples];
	const baseline = currentSanitizeText(text);
	const jsResult = jsSanitizeText(text);
	const regexResult = regexSanitizeText(text);
	if (jsResult !== baseline) {
		console.log(`MISMATCH js/current ${name}`);
	}
	if (regexResult !== baseline) {
		console.log(
			`MISMATCH regex/current ${name}: regex=${JSON.stringify(regexResult)} baseline=${JSON.stringify(baseline)}`,
		);
	}
	const gatedResult = gatedSanitizeText(text);
	const skipResult = skipRunSanitizeText(text);
	const removalStartResult = removalStartSanitizeText(text);
	const wellFormedControlResult = wellFormedControlSanitizeText(text);
	const lazyWellFormedResult = lazyWellFormedSanitizeText(text);
	if (gatedResult !== baseline) {
		console.log(`MISMATCH gated/current ${name}`);
	}
	if (skipResult !== baseline) {
		console.log(
			`MISMATCH skip/current ${name}: skip=${JSON.stringify(skipResult)} baseline=${JSON.stringify(baseline)}`,
		);
	}
	if (removalStartResult !== baseline) {
		console.log(
			`MISMATCH removalStart/current ${name}: removalStart=${JSON.stringify(removalStartResult)} baseline=${JSON.stringify(baseline)}`,
		);
	}
	if (wellFormedControlResult !== baseline) {
		console.log(
			`MISMATCH wellFormedControl/current ${name}: wellFormedControl=${JSON.stringify(wellFormedControlResult)} baseline=${JSON.stringify(baseline)}`,
		);
	}
	if (lazyWellFormedResult !== baseline) {
		console.log(
			`MISMATCH lazyWellFormed/current ${name}: lazyWellFormed=${JSON.stringify(lazyWellFormedResult)} baseline=${JSON.stringify(baseline)}`,
		);
	}

	bench(`jsSanitizeText/${name}`, () => {
		jsSanitizeText(text);
	});
	bench(`currentSanitizeText/${name}`, () => {
		currentSanitizeText(text);
	});
	bench(`regexSanitizeText/${name}`, () => {
		regexSanitizeText(text);
	});
	bench(`gatedSanitizeText/${name}`, () => {
		gatedSanitizeText(text);
	});
	bench(`skipRunSanitizeText/${name}`, () => {
		skipRunSanitizeText(text);
	});
	bench(`removalStartSanitizeText/${name}`, () => {
		removalStartSanitizeText(text);
	});
	bench(`wellFormedControlSanitizeText/${name}`, () => {
		wellFormedControlSanitizeText(text);
	});
	bench(`lazyWellFormedSanitizeText/${name}`, () => {
		lazyWellFormedSanitizeText(text);
	});
	console.log();
}
