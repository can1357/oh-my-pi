/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The host the advisor-config corpus was captured with, rebuilt for the pi-tui
 * overlay, and each case's steps by label.
 */
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createRoot, type Signal, signal, type UiEvent, type UiNode } from "@oh-my-pi/pi-tui";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import type { WatchdogConfigDoc } from "../../../src/advisor/advisor-config-types";
import {
	AdvisorConfigOverlay,
	type AdvisorConfigCallbacks,
	type AdvisorConfigDeps,
	type AdvisorConfigStat,
} from "../../../src/ui/overlays/advisor-config";

const mk = (id: string, provider: string, reasoning = false) =>
	buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://x",
		reasoning,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
const models = [
	mk("claude-sonnet-4-5", "anthropic", true),
	mk("claude-haiku", "anthropic"),
	mk("llama-3.1-70b", "ollama"),
];

const later = CORPUS_NOW + 3 * 3600_000 + 30_000;
const reports = [
	{
		provider: "anthropic",
		fetchedAt: CORPUS_NOW,
		limits: [
			{
				id: "a",
				label: "work",
				scope: { provider: "anthropic", windowId: "5h" },
				window: { id: "5h", label: "5h window", resetsAt: later },
				amount: { usedFraction: 0.42, unit: "percent" },
			},
			{
				id: "b",
				label: "",
				scope: { provider: "anthropic", windowId: "7d" },
				window: { id: "7d", label: "Weekly" },
				amount: { used: 9, limit: 10, unit: "requests" },
			},
		],
	},
] as UsageReport[];

const mainDoc = (): WatchdogConfigDoc => ({
	instructions: "Shared baseline: be terse.\nSecond line.",
	advisors: [
		{
			name: "Architect",
			model: "anthropic/claude-sonnet-4-5:high",
			tools: ["read", "lsp"],
			instructions:
				"Watch the architecture. Flag layering violations, cyclic imports and hidden global state; prefer boring designs — 日本語のテキストも折り返す。",
			reviewMode: "agent-end",
			reviewInterval: 3,
		},
		{
			name: "A very long advisor name that keeps going and going ✨",
			enabled: false,
			tools: [],
			syncBacklog: "strict",
		},
	],
	warnings: ['/repo/WATCHDOG.yml: advisor "\x1b[31mBad\tName\x1b[0m" dropped — boom'],
});

const userDoc = (): WatchdogConfigDoc => ({
	advisors: [{ name: "User advisor", model: "ollama/llama-3.1-70b" }],
	warnings: ["~/.omp/WATCHDOG.yml: advisor x dropped — no model"],
});

/** A built overlay plus the fixture knobs steps turn. */
export interface AdvisorFixture {
	readonly root: UiNode;
	/** The live stats' input-token count (the "live stats change" step bumps it). */
	readonly statTokens: Signal<number>;
}

interface CaseOptions {
	readonly doc: () => WatchdogConfigDoc;
	readonly withData: boolean;
	readonly deps?: Partial<AdvisorConfigDeps>;
}

const CASES: Record<string, CaseOptions> = {
	roster: { doc: mainDoc, withData: true },
	"detail-editors": { doc: mainDoc, withData: true },
	"model-thinking": { doc: mainDoc, withData: true },
	"native-prefs": { doc: mainDoc, withData: true },
	"scope-switch-dirty": { doc: mainDoc, withData: false },
	"empty-seeded": {
		doc: () => ({ advisors: [] }),
		withData: false,
		deps: { defaultModelLabel: undefined, syncBacklog: undefined },
	},
};

/**
 * The live stats' input tokens when a case starts: the builder's counter is
 * module state, so the roster's "live stats change" carried into every case
 * recorded after it (roster dark, roster light, then the rest).
 */
function initialTokens(caseName: string, theme: string): number {
	if (caseName !== "roster") return 3200;
	return theme === "dark" ? 1200 : 2200;
}

