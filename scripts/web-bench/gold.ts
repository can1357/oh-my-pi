/** Minimum Markdown structure to retain. */
export interface Structure {
	headings: number;
	code_fences: number;
	links: number;
}

/** Human-reviewed snippets and structure for one reference snapshot. */
export interface Gold {
	must: string[];
	must_not: string[];
	structure: Structure;
}

/** Separate expectations for plain HTTP and the browser-rendered DOM. */
export interface GoldFile extends Gold {
	browser?: Gold;
}

/** Parsed Markdown text and structure; link destinations are not visible words. */
export interface MarkdownView {
	text: string;
	structure: Structure;
	metaDump: boolean;
}

const block = (text: string) => `${text}\n`;
const sentenceEnd = /(?<=[.!?])\s+|(?<=[。！？])/u;
const chrome =
	/\b(?:cookie|sign in|log in|sign up|privacy|footer|terms(?: of use)?|subscribe|related|skip to|menu)\b/iu;
const rawMetadata = /<\/?(?:head|meta|title|script|link)\b/i;
const frontMatter = /^[ \t]*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/;
const yamlMetadata = /^[ \t]*(?:title|author|description|date|published|canonical|og:[\w-]+)[ \t]*:/im;

const readerMetadataLine = /^(?:title|description|author|published|canonical):[ \t]/;

/** Remove only the leading metadata block emitted by the Reader. */
export function stripReaderFrontMatter(markdown: string): string {
	const header = frontMatter.exec(markdown);
	if (!header || !header[1].split(/\r?\n/).every(line => readerMetadataLine.test(line))) return markdown;
	return markdown.slice(header[0].length);
}

/** Strip Markdown syntax without counting hrefs, language tags, or list markers as text. */
export function markdownView(markdown: string, examples?: string[]): MarkdownView {
	const structure: Structure = { headings: 0, code_fences: 0, links: 0 };
	let metaDump = yamlMetadata.test(frontMatter.exec(markdown)?.[1] ?? "");
	const text = Bun.markdown.render(markdown, {
		heading: text => {
			structure.headings++;
			return block(text);
		},
		link: text => {
			structure.links++;
			return text;
		},
		code: text => {
			if (examples) examples.push(...text.split("\n"));
			return block(text);
		},
		paragraph: block,
		blockquote: block,
		listItem: block,
		tr: block,
		th: text => `${text}\t`,
		td: text => {
			examples?.push(text);
			return `${text}\t`;
		},
		html: text => {
			metaDump ||= rawMetadata.test(text);
			return text.replace(/<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi, "");
		},
	});
	// Count complete fenced blocks (including unlabelled fences), not indented code.
	let fence = "";
	for (const line of markdown.split(/\r?\n/)) {
		const marker = /^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$/.exec(line);
		if (!marker) continue;
		if (!fence) {
			fence = marker[1];
		} else if (marker[1].startsWith(fence) && !marker[2].trim()) {
			structure.code_fences++;
			fence = "";
		}
	}
	return { text, structure, metaDump };
}

