import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RunTrace, Shell, ShellVisualization, type ShellVizOptions } from "../native/index.js";

it("refuses an incompatible saved conditional by syntax archive version, not by serde decoding", async () => {
	// RunTrace.snapshot() from main 602aaee4cd3101c14e6c821a41a200f311896146,
	// whose conditional syntax predates the flat chains and operator offsets.
	const legacy = await Bun.file(new URL("./fixtures/shell-trace-syntax-v1.json", import.meta.url)).text();
	const { script: command } = JSON.parse(legacy) as { script: string };
	const trace = new RunTrace(command);
	const result = await new Shell().run({ command, trace });
	expect(result.exitCode).toBe(0);
	const options: ShellVizOptions = {
		view: "pseudo",
		layers: { color: false, inline: true, idioms: true, effects: true, unwrap: true },
		split: false,
		playing: false,
		speed: 1,
		expandedNodes: [],
	};
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shell-trace-archive-"));
	try {
		const file = path.join(directory, "trace.json");
		await Bun.write(file, trace.snapshot());
		const restored = new ShellVisualization(await Bun.file(file).text());
		expect(JSON.parse(restored.present(options))).toEqual(JSON.parse(trace.present(options)));
		expect(() => new ShellVisualization(legacy)).toThrow("unsupported native syntax archive version");
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
