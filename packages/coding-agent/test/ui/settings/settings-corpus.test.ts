/**
 * Corpus parity of the settings window (`overlays/settings`): every case,
 * both themes, replayed through keys, pointer reports and native events.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { buildSettings } from "./fixture";
import { caseFiles, hasCorpus, runCase } from "./harness";

const SCREEN = "settings";

describe.skipIf(!hasCorpus(SCREEN))("overlays/settings corpus", () => {
	const files = hasCorpus(SCREEN) ? caseFiles(SCREEN) : [];
	for (const file of files) {
		test(path.basename(file, ".json"), async () => {
			const result = await runCase(file, corpus => buildSettings(corpus));
			if (result.failures.length > 0)
				console.log(
					`${path.basename(file)} ${result.passed}/${result.total}\n  ${result.failures.slice(0, 3).join("\n  ")}`,
				);
			expect(result.failures).toEqual([]);
		});
	}
});
