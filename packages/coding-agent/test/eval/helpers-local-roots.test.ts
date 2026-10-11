import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { resolveEvalUrlRoots } from "../../src/eval/backend";
import { createHelpers, type HelperContext } from "../../src/eval/js/shared/helpers";
import type { ToolSession } from "../../src/tools";
import { rejectionOf } from "../helpers/rejection";

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

	it("leaves plain relative and absolute paths resolving against the cwd", async () => {
		using tmp = TempDir.createSync("@eval-helpers-plain-");
		const helpers = createHelpers(makeCtx(tmp.path(), {}));

		const rel = await helpers.writeFile("foo/bar.txt", "bar");
		expect(rel).toBe(path.join(tmp.path(), "foo", "bar.txt"));
		expect(await helpers.read("foo/bar.txt")).toBe("bar");
	});

	it("reads artifact://<id> as its file's full text, with offset/limit selecting lines", async () => {
		using tmp = TempDir.createSync("@eval-helpers-artifact-");
		const artifacts = path.join(tmp.path(), "artifacts");
		const wide = "v".repeat(14_430);
		await Bun.write(path.join(artifacts, "12.eval.log"), `${wide}\nsecond\nthird\n`);
		await Bun.write(path.join(artifacts, "120.bash.log"), "other");
		const helpers = createHelpers(makeCtx(tmp.path(), { artifact: artifacts }));

		expect(helpers.hasRoot("artifact://12")).toBe(true);
		expect(await helpers.read("artifact://12")).toBe(`${wide}\nsecond\nthird\n`);
		expect(await helpers.read("artifact://12", { offset: 2, limit: 1 })).toBe("second");
		// Not in this session's dir: the prelude falls back to the read tool.
		expect(await helpers.read("artifact://7")).toBeUndefined();
	});

	it("leaves artifact selectors to the read tool and refuses artifact writes", async () => {
		using tmp = TempDir.createSync("@eval-helpers-artifact-guard-");
		const artifacts = path.join(tmp.path(), "artifacts");
		const helpers = createHelpers(makeCtx(tmp.path(), { artifact: artifacts }));

		expect(helpers.hasRoot("artifact://12:raw:1-1")).toBe(false);
		expect(await rejectionOf(helpers.writeFile("artifact://12", "x"))).toMatchObject({
			message: expect.stringMatching(/not supported/i),
		});
		expect(await Bun.file(path.join(artifacts, "12")).exists()).toBe(false);
	});

	it("serves artifact:// from the session's artifacts dir, and leaves it to the read tool without one", async () => {
		using tmp = TempDir.createSync("@eval-helpers-session-artifacts-");
		await Bun.write(path.join(tmp.path(), "12.eval.log"), "artifact text");
		const withDir = { cwd: tmp.path(), getArtifactsDir: () => tmp.path() } as unknown as ToolSession;
		const withoutDir = { cwd: tmp.path() } as unknown as ToolSession;

		const helpers = createHelpers(makeCtx(tmp.path(), resolveEvalUrlRoots(withDir)));
		expect(await helpers.read("artifact://12")).toBe("artifact text");
		expect(createHelpers(makeCtx(tmp.path(), resolveEvalUrlRoots(withoutDir))).hasRoot("artifact://12")).toBe(false);
	});
});
