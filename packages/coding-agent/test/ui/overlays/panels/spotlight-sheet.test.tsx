/** @jsxImportSource @oh-my-pi/pi-tui */
import { encodeRankPart } from "../../../../src/tools/details/spotlight";
import { SpotlightSheet } from "../../../../src/ui/overlays/panels/spotlight-sheet";
import { type Driver, panelSuite } from "./harness";

const ORIGINAL = ["INFO boot", "INFO step 1", "INFO step 2", "ERROR db refused", "INFO step 3"].join("\n");
const REDUCED = ["INFO boot", "… [2-3]", "ERROR db refused", "… [5-5]"].join("\n");
const request = {
	task: "Why does ingest\nstall?",
	commands: ["make build", "./ingest.sh --dry-run"],
	said: "",
	intent: "Find the failing step: Which ingest step failed, and why?",
	source: "./ingest.sh",
	probe: "The most important line in this output is: `",
	model: "whiskers-latest",
	thinking: "low",
};
const SAVED = {
	tool: "bash",
	steps: ["window"],
	inChars: 48_800,
	outChars: 2_400,
	inTokens: 52_000,
	outTokens: 12_000,
	savedTokens: 40_000,
	original: {
		url: "local://7.log",
		lines: 5,
		start: 1,
		heat: "1-29",
		kept: [
			[1, 1],
			[4, 4],
		],
	},
	request,
};
const RICH_ORIGINAL = [
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
].join("\n");
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
const RANK_VALUES = [
	encodeRankPart([0.3, 0.7, 0.1, 0.2, 0.8, 0.4, 0.9, 0, 0, 0.1], 2),
	encodeRankPart([0, 0.4, 0, 0, 0.3, 0, 0.5, 0, 0, 0], 2),
];
const RICH = {
	tool: "read",
	steps: ["window"],
	inChars: 1_200,
	outChars: 600,
	inTokens: 300,
	outTokens: 150,
	savedTokens: 150,
	original: {
		url: "local://9.log",
		lines: 10,
		start: 40,
		path: "src/ingest.ts",
		heat: "3712948-01",
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
	request,
};
const MULTI = {
	...RICH,
	original: {
		url: "local://11.log",
		lines: 7,
		start: 1,
		heat: "345198-",
		why: "sabbbas",
		kept: [
			[1, 1],
			[5, 7],
		],
		windows: [
			{
				path: "a.py",
				at: 0,
				lines: 4,
				start: 1,
				rank: { parts: ["Spotlight"], max: 1, values: [encodeRankPart([0.3, 0.4, 0.5, 0.1], 1)], cutoff: 0.4 },
			},
			{
				path: "b.ts",
				at: 4,
				lines: 3,
				start: 10,
				rank: {
					parts: ["Spotlight", "overlap"],
					max: 2,
					values: [encodeRankPart([0.9, 0.8, 0.1], 2), encodeRankPart([0.2, 0.1, 0], 2)],
					cutoff: 0.5,
					budget: 100,
					used: 90,
				},
			},
		],
		map: [1, [2, 4], 5, 6, 7, null],
	},
};
const BIG = "x\n".repeat(3000) + "ünïcödé 日本語";

const CASES: Record<string, readonly [unknown, string, string]> = {
	saved: [SAVED, ORIGINAL, REDUCED],
	rich: [RICH, RICH_ORIGINAL, RICH_REDUCED],
	"held-out": [{ ...RICH, holdout: true }, RICH_ORIGINAL, RICH_REDUCED],
	gated: [{ ...SAVED, gated: true, savedTokens: -5, outChars: 60_000 }, ORIGINAL, REDUCED],
	"multi-window": [MULTI, RICH_ORIGINAL.split("\n").slice(0, 7).join("\n"), RICH_REDUCED],
	"no-request-big": [
		{ ...SAVED, request: undefined, original: { ...SAVED.original, lines: 3001, kept: [[1, 10]] } },
		BIG,
		"x",
	],
};

const action = (act: string) => (d: Driver) => void d.emit({ type: "action", key: "", act, mods: [] });

panelSuite({
	dir: "overlays/spotlight-sheet",
	mount(caseName) {
		const [spotlight, original, reduced] = CASES[caseName]!;
		return {
			view: () => (
				<SpotlightSheet spotlight={spotlight as never} original={original} reduced={reduced} onClose={() => {}} />
			),
			steps: {
				"params toggle": action("params"),
				"params toggle back": action("params"),
				"close action": action("close"),
				"other event": d => void d.emit({ type: "select", key: "", item: "x" }),
			},
		};
	},
});
