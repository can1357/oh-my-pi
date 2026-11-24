import { describe, expect, setSystemTime, test } from "bun:test";
import { createRoot, isUiNode, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import { corpusEnvironment, describeTree, firstDiff, stageNative } from "@oh-my-pi/pi-tui/testing/corpus";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import "../../../src/ui/styles/tools/irc";
import { type IrcMessage, IrcMessageCard } from "../../../src/ui/tools/irc";
import { loadScreenCase, screenCaseFiles } from "./screens";

const DIR = "tools/irc-card";
const files = screenCaseFiles(DIR);

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
