import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { ResourceAnalysis } from "@oh-my-pi/pi-coding-agent/extensibility/resource-analysis";
import type {
	SkillAnalysisCandidate,
	SkillAnalysisStatus,
	SkillDiagnosticAnalysisRecord,
	SkillDiagnosticController,
	SkillDiagnosticItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/skill-diagnostic-controller";
import type { SkillDiagnosticEntry } from "@oh-my-pi/pi-coding-agent/extensibility/skill-diagnostics";
import {
	SkillDiagnosticsPanel,
	type SkillDiagnosticsPanelResult,
} from "@oh-my-pi/pi-coding-agent/modes/components/skill-diagnostics-panel";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

// The real panel on a real TUI and terminal, driven by keys. The controller is a recording double whose
// billing and writing methods fail the test if the panel ever calls them: the panel may only read items,
// subscribe and cancel running work; everything else must come back to its host as a typed result.
const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	pageDown: "\x1b[6~",
	home: "\x1b[H",
	end: "\x1b[F",
	tab: "\t",
	enter: "\r",
	escape: "\x1b",
} as const;

const entry = (name: string, filePath: string, extra: Partial<SkillDiagnosticEntry> = {}): SkillDiagnosticEntry => ({
	name,
	filePath,
	source: "custom:user",
	...extra,
});

const candidate = (id: string, root: string, extra: Partial<SkillAnalysisCandidate> = {}): SkillAnalysisCandidate => ({
	id,
	name: "review",
	filePath: `${root}/SKILL.md`,
	root,
	fingerprint: "f".repeat(64),
	complete: true,
	files: 1,
	omissions: [],
	...extra,
});

const advice: ResourceAnalysis = {
	relationship: "overlap",
	evidence: [
		{ candidateId: "skill-1", file: "SKILL.md", quote: "description: Review code", explanation: "same purpose" },
	],
	differences: ["the second adds checklists"],
	recommendation: { action: "prefer", preferredId: "skill-1", reason: "the first is a superset" },
	limitations: [],
};

const record = (
	status: SkillAnalysisStatus,
	extra: Partial<SkillDiagnosticAnalysisRecord> = {},
): SkillDiagnosticAnalysisRecord => ({
	id: "plan-1",
	name: "review",
	status,
	model: "anthropic/claude-test",
	bytes: 2048,
	candidates: [candidate("skill-1", "/skills/a/review"), candidate("skill-2", "/skills/b/review")],
	disclosure: "Files are treated as data.",
	createdAt: 1_700_000_000_000,
	applied: false,
	...extra,
});

const group = (name: string, extra: Partial<SkillDiagnosticItem> = {}): SkillDiagnosticItem => ({
	name,
	issues: ["conflict"],
	skills: [entry(name, `/skills/a/${name}/SKILL.md`), entry(`b/${name}`, `/skills/b/${name}/SKILL.md`)],
	duplicates: [],
	reason: "source-order",
	canAnalyze: true,
	...extra,
});

const lone = (name: string): SkillDiagnosticItem => ({
	name,
	issues: ["missing-provenance"],
	skills: [entry(name, `/skills/solo/${name}/SKILL.md`)],
	duplicates: [],
	canAnalyze: false,
	unavailableReason: "Only one loaded copy is available; relationship analysis needs comparable variants.",
});

const cx: DescribeContext = { cols: 140, reduceMotion: false, dark: true, supports: () => true, feature: () => false };

/** The described node keyed `key` and its key path, which is the `key` its native events carry. */
function findKeyed(root: NativeNode, key: string): { node: NativeNode; path: string } | undefined {
	const walk = (described: NativeNode, path: string[]): { node: NativeNode; path: string } | undefined => {
		const children: readonly NativeChild[] = described.c ?? [];
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if (!child || !("k" in child)) continue;
			const childPath = [...path, child.key ?? String(i)];
			if (child.key === key) return { node: child, path: childPath.join("/") };
			const found = walk(child, childPath);
			if (found) return found;
		}
		return undefined;
	};
	return walk(root, []);
}

function mustFind(root: NativeNode, key: string): { node: NativeNode; path: string } {
	const found = findKeyed(root, key);
	if (!found) throw new Error(`no described node keyed ${key}`);
	return found;
}

