import { describe, expect, test } from "bun:test";
import { captureStage, skipsAt } from "../deviations";
import { checkFlowCase, flowCaseFiles, loadFlowCase } from "./tool-flows";

const IDS = ["grep", "glob", "lsp", "web_search", "github", "goal", "debug", "recall", "reflect", "retain", "mcp"];

for (const id of IDS) {
	const screen = `transcript/tool/${id}`;
	const files = flowCaseFiles(id);
	describe.skipIf(files.length === 0)(`${screen} corpus`, () => {
		for (const file of files) {
			for (const result of checkFlowCase(loadFlowCase(id, file))) {
				const ref = {
					screen,
					case: file,
					index: result.index,
					label: result.label,
				};
				if (result.painted)
					captureStage({
						screen,
						file,
						index: result.index,
						label: result.label,
						rows: result.painted,
						native: result.described,
					});
				test(`${file} · ${result.label}`, () => {
					const failures: string[] = [];
					// A listed native deviation leaves the native tree out of the comparison.
					if (result.native && !skipsAt(ref, "native")) failures.push(`native: ${result.native}`);
					// A listed row deviation passes the stage when only its rows differ.
					for (const width in result.rows) {
						const diff = result.rows[width];
						if (diff && !skipsAt(ref, "rows", width)) failures.push(`rows@${width}: ${diff}`);
					}
					expect(failures).toEqual([]);
				});
			}
		}
	});
}
