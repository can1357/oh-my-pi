/**
 * `composer/status-line` corpus: the standalone status bar in every preset
 * (default, minimal, compact, full, custom, no hooks, transparent) through
 * composer placements, extension statuses and live modes.
 */
import { jsx, signal } from "@oh-my-pi/pi-tui";
import type { StatusFacts, StatusPlacement } from "../../../src/ui/status/facts";
import { StatusLine } from "../../../src/ui/status/status-line";
import "../../../src/ui/styles/status";
import type { StatusLineSettings } from "../../../src/modes/view-model/status-line/types";
import { stagedSuite } from "./corpus-suite";
import { corpusStatusFacts } from "./fixture";

const HOOK_A = "hook \x1b[31mred\x1b[0m\twith tab and a long long long long long long text";
const HOOK_B = "second 日本語";

stagedSuite("composer/status-line", corpusCase => {
	const inputs = corpusCase.inputs as { settings: StatusLineSettings };
	const facts = signal(corpusStatusFacts());
	const placement = signal<StatusPlacement>({ bar: "none", gap: false, autocomplete: false });
	const update = (patch: Partial<StatusFacts>) => facts.set({ ...facts(), ...patch });
	const place = (patch: Partial<StatusPlacement>) => placement.set({ ...placement(), ...patch });
	const steps: Record<string, () => void> = {
		"full bar": () => place({ bar: "full", gap: false }),
		"hook a": () => update({ hooks: [HOOK_A] }),
		"hook b": () => update({ hooks: [HOOK_A, HOOK_B] }),
		"top-rule chip, left bar, gap": () => place({ bar: "left", gap: true }),
		"plan mode": () => update({ plan: { enabled: true, paused: false } }),
		"plan paused": () => update({ plan: { enabled: true, paused: true } }),
		"autocomplete active": () => place({ autocomplete: true }),
		"autocomplete inactive": () => place({ autocomplete: false }),
		"subagents running": () => update({ subagents: 2 }),
		recording: () => update({ recording: true }),
		"autocompact off": () => update({ autoCompact: false }),
		"clear hooks": () => update({ hooks: [] }),
		"top-border attachment, no bar": () => place({ bar: "none", gap: false }),
	};
	return {
		tree: jsx(StatusLine, { settings: () => inputs.settings, facts, placement }),
		step(label) {
			const step = steps[label];
			if (!step) throw new Error(`status-line: unknown stage ${label}`);
			step();
		},
	};
});
