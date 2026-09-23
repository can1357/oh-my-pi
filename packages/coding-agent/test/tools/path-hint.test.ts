import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describeNearestExistingDir, withPathHint } from "../../src/tools/path-hint";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "path-hint-test-"));
afterAll(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("describeNearestExistingDir", () => {
	test("lists the nearest existing ancestor, directories first", async () => {
		const root = await fs.mkdtemp(path.join(tempRoot, "nearest-"));
		await fs.mkdir(path.join(root, "src", "sub"), { recursive: true });
		await fs.writeFile(path.join(root, "README.md"), "x");

		const hint = await describeNearestExistingDir(path.join(root, "src", "sub", "missing.ts"), "/");
		expect(hint).toBe(`Nearest existing directory: ${path.join(root, "src", "sub")}/ (empty)`);

		const parentHint = await describeNearestExistingDir(path.join(root, "nope"), "/");
		expect(parentHint).toBe(`Nearest existing directory: ${root}/ contains: src/, README.md`);
	});

	test("caps the listing at 12 entries and reports the remainder", async () => {
		const many = await fs.mkdtemp(path.join(tempRoot, "cap-"));
		for (let i = 1; i <= 14; i++) {
			await fs.writeFile(path.join(many, `f${String(i).padStart(2, "0")}.txt`), "x");
		}

		const hint = await describeNearestExistingDir(path.join(many, "missing"), "/");
		expect(hint).toContain("f01.txt");
		expect(hint).toContain("f12.txt");
		expect(hint).not.toContain("f13.txt");
		expect(hint).toContain("… +2 more");
	});

	test("resolves relative paths against the supplied base directory", async () => {
		const root = await fs.mkdtemp(path.join(tempRoot, "relative-"));
		await fs.mkdir(path.join(root, "src", "sub"), { recursive: true });
		const hint = await describeNearestExistingDir("src/missing.ts", root);
		expect(hint).toBe(`Nearest existing directory: ${path.join(root, "src")}/ contains: sub/`);
	});

	test("returns undefined when no ancestor exists within the hop budget", async () => {
		const deep = ["/definitely-not-a-root", "a", "b", "c", "d", "e", "f", "g", "h", "missing"].join("/");
		expect(await describeNearestExistingDir(deep, "/")).toBeUndefined();
	});
});

describe("withPathHint", () => {
	test("appends the hint on a new line when available", async () => {
		const root = await fs.mkdtemp(path.join(tempRoot, "append-"));
		await fs.mkdir(path.join(root, "src"));
		await fs.writeFile(path.join(root, "README.md"), "x");
		const message = await withPathHint("Path not found: thing", path.join(root, "thing"), "/");
		expect(message).toBe(`Path not found: thing\nNearest existing directory: ${root}/ contains: src/, README.md`);
	});

	test("returns the original message when no hint is available", async () => {
		const deep = "/definitely-not-a-root/a/b/c/d/e/f/g/h/missing";
		expect(await withPathHint("Path not found: deep", deep, "/")).toBe("Path not found: deep");
	});
});
