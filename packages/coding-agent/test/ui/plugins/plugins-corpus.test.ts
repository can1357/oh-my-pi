/**
 * Corpus parity of the plugin overlays (`overlays/plugins`): the selector
 * and the plugin settings views, both themes, replayed step by step.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import { caseFiles, hasCorpus, runCase } from "../settings/harness";
import { buildPluginSettings } from "./fixture";
import { buildSelector } from "./selector-fixture";

const SCREEN = "plugins";

describe.skipIf(!hasCorpus(SCREEN))("overlays/plugins corpus", () => {
	for (const file of hasCorpus(SCREEN) ? caseFiles(SCREEN) : []) {
		test(path.basename(file, ".json"), async () => {
			const corpus = await Bun.file(file).json();
			let step: (label: string) => boolean | Promise<boolean> = () => false;
			const result = await runCase(
				file,
				(_, env) => {
					const built = corpus.case.startsWith("selector")
						? buildSelector(corpus.case, env ?? corpusEnvironment(corpus.theme))
						: buildPluginSettings(corpus.case);
					step = built.step;
					return built.driven;
				},
				label => step(label),
			);
			if (result.failures.length > 0)
				console.log(
					`${path.basename(file)} ${result.passed}/${result.total}\n  ${result.failures.slice(0, 3).join("\n  ")}`,
				);
			expect(result.failures).toEqual([]);
		});
	}
});