export function buildAdvisorConfig(
	caseName: string,
	theme: string,
	effects?: Partial<AdvisorConfigCallbacks>,
): AdvisorFixture {
	const options = CASES[caseName];
	if (!options) throw new Error(`unknown case ${caseName}`);
	const statTokens = signal(initialTokens(caseName, theme));
	const stats = (): AdvisorConfigStat[] => [
		{
			name: "Architect",
			sessionId: "s1",
			status: "running",
			model: { provider: "anthropic" },
			tokens: { input: statTokens(), output: 340, cacheRead: 50 },
			cost: 0.0123,
			contextWindow: 200_000,
			contextTokens: 12_345,
		},
		{
			name: "default",
			status: "idle",
			tokens: { input: 1, output: 1, cacheRead: 0 },
			cost: 0,
			contextWindow: 0,
			contextTokens: 0,
		},
	];
	const deps: AdvisorConfigDeps = {
		getAvailableModels: () => models,
		mruOrder: ["anthropic/claude-haiku"],
		defaultToolNames: new Set(["read", "grep", "glob"]),
		availableToolNames: ["read", "grep", "glob", "lsp", "web_search"],
		syncBacklog: "3",
		defaultModelLabel: "anthropic/claude-haiku",
		...options.deps,
	};
	const callbacks: AdvisorConfigCallbacks = {
		loadDoc: async () => userDoc(),
		save: async () => {},
		close: () => {},
		notify: () => {},
		warn: () => {},
		...(options.withData
			? {
					stats,
					getUsageReports: async () => reports,
					getQuotaLimitFilter: () => (_report, limit) => limit.id !== "zzz",
				}
			: {}),
		...effects,
	};
	const root = createRoot(
		() =>
			(
				<AdvisorConfigOverlay
					deps={deps}
					scope="project"
					doc={options.doc()}
					callbacks={callbacks}
					now={() => CORPUS_NOW}
				/>
			) as UiNode,
	);
	return { root, statTokens };
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";
const SGR = {
	press: (col: number, row: number) => `\x1b[<0;${col};${row}M`,
	release: (col: number, row: number) => `\x1b[<0;${col};${row}m`,
	motion: (col: number, row: number) => `\x1b[<35;${col};${row}M`,
	wheelDown: (col: number, row: number) => `\x1b[<65;${col};${row}M`,
	wheelUp: (col: number, row: number) => `\x1b[<64;${col};${row}M`,
};

/** What one recorded step does. */
export type Step =
	| { readonly keys: readonly string[] }
	| { readonly event: UiEvent }
	/** An event of the editor's picker sheet (the prefs node's picker child). */
	| { readonly picker: UiEvent }
	| { readonly paste: string }
	| { readonly flush: true }
	| { readonly tick: true }
	| { readonly none: true };

const keys = (...k: string[]): Step => ({ keys: k });
const ev = (event: Record<string, unknown>): Step => ({ event: { key: "", ...event } as UiEvent });
const focus = (item: string): Step => ev({ type: "select", item });
const action = (act: string, value?: string): Step => ev({ type: "action", act, value, mods: [] });
const change = (item: string, value: unknown): Step => ev({ type: "change", item, value });
const picker = (event: Record<string, unknown>): Step => ({ picker: { key: "", ...event } as UiEvent });
const FLUSH: Step = { flush: true };
const NONE: Step = { none: true };

/** Steps by stage label, per case (labels repeat only with the same step). */
export const STEPS: Record<string, Record<string, Step>> = {
	roster: {
		"await reports": FLUSH,
		"down advisor 1": keys(DOWN),
		"down add": keys(DOWN),
		"down shared": keys(DOWN),
		"down scope": keys(DOWN),
		"down save": keys(DOWN),
		"down close": keys(DOWN),
		wrap: keys(DOWN, UP, UP, UP, UP, UP, UP),
		"live stats change": { tick: true },
		"render 100": NONE,
		"wheel preview": keys(SGR.wheelDown(90, 4), SGR.wheelDown(90, 4), SGR.wheelDown(90, 4)),
		"wheel back": keys(SGR.wheelUp(90, 4)),
		"motion sidebar": keys(SGR.motion(5, 3)),
		"press outside": keys(SGR.press(5, 1), SGR.press(5, 40)),
		"click advisor 1": keys(SGR.press(5, 3), SGR.release(5, 3)),
		back: keys(ESC),
		"paste ignored": { paste: "ignored" },
		nativeSheet: NONE,
	},
	"detail-editors": {
		"await reports": FLUSH,
		"open detail": keys(ENTER),
		"detail nav": keys(DOWN, DOWN, UP, UP),
		"name editor": keys(ENTER),
		type: keys("X", "é", "\x7f", "\x1b[D"),
		"submit name": keys(ENTER),
		"focus name": focus("name"),
		"name editor esc": keys(ENTER, "Q", ESC),
		"focus toggleEnabled": focus("toggleEnabled"),
		toggle: keys(ENTER),
		"toggle back": keys(ENTER),
		"focus reviewMode": focus("reviewMode"),
		"review picker": keys(ENTER),
		"pick turn": keys(DOWN, UP, ENTER),
		"review picker esc": keys(ENTER, DOWN, ESC),
		"focus reviewInterval": focus("reviewInterval"),
		"interval editor": keys(ENTER),
		"bad interval": keys("x", ENTER),
		"good interval": keys("\x7f", "\x7f", "7", ENTER),
		"interval esc": keys(ENTER, "9", ESC),
		"focus syncBacklog": focus("syncBacklog"),
		"sync picker": keys(ENTER, DOWN, DOWN),
		"pick sync": keys(ENTER),
		"sync picker esc": keys(ENTER, UP, ESC),
		"focus tools": focus("tools"),
		"tools editor": keys(ENTER),
		"toggle tools": keys(ENTER, DOWN, DOWN, DOWN, ENTER),
		"tools wheel": keys(SGR.wheelDown(5, 3)),
		"tools click": keys(SGR.press(5, 4), SGR.release(5, 4)),
		"tools done": keys(DOWN, DOWN, DOWN, DOWN, DOWN, ENTER),
		"tools reopen": keys(ENTER, ENTER),
		"tools esc apply": keys(ESC),
		"focus resetModel": focus("resetModel"),
		"reset model": keys(ENTER),
		"focus instructions": focus("instructions"),
		"instructions editor": keys(ENTER),
		"type instr": keys("a", "b", "\r", "c"),
		paste: { paste: "pasted ✓ text" },
		"instr cancel": keys(ESC),
		"instructions again": keys(ENTER, "z", "\x11"),
		"focus back": focus("back"),
		"back to list": keys(ENTER),
		"shared instr": keys(DOWN, DOWN, DOWN, ENTER),
		"shared type": keys("q", "\x11"),
		"to save": keys(DOWN, DOWN, DOWN, DOWN, DOWN),
		save: keys(ENTER),
		"await save": FLUSH,
	},
	"model-thinking": {
		"open detail": keys(ENTER),
		"focus model": focus("model"),
		"model picker": keys(ENTER),
		search: keys("c", "l"),
		nav: keys(DOWN, UP),
		"clear search": keys(ESC),
		"cancel picker": keys(ESC),
		"model picker again": keys(ENTER),
		pick: keys(ENTER),
		"thinking nav": keys(DOWN, DOWN),
		"thinking back": keys(ESC),
		"pick again": keys(ENTER),
		"thinking pick": keys(DOWN, ENTER),
		"model picker 3": keys(ENTER, DOWN, DOWN),
		"pick non-reasoning": keys(ENTER),
	},
	"native-prefs": {
		"await reports": FLUSH,
		"action page:advisor:1": action("page", "advisor:1"),
		"change toggleEnabled=true": change("toggleEnabled", true),
		'change name="  Renamed  "': change("name", "  Renamed  "),
		'change name="   "': change("name", "   "),
		'change reviewMode="agent-end"': change("reviewMode", "agent-end"),
		'change reviewMode="bogus"': change("reviewMode", "bogus"),
		"change reviewMode=null": change("reviewMode", null),
		"change reviewInterval=4": change("reviewInterval", 4),
		"change reviewInterval=0": change("reviewInterval", 0),
		"change reviewInterval=null": change("reviewInterval", null),
		'change syncBacklog="5"': change("syncBacklog", "5"),
		'change syncBacklog="inherit"': change("syncBacklog", "inherit"),
		'change tools=["grep","web_search"]': change("tools", ["grep", "web_search"]),
		'change tools=["read","grep","glob"]': change("tools", ["read", "grep", "glob"]),
		"change tools=[]": change("tools", []),
		"focus name": focus("name"),
		"activate name": ev({ type: "activate", item: "name" }),
		"type draft": action("noop"),
		draft: keys("Z"),
		"action close:name": action("close", "name"),
		"action edit:reviewInterval": action("edit", "reviewInterval"),
		"interval type": keys("\x7f", "9"),
		"action field-cancel": action("field-cancel"),
		"action field-save": action("field-save"),
		"activate syncBacklog": ev({ type: "activate", item: "syncBacklog" }),
		"picker select strict": picker({ type: "select", item: "strict" }),
		"picker confirm": picker({ type: "action", act: "confirm", mods: [] }),
		"activate reviewMode": ev({ type: "activate", item: "reviewMode" }),
		"picker activate agent-end": picker({ type: "activate", item: "agent-end" }),
		"activate tools": ev({ type: "activate", item: "tools" }),
		"picker toggle lsp": picker({ type: "activate", item: "lsp" }),
		"picker apply": picker({ type: "action", act: "apply", mods: [] }),
		"activate model": ev({ type: "activate", item: "model" }),
		"picker select model": picker({ type: "select", item: "anthropic/claude-haiku" }),
		"picker close": picker({ type: "action", act: "close", mods: [] }),
		"activate model 2": ev({ type: "activate", item: "model" }),
		"picker use": picker({ type: "action", act: "use", mods: [] }),
		"activate instructions": ev({ type: "activate", item: "instructions" }),
		"action close:instructions": action("close", "instructions"),
		"action page:shared": action("page", "shared"),
		"action close:shared": action("close", "shared"),
		"activate shared": ev({ type: "activate", item: "shared" }),
		esc: keys(ESC),
		"action page:advisor:0": action("page", "advisor:0"),
		"action edit:shared": action("edit", "shared"),
		esc2: keys(ESC),
		"other key ignored": { event: { type: "change", key: "x/y", item: "name", value: "nope" } as UiEvent },
		"toggle ignored": { event: { type: "toggle", key: "", collapsed: true } },
		"action add": action("add"),
		'change name="Added"': change("name", "Added"),
		"action delete:delete": action("delete", "delete"),
		"action page:advisor:9": action("page", "advisor:9"),
		"action save": action("save"),
		"await save": FLUSH,
		"action scope": action("scope"),
		"await scope": FLUSH,
		"action close": action("close"),
	},
	"scope-switch-dirty": {
		"to add": keys(DOWN, DOWN),
		"add advisor": keys(ENTER),
		back: keys(ESC),
		"to scope": keys(DOWN, DOWN, DOWN, DOWN, DOWN),
		"scope (dirty)": keys(ENTER),
		await: FLUSH,
		"to save": keys(DOWN),
		save: keys(ENTER),
		"await save": FLUSH,
		"to scope 2": keys(DOWN, DOWN, DOWN, DOWN, DOWN),
		scope: keys(ENTER),
		"await scope": FLUSH,
		delete: keys(ENTER),
		"focus delete": focus("delete"),
		"delete it": keys(ENTER),
		"close row": keys(UP, ENTER),
	},
	"empty-seeded": {
		down: keys(DOWN),
		"shared none": keys(DOWN, DOWN),
		"open default": keys(UP, UP, UP, ENTER),
		"focus name": focus("name"),
		"name empty submit": keys(ENTER, "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", ENTER),
		back: keys(ESC),
		"click outside height": keys(SGR.press(3, 200)),
	},
};
