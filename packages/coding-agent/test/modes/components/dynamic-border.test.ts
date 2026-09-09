import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DynamicBorder } from "../../../src/modes/components/dynamic-border";
import { getThemeByName, setThemeInstance, theme } from "../../../src/modes/theme/theme";

const componentPath = path.resolve(import.meta.dir, "../../../src/modes/components/dynamic-border.ts");

describe("DynamicBorder", () => {
	// Regression for #5366: extensions importing legacy pi UI components get a
	// second `src` module graph whose module-level `theme` is never assigned by
	// host startup. `render()` must degrade to plain glyphs instead of throwing
	// "undefined is not an object (evaluating 'theme.boxRound')" and killing the
	// TUI. Other test files in the same process initialize the theme module, so
	// the uninitialized state is only reachable in a fresh module graph — a
	// subprocess reproduces the actual reported scenario deterministically.
	it("renders plain glyphs when the module-level theme is uninitialized", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dynamic-border-"));
		try {
			const script = [
				`import { DynamicBorder } from ${JSON.stringify(componentPath)};`,
				'const custom = new DynamicBorder(str => "<" + str + ">");',
				`if (JSON.stringify(custom.render(4)) !== JSON.stringify(["<────>"])) process.exit(1);`,
				"const plain = new DynamicBorder();",
				`if (JSON.stringify(plain.render(3)) !== JSON.stringify(["───"])) process.exit(2);`,
				"",
			].join("\n");
			const file = path.join(dir, "uninitialized-theme.ts");
			await Bun.write(file, script);
			const proc = Bun.spawn(["bun", file], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			const [exitCode, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("paints with theme.boxRound.horizontal once the theme is initialized", async () => {
		const previous = theme;
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
		try {
			const border = new DynamicBorder(str => `<${str}>`);
			expect(border.render(3)).toEqual([`<${loaded.boxRound.horizontal.repeat(3)}>`]);
		} finally {
			if (previous) setThemeInstance(previous);
		}
	});
});
