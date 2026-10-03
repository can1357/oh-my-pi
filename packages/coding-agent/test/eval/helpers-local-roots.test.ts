import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { createHelpers, type HelperContext } from "../../src/eval/js/shared/helpers";

/**
 * The eval helpers (`read`/`write`) must substitute injected on-disk
 * roots for internal-URL schemes. Without it, `write("local://x.md")` hits a
 * stdlib `path.resolve` that collapses `local://` to `local:/`, creating a junk
 * `local:` directory under the cwd instead of landing where `read local://x.md`
 * resolves. These lock the substitution contract and its guards.
 */
function makeCtx(cwd: string, roots: Record<string, string>): HelperContext {
	return {
		cwd: () => cwd,
		env: new Map(),
		localRoots: () => roots,
		emitStatus: () => {},
	};
}

describe("eval js helpers internal-url resolution", () => {
	it("writes and reads local:// under the injected root", async () => {
		using tmp = TempDir.createSync("@eval-helpers-local-");
		const root = path.join(tmp.path(), "local");
		const helpers = createHelpers(makeCtx(tmp.path(), { local: root }));

		const written = await helpers.writeFile("local://notes/merge-map.md", "hello");
		expect(written).toBe(path.join(root, "notes", "merge-map.md"));
		expect(await Bun.file(written).text()).toBe("hello");
		expect(await helpers.read("local://notes/merge-map.md")).toBe("hello");

		// Regression: no literal `local:` directory created under the cwd.
		expect(await Bun.file(path.join(tmp.path(), "local:")).exists()).toBe(false);
		expect(await Bun.file(path.join(tmp.path(), "local:", "notes", "merge-map.md")).exists()).toBe(false);
	});

	it("rejects traversal and schemes without an injected root", async () => {
		using tmp = TempDir.createSync("@eval-helpers-guard-");
		const helpers = createHelpers(makeCtx(tmp.path(), { local: path.join(tmp.path(), "local") }));

		await expect(helpers.writeFile("local://../escape.md", "x")).rejects.toThrow(/traversal|escapes/i);
		await expect(helpers.writeFile("memory://x.md", "x")).rejects.toThrow(/not supported/i);
		await expect(helpers.read("https://example.com/page")).rejects.toThrow(/not supported/i);
	});

	it("recovers the single-slash typo local:/x.md (issue #8805)", async () => {
		using tmp = TempDir.createSync("@eval-helpers-single-slash-");
		const root = path.join(tmp.path(), "local");
		const helpers = createHelpers(makeCtx(tmp.path(), { local: root }));

		const written = await helpers.writeFile("local:/notes/typo.md", "hello");
		expect(written).toBe(path.join(root, "notes", "typo.md"));
		expect(await helpers.read("local:/notes/typo.md")).toBe("hello");

		// No literal `local:` directory created under the cwd.
		expect(await Bun.file(path.join(tmp.path(), "local:")).exists()).toBe(false);
	});

	it("rejects single-slash schemes without an injected root", async () => {
		using tmp = TempDir.createSync("@eval-helpers-single-slash-reject-");
		const helpers = createHelpers(makeCtx(tmp.path(), { local: path.join(tmp.path(), "local") }));

		await expect(helpers.writeFile("memory:/x.md", "x")).rejects.toThrow(/not supported/i);
	});

	if (process.platform === "win32") {
		it("leaves Windows drive spellings as filesystem paths", async () => {
			using tmp = TempDir.createSync("@eval-helpers-drive-");
			const helpers = createHelpers(makeCtx(tmp.path(), { c: path.join(tmp.path(), "c-root") }));

			// Must not route into protocol handling (and must not create c-root).
			await expect(helpers.read("C:/does-not-exist-omp-12345.txt")).rejects.not.toThrow(/not supported/i);
			expect(await Bun.file(path.join(tmp.path(), "c-root")).exists()).toBe(false);
		});
	}

	it("leaves plain relative and absolute paths resolving against the cwd", async () => {
		using tmp = TempDir.createSync("@eval-helpers-plain-");
		const helpers = createHelpers(makeCtx(tmp.path(), {}));

		const rel = await helpers.writeFile("foo/bar.txt", "bar");
		expect(rel).toBe(path.join(tmp.path(), "foo", "bar.txt"));
		expect(await helpers.read("foo/bar.txt")).toBe("bar");
	});
});
