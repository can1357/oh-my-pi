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

test("prefers a live maximum over a previously resolved rule fallback", () => {
	const astra = bundledAstra();
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: undefined })).toBe(872_000);
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 640_000 })).toBe(640_000);
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: undefined })).toBe(872_000);
});

test("uses the policy fallback when a model maximum is not finite", () => {
	const astra = bundledAstra();
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: Number.NaN })).toBe(872_000);
});

test("uses the policy fallback when cached maxima are non-positive", () => {
	const now = 1_000_000;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-window-"));
	const dbPath = path.join(tempDir, "models.db");
	try {
		writeModelCache("openai-codex", now, [{ ...bundledAstra(), maxContextWindow: 0 }], true, "", dbPath);
		const cachedSpec = readModelCache("openai-codex", 1_000, () => now, dbPath)?.models.find(
			model => model.id === "gpt-6-astra",
		);
		if (!cachedSpec) throw new Error("Expected cached Astra model");

		expect(resolveMaxContextWindow(buildModel(cachedSpec))).toBe(872_000);
	} finally {
		removeSyncWithRetries(tempDir);
	}
});
