import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { prepareEvalSource } from "../../src/eval/input";
import type { ToolSession } from "../../src/tools";

function session(cwd: string): ToolSession {
	return {
		cwd,
		settings: Settings.isolated(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

describe("eval percent commands", () => {
	it("re-reads quoted script paths on each explicit load", async () => {
		using tmp = TempDir.createSync("@eval-source-");
		const file = path.join(tmp.path(), "setup file.ts");
		await Bun.write(file, "const value = 1;");
		const first = await prepareEvalSource({ language: "js", code: '%load "setup file.ts"' }, session(tmp.path()));
		await Bun.write(file, "const value = 2;");
		const second = await prepareEvalSource({ language: "js", code: '%load "setup file.ts"' }, session(tmp.path()));
		expect(first.code).toBe("const value = 1;");
		expect(second.code).toBe("const value = 2;");
		expect(second.filename).toBe(file);
	});

	it("loads Python scripts at the host so the runner gets their filename", async () => {
		using tmp = TempDir.createSync("@eval-source-py-");
		const file = path.join(tmp.path(), "setup.py");
		await Bun.write(file, "value = 1");
		expect(await prepareEvalSource({ language: "py", code: "%load setup.py" }, session(tmp.path()))).toEqual({
			code: "value = 1",
			filename: file,
		});
	});

	it("loads local URLs from the calling session artifact root instead of the host session", async () => {
		using tmp = TempDir.createSync("@eval-local-source-");
		const context = session(tmp.path());
		context.getArtifactsDir = () => path.join(tmp.path(), "artifacts");
		const sourcePath = path.join(tmp.path(), "artifacts", "local", "setup.ts");
		await Bun.write(sourcePath, "const value = 42;");
		const source = await prepareEvalSource({ language: "js", code: "%load local://setup.ts" }, context);
		expect(source.code).toBe("const value = 42;");
		expect(source.filename).toBe(await fs.realpath(sourcePath));
	});

	it("parses package requirements without interpreting shell operators", async () => {
		const source = await prepareEvalSource(
			{ language: "js", code: `%bun add "left-pad@^1 || ^2" csv-parse` },
			session(process.cwd()),
		);
		expect(source.packages).toEqual(["left-pad@^1 || ^2", "csv-parse"]);
		expect(source.code).toBe("");
	});

	it("leaves Python package installs to the runner's own %pip magic", async () => {
		const code = "%pip install pillow";
		expect(await prepareEvalSource({ language: "py", code }, session(process.cwd()))).toEqual({ code });
	});

	it("rejects ambiguous commands and installer flags before installing", async () => {
		const context = session(process.cwd());
		await expect(prepareEvalSource({ language: "js", code: "%load a.ts\nrun()" }, context)).rejects.toThrow(
			/standalone/,
		);
		await expect(prepareEvalSource({ language: "js", code: '%load "missing.ts' }, context)).rejects.toThrow(/quote/);
		await expect(prepareEvalSource({ language: "js", code: "%bun add --global x" }, context)).rejects.toThrow(
			/flags/,
		);
		await expect(prepareEvalSource({ language: "js", code: "%pip install pillow" }, context)).rejects.toThrow(/%bun/);
		await expect(
			prepareEvalSource({ language: "js", code: "%load https://example.com/setup.ts" }, context),
		).rejects.toThrow(/local/);
	});
});
