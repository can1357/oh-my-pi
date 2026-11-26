/**
 * `composer/welcome` corpus: the welcome card across tip rolls, version
 * changes, self-update activity and the intro animation (terminal clock).
 */
import { jsx } from "@oh-my-pi/pi-tui";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import "../../../src/ui/styles/welcome";
import { welcomeTip } from "../../../src/ui/welcome/tips";
import { type VersionUpdate, Welcome, WelcomeModel } from "../../../src/ui/welcome/welcome";
import { stagedSuite } from "../status/corpus-suite";

interface WelcomeInputs {
	readonly version: string;
	/** `{ nagRoll, tipRoll }`, or one roll for both. */
	readonly random: number | { readonly nagRoll: number; readonly tipRoll: number };
	readonly updates?: readonly [string, VersionUpdate | null][];
}

stagedSuite("composer/welcome", (corpusCase, env) => {
	const inputs = corpusCase.inputs as WelcomeInputs;
	const rolls = typeof inputs.random === "number" ? { nagRoll: inputs.random, tipRoll: inputs.random } : inputs.random;
	// Captured on macOS (modifier keycaps) under the unicode symbol preset, classic renderer.
	const tip = welcomeTip({ ...rolls, preset: "unicode", tern: false });
	const model = new WelcomeModel(inputs.version);
	const steps = new Map<string, () => void>([
		["prerelease version", () => model.version.set("14.2.0-beta.1")],
		["t=0", () => model.playIntro(CORPUS_NOW)],
		["settled", () => model.stopIntro()],
	]);
	for (const [label, update] of inputs.updates ?? []) steps.set(label, () => model.update.set(update));
	return {
		tree: jsx(Welcome, {
			version: model.version,
			update: model.update,
			tip: () => tip,
			keys: () => ({ preset: "unicode", platform: "darwin" }),
			introStart: model.introStart,
		}),
		step(label) {
			const frame = /^t=(\d+)$/.exec(label);
			if (frame && label !== "t=0") return env.setNow(CORPUS_NOW + Number(frame[1]));
			const step = steps.get(label);
			if (!step) throw new Error(`welcome: unknown stage ${label}`);
			step();
		},
	};
});
