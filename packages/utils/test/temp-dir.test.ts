import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "../src/temp";

const tmpRoot = path.resolve(os.tmpdir());

function isUnder(root: string, target: string): boolean {
	const relative = path.relative(root, path.resolve(target));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

describe("TempDir prefix placement", () => {
	it("places @-prefixed directories under the OS temp dir", async () => {
		using sync = TempDir.createSync("@pi-temp-at-sync-");
		await using async = await TempDir.create("@pi-temp-at-async-");
		expect(isUnder(tmpRoot, sync.path())).toBe(true);
		expect(isUnder(tmpRoot, async.path())).toBe(true);
		expect(path.basename(sync.path())).toStartWith("pi-temp-at-sync-");
	});

	it("treats bare relative prefixes as tmpdir-relative instead of CWD-relative", async () => {
		using sync = TempDir.createSync("pi-temp-bare-sync-");
		await using async = await TempDir.create("pi-temp-bare-async-");
		for (const dir of [sync.path(), async.path()]) {
			expect(isUnder(tmpRoot, dir)).toBe(true);
			expect(isUnder(process.cwd(), dir)).toBe(false);
		}
	});

	it("respects absolute prefixes verbatim", async () => {
		using root = TempDir.createSync("@pi-temp-abs-root-");
		using nested = TempDir.createSync(path.join(root.path(), "nested-"));
		expect(isUnder(root.path(), nested.path())).toBe(true);
		expect(path.basename(nested.path())).toStartWith("nested-");
	});

	it("defaults to a pi-temp- directory under the OS temp dir", () => {
		using dir = TempDir.createSync();
		expect(isUnder(tmpRoot, dir.path())).toBe(true);
		expect(path.basename(dir.path())).toStartWith("pi-temp-");
	});
});
