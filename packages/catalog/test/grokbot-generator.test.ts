import { expect, test } from "bun:test";
import { generateOfflineSeedCatalog, mergePreviousSnapshotModels } from "../scripts/generate-models";
import { buildModel } from "../src/build";
import { Effort } from "../src/effort";
import { getBundledModel } from "../src/models";
import { buildGrokbotStaticSeed } from "../src/provider-models/grokbot";

test("offline Grok Bot regeneration removes private snapshot rows without changing other providers", () => {
	const anthropic = getBundledModel("anthropic", "claude-opus-4-6")!;
	const privateRow = buildModel({ ...buildGrokbotStaticSeed()[0], id: "private-account-only-route" });
	const snapshot = {
		anthropic: { [anthropic.id]: anthropic },
		grokbot: { [privateRow.id]: privateRow },
	};
	const regenerated = generateOfflineSeedCatalog(snapshot, ["grokbot"]);
	expect(regenerated.anthropic).toEqual(snapshot.anthropic);
	expect(regenerated.grokbot).not.toHaveProperty(privateRow.id);
	expect(regenerated.grokbot["claude-opus-5-5"].thinking?.efforts).toContain(Effort.Medium);
	expect(snapshot.grokbot).toHaveProperty(privateRow.id);
	expect(mergePreviousSnapshotModels([], snapshot, new Set()).map(row => row.provider)).toEqual(["anthropic"]);
});
