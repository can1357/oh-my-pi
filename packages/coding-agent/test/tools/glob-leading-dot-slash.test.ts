import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { GlobTool } from "../../src/tools/glob";

describe("glob patterns with a leading ./", () => {
	let dir: string;
	let session: ToolSession;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-leading-dot-slash-"));
		session = {
			cwd: dir,
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		await fs.mkdir(path.join(dir, "src", "nested"), { recursive: true });
		await Bun.write(path.join(dir, "src", "a.ts"), "export {};\n");
		await Bun.write(path.join(dir, "src", "nested", "b.ts"), "export {};\n");
		await Bun.write(path.join(dir, "package.json"), "{}\n");
		await Bun.write(path.join(dir, "src", "data.json"), "{}\n");
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function matches(pattern: string): Promise<string[]> {
		const result = await new GlobTool(session).execute("glob-leading-dot-slash", {
			path: pattern,
			gitignore: false,
		});
		return result.details?.files?.toSorted() ?? [];
	}

	it("finds the same files with a leading ./ as without it", async () => {
		expect(await matches("src/*.ts")).toEqual(["src/a.ts"]);
		expect(await matches("./src/*.ts")).toEqual(["src/a.ts"]);
		expect(await matches("././src/*.ts")).toEqual(["src/a.ts"]);
		expect(await matches("src/**/*.ts")).toEqual(["src/a.ts", "src/nested/b.ts"]);
		expect(await matches("./src/**/*.ts")).toEqual(["src/a.ts", "src/nested/b.ts"]);
		// A bare "*.json" matches at any depth; a leading ./ must not narrow it to the root.
		expect(await matches("*.json")).toEqual(["package.json", "src/data.json"]);
		expect(await matches("./*.json")).toEqual(["package.json", "src/data.json"]);
	});

	it("keeps a leading ./ before a literal directory name that starts with ~", async () => {
		await fs.mkdir(path.join(dir, "~"));
		await Bun.write(path.join(dir, "~", "kept.ts"), "export {};\n");
		expect(await matches("./~/*.ts")).toEqual(["~/kept.ts"]);
	});
});
