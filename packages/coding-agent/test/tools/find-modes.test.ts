import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inferFindMode, resolveFindMode, scopeWithGlob } from "../../src/tools/jfind/modes";
import { missingPathMessage, missingPathRecovery } from "../../src/tools/path-utils";

describe("find mode resolution", () => {
	it("picks the engine the supplied arguments point at", () => {
		expect(resolveFindMode({ query: "where is retry handled" })).toBe("semantic");
		expect(resolveFindMode({ pattern: "TODO", glob: "*.ts" })).toBe("content");
		expect(resolveFindMode({ glob: "src/**/*.ts" })).toBe("names");
		expect(resolveFindMode({ path: "src" })).toBe("names");
	});

	it("infers a mode without throwing so approval can classify an invalid call", () => {
		expect(inferFindMode({ query: "x", pattern: "y" })).toBe("semantic");
		expect(inferFindMode({})).toBe("semantic");
	});

	it("refuses a judged query mixed with an exact mode, saying why and what each is for", () => {
		expect(() => resolveFindMode({ query: "retry", pattern: "retry" })).toThrow(/judged search that can miss/);
		expect(() => resolveFindMode({ query: "retry", glob: "*.ts" })).toThrow(/`pattern`\/`glob` to match text or names exactly/);
	});

	it("refuses an empty call by listing the three modes", () => {
		let message = "";
		try {
			resolveFindMode({});
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("`query`");
		expect(message).toContain("`pattern`");
		expect(message).toContain("`glob`");
	});

	it("refuses arguments the chosen mode would silently ignore", () => {
		expect(() => resolveFindMode({ pattern: "x", hidden: true })).toThrow(/`hidden` does not apply to content mode/);
		expect(() => resolveFindMode({ glob: "*.ts", case: false })).toThrow(/`case` does not apply to names mode/);
		expect(() => resolveFindMode({ query: "x", limit: 5 })).toThrow(/`limit` does not apply to semantic mode/);
	});
});

describe("find scope joining", () => {
	it("applies each glob to each root", () => {
		expect(scopeWithGlob("src;lib/", "*.ts;*.tsx")).toBe("src/*.ts;src/*.tsx;lib/*.ts;lib/*.tsx");
	});

	it("uses the globs alone when no path is given", () => {
		expect(scopeWithGlob(undefined, "**/*.md")).toBe("**/*.md");
	});

	it("leaves the path untouched without a glob", () => {
		expect(scopeWithGlob("src;!**/*.test.ts", undefined)).toBe("src;!**/*.test.ts");
	});

	it("passes exclusions through instead of attaching a glob to them", () => {
		expect(scopeWithGlob("src;!**/*.test.ts", "*.ts")).toBe("src/*.ts;!**/*.test.ts");
	});

	it("refuses a glob on a path that is already a glob", () => {
		expect(() => scopeWithGlob("src/**/*.ts", "*.md")).toThrow(/already contains a glob/);
	});
});

describe("missing path recovery", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "find-missing-"));
		await fs.mkdir(path.join(cwd, "src", "deep"), { recursive: true });
		await fs.writeFile(path.join(cwd, "src", "Config.ts"), "export {};\n");
		await fs.writeFile(path.join(cwd, "src", "deep", "unique-name.ts"), "export {};\n");
		await fs.writeFile(path.join(cwd, "README.md"), "# x\n");
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("names the unique file whose trailing path matches", async () => {
		const recovery = await missingPathRecovery("deep/unique-name.ts", cwd);
		expect(recovery).toContain("Did you mean");
		expect(recovery).toContain("unique-name.ts");
	});

	it("names the same file differing only by case", async () => {
		const recovery = await missingPathRecovery("src/config.ts", cwd);
		expect(recovery).toContain("Config.ts");
		expect(recovery).toContain("case-sensitive");
	});

	it("lists what the nearest existing directory holds when nothing resembles the path", async () => {
		const recovery = await missingPathRecovery("src/nothing/here.ts", cwd);
		expect(recovery).toContain("`src` exists and holds");
		expect(recovery).toContain("deep/");
		expect(recovery).toContain("Config.ts");
	});

	it("has nothing to add for URLs", async () => {
		expect(await missingPathRecovery("local://missing.md", cwd)).toBeUndefined();
		expect(await missingPathMessage("local://missing.md", cwd)).toBe("Path not found: local://missing.md");
	});

	it("keeps the plain message first so callers can still match on it", async () => {
		const message = await missingPathMessage("src/nothing/here.ts", cwd);
		expect(message.startsWith("Path not found: src/nothing/here.ts. ")).toBe(true);
	});
});
