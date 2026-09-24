import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveReadPath, resolveReadPathAsync } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

/**
 * Regression for issue #12805: `expandPath()` collapsed U+00A0 (and the other
 * unicode spaces) to ASCII before any filesystem probe, so a file whose real
 * name contained NBSP was unaddressable — and, when an ASCII-space sibling
 * existed, `resolveReadPath` silently returned that sibling's bytes. The read
 * resolvers now probe the literal on-disk name first and fall back to the
 * collapsed form only when the literal does not exist.
 */
describe("unicode-space filename resolution (issue #12805)", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function tmpDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-nbsp-"));
		dirs.push(dir);
		return dir;
	}

	it("resolves a lone NBSP file to itself instead of a nonexistent ASCII-space path", () => {
		const dir = tmpDir();
		const nbsp = path.join(dir, "shot\u00a0name.png");
		fs.writeFileSync(nbsp, "RIGHT");
		const resolved = resolveReadPath(nbsp, dir);
		expect(resolved).toBe(nbsp);
		expect(fs.readFileSync(resolved, "utf8")).toBe("RIGHT");
	});

	it("never substitutes an ASCII-space sibling for the requested NBSP file", () => {
		const dir = tmpDir();
		const nbsp = path.join(dir, "shot\u00a0name.png");
		fs.writeFileSync(nbsp, "RIGHT");
		fs.writeFileSync(path.join(dir, "shot name.png"), "WRONG");
		expect(fs.readFileSync(resolveReadPath(nbsp, dir), "utf8")).toBe("RIGHT");
	});

	it("async resolver honors the same literal-first ordering", async () => {
		const dir = tmpDir();
		const nbsp = path.join(dir, "shot\u00a0name.png");
		fs.writeFileSync(nbsp, "RIGHT");
		fs.writeFileSync(path.join(dir, "shot name.png"), "WRONG");
		expect(fs.readFileSync(await resolveReadPathAsync(nbsp, dir), "utf8")).toBe("RIGHT");
	});

	it("still falls back to the collapsed form for paste-from-web (ASCII file, NBSP request)", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, "web page.txt"), "ASCII");
		const nbspRequest = path.join(dir, "web\u00a0page.txt");
		const resolved = resolveReadPath(nbspRequest, dir);
		expect(resolved).toBe(path.join(dir, "web page.txt"));
		expect(fs.readFileSync(resolved, "utf8")).toBe("ASCII");
	});

	it("addresses the other collapsed unicode spaces (U+202F narrow no-break space)", () => {
		const dir = tmpDir();
		const narrow = path.join(dir, "at\u202f14.20.png");
		fs.writeFileSync(narrow, "NARROW");
		fs.writeFileSync(path.join(dir, "at 14.20.png"), "WRONG");
		expect(fs.readFileSync(resolveReadPath(narrow, dir), "utf8")).toBe("NARROW");
	});
});
