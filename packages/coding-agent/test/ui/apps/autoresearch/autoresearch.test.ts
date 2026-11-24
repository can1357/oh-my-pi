import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import {
	AutoresearchSheet,
	type AutoresearchDashboardRuntime,
	AutoresearchWidget,
} from "../../../../src/ui/apps/autoresearch";
import { appSuite } from "../harness";

const now = () => CORPUS_NOW;

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
