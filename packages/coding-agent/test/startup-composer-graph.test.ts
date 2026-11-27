import { expect, test } from "bun:test";
import * as path from "node:path";

test("startup-composer prepaint graph stays decoupled from settings, model-registry, lsp, and mcp", async () => {
	const entrypoint = path.resolve(import.meta.dir, "../src/modes/startup-composer.ts");
	const result = await Bun.build({
		entrypoints: [entrypoint],
		target: "bun",
		packages: "external",
		metafile: true,
	});
	expect(result.success).toBe(true);
	const files = Object.keys(result.metafile.inputs);
	for (const forbidden of [
		"src/config/settings.ts",
		"src/config/model-registry.ts",
		"src/config/model-resolver.ts",
		"src/lsp/client.ts",
		"src/mcp/manager.ts",
		"src/task/label.ts",
	]) {
		expect(
			files.some(file => file.replaceAll("\\", "/").endsWith(forbidden)),
			`startup-composer unexpectedly pulled in ${forbidden}`,
		).toBe(false);
	}
});
