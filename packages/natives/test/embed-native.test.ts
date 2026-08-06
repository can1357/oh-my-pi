import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Integration tests for `scripts/embed-native.ts`, covering the version-
 * sentinel guard: embedding a `.node` built from a different release (no
 * `__piNativesV{version}` export) must fail the build with the rebuild
 * command instead of producing a binary that can never start (the failure
 * behind the "does not expose the version sentinel" startup crash).
 *
 * The script derives every path from its own location, so each test stages a
 * minimal package layout in a temp dir and runs a copied script against it:
 *
 *   <tmp>/scripts/embed-native.ts  (verbatim copy)
 *   <tmp>/native/<addon>.node      (fixture bytes)
 *   <tmp>/package.json             (fixture version)
 */

const repoScriptPath = path.join(import.meta.dir, "..", "scripts", "embed-native.ts");

let tmpDir: string;

function stagePackage(version: string, addons: Record<string, string>): string {
	const scriptsDir = path.join(tmpDir, "scripts");
	const nativeDir = path.join(tmpDir, "native");
	fs.mkdirSync(scriptsDir, { recursive: true });
	fs.mkdirSync(nativeDir, { recursive: true });
	fs.copyFileSync(repoScriptPath, path.join(scriptsDir, "embed-native.ts"));
	fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ version }));
	for (const [filename, content] of Object.entries(addons)) {
		fs.writeFileSync(path.join(nativeDir, filename), content);
	}
	return path.join(scriptsDir, "embed-native.ts");
}

function runEmbed(scriptPath: string): { exitCode: number; stderr: string } {
	const result = Bun.spawnSync({
		cmd: [process.execPath, scriptPath],
		cwd: tmpDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { exitCode: result.exitCode, stderr: result.stderr.toString("utf-8") };
}

function platformTag(): string {
	return `${process.platform}-${process.arch}`;
}

function addonFilename(): string {
	// x64 embeds the variant-suffixed names; other arches use the default name.
	return process.arch === "x64" ? `pi_natives.${platformTag()}-baseline.node` : `pi_natives.${platformTag()}.node`;
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-native-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("embed-native version-sentinel guard", () => {
	test("rejects an addon built from a different release", () => {
		const scriptPath = stagePackage("9.9.9", {
			[addonFilename()]: "stale native bytes exposing __piNativesV9_9_8",
		});
		const { exitCode, stderr } = runEmbed(scriptPath);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("__piNativesV9_9_9");
		expect(stderr).toContain("built from a different release");
		expect(stderr).toContain("bun --cwd=packages/natives run build");
	});

	test("embeds an addon exposing the current sentinel", () => {
		const scriptPath = stagePackage("9.9.9", {
			[addonFilename()]: "fresh native bytes exposing __piNativesV9_9_9",
		});
		const { exitCode, stderr } = runEmbed(scriptPath);
		if (exitCode !== 0) console.error(stderr);
		expect(exitCode).toBe(0);
		const generated = fs.readFileSync(path.join(tmpDir, "native", "embedded-addon.js"), "utf-8");
		expect(generated).toContain(`platformTag: ${JSON.stringify(platformTag())}`);
		expect(generated).toContain(`version: "9.9.9"`);
	});
});
