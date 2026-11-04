import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	encodeRankPart,
	keptRanges,
	rankPartAt,
	reasonShows,
	type SpotlightDetails,
	SpotlightNotice,
	type SpotlightReason,
} from "@oh-my-pi/pi-tui/chat/spotlight";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { setTranscriptActionHandler, type TranscriptAction } from "@oh-my-pi/pi-tui/chat/transcript-actions";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { hasSpotlightOriginal, SpotlightSheet } from "@oh-my-pi/pi-tui/overlays/spotlight-sheet";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TspChartProps, TspCodeFold, TspCodeMark, TspNode, TspPropNode, TspSpan } from "@oh-my-pi/pi-wire";
import { TspHarness } from "./tsp-harness";

beforeAll(async () => {
	await initTheme(false);
});

let harness: TspHarness | undefined;
afterEach(() => {
	setTranscriptActionHandler(undefined);
	harness?.stop();
	harness = undefined;
	stopSharedSpinnerTicker();
});

const UI = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };

/** The notice's Nerd Font stars: `md-star_off_outline`, `fa-star`, `md-star_shooting_outline`. */
const STAR_OFF = "\u{f155b}";
const STAR = "\uf005";
const SHOOTING_STAR = "\u{f1742}";

const ORIGINAL = ["INFO boot", "INFO step 1", "INFO step 2", "ERROR db refused", "INFO step 3"].join("\n");
const REDUCED = ["INFO boot", "… [2-3]", "ERROR db refused", "… [5-5]"].join("\n");

const SAVED: SpotlightDetails = {
	tool: "bash",
	steps: ["window"],
	inChars: 48_800,
	outChars: 2_400,
	inTokens: 52_000,
	outTokens: 12_000,
	savedTokens: 40_000,
	original: {
		url: "artifact://7",
		lines: 5,
		start: 1,
		heat: "1-29",
		kept: [
			[1, 1],
			[4, 4],
		],
	},
	request: {
		task: "Why does ingest\nstall?",
		commands: ["make build", "./ingest.sh --dry-run"],
		said: "",
		intent: "Find the failing step",
		source: "./ingest.sh",
		probe: "The most important line in this output is: `",
		model: "whiskers-latest",
		thinking: "low",
	},
};

const PASSTHROUGH: SpotlightDetails = {
	tool: "bash",
	steps: ["none"],
	inChars: 4,
	outChars: 4,
	inTokens: 1,
	outTokens: 1,
	savedTokens: 0,
};

/** A finished, collapsed card of `tool` called with `args` whose result carries `spotlight`. */
function toolCard(
	tool: string,
	args: Record<string, unknown>,
	id: string,
	output: string,
	spotlight: SpotlightDetails,
): ToolExecutionComponent {
	const card = new ToolExecutionComponent(tool, args, {}, undefined, UI, process.cwd(), id);
	card.setArgsComplete(id);
	card.setExecutionStarted(id);
	card.updateResult({ content: [{ type: "text", text: output }], details: { spotlight }, isError: false }, false, id);
	return card;
}

/** A finished, collapsed bash card whose result carries `spotlight`. */
function bashCard(id: string, output: string, spotlight: SpotlightDetails): ToolExecutionComponent {
	return toolCard("bash", { command: "./ingest.sh" }, id, output, spotlight);
}

/** A grep cut by the generic hook: its original is the saved output, its source the call. */
const GREP_SAVED: SpotlightDetails = {
	...SAVED,
	tool: "grep",
	request: { ...SAVED.request!, source: 'grep {"pattern":"refused","path":"src"}' },
};

/**
 * A read window (lines 40-49) a budgeted rank cut: every line with a reason, two rank parts (as older traces carry),
 * the marker map.
 */
