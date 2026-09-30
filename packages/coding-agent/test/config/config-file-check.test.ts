import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelsConfigFile } from "../../src/config/models-config";

describe("ConfigFile.check", () => {
	let directory: string;
	let filePath: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-check-"));
		filePath = path.join(directory, "models.yml");
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	it.each([
		["a loadable file", "providers:\n  a:\n    baseUrl: http://a.example/v1\n"],
		[
			"a byte-order mark and surrounding blank lines",
			"\uFEFF\n\nproviders:\n  a:\n    baseUrl: http://a.example/v1\n\n",
		],
		["a schema violation", "providers: 3\n"],
		[
			"a provider the validator rejects",
			"providers:\n  a:\n    api: openai-completions\n    models:\n      - id: m\n",
		],
		["an empty file", ""],
		["malformed YAML", "providers: [oops\n"],
	])("reports what loading a file holding %s reports", async (_name, text) => {
		await fs.writeFile(filePath, text);
		const file = ModelsConfigFile.relocate(filePath);
		const loaded = file.tryLoad();
		const checked = file.check(text);

		expect(checked.status).toBe(loaded.status);
		expect(checked.error?.toString()).toBe(loaded.error?.toString());
		expect(checked.value).toEqual(loaded.value);
	});

	it("runs validators registered on the file", () => {
		const file = ModelsConfigFile.relocate(filePath).withValidation("test", config => {
			if (config.providers?.a) throw new Error("no provider a");
		});
		const checked = file.check("providers:\n  a:\n    baseUrl: http://a.example/v1\n");
		expect(checked.status).toBe("error");
		if (checked.status !== "error") return;
		expect(checked.error.message).toContain("no provider a");
	});

	it("neither reads the file nor caches its answer", async () => {
		const file = ModelsConfigFile.relocate(filePath);
		expect(file.check("providers: {}\n").status).toBe("ok");
		expect(file.tryLoad().status).toBe("not-found");

		await fs.writeFile(filePath, "providers: {}\n");
		file.invalidate();
		expect(file.tryLoad().status).toBe("ok");
		expect(file.check("providers: 3\n").status).toBe("error");
		expect(file.tryLoad().status).toBe("ok");
	});
});
