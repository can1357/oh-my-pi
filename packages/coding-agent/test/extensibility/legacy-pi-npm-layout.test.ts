import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { collectBundledPiEntries } from "../../scripts/legacy-pi-virtual-module";
import type { BundledPiEntry } from "../../scripts/legacy-pi-virtual-module";

test("published build plugin collects legacy Pi entries from installed sibling packages", async () => {
	using install = TempDir.createSync("@omp-legacy-pi-install-");
	const packageDir = path.resolve(import.meta.dir, "..", "..");
	const packagesDir = path.resolve(packageDir, "..");
	const scopeDir = install.join("node_modules/@oh-my-pi");
	const codingAgentDir = path.join(scopeDir, "pi-coding-agent");
	await fs.mkdir(path.join(codingAgentDir, "scripts"), { recursive: true });
	await fs.copyFile(
		path.join(packageDir, "scripts/legacy-pi-virtual-module.ts"),
		path.join(codingAgentDir, "scripts/legacy-pi-virtual-module.ts"),
	);
	await fs.copyFile(path.join(packageDir, "package.json"), path.join(codingAgentDir, "package.json"));
	await fs.symlink(path.join(packageDir, "src"), path.join(codingAgentDir, "src"), "dir");
	for (const [dir, npmDir] of [
		["agent", "pi-agent-core"],
		["ai", "pi-ai"],
		["catalog", "pi-catalog"],
		["natives", "pi-natives"],
		["tui", "pi-tui"],
		["utils", "pi-utils"],
	]) {
		await fs.symlink(path.join(packagesDir, dir), path.join(scopeDir, npmDir), "dir");
	}

	// A consumer module in the install root statically imports the installed copy, so its
	// `import.meta.dir` resolves inside node_modules exactly as a downstream host build sees it.
	const consumer = install.join("collect.ts");
	await Bun.write(
		consumer,
		'import { collectBundledPiEntries } from "./node_modules/@oh-my-pi/pi-coding-agent/scripts/legacy-pi-virtual-module.ts";\nconsole.log(JSON.stringify(await collectBundledPiEntries()));\n',
	);
	const result = await $`${process.execPath} ${consumer}`.cwd(install.path()).quiet().nothrow();
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	const installed: BundledPiEntry[] = result.json();
	const monorepo = await collectBundledPiEntries();
	expect(installed.map(entry => entry.key)).toEqual(monorepo.map(entry => entry.key));
	expect(installed.find(entry => entry.key === "@oh-my-pi/pi-agent-core")?.importSpecifier).toBe(
		"@oh-my-pi/pi-agent-core",
	);
	expect(installed.find(entry => entry.key === "@oh-my-pi/pi-ai/oauth/anthropic")?.importSpecifier).toBe(
		"@oh-my-pi/pi-ai/oauth/anthropic",
	);
	expect(installed.find(entry => entry.key === "@oh-my-pi/pi-coding-agent")?.importSpecifier).toBe(
		path.join(codingAgentDir, "src/extensibility/legacy-pi-coding-agent-shim.ts"),
	);
});
