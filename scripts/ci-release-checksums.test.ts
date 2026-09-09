import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { formatChecksums } from "./ci-release-checksums";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("formatChecksums", () => {
	it("sorts entries by basename and formats as `sha256sum -c`-compatible lines", () => {
		const output = formatChecksums([
			{ name: "omp-linux-x64", sha256: "b".repeat(64) },
			{ name: "omp-darwin-arm64", sha256: "a".repeat(64) },
		]);
		expect(output).toBe(`${"a".repeat(64)}  omp-darwin-arm64\n${"b".repeat(64)}  omp-linux-x64\n`);
	});

	it("hashes assets and writes a sorted checksum manifest", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "omp-release-checksums-"));
		tempDirs.push(dir);
		const aPath = path.join(dir, "omp-a");
		const zPath = path.join(dir, "omp-z");
		const outPath = path.join(dir, "SHA256SUMS.txt");
		await Promise.all([writeFile(aPath, "abc"), writeFile(zPath, "")]);

		const result = await $`bun ${path.join(import.meta.dir, "ci-release-checksums.ts")} ${outPath} ${zPath} ${aPath}`
			.quiet()
			.nothrow();

		expect(result.exitCode).toBe(0);
		expect(await readFile(outPath, "utf8")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  omp-a\n" +
				"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  omp-z\n",
		);
	});

	it("returns an empty string for no entries", () => {
		expect(formatChecksums([])).toBe("");
	});
});
