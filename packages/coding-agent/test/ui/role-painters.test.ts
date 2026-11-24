import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { rolePainterRegistrations } from "@oh-my-pi/pi-tui/term/paint";

const STYLES = path.join(import.meta.dir, "../../src/ui/styles");
const PAINTERS = path.join(path.dirname(Bun.resolveSync("@oh-my-pi/pi-tui/term/paint", import.meta.dir)), "painters");

/** Every module under `dir` that may register looks. */
async function modules(dir: string): Promise<string[]> {
	const files = await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: dir, absolute: true }));
	return files.filter(file => !file.endsWith(".d.ts")).sort();
}

describe("role painters", () => {
	test("each kind|role is registered once across all style modules", async () => {
		// Globbed at run time so a new style module is covered without editing this list.
		for (const file of [...(await modules(PAINTERS)), ...(await modules(STYLES))]) await import(file);
		const duplicates: string[] = [];
		for (const [key, count] of rolePainterRegistrations()) if (count > 1) duplicates.push(`${key} ×${count}`);
		expect(duplicates).toEqual([]);
	});
});
