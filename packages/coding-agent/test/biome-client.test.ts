import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BiomeClient } from "../src/lsp/clients/biome-client";
import type { ServerConfig } from "../src/lsp/types";

const tempDirs: string[] = [];
const tempRoots: string[] = [];
const repoRoot = path.resolve(import.meta.dir, "../../..");

function resolveRepoBiome(): string {
	const platformPackages: Partial<Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string[]>>>> = {
		darwin: { arm64: ["cli-darwin-arm64"], x64: ["cli-darwin-x64"] },
		linux: {
			arm64: ["cli-linux-arm64", "cli-linux-arm64-musl"],
			x64: ["cli-linux-x64", "cli-linux-x64-musl"],
		},
		win32: { arm64: ["cli-win32-arm64"], x64: ["cli-win32-x64"] },
	};
	const executable = process.platform === "win32" ? "biome.exe" : "biome";
	for (const packageName of platformPackages[process.platform]?.[process.arch] ?? []) {
		try {
			return Bun.resolveSync(`@biomejs/${packageName}/${executable}`, repoRoot);
		} catch {}
	}
	throw new Error(`No repository Biome binary for ${process.platform}/${process.arch}`);
}

const repoBiome = resolveRepoBiome();

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-biome-client-test-"));
	tempDirs.push(dir);
	return dir;
}

async function createFakeBiomeCommand(
	tempDir: string,
	expectedInput: string,
	formattedOutput: string,
): Promise<string> {
	const command = path.join(tempDir, "biome");
	const expectedInputPath = path.join(tempDir, "expected-input.ts");
	const formattedOutputPath = path.join(tempDir, "formatted-output.ts");
	await Bun.write(expectedInputPath, expectedInput);
	await Bun.write(formattedOutputPath, formattedOutput);
	await Bun.write(
		command,
		`#!/bin/sh
test "$1" = "format" || exit 7
test "$2" = "--write" || exit 8
test "$3" = "${path.join(tempDir, "example.ts")}" || exit 10
cmp -s "$3" "${expectedInputPath}" || exit 9
cp "${formattedOutputPath}" "$3"
exit 0
`,
	);
	await fs.chmod(command, 0o755);
	return command;
}

function biomeConfig(command: string): ServerConfig {
	return {
		command: "biome",
		fileTypes: [".ts"],
		rootMarkers: [],
		resolvedCommand: command,
	};
}

describe("BiomeClient format", () => {
	test("formats the supplied content instead of stale on-disk content", async () => {
		const tempDir = await makeTempDir();
		const targetFile = path.join(tempDir, "example.ts");
		const unformatted = "export const value:number=1\n";
		const formatted = "export const value: number = 1;\n";
		await Bun.write(targetFile, "export const stale = true;\n");
		const command = await createFakeBiomeCommand(tempDir, unformatted, formatted);
		const result = await new BiomeClient(biomeConfig(command), tempDir).format(targetFile, unformatted);

		expect(result).toBe(formatted);
		expect(await Bun.file(targetFile).text()).toBe(formatted);
	});

	test("formats configured TypeScript with the repository Biome", async () => {
		const scratchDir = await fs.mkdtemp(
			path.join(repoRoot, "packages", "coding-agent", "src", "__biome_client_test__-"),
		);
		tempDirs.push(scratchDir);
		const targetFile = path.join(scratchDir, "configured.ts");
		const unformatted = "export const configured:number=1\n";
		await Bun.write(targetFile, unformatted);

		const result = await new BiomeClient(biomeConfig(repoBiome), repoRoot).format(targetFile, unformatted);

		expect(result).toBe("export const configured: number = 1;\n");
	});

	test("leaves config-excluded content unchanged with the repository Biome", async () => {
		const excludedRoot = path.join(repoRoot, ".perf");
		const createdRoot = await fs.mkdir(excludedRoot, { recursive: true });
		if (createdRoot) tempRoots.push(excludedRoot);
		const scratchDir = await fs.mkdtemp(path.join(excludedRoot, "biome-client-test-"));
		tempDirs.push(scratchDir);
		const targetFile = path.join(scratchDir, "excluded.ts");
		const unformatted = "export const excluded:number=1\n";
		await Bun.write(targetFile, unformatted);

		const result = await new BiomeClient(biomeConfig(repoBiome), repoRoot).format(targetFile, unformatted);

		expect(result).toBe(unformatted);
	});

	test("returns the original content when Biome fails", async () => {
		const tempDir = await makeTempDir();
		const command = path.join(tempDir, "biome-failure");
		await Bun.write(command, "#!/bin/sh\ncat >/dev/null\nexit 1\n");
		await fs.chmod(command, 0o755);
		const targetFile = path.join(tempDir, "example.ts");
		const content = "export const value = 1;\n";

		const result = await new BiomeClient(biomeConfig(command), tempDir).format(targetFile, content);

		expect(result).toBe(content);
	});
});

describe("BiomeClient lint", () => {
	test("cancels a hung Biome process when diagnostics are aborted", async () => {
		const tempDir = await makeTempDir();
		const command = path.join(tempDir, "biome-hang");
		await Bun.write(command, "#!/bin/sh\nwhile :; do :; done\n");
		await fs.chmod(command, 0o755);
		const targetFile = path.join(tempDir, "example.ts");
		const started = Date.now();

		let rejected = false;
		try {
			await new BiomeClient(biomeConfig(command), tempDir).lint(targetFile, AbortSignal.timeout(50));
		} catch {
			rejected = true;
		}

		expect(rejected).toBe(true);
		expect(Date.now() - started).toBeLessThan(2_000);
	}, 5_000);

	test("surfaces Biome 2.x --reporter=json diagnostics", async () => {
		const tempDir = await makeTempDir();
		await Bun.write(
			path.join(tempDir, "biome.json"),
			`${JSON.stringify({ linter: { enabled: true, rules: { recommended: true } } })}\n`,
		);
		const targetFile = path.join(tempDir, "lint-me.ts");
		// `x == 2` triggers lint/suspicious/noDoubleEquals (a recommended rule).
		await Bun.write(targetFile, "const x: number = 1;\nif (x == 2) {\n}\n");

		const diagnostics = await new BiomeClient(biomeConfig(repoBiome), tempDir).lint(targetFile);

		const doubleEquals = diagnostics.find(d => d.code === "lint/suspicious/noDoubleEquals");
		expect(doubleEquals).toBeDefined();
		expect(doubleEquals?.source).toBe("biome");
		expect(doubleEquals?.severity).toBe(1);
		expect(doubleEquals?.message).toContain("==");
		// Biome reports `==` at line 2, columns 7-9 (1-indexed); LSP ranges are
		// 0-indexed, so the mapping must land on line 1, characters 6-8.
		expect(doubleEquals?.range).toEqual({
			start: { line: 1, character: 6 },
			end: { line: 1, character: 8 },
		});
	});

	test("returns no diagnostics for a clean file", async () => {
		const tempDir = await makeTempDir();
		await Bun.write(
			path.join(tempDir, "biome.json"),
			`${JSON.stringify({ linter: { enabled: true, rules: { recommended: true } } })}\n`,
		);
		const targetFile = path.join(tempDir, "clean.ts");
		await Bun.write(targetFile, "export const value = 1;\n");

		const diagnostics = await new BiomeClient(biomeConfig(repoBiome), tempDir).lint(targetFile);

		expect(diagnostics).toEqual([]);
	});
});
