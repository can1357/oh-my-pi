import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const TOOL_NAME = "legacy-multi-file-tool";

describe("issue #983: multi-file legacy Pi extensions", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	it("loads legacy Pi extensions whose sibling TypeScript files import each other via relative paths", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-issue-983-project-"));
		tempDirs.push(projectDir);
		const extensionDir = path.join(projectDir, "legacy-pi-multi-file-extension");

		await fs.mkdir(extensionDir, { recursive: true });
		await Bun.write(
			path.join(extensionDir, "package.json"),
			JSON.stringify(
				{
					name: "legacy-pi-multi-file-extension",
					version: "1.0.0",
					pi: {
						extensions: ["./index.ts"],
					},
				},
				null,
				2,
			),
		);
		await Bun.write(path.join(extensionDir, "helper.ts"), `export const foo = ${JSON.stringify(TOOL_NAME)};\n`);
		await Bun.write(
			path.join(extensionDir, "index.ts"),
			[
				'import { foo } from "./helper.ts";',
				"",
				"export default function(pi) {",
				"\tconst { Type } = pi.typebox;",
				"\tpi.registerTool({",
				"\t\tname: foo,",
				'\t\tdescription: "Issue #983 regression test",',
				"\t\tparameters: Type.Object({}),",
				'\t\texecute: async () => ({ content: [{ type: "text", text: foo }] }),',
				"\t});",
				"}",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([extensionDir], projectDir);
		const extension = result.extensions.find(ext => ext.path === path.join(extensionDir, "index.ts"));

		expect(result.errors).toHaveLength(0);
		expect(extension).toBeDefined();
		expect(extension?.tools.has(TOOL_NAME)).toBe(true);
	});
});