/** Fold layout whitespace but retain exact spelling, case, and punctuation. */
export function normalize(text: string): string {
	return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function spread<T>(items: T[], max: number): T[] {
	if (items.length <= max) return items;
	if (max <= 1) return items.slice(0, max);
	return Array.from({ length: max }, (_, index) => items[Math.floor((index * (items.length - 1)) / (max - 1))]);
}

/** Represent Reader plaintext without interpreting it as Markdown. */
export function plainTextView(text: string): MarkdownView {
	return { text, structure: { headings: 0, code_fences: 0, links: 0 }, metaDump: false };
}

/** Draft snippets from the Reader response, or from both references when a Lynx dump is supplied. */
export function draftGold(lynx: string | undefined, content: string, markdown = true): Gold {
	const examples: string[] = [];
	const { text, structure } = markdown ? markdownView(content, examples) : plainTextView(content);
	const plainLynx = lynx === undefined ? undefined : normalize(lynx);
	const plainMarkdown = normalize(text);
	const matches = (snippet: string) => snippet.length >= 4 && (plainLynx === undefined || plainLynx.includes(snippet));
	const sentences = [
		...new Set(
			plainMarkdown
				.split(sentenceEnd)
				.map(normalize)
				.filter(line => line.length >= 30),
		),
	].filter(line => line.length <= 240 && matches(line));
	const lines = [...new Set(text.split("\n").map(normalize))].filter(line => line.length <= 160 && matches(line));
	const technical = spread(
		[...new Set(examples.map(normalize))].filter(line => line.length <= 160 && matches(line)),
		4,
	);
	const must = [...new Set([...spread(sentences, 16), ...technical])];
	if (must.length < 10) {
		for (const line of spread(
			lines.filter(line => !must.some(snippet => snippet.includes(line))),
			10 - must.length,
		)) {
			must.push(line);
		}
	}
	const shortLynxOnly = [...new Set(lynx?.split("\n").map(normalize))].filter(
		line =>
			line.length >= 5 &&
			line.length <= 90 &&
			line.split(" ").length <= 10 &&
			!plainMarkdown.includes(line) &&
			/\p{L}/u.test(line),
	);
	const likelyChrome = shortLynxOnly.filter(line => chrome.test(line));
	const other = shortLynxOnly.filter(line => !chrome.test(line));
	const must_not = [...likelyChrome, ...other].slice(0, 12);
	return { must, must_not, structure };
}

/** Serialize drafts as ordinary TOML, retaining separate browser expectations. */
export function writeGold(gold: GoldFile): string {
	const entries = (value: Gold) => [
		"must = [",
		...value.must.map(snippet => `\t${JSON.stringify(snippet)},`),
		"]",
		"must_not = [",
		...value.must_not.map(snippet => `\t${JSON.stringify(snippet)},`),
		"]",
	];
	const structure = (value: Structure) => [
		`headings = ${value.headings}`,
		`code_fences = ${value.code_fences}`,
		`links = ${value.links}`,
	];
	return [
		"# Draft: review these snippets and minimum counts against both reference outputs.",
		...entries(gold),
		"\n[structure]",
		...structure(gold.structure),
		...(gold.browser
			? ["\n[browser]", ...entries(gold.browser), "\n[browser.structure]", ...structure(gold.browser.structure)]
			: []),
		"",
	].join("\n");
}

/** Parse the reviewed gold file, rejecting blank snippets and malformed minimums. */
export function parseGold(toml: string): GoldFile {
	const parsed = Bun.TOML.parse(toml) as GoldFile;
	for (const value of parsed.browser === undefined ? [parsed] : [parsed, parsed.browser]) {
		for (const snippets of [value.must, value.must_not]) {
			if (!Array.isArray(snippets) || snippets.some(snippet => typeof snippet !== "string" || !normalize(snippet))) {
				throw new Error("gold.must and gold.must_not must be arrays of nonempty strings");
			}
		}
		for (const key of ["headings", "code_fences", "links"] as const) {
			if (!Number.isSafeInteger(value.structure?.[key]) || value.structure[key] < 0) {
				throw new Error(`gold.structure.${key} must be a nonnegative integer`);
			}
		}
	}
	return parsed;
}

function snippetText(text: string, ignoreWhitespace: boolean): string {
	// A gold excerpt may contain a single table row, which is not a complete
	// GFM table. Handle rows with edge pipes and isolated cell separators.
	const withoutRows = text.replace(/^[ \t]*\|[^|\n]+(?:\|[^|\n]+)*\|[ \t]*$/gm, row => row.replaceAll("|", " "));
	const plain = withoutRows
		.replace(/(?<=^|\s)\|(?=\s|$)/g, " ")
		.replace(/\\?`+/g, "")
		.replace(/[‘’]/gu, "'")
		.replace(/[“”]/gu, '"')
		.replace(/\p{Default_Ignorable_Code_Point}/gu, "");
	return ignoreWhitespace ? plain.replace(/\s+/gu, "").normalize("NFC") : normalize(plain);
}

/** Match gold snippets and structure against a parsed Markdown output. */
export function checkGold(
	view: MarkdownView,
	gold: Gold,
): {
	missing: string[];
	noise: string[];
	shortStructure: string[];
} {
	const content = snippetText(view.text, true);
	const chrome = snippetText(view.text, false);
	const contains = (candidate: string, snippet: string, ignoreWhitespace: boolean) => {
		const literal = snippetText(snippet, ignoreWhitespace);
		if (literal && candidate.includes(literal)) return true;
		// Strip backticks before parsing Markdown syntax in the excerpt: an
		// accidental matching pair must not hide punctuation or link markup.
		const visible = snippetText(markdownView(snippet.replace(/\\?`+/g, "")).text, ignoreWhitespace);
		return visible.length > 0 && candidate.includes(visible);
	};
	return {
		missing: gold.must.filter(snippet => !contains(content, snippet, true)),
		noise: gold.must_not.filter(snippet => contains(chrome, snippet, false)),
		shortStructure: (["headings", "code_fences", "links"] as const)
			.filter(key => view.structure[key] < gold.structure[key])
			.map(key => `${key}=${view.structure[key]} < ${gold.structure[key]}`),
	};
}

/** A Unicode word multiset; equality checks frequency, not just membership. */
export interface WordBag {
	counts: Map<string, number>;
	size: number;
}

/** Tokenize visible text for reference, candidate, and holdout comparisons. */
export function words(text: string, splitCjk = false): WordBag {
	const counts = new Map<string, number>();
	let size = 0;
	// CJK words can wrap between any two characters in the plain-text writer.
	const plain = text.normalize("NFC").toLowerCase();
	const tokenText = splitCjk
		? plain.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]\p{M}*/gu, " $& ")
		: plain;
	for (const [part] of tokenText.matchAll(/[\p{L}\p{N}\p{M}_]+/gu)) {
		counts.set(part, (counts.get(part) ?? 0) + 1);
		size++;
	}
	return { counts, size };
}

/** Multiset intersection; repeated words only count up to the lower frequency. */
export function consensus(left: WordBag, right: WordBag): WordBag {
	const counts = new Map<string, number>();
	let size = 0;
	for (const [word, count] of left.counts) {
		const hit = Math.min(count, right.counts.get(word) ?? 0);
		if (hit === 0) continue;
		counts.set(word, hit);
		size += hit;
	}
	return { counts, size };
}
