import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const packageRoot = path.resolve(import.meta.dir, "..");

/**
 * Regression for #14027: the package ships `src/` and consumers import it from
 * `node_modules`, where Bun tries `.js`/`.mjs`/`.cjs`/`.jsx` before `.ts`. A module
 * sharing its basename with a JavaScript asset (e.g. a text-imported eval prelude)
 * then resolves to the asset for every extensionless importer.
 */
test("every src module resolves to itself when the package is installed under node_modules", async () => {
	using tempDir = TempDir.createSync("@omp-installed-source-resolution-");
	const installedRoot = tempDir.join("node_modules", "@oh-my-pi", "pi-coding-agent");
	await fs.mkdir(path.dirname(installedRoot), { recursive: true });
	await fs.symlink(packageRoot, installedRoot, "dir");

	const misresolved: string[] = [];
	for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: path.join(packageRoot, "src") })) {
		const specifier = `./src/${rel.slice(0, rel.lastIndexOf("."))}`;
		const resolved = Bun.resolveSync(specifier, installedRoot);
		if (resolved !== path.join(packageRoot, "src", rel)) misresolved.push(`${specifier} -> ${resolved}`);
	}

	expect(misresolved).toEqual([]);
});
