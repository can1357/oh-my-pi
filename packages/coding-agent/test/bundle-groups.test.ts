import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { buildGroupedBundle, bundleModuleKey } from "../scripts/bundle-groups";

describe("grouped npm bundle", () => {
	it("keeps import() semantics while grouping modules by the processes that load them", async () => {
		using dir = TempDir.createSync("@omp-bundle-groups-");
		const source = dir.join("source");
		await Bun.write(
			`${source}/entry.ts`,
			[
				"export async function main() {",
				'\tconst factory = (await import("./factory.cjs")).default;',
				'\tconst { value } = await import("./awaits.ts");',
				'\tconst { same } = await import("./same.ts");',
				'\tconst { other } = await import("./other.ts");',
				"\tconst text = 'import(\"./other.ts\")';",
				"\treturn { factory: factory(), value, same, other, text };",
				"}",
				"main().then(result => console.log(JSON.stringify(result)));",
			].join("\n"),
		);
		await Bun.write(`${source}/factory.cjs`, 'module.exports = function factory() { return "factory"; };\n');
		await Bun.write(`${source}/awaits.ts`, 'export const value = await Promise.resolve("awaited");\n');
		await Bun.write(`${source}/same.ts`, 'export const same = "same";\n');
		await Bun.write(`${source}/other.ts`, 'export const other = "other";\n');
		const key = (file: string) => bundleModuleKey(path.join(source, file));
		// The entry and same.ts load in sessions only, other.ts in workers only: two groups.
		const profile = {
			modules: { [key("entry.ts")]: ["session"], [key("same.ts")]: ["session"], [key("other.ts")]: ["worker"] },
		};

		const outdir = dir.join("dist");
		const output = await buildGroupedBundle(
			{ entrypoints: [`${source}/entry.ts`], target: "bun", plugins: [], outdir, metafile: true },
			profile,
		);
		expect(output.success, output.logs.map(log => log.message).join("\n")).toBe(true);

		const child = Bun.spawn([process.execPath, `${outdir}/entry.js`], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			factory: "factory",
			value: "awaited",
			same: "same",
			other: "other",
			text: 'import("./other.ts")',
		});

		const entryScript = Object.values(output.metafile!.outputs).find(info => info.entryPoint)!;
		const entryModules = Object.keys(entryScript.inputs).map(input => path.basename(input));
		expect(entryModules).toContain("same.ts");
		expect(entryModules).not.toContain("other.ts");
	}, 30_000);
});
