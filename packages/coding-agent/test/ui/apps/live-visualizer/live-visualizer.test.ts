import { expect, test } from "bun:test";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { createLiveCallModel, LiveVisualizer } from "../../../../src/ui/apps/live-visualizer";
import { appSuite, paintAppRows } from "../harness";

test("the live visualizer shows ASCII key names for mute and end", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "ascii" }));
	const view = () => LiveVisualizer({ model: createLiveCallModel(), onStop: () => {}, onToggleMute: () => {} });
	const rows = paintAppRows(view, env, 100);
	expect(rows.find(row => row.includes("mute"))).toContain("Space mute · Esc end");
});

const TRANSCRIPT = "hello   world\nthis is a long transcript 日本語 ".repeat(5);

appSuite({
	dir: "apps/live-visualizer",
	mount() {
		const model = createLiveCallModel();
		const noop = () => {};
		return {
			view: () => LiveVisualizer({ model, onStop: noop, onToggleMute: noop, stopKeys: ["ctrl+l"] }),
			steps: {
				"phase listening": () => model.setPhase("listening"),
				"input level 0.4": () => model.setInputLevel(0.4),
				"frame 1": () => model.setFrame(1),
				"frame 2": () => model.setFrame(2),
				"input level NaN": () => model.setInputLevel(Number.NaN),
				"frame 3": () => model.setFrame(3),
				transcript: () => model.setTranscript(TRANSCRIPT),
				"phase working": () => model.setPhase("working"),
				"frame 7": () => model.setFrame(7),
				"phase speaking": () => model.setPhase("speaking"),
				"phase muted": () => model.setPhase("muted"),
				"transcript cleared": () => model.clearTranscript(),
				"phase error": () => model.setPhase("error"),
				"input level 2 (clamped)": () => model.setInputLevel(2),
				"frame 9": () => model.setFrame(9),
				"phase connecting": () => model.setPhase("connecting"),
			},
		};
	},
});
