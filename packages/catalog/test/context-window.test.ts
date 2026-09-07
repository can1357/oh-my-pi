import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveMaxContextWindow } from "@oh-my-pi/pi-catalog/compat/context-window";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

function bundledAstra() {
	const astra = getBundledModels("openai-codex").find(model => model.id === "gpt-6-astra");
	if (!astra) throw new Error("Expected bundled Astra model");
	return astra;
}

test("prefers a live maximum when no rule fallback owns one", () => {
	const astra = bundledAstra();
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 872_000 })).toBe(872_000);
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: undefined })).toBeUndefined();
});

test("ignores non-positive cached maxima without a rule fallback", () => {
	const astra = bundledAstra();
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: Number.NaN })).toBeUndefined();
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 0 })).toBeUndefined();
});

test("floors stale Astra windows to the documented 1.05M at build time", () => {
	const now = 1_000_000;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-window-"));
	const dbPath = path.join(tempDir, "models.db");
	try {
		writeModelCache(
			"openai-codex",
			now,
			[{ ...bundledAstra(), contextWindow: 272_000, maxContextWindow: 0 }],
			true,
			"",
			dbPath,
		);
		const cachedSpec = readModelCache("openai-codex", 1_000, () => now, dbPath)?.models.find(
			model => model.id === "gpt-6-astra",
		);
		if (!cachedSpec) throw new Error("Expected cached Astra model");

		expect(buildModel(cachedSpec).contextWindow).toBe(1_050_000);
	} finally {
		removeSyncWithRetries(tempDir);
	}
});
