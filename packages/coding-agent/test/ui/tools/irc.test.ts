import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createRoot, isUiNode, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import { corpusEnvironment, describeTree, firstDiff, stageNative } from "@oh-my-pi/pi-tui/testing/corpus";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import "../../../src/ui/styles/tools/irc";
import { type IrcMessage, IrcMessageCard } from "../../../src/ui/tools/irc";
import { loadScreenCase, screenCaseFiles } from "./screens";

const DIR = "tools/irc-card";
const files = screenCaseFiles(DIR);

const originalTheme = currentTheme();
afterEach(() => setCurrentTheme(originalTheme));

test("IRC message cards use the active preset's directional glyphs in native and terminal headings", () => {
	const theme = loadThemeSync("dark", { symbolPreset: "nerd" });
	setCurrentTheme(theme);
	const env = staticEnvironment(theme);
	createRoot(dispose => {
		try {
			const node = IrcMessageCard({ message: { kind: "relay", from: "Anna", to: "Ben" } });
			if (!isUiNode(node)) throw new Error("Expected an IRC message card");
			expect(describeTree(node, env)).toMatchObject({
				k: "card",
				p: { role: "omp.irc.relay", head: [{ s: "toolTitle strong", t: "IRC Anna  Ben" }] },
			});
			const ascii = staticEnvironment(loadThemeSync("dark", { symbolPreset: "ascii" }));
			expect(paintNode(ascii, node, 100).rows.map(row => Bun.stripANSI(row))).toEqual(["# IRC Anna -> Ben"]);
		} finally {
			dispose();
		}
	});
});

describe.skipIf(files.length === 0)(`${DIR} corpus`, () => {
	for (const file of files) {
		const corpusCase = loadScreenCase(DIR, file);
		const inputs = corpusCase.inputs as { card: IrcMessage; nowMs: number };
		test(file, () => {
			const env = corpusEnvironment(corpusCase.theme);
			const expanded = signal(false);
			setSystemTime(new Date(inputs.nowMs));
			try {
				createRoot(dispose => {
					const node = IrcMessageCard({ message: inputs.card, expanded });
					if (!isUiNode(node)) throw new Error("irc card: node expected");
					const failures: string[] = [];
					corpusCase.stages.forEach((stage, index) => {
						expanded.set(stage.label === "expanded");
						const native = firstDiff(stageNative(corpusCase, index), describeTree(node as UiNode, env));
						if (native) failures.push(`${stage.label} native: ${native}`);
						for (const width of corpusCase.widths) {
							const diff = firstCellDiff(
								stage.rows[String(width)] ?? [],
								paintNode(env, node as UiNode, width).rows,
							);
							if (diff) failures.push(`${stage.label} @${width}: ${diff}`);
						}
					});
					dispose();
					expect(failures).toEqual([]);
				});
			} finally {
				setSystemTime();
			}
		});
	}
});