/** The actions the described action bar offers, in bar order. */
function offered(root: NativeNode): string[] {
	const acts: string[] = [];
	const walk = (described: NativeNode): void => {
		if (described.k === "row" && described.p?.role === "omp.btn" && described.p.actions?.click) {
			acts.push(described.p.actions.click);
		}
		for (const child of described.c ?? []) if ("k" in child) walk(child);
	};
	walk(root);
	return acts;
}

/** A real panel on a real TUI and virtual terminal, with the recording controller double behind it. */
interface View {
	readonly panel: SkillDiagnosticsPanel;
	readonly calls: string[];
	readonly results: SkillDiagnosticsPanelResult[];
	readonly listeners: Set<() => void>;
	describe(): NativeNode;
	native(event: NativeUiEvent): Promise<void>;
	screen(): string;
	press(data: string): Promise<void>;
	change(next: SkillDiagnosticItem[]): Promise<void>;
}

describe("skill diagnostics panel", () => {
	const opened: { tui: TUI; panel: SkillDiagnosticsPanel }[] = [];

	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		for (const { tui, panel } of opened.splice(0)) {
			panel.dispose();
			tui.stop();
		}
	});

	async function open(initial: SkillDiagnosticItem[], size: { columns?: number; rows?: number } = {}): Promise<View> {
		let items = initial;
		const listeners = new Set<() => void>();
		const calls: string[] = [];
		const results: SkillDiagnosticsPanelResult[] = [];
		const controller = {
			items: () => items,
			subscribe: (listener: () => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			cancel: (id: string) => {
				calls.push(`cancel:${id}`);
				return record("cancelled", { id });
			},
			prepare: () => {
				throw new Error("the panel must not prepare an analysis");
			},
			start: () => {
				throw new Error("the panel must not start an analysis");
			},
			apply: () => {
				throw new Error("the panel must not apply a recommendation");
			},
		} as unknown as SkillDiagnosticController;
		const term = new VirtualTerminal(size.columns ?? 140, size.rows ?? 40);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const panel = new SkillDiagnosticsPanel(tui, controller, { done: result => results.push(result) });
		opened.push({ tui, panel });
		tui.addChild(panel);
		tui.setFocus(panel);
		tui.start();
		await scheduler.drain(term);
		const screen = () =>
			term
				.getViewport()
				.map(row => Bun.stripANSI(row))
				.join("\n");
		return {
			panel,
			calls,
			results,
			listeners,
			describe: () => panel.describe(cx),
			/** A native terminal event, as it would arrive from the described surface. */
			async native(event: NativeUiEvent): Promise<void> {
				panel.handleNativeEvent(event);
				await scheduler.drain(term);
			},
			screen,
			/** Type one key, as the terminal would deliver it. */
			async press(data: string): Promise<void> {
				term.sendInput(data);
				await scheduler.drain(term);
			},
			/** The controller changed state, as a background analysis or an RPC client would cause. */
			async change(next: SkillDiagnosticItem[]): Promise<void> {
				items = next;
				for (const listener of listeners) listener();
				await scheduler.drain(term);
			},
		};
	}

	it("draws names, paths, provenance and model text without letting them act as terminal controls", async () => {
		const hostile = "\x1b]0;spoofed title\x07design\nINJECTED\r\t";
		const view = await open([
			group(hostile, {
				skills: [
					entry(hostile, `/skills/\x1b[2Jwipe/${hostile}/SKILL.md`, {
						pluginName: hostile,
						repository: hostile,
						version: hostile,
					}),
					entry(`fork/${hostile}`, "/skills/fork/SKILL.md"),
				],
				analysis: record("complete", {
					model: hostile,
					result: {
						...advice,
						evidence: [{ candidateId: "skill-1", file: hostile, quote: hostile, explanation: hostile }],
						differences: [hostile],
						limitations: [hostile],
						recommendation: { action: "keep-all", reason: hostile },
					},
				}),
				lastAnalysis: record("failed", { id: "old", error: hostile }),
			}),
		]);
		const rows = view.panel.render(140).map(row => row.replace(/\x1b\[[0-9;:]*m/g, ""));
		for (const row of rows) expect(row).not.toMatch(/[\x1b\x07\r\t]/);
		const text = rows.join("\n");
		expect(text).toContain("design INJECTED");
		expect(text).not.toContain("spoofed title");
		expect(text).not.toContain("[2J");
		expect(view.screen()).toContain("design INJECTED");
	});

	it("selects rows with the keys and scrolls the inspector only when it has focus, never asking for work", async () => {
		const review = group("review", {
			skills: [
				entry("review", "/skills/a/review/SKILL.md"),
				...Array.from({ length: 5 }, (_, index) =>
					entry(`fork-${index}/review`, `/skills/fork-${index}/review/SKILL.md`),
				),
			],
		});
		const view = await open([review, group("testing"), lone("solo")], { rows: 24 });
		expect(view.screen()).toContain("/skills/a/review/SKILL.md");

		await view.press(KEYS.down);
		expect(view.screen()).toContain("/skills/a/testing/SKILL.md");
		expect(view.screen()).not.toContain("/skills/a/review/SKILL.md");

		await view.press(KEYS.end);
		expect(view.screen()).toContain("Unavailable:");
		expect(view.screen()).toContain("Only one loaded copy");
		await view.press(KEYS.up);
		await view.press(KEYS.home);
		expect(view.screen()).toContain("/skills/a/review/SKILL.md");
		await view.press(KEYS.pageDown);
		expect(view.screen()).toContain("Unavailable:");
		await view.press(KEYS.home);

		// The inspector overflows this short terminal: Tab moves focus to it and Down/End scroll it in place.
		expect(view.screen()).not.toContain("skill://<name>");
		await view.press(KEYS.tab);
		await view.press(KEYS.end);
		expect(view.screen()).toContain("skill://<name>");
		await view.press(KEYS.tab);
		await view.press(KEYS.down);
		expect(view.screen()).toContain("/skills/a/testing/SKILL.md");

		expect(view.calls).toEqual([]);
		expect(view.results).toEqual([]);
	});

	it("Enter returns a typed request only for comparable rows; a lone copy says why and nothing is requested", async () => {
		const first = await open([group("review"), lone("solo")]);
		await first.press(KEYS.down);
		await first.press(KEYS.enter);
		expect(first.screen()).toContain("Nothing to analyze");
		expect(first.results).toEqual([]);
		await first.press(KEYS.up);
		await first.press(KEYS.enter);
		expect(first.results).toEqual([{ action: "analyze", selected: "review", prepared: undefined }]);
		// A closed panel ignores further keys.
		await first.press(KEYS.enter);
		await first.press(KEYS.escape);
		expect(first.results).toHaveLength(1);
		expect(first.calls).toEqual([]);
	});

	it("Esc closes with the selected row so the host can reopen on it", async () => {
		const view = await open([group("review"), group("testing")]);
		await view.press(KEYS.down);
		await view.press(KEYS.escape);
		expect(view.results).toEqual([{ action: "close", selected: "testing" }]);
	});

	it("hands an already prepared plan to the host as is, and refuses to restart a running one", async () => {
		const prepared = record("prepared");
		const first = await open([group("review", { analysis: prepared })]);
		await first.press(KEYS.enter);
		expect(first.results).toEqual([{ action: "analyze", selected: "review", prepared }]);

		const second = await open([group("review", { analysis: record("running") })]);
		await second.press(KEYS.enter);
		expect(second.results).toEqual([]);
		expect(second.screen()).toContain("already running");
		expect(second.calls).toEqual([]);
	});

	it("C cancels only a running analysis", async () => {
		const idle = await open([group("review")]);
		await idle.press("c");
		expect(idle.screen()).toContain("No analysis is running");
		expect(idle.calls).toEqual([]);

		const running = await open([group("review", { analysis: record("running") })]);
		expect(running.screen()).toContain("Sending the listed files to anthropic/claude-test");
		await running.press("c");
		expect(running.calls).toEqual(["cancel:plan-1"]);
		expect(running.screen()).toContain("Analysis cancelled.");
		expect(running.results).toEqual([]);
	});

	it("A returns the current completed recommendation and explains every case where it is not offered", async () => {
		const ready = record("complete", { result: advice });
		const offered = await open([group("review", { analysis: ready })]);
		expect(offered.screen()).toContain("Relationship: overlap");
		expect(offered.screen()).toContain("Reason (model-generated): the first is a superset");
		await offered.press("a");
		expect(offered.results).toEqual([{ action: "apply", selected: "review", record: ready }]);

		const partial = await open([
			group("review", {
				analysis: record("complete", {
					result: advice,
					candidates: [
						candidate("skill-1", "/skills/a/review"),
						candidate("skill-2", "/skills/b/review", { complete: false, omissions: ["links are skipped"] }),
					],
				}),
			}),
		]);
		expect(partial.screen()).toContain("PARTIAL");
		await partial.press("a");
		expect(partial.screen()).toContain("Coverage was incomplete");
		expect(partial.results).toEqual([]);

		const keepAll = await open([
			group("review", {
				analysis: record("complete", {
					result: { ...advice, recommendation: { action: "keep-all", reason: "they differ" } },
				}),
			}),
		]);
		await keepAll.press("a");
		expect(keepAll.screen()).toContain("keeping every copy");
		expect(keepAll.results).toEqual([]);

		const none = await open([group("review")]);
		await none.press("a");
		expect(none.screen()).toContain("Nothing to apply");
		expect(none.results).toEqual([]);
	});

	it("keeps a superseded result viewable but never offers to apply it", async () => {
		const view = await open([
			group("review", {
				analysis: record("cancelled", { id: "plan-2" }),
				lastAnalysis: record("complete", { result: advice }),
			}),
		]);
		expect(view.screen()).toContain("Current: cancelled");
		expect(view.screen()).toContain("Previous result: analyzed");
		expect(view.screen()).toContain("Relationship: overlap");
		await view.press("a");
		expect(view.screen()).toContain("Nothing to apply");
		expect(view.results).toEqual([]);
	});

	it("shows model failures next to the issues instead of hiding them", async () => {
		const view = await open([
			group("review", { analysis: record("failed", { error: "provider rejected the request" }) }),
		]);
		expect(view.screen()).toContain("Error: provider rejected the request");
		expect(view.screen()).toContain("failed");
		expect(view.screen()).toContain("Conflict:");
	});

	it("explains defaults, namespaced variants, redundant copies and declared origins from the controller's rows", async () => {
		const plugin = (name: string, filePath: string, repository: string, version: string): SkillDiagnosticEntry =>
			entry(name, filePath, { source: "omp-plugins:user", repository, version });
		const kept = plugin("review", "/plugins/new/SKILL.md", "github.com/acme/tools", "2.0.0");
		const view = await open(
			[
				group("testing", {
					reason: "custom-directory",
					skills: [
						entry("first/testing", "/skill-store/first/SKILL.md"),
						entry("second/testing", "/skill-store/second/SKILL.md"),
					],
				}),
				group("review", {
					issues: ["redundancy"],
					skills: [kept],
					duplicates: [
						{
							skill: plugin("review", "/plugins/old/SKILL.md", "github.com/acme/tools", "1.0.0"),
							retained: kept,
							match: "origin",
						},
						{ skill: entry("review", "/skill-store/mirror/SKILL.md"), retained: kept, match: "content" },
					],
				}),
				group("brainstorm", {
					skills: [
						plugin("brainstorm", "/plugins/upstream/SKILL.md", "github.com/acme/tools", "2.0.0"),
						plugin("fork/brainstorm", "/plugins/fork/SKILL.md", "github.com/acme/tools", "1.9.0"),
						plugin("other/brainstorm", "/plugins/other/SKILL.md", "github.com/else/kit", "1.0.0"),
					],
				}),
			],
			{ rows: 60, columns: 180 },
		);
		const testing = view.screen();
		expect(testing).toMatch(/Selection:.*[Cc]ustom directory/);
		expect(testing).toContain("No bare default");
		expect(testing).toContain("Variant: first/testing");
		expect(testing).toContain("Variant: second/testing");
		expect(testing).not.toContain("Default: testing");

		await view.press(KEYS.down);
		const review = view.screen();
		expect(review).toContain("Same-origin variant: review");
		expect(review).toContain("Hidden in favor of: review (/plugins/new/SKILL.md)");
		expect(review).toContain("Redundant copy: review");
		expect(review).toContain("Identical to: review (/plugins/new/SKILL.md)");
		expect(review).toContain("Origin: github.com/acme/tools 2.0.0");

		await view.press(KEYS.down);
		const brainstorm = view.screen();
		expect(brainstorm).toContain("Origin: github.com/acme/tools 2.0.0");
		expect(brainstorm).toContain("Origin: github.com/acme/tools 1.9.0");
		// Only the variant sharing the default's origin is flagged as hideable.
		expect(brainstorm.match(/skills\.dedupeSameOrigin would hide/g)).toHaveLength(1);
		expect(brainstorm).toMatch(/Variant: fork\/brainstorm[\s\S]*would hide[\s\S]*Variant: other\/brainstorm/);
	});

	it("redraws from controller updates, keeps the selection by name, and stops listening once disposed", async () => {
		const view = await open([group("alpha"), group("beta"), lone("solo")]);
		await view.press(KEYS.down);
		expect(view.screen()).toContain("/skills/a/beta/SKILL.md");

		await view.change([
			group("alpha"),
			group("beta", { analysis: record("running", { name: "beta" }) }),
			lone("solo"),
		]);
		expect(view.screen()).toContain("analyzing");
		expect(view.screen()).toContain("Sending the listed files");

		await view.change([
			group("alpha"),
			group("aardvark"),
			group("beta", {
				analysis: record("complete", { name: "beta", result: advice }),
			}),
			lone("solo"),
		]);
		expect(view.screen()).toContain("Relationship: overlap");
		expect(view.screen()).toContain("/skills/a/beta/SKILL.md");

		await view.change([group("alpha"), lone("solo")]);
		expect(view.screen()).toContain("Unavailable:");

		expect(view.listeners.size).toBe(1);
		view.panel.dispose();
		expect(view.listeners.size).toBe(0);
		expect(view.calls).toEqual([]);
	});

	it("says so when no skills are loaded and ignores the action keys", async () => {
		const view = await open([]);
		expect(view.screen()).toContain("No skills are loaded");
		for (const key of [KEYS.enter, "a", "c", KEYS.down, KEYS.tab, KEYS.end]) await view.press(key);
		expect(view.results).toEqual([]);
		expect(view.calls).toEqual([]);
	});

	// The native surface: the panel's description and the events a native terminal sends back. These pin what the
	// bar offers and what each event requests, not the layout; no native terminal runtime is exercised here.
	const rowEvent = (view: View, type: "select" | "activate", item: string): NativeUiEvent => ({
		type,
		key: mustFind(view.describe(), "skills").path,
		item,
	});

	/** A click on the bar's button; a button the bar does not offer is still delivered, as a late event would be. */
	const action = (view: View, act: string): NativeUiEvent => ({
		type: "action",
		key: findKeyed(view.describe(), act)?.path ?? act,
		act,
		mods: [],
	});

	const selectedRow = (view: View): string | null | undefined => {
		const { node } = mustFind(view.describe(), "skills");
		if (node.k !== "list") throw new Error(`expected the sidebar list, got ${node.k}`);
		return node.p?.selected;
	};

	it("native select moves the selection and activate requests analysis of the activated row only", async () => {
		const view = await open([group("review"), group("testing"), lone("solo")]);
		expect(selectedRow(view)).toBe("review");
		await view.native(rowEvent(view, "select", "testing"));
		expect(selectedRow(view)).toBe("testing");
		await view.native(rowEvent(view, "select", "missing"));
		expect(selectedRow(view)).toBe("testing");
		expect(view.results).toEqual([]);

		// A lone copy is selected but requests nothing.
		await view.native(rowEvent(view, "activate", "solo"));
		expect(selectedRow(view)).toBe("solo");
		expect(view.results).toEqual([]);

		await view.native(rowEvent(view, "activate", "review"));
		expect(view.results).toEqual([{ action: "analyze", selected: "review", prepared: undefined }]);

		// A closed panel ignores further native events.
		await view.native(rowEvent(view, "select", "testing"));
		await view.native(action(view, "analyze"));
		expect(selectedRow(view)).toBe("review");
		expect(view.results).toHaveLength(1);
		expect(view.calls).toEqual([]);
	});

	it("offers analyze, apply and cancel in the native action bar only where they can act", async () => {
		const reloadFailed = record("applied", { applied: true, result: advice, error: "reload failed" });
		const cases: [string, SkillDiagnosticItem, string[]][] = [
			["nothing analyzed", group("review"), ["analyze", "close"]],
			["lone copy", lone("solo"), ["close"]],
			["running", group("review", { analysis: record("running") }), ["cancel", "close"]],
			[
				"apply-ready",
				group("review", { analysis: record("complete", { result: advice }) }),
				["analyze", "apply", "close"],
			],
			[
				"keep all",
				group("review", {
					analysis: record("complete", {
						result: { ...advice, recommendation: { action: "keep-all", reason: "they differ" } },
					}),
				}),
				["analyze", "close"],
			],
			[
				"superseded result",
				group("review", {
					analysis: record("cancelled", { id: "plan-2" }),
					lastAnalysis: record("complete", { result: advice }),
				}),
				["analyze", "close"],
			],
			[
				"applied",
				group("review", { analysis: record("applied", { applied: true, result: advice }) }),
				["analyze", "close"],
			],
			["applied but reload failed", group("review", { analysis: reloadFailed }), ["analyze", "apply", "close"]],
		];
		for (const [label, item, expected] of cases) {
			const view = await open([item]);
			expect({ label, acts: offered(view.describe()) }).toEqual({ label, acts: expected });
		}
	});

	it("native actions request analysis, apply and cancel as the keys do, and refuse them when not offered", async () => {
		const idle = await open([group("review")]);
		await idle.native(action(idle, "apply"));
		await idle.native(action(idle, "cancel"));
		expect(idle.results).toEqual([]);
		expect(idle.calls).toEqual([]);
		await idle.native(action(idle, "analyze"));
		expect(idle.results).toEqual([{ action: "analyze", selected: "review", prepared: undefined }]);

		const prepared = record("prepared");
		const handedOver = await open([group("review", { analysis: prepared })]);
		await handedOver.native(action(handedOver, "analyze"));
		expect(handedOver.results).toEqual([{ action: "analyze", selected: "review", prepared }]);

		const ready = record("complete", { result: advice });
		const applying = await open([group("review", { analysis: ready })]);
		await applying.native(action(applying, "apply"));
		expect(applying.results).toEqual([{ action: "apply", selected: "review", record: ready }]);
		expect(applying.calls).toEqual([]);

		const running = await open([group("review", { analysis: record("running") })]);
		await running.native(action(running, "analyze"));
		await running.native(action(running, "apply"));
		expect(running.results).toEqual([]);
		expect(running.calls).toEqual([]);
		await running.native(action(running, "cancel"));
		expect(running.calls).toEqual(["cancel:plan-1"]);
		expect(running.results).toEqual([]);

		const closing = await open([group("review"), group("testing")]);
		await closing.native(rowEvent(closing, "select", "testing"));
		await closing.native(action(closing, "close"));
		expect(closing.results).toEqual([{ action: "close", selected: "testing" }]);
	});

	it("native selection returns focus to the list and restarts the inspector scroll; detail focus scrolls it", async () => {
		const view = await open([group("review"), group("testing"), group("other")]);
		const detailScroll = () => mustFind(view.describe(), "detail").node.scroll;
		const initial = detailScroll();

		await view.press(KEYS.tab);
		await view.press(KEYS.end);
		const scrolled = detailScroll();
		expect(scrolled?.by).toBe("end");
		expect(scrolled?.n).toBeGreaterThan(initial?.n ?? 0);
		expect(selectedRow(view)).toBe("review");

		await view.native(rowEvent(view, "select", "testing"));
		const restarted = detailScroll();
		expect(restarted?.by).toBe("start");
		expect(restarted?.n).toBeGreaterThan(scrolled?.n ?? 0);

		// Focus is back on the list, so Down selects the next row instead of scrolling.
		await view.press(KEYS.down);
		expect(selectedRow(view)).toBe("other");
		expect(view.results).toEqual([]);
		expect(view.calls).toEqual([]);
	});

	it("A names why a running or applied result is not applied, and retries an applied one whose reload failed", async () => {
		const running = await open([group("review", { analysis: record("running") })]);
		await running.press("a");
		expect(running.screen()).toContain("is running");
		expect(running.screen()).not.toContain("analyze first");
		expect(running.results).toEqual([]);

		const applied = await open([group("review", { analysis: record("applied", { applied: true, result: advice }) })]);
		await applied.press("a");
		expect(applied.screen()).toContain("already applied");
		expect(applied.screen()).not.toContain("analyze first");
		expect(applied.results).toEqual([]);

		const reloadFailed = record("applied", { applied: true, result: advice, error: "reload failed" });
		const retry = await open([group("review", { analysis: reloadFailed })]);
		await retry.press("a");
		expect(retry.results).toEqual([{ action: "apply", selected: "review", record: reloadFailed }]);
	});
});
