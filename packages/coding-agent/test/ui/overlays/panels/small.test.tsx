/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterEach, expect, test } from "bun:test";
import { resolveChildren } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { KeybindingsManager, setKeybindings } from "../../../../src/config/keybindings/keybindings";
import type { CodexResetFireworksEvent } from "../../../../src/modes/view-model/overlays/codex-reset-fireworks";
import { BorderedLoader } from "../../../../src/ui/overlays/panels/bordered-loader";
import { CodexResetFireworks } from "../../../../src/ui/overlays/panels/codex-reset-fireworks";
import { ErrorBanner } from "../../../../src/ui/overlays/panels/error-banner";
import { StatsNotice } from "../../../../src/ui/overlays/panels/stats-notice";
import { signal } from "@oh-my-pi/pi-tui";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import type { PauseWorkStatus } from "../../../../src/modes/view-model/overlays/pause-screen";
import { isSettled, PauseScreen } from "../../../../src/ui/overlays/panels/pause-screen";
import { MoveOverlay } from "../../../../src/ui/overlays/panels/move-overlay";
import { PlanSave } from "../../../../src/ui/overlays/panels/plan-save";
import { ReportPanel } from "../../../../src/ui/overlays/panels/report-panel";
import {
	SnapcompactSamples,
	SnapcompactShapePreview,
} from "../../../../src/ui/overlays/panels/snapcompact-shape-preview";
import { type Driver, panelSuite } from "./harness";

const noop = (): void => {};
const action = (act: string) => (d: Driver) => void d.emit({ type: "action", key: "", act, mods: [] });

test("the pinned error headline uses the ASCII status mark", () => {
	const theme = loadThemeSync("dark", { symbolPreset: "ascii" });
	const [banner] = resolveChildren(<ErrorBanner message="Request timed out" />)();
	expect(paintNode(staticEnvironment(theme), banner!, 48).rows.map(stripEscapes)).toContain(" [-] Request timed out");
});

const ERROR_MESSAGES: Record<string, string> = {
	short: "Output blocked by content filtering policy",
	multi: "\n  \nfirst line\nsecond line\n\tthird with tab\nfourth\nfifth\nsixth",
	long: `${"x".repeat(90)} 日本語の長いエラーメッセージ ${"y".repeat(200)}`,
	empty: "   ",
	ansi: "\x1b[31mred error\x1b[0m and more",
};

panelSuite({
	dir: "overlays/error-banner",
	mount(caseName) {
		const dismissable = !caseName.endsWith("-no-dismiss");
		const message = ERROR_MESSAGES[caseName.replace(/-no-dismiss$/, "")]!;
		return {
			view: () => <ErrorBanner message={message} onDismiss={dismissable ? noop : undefined} />,
			steps: {
				details: action("details"),
				dismiss: action("dismiss"),
				"select ignored": d => void d.emit({ type: "select", key: "", item: "x" }),
				less: action("details"),
				"other act": action("nope"),
			},
		};
	},
});

const STATS_LONG =
	"Stats dashboard running at http://localhost:3847 — opening in your browser; a long line that wraps 日本語";

panelSuite({
	dir: "overlays/stats-notice",
	mount(caseName) {
		const [message, url] =
			caseName === "stats"
				? ["Stats at http://localhost:1", "http://localhost:1"]
				: caseName === "stats-long"
					? [STATS_LONG, "http://localhost:3847"]
					: ["", ""];
		return { view: () => <StatsNotice message={message} url={url} /> };
	},
});

panelSuite({
	dir: "overlays/bordered-loader",
	mount(caseName) {
		const message = caseName === "loader" ? "Sharing session..." : STATS_LONG;
		return { view: () => <BorderedLoader message={message} onAbort={noop} />, steps: { onAbort: noop } };
	},
});

panelSuite({
	dir: "overlays/pause-screen",
	mount(caseName) {
		const name = caseName === "named" ? "My  Awesome\tSession 日本語" : undefined;
		let now = CORPUS_NOW;
		const since = signal(now);
		const busy = caseName === "busy";
		const work = signal<PauseWorkStatus>({ unsettledTurns: busy ? 1 : 0, unfinishedJobs: 0 });
		// What the controller reports next; it polls only while work is outstanding.
		let reported = work();
		const poll = () => {
			if (!isSettled(work())) work.set(reported);
		};
		let height = 24;
		const tick = (ms: number) => (d: Driver) => d.env.setNow((now += ms));
		return {
			view: () => <PauseScreen sessionName={name} since={since} work={work} onResume={noop} />,
			height: () => height,
			steps: {
				"tick 7s": tick(7_000),
				run: () => since.set(now),
				"rows 12": () => void (height = 12),
				work: () => void (reported = { unsettledTurns: 2, unfinishedJobs: 3 }),
				"wait tick": poll,
				"rows 5": () => void (height = 5),
				"rows 3": () => void (height = 3),
				"rows 2": () => void (height = 2),
				"rows 1": () => void (height = 1),
				"rows 40, hour": d => ((height = 40), tick(3_725_000)(d)),
				"work cleared": () => void (reported = { unsettledTurns: 0, unfinishedJobs: 0 }),
				"wait tick 2": poll,
				"native other": action("other"),
				"native resume": action("resume"),
			},
		};
	},
});

