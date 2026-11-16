import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";

const packageDir = path.join(import.meta.dir, "..");

describe("published @oh-my-pi/omp-stats package", () => {
	it("ships the file behind the test-support export", async () => {
		const manifest = (await Bun.file(path.join(packageDir, "package.json")).json()) as {
			exports: Record<string, { import: string }>;
		};
		const target = manifest.exports["./test-support/temp-agent"].import;
		const output = await $`${process.execPath} pm pack --dry-run --ignore-scripts`.cwd(packageDir).quiet().text();
		const packed = Array.from(output.matchAll(/^packed \S+ (.+)$/gm), match => `./${match[1]}`);
		expect(packed).toContain(target);
	});
});
