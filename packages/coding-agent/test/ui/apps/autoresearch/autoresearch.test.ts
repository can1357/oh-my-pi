import { expect, test } from "bun:test";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { createSessionRuntime } from "../../../../src/autoresearch/state";
import {
	AutoresearchSheet,
	type AutoresearchDashboardRuntime,
	AutoresearchWidget,
} from "../../../../src/ui/apps/autoresearch";
import { appSuite, paintAppRows } from "../harness";

const now = () => CORPUS_NOW;

test("the autoresearch sheet navigation row paints ASCII keycaps", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "ascii" }));
	const runtime = createSessionRuntime();
	const view = () => AutoresearchSheet({ runtime, now, terminalRows: 24, onClose: () => {} });
	const rows = paintAppRows(view, env, 100);
	expect(rows.at(-1)).toContain("Up/Down j/k PgUp PgDn g Shift+G Esc");
});

appSuite({
	dir: "apps/autoresearch-dashboard",
	mount(caseName, corpusCase) {
		const runtime = (corpusCase.inputs as { runtime: AutoresearchDashboardRuntime }).runtime;
		if (caseName.startsWith("widget-")) {
			// The old widget laid itself out for `process.stdout.columns ?? 120` (no TTY in the capture).
			return { view: () => AutoresearchWidget({ runtime, now, columns: 120 }) };
		}
		return { view: () => AutoresearchSheet({ runtime, now, terminalRows: 40, onClose: () => {} }) };
	},
});
