/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `setup/wizard` and `setup/startup-splash` corpus: the full-screen wizard
 * across its phases (splash, dissolve, scenes, outro, done) and the startup
 * splash, on a clock and screen size the steps move.
 */
import { afterAll } from "bun:test";
import { signal } from "@oh-my-pi/pi-tui";
import type { StaticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { padTo, wrap } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import { setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import {
	ALL_SCENES,
	type GlyphPreset,
	glyphScene,
	modelScene,
	SetupWizard,
	type SetupScene,
	StartupSplash,
	type ThemeLook,
	updatesScene,
	wizardFocus,
} from "../../../src/ui/setup";
import { corpusSuite, type Driver, type Mounted } from "./harness";
import { corpusModel, fakeHost } from "./host";

// This file publishes corpus themes as the active theme; put the previous one back for later files.
const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

setAgentDir("/corpus-home/.omp/agent");

const VERSION = "19.1.1";

/** The look a preview applies: the paint environment and the runtime theme the scenes' copy reads. */
function looks(env: StaticEnvironment) {
	let symbols: GlyphPreset = "unicode";
	let theme: ThemeLook | null = null;
	const apply = (): void => {
		const name = theme === null || theme.theme === "auto" ? "dark" : theme.theme;
		const resolved = loadThemeSync(name, {
			symbolPreset: theme?.symbols ?? symbols,
			colorBlindMode: theme?.colorBlind ?? false,
		});
		env.setTheme(resolved);
		setCurrentTheme(resolved);
	};
	apply();
	return {
		previewSymbolPreset: (preset: GlyphPreset | null) => {
			symbols = preset ?? "unicode";
			apply();
		},
		// Back to the look setup started with (theme and glyphs) once the theme has loaded: the next scene mounts first.
		previewTheme: async (look: ThemeLook | null) => {
			if (look === null) await Bun.sleep(0);
			theme = look;
			if (look === null) symbols = "unicode";
			apply();
		},
	};
}

/** A scene with a 30-row body that echoes typed keys (corpus fixture). */
function plainScene(): SetupScene {
	return {
		id: "plain",
		title: "Plain scene with ünïcode title",
		subtitle: "",
		step: "Plain",
		minVersion: 1,
		mount(context) {
			const typed = signal<readonly string[]>([]);
			return {
				body: (
					<text
						text={() => `plain ${typed().length}`}
						term={() => ({ role: "test.plain", typed: typed().join(""), budget: context.maxLines() })}
						onKey={key => {
							// Ctrl+C is the wizard's (it leaves setup); the old wizard took it before the scene.
							if (key.id === "ctrl+c") return false;
							if (key.id === "enter") context.finish("done");
							else typed.set([...typed(), JSON.stringify(key.raw)]);
							return true;
						}}
					/>
				),
			};
		},
	};
}

defineRolePainter("text", "test.plain", (node, cx) => {
	const term = (node.props() as { term: { typed: string; budget: number | undefined } }).term;
	const rows = Array.from({ length: 30 }, (_, i) => `row ${i} ${term.typed} budget=${term.budget}`);
	return { rows: rows.flatMap(row => wrap(row, cx.width)).map(row => padTo(row, cx.width)) };
});

const GPT5 = corpusModel("openai", "gpt-5");

const SCENES: Record<string, () => readonly SetupScene[]> = {
	"all-scenes-walkthrough": () => ALL_SCENES,
	"custom-scenes-mouse-and-resize": () => [updatesScene, plainScene(), glyphScene, modelScene],
	"native-skip-then-ctrl-c": () => [updatesScene, plainScene(), glyphScene, modelScene],
	"outro-without-default-model": () => [updatesScene],
};

const ROWS: Record<string, number> = { "outro-without-default-model": 24 };

corpusSuite({
	dir: "setup/wizard",
	mount(caseName, _corpusCase, env): Mounted {
		const now = signal(CORPUS_NOW);
		const rows = signal(ROWS[caseName] ?? 30);
		const host = fakeHost({
			...(caseName === "outro-without-default-model" ? {} : { models: [GPT5], current: GPT5 }),
			...looks(env),
		});
		const at = (ms: number) => () => {
			now.set(CORPUS_NOW + ms);
			env.setNow(CORPUS_NOW + ms);
		};
		const action = (act: string) => (driver: Driver) => void driver.emit({ type: "action", key: "", act, mods: [] });
		const steps: Record<string, (driver: Driver) => void> = {
			"native skip": action("skip"),
			"native exit": action("exit"),
			"native continue": action("continue"),
			"mouse wheel down at row 20": driver => driver.press("\x1b[<65;10;20M"),
			"mouse left click at row 14": driver => driver.press("\x1b[<0;10;14M"),
			"mouse wheel up (plain scene, no routeMouse → up arrow)": driver => driver.press("\x1b[<64;10;20M"),
			"terminal rows 12": () => rows.set(12),
			"terminal rows 3": () => rows.set(3),
			"terminal rows 40": () => rows.set(40),
		};
		for (const stage of _corpusCase.stages) {
			const time = /t=\+?(\d+)|dissolve done|outro ends/.exec(stage.label);
			if (!time || steps[stage.label]) continue;
			// Clock steps: the capture set ms since mount (the input notes list them).
			steps[stage.label] = at(CLOCK[caseName]?.[stage.label] ?? Number(time[1]));
		}
		return {
			view: () => (
				<SetupWizard
					host={host}
					scenes={SCENES[caseName]!()}
					version={VERSION}
					now={now}
					rows={rows}
					onDone={() => void host.events.push("wizard done")}
				/>
			),
			steps,
			focus: driver => wizardFocus(driver.root),
			height: () => rows(),
			events: () => host.events.splice(0),
		};
	},
});

/** Clock steps by case and label, in ms since mount (from the capture's step list). */
const CLOCK: Record<string, Record<string, number>> = {
	"all-scenes-walkthrough": {
		"dissolve t=+100": 2600,
		"dissolve t=+300": 2800,
		"dissolve done (sign-in scene)": 3000,
		"outro t=+200": 3200,
		"outro t=+800": 3800,
		"outro ends (done)": 4300,
	},
	"custom-scenes-mouse-and-resize": {
		"dissolve t=+100": 1600,
		"dissolve t=+300": 1800,
		"dissolve t=+420 (no tick yet)": 1920,
		"dissolve done": 3000,
		"outro t=+200": 3200,
	},
	"native-skip-then-ctrl-c": { "dissolve done": 9000, "outro t=+600": 9600 },
	"outro-without-default-model": { "dissolve done": 1000, "outro t=+300": 1300 },
};

corpusSuite({
	dir: "setup/startup-splash",
	mount(caseName, _corpusCase, env): Mounted {
		looks(env);
		const now = signal(CORPUS_NOW);
		const rows = signal(24);
		const events: string[] = [];
		const at = (ms: number) => () => {
			now.set(CORPUS_NOW + ms);
			env.setNow(CORPUS_NOW + ms);
		};
		const steps: Record<string, (driver: Driver) => void> = {
			"terminal rows 6": () => rows.set(6),
			"terminal rows 50": () => rows.set(50),
			"native skip": driver => void driver.emit({ type: "action", key: "", act: "skip", mods: [] }),
			"t=9000 (past end)": at(9000),
		};
		for (const ms of [100, 500, 900, 1800, 2600]) steps[`t=${ms}`] = at(ms);
		return {
			view: () => (
				<StartupSplash
					version={VERSION}
					now={now}
					onDone={() => {
						events.push("hide");
						setTimeout(() => events.push("splash done"), 0);
					}}
				/>
			),
			steps,
			height: () => rows(),
			// The capture's splash never timed out (its ticker did not run); ours ends at 2.6s.
			...(caseName === "animation" ? {} : { events: () => events.splice(0) }),
		};
	},
});
