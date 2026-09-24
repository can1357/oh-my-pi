import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describeNearestExistingDir, formatDirectoryDisplay, withPathHint } from "../../src/tools/path-hint";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "path-hint-test-"));
afterAll(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("formatDirectoryDisplay", () => {
	test("prefers a cwd-relative display with a trailing slash", () => {
		const root = path.join(tempRoot, "display-");
		expect(formatDirectoryDisplay(path.join(root, "src"), root)).toBe("src/");
		expect(formatDirectoryDisplay(root, root)).toBe(".");
	});

	test("shortens home paths outside the cwd", () => {
		expect(formatDirectoryDisplay(path.join(os.homedir(), "somewhere", "src"), tempRoot)).toBe("~/somewhere/src/");
	});

	test("renders the filesystem root without doubling the separator", () => {
		const root = path.parse(tempRoot).root;
		expect(formatDirectoryDisplay(root, tempRoot)).toBe(root.replaceAll("\\", "/"));
	});
});

describe("describeNearestExistingDir", () => {
	test("lists the nearest existing ancestor relative to the base directory, directories first", async () => {
		const root = await fs.mkdtemp(path.join(tempRoot, "nearest-"));
		await fs.mkdir(path.join(root, "src", "sub"), { recursive: true });
		await fs.writeFile(path.join(root, "README.md"), "x");

		const hint = await describeNearestExistingDir(
			path.join(root, "src", "sub", "missing.ts"),
			path.join(root, "src"),
		);
		expect(hint).toBe("Nearest existing directory: sub/ (empty)");

		const parentHint = await describeNearestExistingDir(path.join(root, "nope"), root);
		expect(parentHint).toBe("Nearest existing directory: . contains: src/, README.md");
	});

	test("caps the listing at 12 entries and reports the remainder", async () => {
		const many = await fs.mkdtemp(path.join(tempRoot, "cap-"));
		for (let i = 14; i >= 1; i--) {
			await fs.writeFile(path.join(many, `f${String(i).padStart(2, "0")}.txt`), "x");
		}

		const hint = await describeNearestExistingDir(path.join(many, "missing"), many);
		expect(hint).toContain("f01.txt");
		expect(hint).toContain("f12.txt");
		expect(hint).not.toContain("f13.txt");
		expect(hint).toContain("… +2 more");
	});

	test("resolves relative paths against the supplied base directory", async () => {
		const root = await fs.mkdtemp(path.join(tempRoot, "relative-"));
		await fs.mkdir(path.join(root, "src", "sub"), { recursive: true });
		const hint = await describeNearestExistingDir("src/missing.ts", root);
		expect(hint).toBe("Nearest existing directory: src/ contains: sub/");
	});

	test("returns undefined when no ancestor exists within the hop budget", async () => {
		// Nine segments below tempRoot: eight hops never climb past the first
		// one, so the result cannot depend on host state outside tempRoot.
		const deep = path.join(tempRoot, "a", "b", "c", "d", "e", "f", "g", "h", "missing");
		expect(await describeNearestExistingDir(deep, tempRoot)).toBeUndefined();
	});

	test("returns undefined when the abort signal fires before the scan", async () => {
		const root = await fs.mkdtemp(path.join(tempRoot, "abort-"));
		await fs.writeFile(path.join(root, "f.txt"), "x");
		const controller = new AbortController();
		controller.abort();
		expect(await describeNearestExistingDir(path.join(root, "missing"), root, controller.signal)).toBeUndefined();
	});
});

describe("withPathHint", () => {
	test("appends the hint on a new line when available", async () => {
		const root = await fs.mkdtemp(path.join(tempRoot, "append-"));
		await fs.mkdir(path.join(root, "src"));
		await fs.writeFile(path.join(root, "README.md"), "x");
		const message = await withPathHint("Path not found: thing", path.join(root, "thing"), root);
		expect(message).toBe("Path not found: thing\nNearest existing directory: . contains: src/, README.md");
	});

	test("returns the original message when no hint is available", async () => {
		const deep = path.join(tempRoot, "a", "b", "c", "d", "e", "f", "g", "h", "missing");
		expect(await withPathHint("Path not found: deep", deep, tempRoot)).toBe("Path not found: deep");
	});
});
