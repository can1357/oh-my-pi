import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const packageDir = path.join(import.meta.dir, "..");

describe("published @oh-my-pi/omp-stats package", () => {
	it("ships the file behind the test-support export", async () => {
		const manifest = (await Bun.file(path.join(packageDir, "package.json")).json()) as {
			exports: Record<string, { import: string }>;
		};
		const target = manifest.exports["./test-support/temp-agent"].import;
		using temp = TempDir.createSync("@pi-stats-pack-");
		const tarball = temp.join("stats.tgz");
		// List the tarball itself: the pack log is human-readable and coloured
		// whenever the invoking shell sets FORCE_COLOR.
		await $`${process.execPath} pm pack --ignore-scripts --quiet --filename ${tarball}`.cwd(packageDir).quiet();
		const files = await new Bun.Archive(await Bun.file(tarball).bytes()).files();
		expect([...files.keys()]).toContain(path.posix.join("package", target));
	});
});
