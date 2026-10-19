import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { createJsonParsePlugin } from "../scripts/json-parse-plugin";

describe("large JSON build assets", () => {
	for (const compiled of [false, true]) {
		it(`preserves JSON values after relocating a ${compiled ? "compiled executable" : "bundle"}`, async () => {
			using dir = TempDir.createSync("@omp-json-assets-");
			const source = dir.join("source with spaces");
			const first = JSON.parse(
				'{"__proto__":{"safe":true},"text":"quotes \\\" and slash \\\\ and ☃","nested":[null,false,0,-3.5,{"π":"😀"}]}',
			) as Record<string, unknown>;
			first.padding = "x".repeat(256 * 1024);
			const second = { text: "different asset with the same basename".repeat(8000), values: [true, "", 1e30] };
			await Bun.write(`${source}/one/data.json`, `\uFEFF${JSON.stringify(first)}`);
			await Bun.write(`${source}/two/data.json`, JSON.stringify(second));
			await Bun.write(
				`${source}/entry.ts`,
				[
					'import first from "./one/data.json";',
					'import second from "./two/data.json";',
					"console.log(JSON.stringify([first, second]));",
				].join("\n"),
			);
			const buildDir = dir.join("build");
			const executable = process.platform === "win32" ? "app.exe" : "app";
			const result = await Bun.build({
				entrypoints: [`${source}/entry.ts`],
				target: "bun",
				format: "esm",
				plugins: [createJsonParsePlugin()],
				...(compiled
					? { compile: { outfile: `${buildDir}/${executable}` }, bytecode: true, splitting: true }
					: { outdir: buildDir }),
			});
			expect(result.success, result.logs.map(log => log.message).join("\n")).toBe(true);
			const relocated = dir.join("relocated");
			await fs.rename(buildDir, relocated);
			await fs.rm(source, { recursive: true });
			const child = Bun.spawn(
				compiled ? [`${relocated}/${executable}`] : [process.execPath, `${relocated}/entry.js`],
				{
					cwd: dir.path(),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(JSON.parse(stdout)).toEqual([first, second]);
		}, 30_000);
	}

	it("rejects invalid large JSON while building", async () => {
		using dir = TempDir.createSync("@omp-json-invalid-");
		await Bun.write(dir.join("invalid.json"), '{"broken":');
		await Bun.write(dir.join("entry.ts"), 'import data from "./invalid.json"; console.log(data);');
		const result = await Bun.build({
			entrypoints: [dir.join("entry.ts")],
			target: "bun",
			plugins: [createJsonParsePlugin(0)],
			throw: false,
		});
		expect(result.success).toBe(false);
		expect(result.logs.some(log => log.message.includes("JSON"))).toBe(true);
	});
});