const RICH_LINES = [
	"function ingest() {",
	"  const db = connect();",
	"  log('boot');",
	"  log('step 1');",
	"  retry(db, 3);",
	"  log('step 2');",
	"  throw new Error('db refused');",
	"  // cleanup",
	"  log('done');",
	"}",
];
const RICH_ORIGINAL = RICH_LINES.join("\n");
const RICH_REDUCED = [
	"function ingest() {",
	"  const db = connect();",
	"  … 4 lines cut",
	"  throw new Error('db refused');",
	"  // cleanup",
	"}",
	"[spotlight: 5 of 10 lines kept]",
	"",
].join("\n");
const SPOTLIGHT_PART = [0.3, 0.7, 0.1, 0.2, 0.8, 0.4, 0.9, 0, 0, 0.1];
const OVERLAP_PART = [0, 0.4, 0, 0, 0.3, 0, 0.5, 0, 0, 0];
const RANK_VALUES = [encodeRankPart(SPOTLIGHT_PART, 2), encodeRankPart(OVERLAP_PART, 2)];

const RICH: SpotlightDetails = {
	tool: "read",
	steps: ["window"],
	inChars: 1_200,
	outChars: 600,
	inTokens: 300,
	outTokens: 150,
	savedTokens: 150,
	original: {
		url: "artifact://9",
		lines: 10,
		start: 40,
		path: "src/ingest.ts",
		heat: "3712849-01",
		why: "sabbbracfs",
		kept: [
			[1, 2],
			[7, 8],
			[10, 10],
		],
		rank: {
			parts: ["Spotlight", "word overlap"],
			max: 2,
			values: RANK_VALUES,
			cutoff: 0.88,
			budget: 600,
			used: 590,
			last: { line: 7, chars: 120 },
		},
		map: [1, 2, [3, 6], 7, 8, 10, null, null],
	},
	request: SAVED.request,
};

/** The rank parts the trace encodes for original line `i` (0-based). */
function parts(i: number): number[] {
	return RANK_VALUES.map(values => rankPartAt(values, i, 2));
}

/** A text node's words, from its `text` or its spans. */
function words(node: TspNode | TspPropNode | undefined): string | undefined {
	const p = node?.p as { text?: string; spans?: readonly TspSpan[] } | undefined;
	return p?.text ?? p?.spans?.map(s => s.t).join("");
}

/** A legend entry (`omp.spotlight.key`): its swatch's glyph and tone, and its muted label. */
function keyOf(key: TspNode): { swatch?: string; tone: unknown; label?: string } {
	const [swatch, label] = key.c ?? [];
	expect(prop(key, "role")).toBe("omp.spotlight.key");
	expect(prop(swatch, "role")).toBe("omp.spotlight.swatch");
	expect(prop(label, "spans")).toEqual([{ t: words(label), s: "muted" }]);
	return { swatch: words(swatch), tone: prop(swatch, "tone"), label: words(label) };
}

/**
 * Opens the sheet of a bash card's trace through its notice, as the host does; the harness then shows it. `reduced` is
 * the card's output; the host shows `wouldBe` instead when given (a held-out result's `shapedUrl` text).
 */
async function openSheet(
	spotlight: SpotlightDetails,
	original: string,
	reduced: string,
	wouldBe?: string,
	card: (id: string, output: string, spotlight: SpotlightDetails) => ToolExecutionComponent = bashCard,
): Promise<TranscriptAction[]> {
	const actions: TranscriptAction[] = [];
	setTranscriptActionHandler(action => {
		actions.push(action);
		if (action.act !== "spotlight" || !hasSpotlightOriginal(action.spotlight)) return;
		const tui = harness!.tui;
		const sheet = new SpotlightSheet({
			spotlight: action.spotlight,
			original,
			reduced: wouldBe ?? action.reduced,
			close: () => handle.hide(),
		});
		const handle = tui.showOverlay(sheet, { anchor: "center" });
		tui.setFocus(sheet);
	});
	const transcript = new TranscriptContainer();
	transcript.addChild(card("c1", reduced, spotlight));
	harness = await TspHarness.start(tui => tui.addChild(transcript));
	await harness.render();
	const notice = harness.find(node => node.p?.role === "omp.tool.spotlight");
	harness.event({ ev: "action", sf: harness.terminal.surface!, id: notice!.id, act: "spotlight" });
	await harness.render();
	return actions;
}

/** Nodes of kind `kind` under `root`, depth first. */
function within(root: TspNode | undefined, kind: string): TspNode[] {
	if (!root) return [];
	return [...(root.k === kind ? [root] : []), ...(root.c ?? []).flatMap(child => within(child, kind))];
}