/** The plan-save and move captures ran with `tui.select.cancel` bound to Ctrl+G, which their Cancel buttons name. */
function bindCaptureCancel(): void {
	setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
}

afterEach(() => setKeybindings(KeybindingsManager.inMemory()));

panelSuite({
	dir: "overlays/plan-save",
	mount(caseName) {
		bindCaptureCancel();
		const suggested = signal(caseName === "typing" ? "/home/me/plans/2026-11-23-refactor-the-thing.md" : "");
		return {
			view: () => <PlanSave suggestedPath={suggested} onDone={noop} />,
			focus: d => d.find("input"),
			steps: {
				suggest: () => suggested.set("/tmp/other-路径.md"),
				paste: d => d.paste("notes/plan.md"),
				unfocus: noop,
				refocus: noop,
				clear: d => {
					for (let i = 0; i < 20; i++) d.press("\x7f");
				},
				"suggest long": () => suggested.set(`/very/${"deep/".repeat(30)}plan.md`),
				save: action("save"),
				cancel: action("cancel"),
				other: d => void d.emit({ type: "select", key: "", item: "x" }),
			},
		};
	},
});

const SNAP_MODEL = { provider: "cursor", api: "cursor-agent", id: "claude-opus-5-high" } as never;

panelSuite({
	dir: "overlays/snapcompact-shape-preview",
	mount(caseName) {
		const value = signal(caseName === "default-model" ? "11on16-bw" : "auto");
		const samples = new SnapcompactSamples();
		const settle = () => samples.settled();
		return {
			view: () => (
				<SnapcompactShapePreview
					value={value}
					model={caseName === "default-model" ? undefined : SNAP_MODEL}
					samples={samples}
					graphics={caseName === "kitty"}
				/>
			),
			steps: {
				settle,
				variant: () => value.set("cjk16-bw"),
				"settle 2": settle,
				bogus: () => value.set("bogus"),
				"variant 5x8": () => value.set("5x8-bw"),
				"settle 3": settle,
				auto: () => value.set("auto"),
			},
		};
	},
});

const reportBody = (n: number) =>
	n === 0 ? (
		<col hidden />
	) : (
		<text
			wrap="word"
			spans={[
				{
					t: Array.from(
						{ length: n },
						(_, i) => `Entry ${i} — some report content 日本語 ${"x".repeat(i % 7)}`,
					).join("\n"),
				},
			]}
		/>
	);

panelSuite({
	dir: "overlays/report-panel",
	mount(caseName) {
		const focused = signal(false);
		const [n, cap] = (
			{ fits: [5, undefined], capped: [40, 12], "tiny-cap": [40, 3], head: [2, 20], empty: [0, 10] } as Record<
				string,
				[number, number | undefined]
			>
		)[caseName] ?? [3, undefined];
		const noMax = caseName === "no-maxrows";
		return {
			view: () => (
				<ReportPanel
					title={noMax ? "T" : "Full Changelog\nmulti"}
					body={reportBody(n)}
					closeKey={noMax ? "Ctrl+C" : "Esc"}
					maxRows={noMax ? undefined : () => cap}
					focused={focused}
					onClose={noop}
				/>
			),
			steps: {
				holdFocus: () => focused.set(true),
				heightAt: noop,
				"native close": d => void d.emit({ type: "action", key: "actions/close", act: "close", mods: [] }),
				"native other": d => void d.emit({ type: "select", key: "", item: "x" }),
			},
		};
	},
});

panelSuite({
	dir: "overlays/codex-reset-fireworks",
	mount(caseName) {
		const event: CodexResetFireworksEvent =
			caseName === "weekly"
				? { kind: "unscheduled-weekly-reset" }
				: {
						kind: "saved-reset-banked",
						added: caseName === "banked-one" ? 1 : 4,
						available: caseName === "banked-one" ? 3 : 9,
					};
		let height = 36;
		let now = CORPUS_NOW;
		const frame = (d: Driver) => d.env.setNow((now += 80));
		const steps: Record<string, (d: Driver) => void> = {
			"rows 9": () => void (height = 9),
			"rows 3": () => void (height = 3),
			"rows 100": () => void (height = 100),
			frame,
		};
		for (let i = 1; i <= 40; i++) steps[`frame ${i}`] = frame;
		return {
			view: () => <CodexResetFireworks event={event} startedAt={CORPUS_NOW} onClose={noop} />,
			height: () => height,
			steps,
		};
	},
});

const MOVE_DIRS = [
	"/home/u/src/",
	"/home/u/scratch/",
	"/home/u/docs/",
	"/tmp/",
	"/var/log/very/long/directory/name/that/overflows/the/box/",
];

panelSuite({
	dir: "overlays/move-overlay",
	mount() {
		bindCaptureCancel();
		const source = {
			search: (prefix: string) =>
				MOVE_DIRS.filter(d => d.startsWith(prefix) || prefix === "").map(value => ({
					value,
					label: `${value.split("/").filter(Boolean).at(-1)}/`,
				})),
		};
		return {
			view: () => <MoveOverlay cwd="/home/u" source={source} onDone={noop} />,
			steps: {
				paste: d => d.paste("/tm"),
				"native select": d => void d.emit({ type: "select", key: "results", item: "/tmp/" }),
				unfocus: noop,
			},
		};
	},
});
