import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __rewriteLegacyExtensionSourceForTests } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempRoots: string[] = [];

afterEach(async () => {
	mock.restore();
	for (const root of tempRoots.splice(0)) {
		await removeWithRetries(root);
	}
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(value)}\n`);
}

/**
 * Regression: an extension inside an installed git-dep monorepo (full
 * workspace tree, no node_modules links for `workspace:*` siblings) must
 * resolve bare imports of workspace members through the workspace root's
 * `workspaces` globs, honoring the member's exports conditions.
 */
test("bare workspace-member imports resolve through the workspace root manifest", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-resolve-"));
	tempRoots.push(root);
	const repoRoot = path.join(root, "plugins", "node_modules", "monorepo-plugin");
	const importer = path.join(repoRoot, "packages", "extension", "extensions", "entry.ts");
	const memberRoot = path.join(repoRoot, "packages", "contracts");
	await fs.mkdir(path.dirname(importer), { recursive: true });
	await fs.mkdir(path.join(memberRoot, "src"), { recursive: true });
	await Bun.write(importer, "export {};\n");
	await writeJson(path.join(repoRoot, "package.json"), {
		name: "monorepo-plugin",
		version: "1.0.0",
		workspaces: ["packages/*"],
	});
	await writeJson(path.join(memberRoot, "package.json"), {
		name: "@monorepo/contracts",
		version: "1.0.0",
		main: "dist/index.js",
		exports: { ".": { bun: "./src/index.ts", default: "./dist/index.js" } },
	});
	await Bun.write(path.join(memberRoot, "src", "index.ts"), "export const marker = 1;\n");

	spyOn(Bun, "resolveSync").mockImplementation(() => {
		throw new Error("compiled fallback");
	});

	const rewritten = await __rewriteLegacyExtensionSourceForTests(
		'import { marker } from "@monorepo/contracts";',
		importer,
	);

	expect(rewritten).toContain(path.join("packages", "contracts", "src", "index.ts"));
});

test("installed node_modules copies shadow workspace members at the same level", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-shadow-"));
	tempRoots.push(root);
	const repoRoot = path.join(root, "monorepo-plugin");
	const importer = path.join(repoRoot, "packages", "extension", "entry.ts");
	const memberRoot = path.join(repoRoot, "packages", "dep");
	const installedRoot = path.join(repoRoot, "node_modules", "@monorepo", "dep");
	await fs.mkdir(path.dirname(importer), { recursive: true });
	await fs.mkdir(memberRoot, { recursive: true });
	await fs.mkdir(installedRoot, { recursive: true });
	await Bun.write(importer, "export {};\n");
	await writeJson(path.join(repoRoot, "package.json"), {
		name: "monorepo-plugin",
		version: "1.0.0",
		workspaces: ["packages/*"],
	});
	await writeJson(path.join(memberRoot, "package.json"), {
		name: "@monorepo/dep",
		version: "1.0.0",
		main: "member.js",
	});
	await Bun.write(path.join(memberRoot, "member.js"), "export default 1;\n");
	await writeJson(path.join(installedRoot, "package.json"), {
		name: "@monorepo/dep",
		version: "2.0.0",
		main: "installed.js",
	});
	await Bun.write(path.join(installedRoot, "installed.js"), "export default 2;\n");

	spyOn(Bun, "resolveSync").mockImplementation(() => {
		throw new Error("compiled fallback");
	});

	const rewritten = await __rewriteLegacyExtensionSourceForTests('import dep from "@monorepo/dep";', importer);

	expect(rewritten).toContain("installed.js");
	expect(rewritten).not.toContain("member.js");
});
