import type { ShellVizPresentation, ShellVizRow } from "@oh-my-pi/pi-wire";
import { defaultShellVizPreferences } from "../../../../src/tools/shell-viz";
import { applyShellVizAction, ShellVisualizer, ShellVisualizerModel } from "../../../../src/ui/apps/shell-visualizer";
import { type AppDriver, appSuite } from "../harness";

function shellRow(index: number): ShellVizRow {
	const node = `0:0:${index + 1}`;
	return {
		id: node,
		depth: 0,
		node,
		state: "ok",
		segments: [
			{
				text: `echo ${"word ".repeat(index)} ${index}`,
				node,
				style: "cmd",
				expanded: "full expansion\nsecond line of expansion",
				tip: "inspection detail 日本語",
			},
		],
		effects: [
			{ glyph: "›", label: "writes", why: "redirects stdout to a file with a very long explanation that wraps" },
		],
		annotations: [
			{ name: "HOME", value: "/home/user", scope: "env" },
			{ name: "BIG", value: "x".repeat(20), fullLength: 9000 },
		],
		detail: "row detail text",
	} as ShellVizRow;
}

interface Fixture {
	rows: number;
	running: boolean;
	output: string;
	message?: string;
}

function presentationOf(fx: Fixture): ShellVizPresentation {
	const rows = Array.from({ length: fx.rows }, (_, i) => shellRow(i));
	return {
		preferences: defaultShellVizPreferences(),
		rows,
		original: rows,
		output: fx.output,
		running: fx.running,
		executing: fx.running,
		watches: [],
		timeline: { cursor: 0, length: fx.rows, elapsedNs: 1_500_000_000, durationNs: 4_000_000_000 },
		...(fx.message ? { message: fx.message } : {}),
	};
}

const CASES: Record<string, { fixture?: Fixture; height: number }> = {
	"no-presentation": { height: 30 },
	"message-only": {
		fixture: { rows: 0, running: false, output: "", message: "Waiting for the first traced command…" },
		height: 30,
	},
	"3-rows-finished": { fixture: { rows: 3, running: false, output: "line one\nline two 日本語\n" }, height: 30 },
	"40-rows-running-height-12": {
		fixture: { rows: 40, running: true, output: Array.from({ length: 30 }, (_, i) => `out ${i}`).join("\n") },
		height: 12,
	},
};

appSuite({
	dir: "apps/shell-visualizer",
	mount(caseName) {
		const { fixture, height } = CASES[caseName]!;
		const presentation = fixture && presentationOf(fixture);
		const model = new ShellVisualizerModel({
			presentation: () => presentation,
			replayEpoch: () => 3,
			liveOrigin: () => true,
			action: value => {
				if (presentation) presentation.preferences = applyShellVizAction(presentation.preferences, value, 4);
			},
			close: () => {},
			height: () => height,
		});
		return {
			view: () => ShellVisualizer({ model }),
			steps: {
				"native select row 0:0:2": (d: AppDriver) => void d.emit({ type: "select", key: "", item: "0:0:2" }),
				"native toggle color layer off": (d: AppDriver) =>
					void d.emit({ type: "change", key: "", item: "layer:color", value: false }),
			},
		};
	},
});