/** A node's prop by name, whatever its kind. */
function prop(node: TspNode | TspPropNode | undefined, name: string): unknown {
	return (node?.p as Record<string, unknown> | undefined)?.[name];
}

/** The transcript's blocks, in order. */
function blocks(h: TspHarness): readonly TspNode[] {
	const transcript = h.find(node => node.p?.role === "omp.transcript");
	return transcript?.c ?? [];
}

describe("spotlight notice", () => {
	it("follows a collapsed card as its own block: bright and clickable when shaping saved, dim when it passed", async () => {
		setTranscriptActionHandler(() => {});
		const transcript = new TranscriptContainer();
		transcript.addChild(bashCard("c1", REDUCED, SAVED));
		transcript.addChild(bashCard("c2", "done", PASSTHROUGH));
		harness = await TspHarness.start(tui => tui.addChild(transcript));
		await harness.render();

		const [saved, savedNotice, kept, keptNotice] = blocks(harness);
		expect(saved?.k).toBe("tool");
		expect(saved?.p).toMatchObject({ key: "c1", collapsed: true });
		expect(savedNotice?.k).toBe("text");
		expect(savedNotice?.p).toMatchObject({
			role: "omp.tool.spotlight",
			key: "spotlight:c1",
			tone: "accent",
			spans: [{ t: SHOOTING_STAR, s: "icon", fx: "pulse" }, { t: "spotlight: saved 40K toks" }],
			actions: { click: "spotlight" },
		});
		expect(kept?.p).toMatchObject({ key: "c2" });
		expect(keptNotice?.p).toMatchObject({
			role: "omp.tool.spotlight",
			key: "spotlight:c2",
			tone: "muted",
			spans: [{ t: STAR_OFF, s: "icon" }],
			title: "Spotlight: passthrough",
		});
		expect(prop(keptNotice, "actions")).toBeUndefined();
		expect(harness.errors).toEqual([]);
	});

	it("follows the card of any tool, with a renderer of its own or the default one", async () => {
		setTranscriptActionHandler(() => {});
		const transcript = new TranscriptContainer();
		transcript.addChild(toolCard("grep", { pattern: "refused", path: "src" }, "c1", REDUCED, GREP_SAVED));
		transcript.addChild(
			toolCard("mcp__docs__search", { query: "retry" }, "c2", REDUCED, { ...SAVED, tool: "mcp__docs__search" }),
		);
		harness = await TspHarness.start(tui => tui.addChild(transcript));
		await harness.render();

		const [grep, grepNotice, mcp, mcpNotice] = blocks(harness);
		expect(grep?.p).toMatchObject({ key: "c1" });
		expect(grepNotice?.p).toMatchObject({ role: "omp.tool.spotlight", key: "spotlight:c1", tone: "accent" });
		expect(mcp?.p).toMatchObject({ key: "c2" });
		expect(mcpNotice?.p).toMatchObject({ role: "omp.tool.spotlight", key: "spotlight:c2", tone: "accent" });
		expect(harness.errors).toEqual([]);
	});

	it("follows a group of reads with one notice per read", async () => {
		setTranscriptActionHandler(() => {});
		const group = new ReadToolGroupComponent();
		for (const id of ["r1", "r2"]) {
			group.updateArgs({ path: `src/${id}.ts` }, id);
			group.updateResult(
				{ content: [{ type: "text", text: REDUCED }], details: { spotlight: { ...SAVED, tool: "read" } } },
				false,
				id,
			);
		}
		const transcript = new TranscriptContainer();
		transcript.addChild(group);
		harness = await TspHarness.start(tui => tui.addChild(transcript));
		await harness.render();

		const notices = blocks(harness).filter(block => block.p?.role === "omp.tool.spotlight");
		expect(notices.map(notice => notice.p?.key)).toEqual(["spotlight:r1", "spotlight:r2"]);
		expect(harness.errors).toEqual([]);
	});

	it("opens a generic tool's sheet on its saved output", async () => {
		const grepCard = (id: string, output: string, spotlight: SpotlightDetails) =>
			toolCard("grep", { pattern: "refused", path: "src" }, id, output, spotlight);
		const actions = await openSheet(GREP_SAVED, ORIGINAL, REDUCED, undefined, grepCard);

		expect(actions).toEqual([{ act: "spotlight", toolCallId: "c1", spotlight: GREP_SAVED, reduced: REDUCED }]);
		const overlay = harness!.find(node => node.k === "overlay");
		expect(overlay?.p).toMatchObject({ role: "omp.overlay.spotlight" });
		expect(prop(overlay, "head")).toContain("⭐ Spotlight · grep ·");
		expect(harness!.errors).toEqual([]);
	});

	it("lights a plain star up to 10K tokens saved and a shooting star past them", () => {
		const notice = (savedTokens: number) => new SpotlightNotice("c1", { ...SAVED, savedTokens }, "").describe().p;
		const saved = { t: "spotlight: saved 10K toks" };
		expect(notice(10_000)).toMatchObject({ spans: [{ t: STAR, s: "icon", fx: "pulse" }, saved] });
		expect(notice(10_001)).toMatchObject({ spans: [{ t: SHOOTING_STAR, s: "icon", fx: "pulse" }, saved] });
	});

	it("counts against what plain would have shown when the trace records it", () => {
		const notice = (plainTokens: number) =>
			new SpotlightNotice(
				"c1",
				{ ...SAVED, plainTokens, savedTokens: Math.max(0, plainTokens - 12_000) },
				"",
			).describe().p;
		// 52K in, 12K out, but plain would have shown 15K: 3K saved, not 40K.
		expect(notice(15_000)).toMatchObject({ spans: [{ t: STAR }, { t: "spotlight: saved 3K toks" }] });
		// Plain would have shown less than the cut: the cut cost tokens.
		expect(notice(11_000)).toMatchObject({ spans: [{ t: STAR }, { t: "spotlight: reshaped, +1K toks" }] });
	});

	it("opens the sheet on a click: the original folded where the model did not see it, tinted by why", async () => {
		const actions = await openSheet(RICH, RICH_ORIGINAL, RICH_REDUCED);
		expect(actions).toEqual([{ act: "spotlight", toolCallId: "c1", spotlight: RICH, reduced: RICH_REDUCED }]);
		const h = harness!;

		const overlay = h.find(node => node.k === "overlay");
		expect(overlay?.p).toMatchObject({ role: "omp.overlay.spotlight", size: "lg", modal: true });
		expect(prop(overlay, "head")).toBe("⭐ Spotlight · read · 1.2K → 600 chars · saved 150 toks");

		// The request collapses to the intent on one line; the toggle names the other non-blank parameters.
		let params = h.find(node => node.p?.role === "omp.spotlight.params");
		expect(params?.c).toHaveLength(1);
		const intent = params?.c?.[0];
		expect(prop(intent, "role")).toBe("omp.spotlight.param");
		const [name, value, more] = within(intent, "text");
		expect(words(name)).toBe("intent");
		expect(value?.p).toMatchObject({
			spans: [{ t: "Find the failing step" }],
			lines: 1,
			truncate: "end",
			title: "Find the failing step",
		});
		expect(more?.p).toMatchObject({
			role: "omp.spotlight.more",
			text: "task, commands, source, probe, model ▸",
			actions: { click: "params" },
		});

		h.event({ ev: "action", sf: h.terminal.surface!, id: more!.id, act: "params" });
		await h.render();
		params = h.find(node => node.p?.role === "omp.spotlight.params");
		const names = (params?.c ?? []).map(paramRow => words(within(paramRow, "text")[0]));
		expect(names).toEqual(["intent", "task", "commands", "source", "probe", "model"]);
		expect(words(h.find(node => node.p?.role === "omp.spotlight.more"))).toBe("fewer ▾");
		const task = h.find(node => node.p?.title === "Why does ingest\nstall?");
		expect(task?.p).toMatchObject({ spans: [{ t: "Why does ingest stall?" }], lines: 2, truncate: "end" });
		const model = h.find(node => node.p?.title === "whiskers-latest\nlow thinking");
		expect(prop(model, "spans")).toEqual([{ t: "whiskers-latest" }, { t: " · ", s: "dim" }, { t: "low thinking" }]);

		// The legend counts each class of line; the budget and cutoff sit at the end.
		const summary = h.find(node => node.p?.role === "omp.spotlight.summary");
		const keys = (summary?.c ?? []).filter(child => prop(child, "role") === "omp.spotlight.key");
		expect(keys.map(keyOf)).toEqual([
			{ swatch: "■", tone: "accent", label: "kept by score 2" },
			{ swatch: "■", tone: "neutral", label: "kept as structure 2" },
			{ swatch: "■", tone: "info", label: "kept as context 1" },
			{ swatch: "■", tone: "error", label: "cut though hot 1" },
			{ swatch: "■", tone: "muted", label: "cut 4" },
		]);
		expect(words(h.find(node => node.p?.role === "omp.spotlight.budget"))).toBe(
			"budget 590 of 600 chars · cutoff 0.88",
		);

		// One code element: the original, numbered from the window's first line.
		const codes = within(overlay, "code");
		expect(codes).toHaveLength(1);
		const [code] = codes;
		expect(code?.p).toMatchObject({
			role: "omp.spotlight.code",
			text: RICH_ORIGINAL,
			path: "src/ingest.ts",
			start: 40,
			numbers: true,
		});
		// A file keeps its lines, and a short one needs no overview.
		expect(prop(code, "wrap")).toBeUndefined();
		expect(prop(code, "overview")).toBeUndefined();
		const marks = prop(code, "marks") as TspCodeMark[];
		expect(marks).toHaveLength(10);
		const markAt = (line: number) => marks.find(mark => mark.line === line);
		expect(markAt(40)).toEqual({ line: 40, heat: 3 / 9, tone: "neutral", wash: parts(0) });
		expect(markAt(41)).toEqual({ line: 41, heat: 7 / 9, tone: "accent", wash: parts(1) });
		// Hidden: heat only, unless it scored hot.
		expect(markAt(43)).toEqual({ line: 43, heat: 2 / 9, wash: parts(3) });
		expect(markAt(44)).toEqual({ line: 44, heat: 8 / 9, tone: "error", wash: parts(4) });
		// A context line Spotlight never scored still carries its tone.
		expect(markAt(47)).toEqual({ line: 47, tone: "info", wash: parts(7) });
		expect(parts(4)[0]).toBeCloseTo(0.8, 2);
		expect(parts(4)[1]).toBeCloseTo(0.3, 2);

		// The hidden runs fold: the first under the marker the model read, tinted for the hot line it hides.
		const folds = prop(code, "folds") as TspCodeFold[];
		expect(folds).toHaveLength(2);
		const [hot, cold] = folds;
		expect(hot).toMatchObject({
			from: 42,
			to: 45,
			label: "  … 4 lines cut",
			note: [
				{ t: "4 lines · peak 0.89", s: "muted" },
				{ t: " · line 44 cut by the budget", s: "error" },
			],
			tone: "error",
		});
		expect(cold).toEqual({ from: 48, to: 48, note: [{ t: "1 line · peak 0.00", s: "muted" }] });

		// The hot fold's card: the line as the sheet draws it, its score's sum, and what took the budget's end.
		const card = hot?.hovercard;
		expect(card?.k).toBe("col");
		const [what, line, sum, why] = card?.c ?? [];
		expect(words(what)).toBe("line 44 · the hottest line this fold hides");
		expect(line?.k).toBe("code");
		expect(line?.p).toMatchObject({
			text: "  retry(db, 3);",
			path: "src/ingest.ts",
			start: 44,
			numbers: true,
			marks: [{ line: 44, heat: 8 / 9, tone: "error", wash: parts(4) }],
		});
		expect(prop(sum, "spans")).toEqual([{ t: "0.80 + 0.30 = 1.10 · cutoff 0.88", s: "muted" }]);
		expect(prop(why, "spans")).toEqual([
			{ t: "cut by the budget: line 46 (1.40) took the last 120 chars", s: "error" },
		]);

		// The shaping notes the model saw, blank ones left out.
		const notes = h.find(node => node.p?.role === "omp.spotlight.notes");
		expect(within(notes, "text").map(words)).toEqual(["notes the model saw", "[spotlight: 5 of 10 lines kept]"]);

		// The footer keys the rows' wash, the parts in their order across a row, before Close.
		const footer = within(overlay, "row").find(node => prop(node, "role") === "omp.actions");
		const legend = footer?.c?.[0];
		expect(prop(legend, "role")).toBe("omp.spotlight.legend");
		const [ramp, tint] = legend?.c?.[0]?.c ?? [];
		expect(prop(ramp, "role")).toBe("omp.spotlight.ramp");
		expect(words(tint)).toBe("row tint, left to right: Spotlight → word overlap");
		expect(footer?.c?.[1]?.k).toBe("spacer");

		const close = h.find(node => node.p?.actions?.click === "close");
		h.event({ ev: "action", sf: h.terminal.surface!, id: close!.id, act: "close" });
		await h.render();
		expect(h.find(node => node.k === "overlay")).toBeUndefined();
		expect(h.errors).toEqual([]);
	});

	it("draws a trace written before reasons, ranks and maps: folds from what was kept, heat-only marks", async () => {
		await openSheet(SAVED, ORIGINAL, REDUCED);
		const h = harness!;
		const overlay = h.find(node => node.k === "overlay");
		const [code] = within(overlay, "code");
		// Command output wraps.
		expect(code?.p).toMatchObject({ text: ORIGINAL, start: 1, numbers: true, wrap: true });
		expect(prop(code, "marks")).toEqual([
			{ line: 1, heat: 1 / 9 },
			{ line: 3, heat: 2 / 9 },
			{ line: 4, heat: 1 },
		]);
		expect(prop(code, "folds")).toEqual([
			{ from: 2, to: 3, note: [{ t: "2 lines · peak 0.22", s: "muted" }] },
			{ from: 5, to: 5, note: [{ t: "1 line", s: "muted" }] },
		]);
		expect(h.find(node => node.p?.role === "omp.spotlight.summary")).toBeUndefined();
		expect(h.find(node => node.p?.role === "omp.spotlight.legend")).toBeUndefined();
		expect(h.find(node => node.p?.role === "omp.spotlight.notes")).toBeUndefined();
		expect(h.errors).toEqual([]);
	});

	it("adds the overview from a screenful of lines on, which a shorter original does without", async () => {
		const sheetFor = async (n: number) => {
			const original = Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
			const trace = { ...SAVED, original: { ...SAVED.original!, lines: n, kept: [[1, n]] as [number, number][] } };
			await openSheet(trace, original, original);
			const overview = prop(
				within(
					harness!.find(node => node.k === "overlay"),
					"code",
				)[0],
				"overview",
			);
			harness!.stop();
			harness = undefined;
			return overview;
		};
		expect(await sheetFor(59)).toBeUndefined();
		expect(await sheetFor(60)).toBe(true);
	});

	it("charts a changed result's heat in the notice's hover card, tinted by the most notable reason per bar", () => {
		// 240 lines in 120 bars of two: the first five bars test the tone priority, the rest are kept by score.
		const why = `absnbsbrcs${"aa".repeat(115)}`;
		const heat = `3933033333${"33".repeat(115)}`;
		const shown = [...why].map(c => reasonShows(c as SpotlightReason));
		const spotlight: SpotlightDetails = {
			...RICH,
			original: { url: "artifact://3", lines: 240, start: 1, heat, why, kept: keptRanges(shown) },
		};
		const card = new SpotlightNotice("c1", spotlight, "").describe().p?.hovercard as TspPropNode | undefined;
		expect(card?.k).toBe("col");
		const [chart, summary] = card?.c ?? [];
		expect(chart?.k).toBe("chart");
		const props = chart?.p as TspChartProps;
		expect(props).toMatchObject({ kind: "bars", size: "sm", min: 0, max: 1 });
		expect(props.series).toHaveLength(120);
		expect(props.series?.slice(0, 6)).toEqual([
			{ value: 1, tone: "error" },
			{ value: 3 / 9, tone: "user" },
			{ value: 3 / 9, tone: "neutral" },
			{ value: 3 / 9, tone: "muted" },
			{ value: 3 / 9, tone: "info" },
			{ value: 3 / 9, tone: "accent" },
		]);
		expect(prop(summary, "spans")).toEqual([
			{ t: "kept 236 of 240 lines · 231 by score · 1 cut though hot", s: "muted" },
		]);

		// A long result shares bars; one without reasons draws plain bars and only what was kept.
		const long: SpotlightDetails = {
			...SAVED,
			original: { url: "artifact://4", lines: 1_000, start: 1, heat: "5".repeat(1_000), kept: [[1, 10]] },
		};
		const plain = new SpotlightNotice("c2", long, "").describe().p?.hovercard as TspPropNode | undefined;
		const plainChart = plain?.c?.[0]?.p as TspChartProps | undefined;
		const plainSeries = plainChart?.series;
		expect(plainSeries).toHaveLength(120);
		expect(plainSeries?.every(bar => bar.tone === undefined && bar.value === 5 / 9)).toBe(true);
		expect(words(plain?.c?.[1])).toBe("kept 10 of 1,000 lines");

		// A passthrough has no card.
		expect(new SpotlightNotice("c3", PASSTHROUGH, "").describe().p?.hovercard).toBeUndefined();
	});

	it("draws a held-out result dim with what it would save, and its click opens the would-be cut", async () => {
		const heldOut: SpotlightDetails = {
			...RICH,
			holdout: true,
			original: { ...RICH.original!, shapedUrl: "artifact://10" },
		};
		const notice = new SpotlightNotice("c1", heldOut, RICH_ORIGINAL).describe();
		expect(notice.p).toMatchObject({
			tone: "muted",
			spans: [{ t: STAR_OFF, s: "icon" }, { t: "spotlight: held out · would save 150 toks" }],
		});
		const card = notice.p?.hovercard as TspPropNode | undefined;
		expect(words(card?.c?.[1])).toBe("would keep 5 of 10 lines · 2 by score · 1 cut though hot");

		// The model saw the original; the host shows the would-be text beside it.
		const actions = await openSheet(heldOut, RICH_ORIGINAL, RICH_ORIGINAL, RICH_REDUCED);
		expect(actions).toEqual([{ act: "spotlight", toolCallId: "c1", spotlight: heldOut, reduced: RICH_ORIGINAL }]);
		const h = harness!;
		const shown = h.find(node => node.p?.role === "omp.tool.spotlight");
		expect(shown?.p).toMatchObject({ tone: "muted", actions: { click: "spotlight" } });
		const overlay = h.find(node => node.k === "overlay");
		expect(prop(overlay, "head")).toBe(
			"⭐ Spotlight · held out (the model saw the original) · read · 1.2K → 600 chars · would save 150 toks",
		);
		const [code] = within(overlay, "code");
		expect((prop(code, "folds") as TspCodeFold[])[0]).toMatchObject({ from: 42, to: 45, label: "  … 4 lines cut" });
		const notes = h.find(node => node.p?.role === "omp.spotlight.notes");
		expect(within(notes, "text").map(words)).toEqual([
			"notes the model would have seen",
			"[spotlight: 5 of 10 lines kept]",
		]);
		expect(h.errors).toEqual([]);
	});

	it("draws a read the edit gate kept whole dim, as the would-be cut it traced, not as a saving", () => {
		const gated: SpotlightDetails = {
			...RICH,
			gated: true,
			editLikely: true,
			// A gated trace saves nothing; what it would have saved is `plain`'s tokens less the would-be cut's.
			savedTokens: 0,
			plainTokens: RICH.outTokens + 150,
			original: { ...RICH.original!, shapedUrl: "artifact://10" },
		};
		const notice = new SpotlightNotice("c1", gated, RICH_ORIGINAL).describe();
		expect(notice.p).toMatchObject({
			tone: "muted",
			spans: [{ t: STAR_OFF, s: "icon" }, { t: "spotlight: kept whole for editing · would save 150 toks" }],
		});
	});
});
