import * as os from "node:os";
import * as path from "node:path";
import {
	diffLines,
	Reader,
	type ReaderOutput,
	type ReaderResponse,
	type ReaderStep,
	renderHtml,
} from "@oh-my-pi/pi-natives";
import { browse } from "../../packages/coding-agent/src/web/browse";
import { HttpSession } from "../../packages/coding-agent/src/web/http-session";
import {
	checkGold,
	consensus,
	draftGold,
	type Gold,
	type GoldFile,
	markdownView,
	normalize,
	parseGold,
	stripReaderFrontMatter,
	type WordBag,
	words,
	writeGold,
} from "./gold";

const root = path.join(os.homedir(), ".omp", "web-corpus");
const width = 250;
const timeoutMs = 30_000;
const modes = ["auto", "full"] as const;
const formats = ["markdown", "text"] as const;
const lineBaseline = 0.964;
const writerWordMinimum = 0.99;
const htmlWordBoundary =
	/^(?:address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|th|thead|tr|ul)$/i;
const visibleEntities: Partial<Record<string, string>> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: " ",
	quot: '"',
};
const dataUri = /(?:^|[\s<"'`]|\]\([ \t]*<?|\s(?:href|src|poster|data)\s*=\s*["']?)data:[^\s,<>]*,/iu;
const gateIds = ["G1", "G2", "G3", "G4", "G5", "G7"] as const;
const verdicts: Partial<Record<PageClass, "wall" | "js-shell">> = {
	wall: "wall",
	"app-shell": "js-shell",
};

type Mode = (typeof modes)[number];
type Format = (typeof formats)[number];
type PageClass = "article" | "docs" | "thread" | "listing" | "app-shell" | "wall";
type Gate = (typeof gateIds)[number];

interface Site {
	slug: string;
	url: string;
	class: PageClass;
	article_href?: string;
}
interface Exchange {
	request: Omit<ReaderStep, "body" | "output">;
	key: string;
	response: Omit<ReaderResponse, "body">;
	bodyFile?: string;
}
interface Recording {
	requestedUrl: string;
	url: string;
	index: number;
	browserIndex?: number;
	off: [number, number];
	on: [number, number];
	exchanges: Exchange[];
}
interface Reference {
	html: string;
	lynx: string;
	url: string;
}
interface CaptureReference extends Reference {
	trafilatura: string;
}
interface LegacyAddon {
	htmlToMarkdown: (html: string, options: { cleanContent: true; hiddenContent: "reachable" }) => Promise<string>;
}
interface Replay {
	output: ReaderOutput;
	browsed: boolean;
}
interface RenderSet {
	outputs: Record<Mode, Record<Format, string>>;
	unstable: { mode: Mode; format: Format }[];
}
interface Agreement {
	precision: number;
	recall: number;
}
interface Row {
	slug: string;
	url: string;
	gates: Record<Gate, boolean | null>;
	matchedLines: number;
	lynxLines: number;
	writers: Agreement | null;
	verdicts: { off?: string; on?: string };
	deterministic: boolean;
	problems: string[];
}

function openLegacy(): LegacyAddon | undefined {
	const filename = Bun.env.OMP_WEB_BASELINE_ADDON;
	if (!filename) return undefined;
	const addon: { exports: Partial<LegacyAddon> } = { exports: {} };
	process.dlopen(addon, path.resolve(filename));
	const { htmlToMarkdown } = addon.exports;
	if (typeof htmlToMarkdown !== "function") {
		throw new Error("OMP_WEB_BASELINE_ADDON must point to a pre-cutover .node addon");
	}
	return { htmlToMarkdown };
}

function pageUrl(input: string): URL {
	const url = new URL(input);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new Error("Expected an HTTP(S) URL without credentials");
	url.hash = "";
	return url;
}

async function pump(
	url: string,
	browser: boolean,
	request: (step: ReaderStep) => Promise<ReaderResponse>,
): Promise<Replay> {
	const reader = new Reader({ browser, sites: false });
	let step = reader.open(url);
	let browsed = false;
	while (step.kind !== "done") {
		browsed ||= step.kind === "browse";
		step = await reader.resolve(await request(step));
	}
	if (!step.output) throw new Error(`Reader ended without an output for ${url}`);
	return { output: step.output, browsed };
}

function requestKey(step: ReaderStep): string {
	return JSON.stringify([
		step.kind,
		step.url,
		step.method,
		step.headers,
		step.body?.toString("base64"),
		step.maxBytes,
		step.purpose,
	]);
}

async function readExchange(dir: string, entry: Exchange): Promise<ReaderResponse> {
	const body = entry.bodyFile ? Buffer.from(await Bun.file(path.join(dir, entry.bodyFile)).arrayBuffer()) : undefined;
	return { ...entry.response, body };
}

async function referenceTool(
	dir: string,
	prefix: string,
	file: string,
	args: string[],
	stdin: Buffer,
): Promise<string> {
	const child = Bun.spawn(args, { stdin, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
	const [text, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	await Bun.write(path.join(dir, `${prefix}${file}`), text);
	if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${normalize(stderr).slice(0, 160)}`);
	return text;
}

function decodeHtml(response: ReaderResponse): { html: string; charset: string } {
	const bytes = response.body ?? Buffer.alloc(0);
	const contentType = response.headers.find(header => header.name.toLowerCase() === "content-type")?.value ?? "";
	let label: string | undefined;
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = "utf-8";
	else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = "utf-16le";
	else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be";
	else
		label =
			/\bcharset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ??
			/<meta\b[^>]{0,1024}\bcharset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 1024).toString("latin1"))?.[1];
	// renderHtml takes a JS string, while Reader replay still sees the original bytes and headers.
	for (const charset of [label, "utf-8", "windows-1252"]) {
		if (!charset) continue;
		try {
			return {
				html: new TextDecoder(charset as Bun.Encoding, { fatal: charset === "utf-8" && !label }).decode(bytes),
				charset,
			};
		} catch {
			// Try the next encoding for an unknown label or invalid unlabelled UTF-8.
		}
	}
	return { html: new TextDecoder().decode(bytes), charset: "utf-8" };
}

async function recordReference(dir: string, prefix: string, response: ReaderResponse): Promise<CaptureReference> {
	const { html, charset } = decodeHtml(response);
	const body = response.body ?? Buffer.alloc(0);
	const lynxArgs = [
		"lynx",
		"-stdin",
		"-dump",
		"-nolist",
		"-width",
		String(width),
		`-assume_charset=${charset}`,
		"-display_charset=utf-8",
	];
	const [lynx, trafilatura] = await Promise.all([
		referenceTool(dir, prefix, "lynx.txt", lynxArgs, body),
		referenceTool(dir, prefix, "trafilatura.md", ["trafilatura", "--output-format", "markdown"], body),
		Bun.write(path.join(dir, `${prefix}page.html`), html),
	]);
	return { html, lynx, trafilatura, url: response.url };
}

async function readReference(dir: string, prefix: string, url: string): Promise<Reference> {
	const [html, lynx] = await Promise.all(
		["page.html", "lynx.txt"].map(file => Bun.file(path.join(dir, `${prefix}${file}`)).text()),
	);
	return { html, lynx, url };
}

function readerAlternate(output: ReaderOutput): string | undefined {
	if (output.kind !== "page") return undefined;
	switch (output.strategy) {
		case "alternate-markdown":
		case "content-negotiation":
		case "llms.txt":
			return stripReaderFrontMatter(output.content ?? "");
		default:
			return undefined;
	}
}

async function record(site: Site): Promise<{ recording: Recording; primary: CaptureReference }> {
	const dir = path.join(root, site.slug);
	const exchanges: Exchange[] = [];
	const capture = async (session: HttpSession, step: ReaderStep): Promise<ReaderResponse> => {
		if (step.kind === "done" || !step.url) throw new Error("Reader emitted an invalid request");
		const { kind, url, method, headers, maxBytes, purpose } = step;
		const result =
			kind === "browse"
				? await browse(url, AbortSignal.timeout(timeoutMs), timeoutMs)
				: await session.request({ url, method, headers, body: step.body, maxBytes, timeoutMs });
		const { body, ...response } = result;
		const bodyFile = body === undefined ? undefined : `exchange-${exchanges.length}.raw`;
		if (bodyFile && body) await Bun.write(path.join(dir, bodyFile), body);
		exchanges.push({
			request: { kind, url, method, headers, maxBytes, purpose },
			key: requestKey(step),
			response,
			bodyFile,
		});
		return result;
	};

	let url = pageUrl(site.url).href;
	if (site.article_href) {
		const response = await capture(new HttpSession(), { kind: "fetch", url, method: "GET", maxBytes: 4 << 20 });
		const href = new RegExp(site.article_href, "u").exec(decodeHtml(response).html)?.[1];
		if (href) url = pageUrl(new URL(href, response.url).href).href;
		else console.warn(`${site.slug}: no article link found; recording the section URL`);
	}
	const branch = async (browser: boolean): Promise<{ range: [number, number]; output: ReaderOutput }> => {
		const first = exchanges.length;
		const session = new HttpSession();
		const { output } = await pump(url, browser, step => capture(session, step));
		return { range: [first, exchanges.length], output };
	};
	const { range: off, output } = await branch(false);
	const { range: on } = await branch(true);
	let index = -1;
	for (let i = off[0]; i < off[1]; i++) {
		const entry = exchanges[i];
		if (["page", "ua-retry", "refresh"].includes(entry.request.purpose ?? "")) {
			if (index < 0 || (entry.response.status >= 200 && entry.response.status < 300)) index = i;
		}
	}
	if (index < 0) throw new Error("Reader did not request a page");
	let browserIndex: number | undefined;
	for (let i = on[0]; i < on[1]; i++) {
		if (exchanges[i].request.kind === "browse") {
			browserIndex = i;
			break;
		}
	}
	if (browserIndex === undefined && (site.class === "wall" || site.class === "app-shell")) {
		browserIndex = exchanges.length;
		await capture(new HttpSession(), { kind: "browse", url: exchanges[index].response.url });
	}
	const primary = await recordReference(dir, "", await readExchange(dir, exchanges[index]));
	const browser = browserIndex === undefined ? undefined : await readExchange(dir, exchanges[browserIndex]);
	const dom = browser?.body?.length ? await recordReference(dir, "browser-", browser) : undefined;
	const alternate = readerAlternate(output);
	const draft = writeGold({
		...(alternate === undefined ? draftGold(primary.lynx, primary.trafilatura) : draftGold(undefined, alternate)),
		browser: dom && draftGold(dom.lynx, dom.trafilatura),
	});
	await Bun.write(path.join(dir, "gold.draft.toml"), draft);
	const recording = { requestedUrl: site.url, url, index, browserIndex, off, on, exchanges };
	await Bun.write(path.join(dir, "recording.json"), JSON.stringify(recording, null, 2));
	return { recording, primary };
}

async function replay(dir: string, recording: Recording, browser: boolean): Promise<Replay> {
	const [start, end] = browser ? recording.on : recording.off;
	let index = start;
	return pump(recording.url, browser, step => {
		const entry = index < end ? recording.exchanges[index++] : undefined;
		if (entry?.key !== requestKey(step)) {
			throw new Error(`No captured exchange for ${step.purpose ?? step.kind} ${step.url}; record this page again`);
		}
		return readExchange(dir, entry);
	});
}

async function renderSet(reference: Reference): Promise<RenderSet> {
	const outputs: RenderSet["outputs"] = {
		auto: { markdown: "", text: "" },
		full: { markdown: "", text: "" },
	};
	const unstable: RenderSet["unstable"] = [];
	for (const mode of modes) {
		for (const format of formats) {
			const options = { mode, format, width, baseUrl: reference.url };
			const first = await renderHtml(reference.html, options);
			outputs[mode][format] = first;
			if (first !== (await renderHtml(reference.html, options))) unstable.push({ mode, format });
		}
	}
	return { outputs, unstable };
}

function outputFilename(mode: Mode, format: Format, browser = false): string {
	if (mode === "full" && format === "text" && !browser) return "ours-full-visible.txt";
	return `ours-${browser ? "browser-" : ""}${mode}.${format === "markdown" ? "md" : "txt"}`;
}

async function writeOutputs(dir: string, rendered: RenderSet, browser = false): Promise<void> {
	const writes = [];
	for (const mode of modes) {
		for (const format of formats) {
			const file = outputFilename(mode, format, browser);
			writes.push(Bun.write(path.join(dir, file), rendered.outputs[mode][format]));
		}
	}
	await Promise.all(writes);
}

function goldPasses(output: ReaderOutput, gold: Gold | undefined): boolean {
	if (output.kind !== "page" || !output.content || !gold?.must.length) return false;
	const markdown = stripReaderFrontMatter(output.content);
	const view = markdownView(markdown);
	const checked = checkGold(view, gold);
	return (
		!checked.missing.length &&
		!checked.noise.length &&
		!checked.shortStructure.length &&
		!view.metaDump &&
		!dataUri.test(markdown)
	);
}

function g4(expected: string, off: Replay, on: Replay, gold: GoldFile): boolean {
	const preserved = ({ output }: Replay) =>
		output.verdict === expected &&
		(output.kind === "failed" ||
			(output.kind === "page" &&
				(!stripReaderFrontMatter(output.content ?? "").trim() || output.strategy === "embedded-summary")));
	const embedded = ({ output }: Replay) =>
		expected === "js-shell" &&
		output.verdict === "js-shell" &&
		output.strategy?.includes("embedded") &&
		goldPasses(output, gold.browser?.must.length ? gold.browser : gold);
	return (
		!off.browsed &&
		(preserved(off) || embedded(off)) &&
		(preserved(on) ||
			embedded(on) ||
			(on.browsed && on.output.verdict === "ok" && goldPasses(on.output, gold.browser)))
	);
}

function scoreSnapshot(
	rendered: RenderSet,
	reference: Reference,
	gold: Gold,
	options: { checkLength: boolean; strategy?: string; browser?: boolean },
) {
	const { markdown, text } = rendered.outputs.auto;
	const view = markdownView(markdown);
	const { checkLength, strategy, browser = false } = options;
	const markdownFile = outputFilename("auto", "markdown", browser);
	const checked = { ...checkGold(view, gold), markdownFile };
	if (strategy?.includes("embedded")) return { ...checked, bloat: null };

	const maxChars = checkLength ? 1.05 * Array.from(normalize(reference.lynx)).length : Infinity;
	const textFile = outputFilename("auto", "text", browser);
	const referenceFile = browser ? "browser-lynx.txt" : "lynx.txt";
	const bloat: string[] = [];
	if (view.metaDump) bloat.push(`${markdownFile}: metadata dump`);
	for (const [file, raw, visible] of [
		[markdownFile, markdown, view.text],
		[textFile, text, text],
	]) {
		if (dataUri.test(raw)) bloat.push(`${file}: data URI`);
		if (checkLength && Array.from(normalize(visible)).length > maxChars) {
			bloat.push(`${file}: visible length exceeds 105% of ${referenceFile}`);
		}
	}
	return { ...checked, bloat };
}

function visibleMarkdown(markdown: string): string {
	// Parse Markdown before removing tags so link titles/destinations never
	// become text, URLs used as labels survive, and code keeps literal tags.
	const html = Bun.markdown.html(markdown);
	const text = html
		.replace(/<!--[\s\S]*?-->|<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<\/?([a-z][\w:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi, (_tag, name: string, attributes: string) => {
			if (name.toLowerCase() === "img") {
				const alt = /(?:^|\s)alt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attributes);
				return alt?.[1] ?? alt?.[2] ?? alt?.[3] ?? "";
			}
			return htmlWordBoundary.test(name) ? " " : "";
		});
	return text.replace(
		/&(?:#([0-9]+)|#x([0-9a-f]+)|([a-z]+));/gi,
		(entity, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
			if (named) return visibleEntities[named] ?? entity;
			const point = hex ? Number.parseInt(hex, 16) : Number(decimal);
			return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff)
				? String.fromCodePoint(point)
				: "\uFFFD";
		},
	);
}

function visibleLynx(text: string): string {
	return (
		text
			// Toolbar lines precede the first content line and use the body margin.
			.replace(/^(?:[ \t]*\r?\n| {3}#\S[^\r\n]*(?:\r?\n|$))+/, "")
			// A hash bullet has a fixed margin; other hash lines can be code.
			.replace(/^(?: {20}| {35})# /gm, "")
			.replace(/^[ \t]*I?FRAME:[^\r\n]*(?:\r?\n[ \t]+(?:https?:\/\/|file:|(?:\.\.?)?\/)\S+[ \t]*(?=\r?$))?/gm, "")
			.replace(/^[ \t]*REFRESH\([^\r\n]*/gm, "")
			.replace(/^[ \t]*(?:_{2,}|(?:_[ \t]+)+_)[ \t]*$/gm, "")
			.replace(/\[(?:USEMAP|ISMAP)(?::[^\]\r\n]*)?\]|\[LINK\]-?/g, " ")
			.replace(
				/\[[^\]\r\n]+\.(?:avif|bmp|gif|ico|jpe?g|png|svgz?|tiff?|webp)(?:[?#][^\]\r\n]*)?\](?:-Submit)?/gi,
				" ",
			)
			.replace(/\[BUTTON Input\]\s*\(not implemented\)_*|\((?:BUTTON|OBJECT)\)|\[IMAGE\]-Submit/g, " ")
			.replace(/\[(?:[ \t]*|[xX*])\]|\([ \t*]*\)/g, " ")
			.replace(/(?<![\p{L}\p{N}_])_{2,}(?![\p{L}\p{N}_])/gu, " ")
			// Plain-text list markers are written into the indentation margin.
			.replace(/^[ \t]{3,}(?:(?:-?\d+|[A-Za-z]{1,3}|[ivxlcdmIVXLCDM]+)\.|o)(?=[ \t])/gm, "")
	);
}

function agreement(candidate: WordBag, reference: WordBag, allowBothEmpty = false): Agreement {
	const matched = consensus(candidate, reference).size;
	const empty = allowBothEmpty && !candidate.size && !reference.size ? 1 : 0;
	return {
		precision: candidate.size ? matched / candidate.size : empty,
		recall: reference.size ? matched / reference.size : empty,
	};
}

async function score(site: Site): Promise<Row> {
	const dir = path.join(root, site.slug);
	const recording = (await Bun.file(path.join(dir, "recording.json")).json()) as Recording;
	const entry = recording.exchanges[recording.index];
	const reference = await readReference(dir, "", entry.response.url);
	const reviewed = Bun.file(path.join(dir, "gold.toml"));
	const goldFile = (await reviewed.exists()) ? reviewed : Bun.file(path.join(dir, "gold.draft.toml"));
	const gold = parseGold(await goldFile.text());
	const rendered = await renderSet(reference);
	const lynxOptions = { format: "text", mode: "full", hidden: "all", width, baseUrl: reference.url } as const;
	const lynxText = await renderHtml(reference.html, lynxOptions);
	const unstable = rendered.unstable.map(({ mode, format }) => outputFilename(mode, format));
	if (lynxText !== (await renderHtml(reference.html, lynxOptions))) unstable.push("ours-full.txt");
	await Promise.all([writeOutputs(dir, rendered), Bun.write(path.join(dir, "ours-full.txt"), lynxText)]);
	const expected = verdicts[site.class];
	const off = await replay(dir, recording, false);
	const on = await replay(dir, recording, true);
	const verdictPass = expected ? g4(expected, off, on, gold) : null;
	const alternate = readerAlternate(off.output);
	const hasAlternate = alternate !== undefined;
	if (expected || hasAlternate) {
		await Promise.all([
			Bun.write(path.join(dir, "ours-reader-off.json"), JSON.stringify(off, null, 2)),
			Bun.write(path.join(dir, "ours-reader-on.json"), JSON.stringify(on, null, 2)),
		]);
	}
	const checkLength = site.class !== "wall" && site.class !== "app-shell";
	const snapshots = [];
	let required = gold.must;
	if (alternate !== undefined) {
		snapshots.push({
			...checkGold(markdownView(alternate), gold),
			markdownFile: "ours-reader-off.json",
			bloat: null,
		});
	} else {
		snapshots.push(scoreSnapshot(rendered, reference, gold, { checkLength, strategy: off.output.strategy }));
		if (gold.browser && recording.browserIndex !== undefined && on.browsed && on.output.verdict === "ok") {
			const dom = await readReference(dir, "browser-", recording.exchanges[recording.browserIndex].response.url);
			const browser = await renderSet(dom);
			await writeOutputs(dir, browser, true);
			snapshots.push(
				scoreSnapshot(browser, dom, gold.browser, {
					checkLength,
					strategy: on.output.strategy,
					browser: true,
				}),
			);
			required = gold.browser.must;
			unstable.push(...browser.unstable.map(({ mode, format }) => outputFilename(mode, format, true)));
		}
	}
	const chosen = snapshots[snapshots.length - 1];
	let writers: Agreement | null = null;
	let matchedLines = 0;
	let lynxLines = 0;
	if (!hasAlternate) {
		writers = agreement(
			words(visibleMarkdown(rendered.outputs.full.markdown), true),
			words(visibleLynx(rendered.outputs.full.text), true),
			true,
		);
		for (const change of diffLines(reference.lynx, lynxText)) {
			if (!change.added) lynxLines += change.count;
			if (!change.added && !change.removed) matchedLines += change.count;
		}
	}
	const writerWordsPass = writers
		? writers.precision >= writerWordMinimum && writers.recall >= writerWordMinimum
		: null;
	const missingGold = !required.length && site.class !== "app-shell";
	const deterministic = unstable.length === 0;
	const bloatIssues = snapshots.flatMap(snapshot => snapshot.bloat ?? []);
	const gates: Row["gates"] = {
		G1: site.class === "wall" ? null : !missingGold && !chosen.missing.length && !chosen.shortStructure.length,
		G2: snapshots.every(snapshot => !snapshot.noise.length),
		G3: snapshots.some(snapshot => snapshot.bloat !== null) ? !bloatIssues.length : null,
		G4: verdictPass,
		G5: writerWordsPass,
		G7: deterministic,
	};
	const sizes = modes.map(mode => formats.map(format => rendered.outputs[mode][format].length).join("/")).join("\t");
	const ratios = writers ? `${(100 * writers.precision).toFixed(1)}/${(100 * writers.recall).toFixed(1)}` : "n/a";
	const lineCounts = hasAlternate ? "n/a" : `${matchedLines}/${lynxLines}`;
	const results = gateIds.map(gate => (gates[gate] === null ? "—" : gates[gate] ? "PASS" : "FAIL")).join("\t");
	console.log(
		`${site.slug}\t${sizes}\t${ratios}\t${lineCounts}\t${off.output.verdict ?? "—"}/${on.output.verdict ?? "—"}\t${results}`,
	);
	const problems: string[] = [];
	if (gates.G1 === false) {
		const prefix = `G1 ${chosen.markdownFile}`;
		if (missingGold) problems.push(`${prefix}: gold.must is empty`);
		for (const snippet of chosen.missing) problems.push(`${prefix}: missing ${JSON.stringify(snippet)}`);
		for (const issue of chosen.shortStructure) problems.push(`${prefix}: ${issue}`);
	}
	if (gates.G2 === false) {
		for (const snapshot of snapshots) {
			for (const snippet of snapshot.noise)
				problems.push(`G2 ${snapshot.markdownFile}: noise ${JSON.stringify(snippet)}`);
		}
	}
	if (gates.G3 === false) for (const issue of bloatIssues) problems.push(`G3 ${issue}`);
	if (gates.G4 === false) {
		problems.push(`G4 ours-reader-off.json / ours-reader-on.json: expected ${expected} or a valid recovery`);
	}
	if (gates.G5 === false) problems.push("G5 ours-full.md / ours-full-visible.txt: precision or recall below 99%");
	for (const file of unstable) problems.push(`G7 ${file}: renders differed`);
	if (problems.length) console.error(`${site.slug}: ${problems.join("; ")}`);
	return {
		slug: site.slug,
		url: reference.url,
		gates,
		matchedLines,
		lynxLines,
		writers,
		verdicts: { off: off.output.verdict, on: on.output.verdict },
		deterministic,
		problems,
	};
}

async function holdout(sites: Site[], count: number, addon?: LegacyAddon): Promise<void> {
	const known = new Set<string>();
	for (const site of sites) {
		known.add(pageUrl(site.url).href);
		const file = Bun.file(path.join(root, site.slug, "recording.json"));
		if (await file.exists()) {
			const saved = (await file.json()) as Recording;
			known.add(saved.url);
			known.add(saved.exchanges[saved.index].response.url);
		}
	}
	const candidates: string[] = [];
	for (const line of (await Bun.stdin.text()).split(/\s+/u)) {
		if (!line) continue;
		let url: string;
		try {
			url = pageUrl(line).href;
		} catch {
			continue;
		}
		if (known.has(url)) continue;
		known.add(url);
		candidates.push(url);
	}
	if (candidates.length < count)
		throw new Error(`Holdout needs ${count} distinct non-corpus URLs; got ${candidates.length}`);
	console.log("holdout\tconsensus words\trecall %\tnoise %\tlegacy recall %\tlegacy noise %\turl");
	for (let i = 0; i < count; i++) {
		const j = i + Math.floor(Math.random() * (candidates.length - i));
		[candidates[i], candidates[j]] = [candidates[j], candidates[i]];
		const url = candidates[i];
		const slug = `holdout-${Bun.hash(url).toString(16)}`;
		try {
			const { primary: reference } = await record({ slug, url, class: "listing" });
			const target = consensus(words(reference.lynx), words(markdownView(reference.trafilatura).text));
			const text = await renderHtml(reference.html, { width, baseUrl: reference.url });
			const legacy = await addon?.htmlToMarkdown(reference.html, { cleanContent: true, hiddenContent: "reachable" });
			const ratios = (markdown: string) => {
				const bag = words(markdownView(markdown).text);
				const agreed = consensus(bag, target).size;
				return `${target.size ? ((100 * agreed) / target.size).toFixed(1) : "—"}\t${target.size && bag.size ? (100 * (1 - agreed / bag.size)).toFixed(1) : "—"}`;
			};
			console.log(
				`${slug}\t${target.size}\t${ratios(text)}\t${legacy === undefined ? "—\t—" : ratios(legacy)}\t${url}`,
			);
		} catch (error) {
			console.error(`${slug}: ${error}`);
			process.exitCode = 1;
		}
	}
}

try {
	const relative = path.relative(path.resolve(import.meta.dir, "../.."), root);
	if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
		throw new Error("~/.omp/web-corpus must be outside the repository");
	}
	const [command, ...args] = Bun.argv.slice(2);
	if (command !== "record" && command !== "score" && command !== "holdout") {
		throw new Error(
			"Usage: bun scripts/web-bench/bench.ts record [--only slug,...] | score [slug ...] | holdout [count] < urls.txt",
		);
	}
	const { page: sites } = Bun.TOML.parse(await Bun.file(path.join(import.meta.dir, "corpus.toml")).text()) as {
		page: Site[];
	};
	for (const site of sites) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(site.slug)) throw new Error(`Invalid corpus slug: ${site.slug}`);
	}
	if (command === "holdout") {
		const count = args.length ? Number(args[0]) : 10;
		if (args.length > 1 || !Number.isSafeInteger(count) || count < 1)
			throw new Error("Holdout count must be a positive integer");
		await holdout(sites, count, openLegacy());
	} else {
		let slugs = args;
		if (command === "record" && args[0] === "--only") {
			if (args.length !== 2) throw new Error("record --only takes one comma-separated list of corpus slugs");
			slugs = args[1].split(",").map(slug => slug.trim());
		}
		for (const slug of slugs)
			if (!sites.some(site => site.slug === slug)) throw new Error(`Unknown corpus slug: ${JSON.stringify(slug)}`);
		const selected = slugs.length ? sites.filter(site => slugs.includes(site.slug)) : sites;
		const rows: Row[] = [];
		const errors: { slug: string; error: string }[] = [];
		if (command === "score") {
			console.log(`page\tauto M/T\tfull M/T\tfull M/T P/R %\tlynx lines\tverdict off/on\t${gateIds.join("\t")}`);
		}
		for (const site of selected) {
			try {
				if (command === "record") {
					const { recording: saved } = await record(site);
					const page = saved.exchanges[saved.index].response;
					console.log(`${site.slug}\t${page.status}\t${page.url}`);
				} else {
					rows.push(await score(site));
				}
			} catch (error) {
				if (command === "score") {
					console.log(`${site.slug}\tERROR`);
					errors.push({ slug: site.slug, error: String(error) });
				}
				console.error(`${site.slug}: ${error}`);
				process.exitCode = 1;
			}
		}
		if (command === "score") {
			const lineRows = rows.filter(row => row.gates.G5 !== null);
			const matched = lineRows.reduce((sum, row) => sum + row.matchedLines, 0);
			const lines = lineRows.reduce((sum, row) => sum + row.lynxLines, 0);
			const linePass = lineRows.length ? lines > 0 && matched / lines >= lineBaseline : null;
			console.log(
				`G5 line identity (ours-full.txt / lynx.txt): ${linePass === null ? "n/a" : `${matched}/${lines} (${lines ? ((100 * matched) / lines).toFixed(2) : "—"}%; minimum 96.4%) ${linePass ? "PASS" : "FAIL"}`}`,
			);
			const gates = [];
			for (const gate of gateIds) {
				const eligible = rows.filter(row => row.gates[gate] !== null);
				const pass = eligible.filter(row => row.gates[gate]).length;
				const ok =
					pass === eligible.length && rows.length === selected.length && (gate !== "G5" || linePass !== false);
				gates.push({ gate, passed: pass, eligible: eligible.length, ok });
				console.log(
					`${gate}: ${eligible.length ? `${pass}/${eligible.length} ${ok ? "PASS" : "FAIL"}` : ok ? "N/A" : "FAIL"}`,
				);
				if (!ok) process.exitCode = 1;
			}
			const summary = {
				gates,
				g5Lines: { matched, lines, threshold: lineBaseline, ok: linePass },
				rows,
				errors,
			};
			await Bun.write(path.join(root, "score.json"), JSON.stringify(summary, null, 2));
		}
	}
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
