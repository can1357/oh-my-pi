import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { resolveFilesnapNpmBinary } from "../src/utils/filesnap-npm";

const dirs: string[] = [];
const entrypoint = path.join(import.meta.dir, "fixtures/filesnap-distribution-probe.ts");
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
async function fixture(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-filesnap-distribution-"));
	dirs.push(dir);
	return dir;
}
async function probe(command: string[], base: string): Promise<void> {
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: "" };
	delete env.FILESNAP_BIN;
	delete env.FILESNAP_TEST_BIN;
	const child = Bun.spawn([...command, base], { cwd: base, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
	expect(JSON.parse(stdout)).toEqual({ restored: [0, 255, 3], redone: [1, 2] });
}

test("standalone rewind and redo need no node_modules, PATH tools or FILESNAP_BIN, even on concurrent first use", async () => {
	const base = await fixture();
	const binary = path.join(base, process.platform === "win32" ? "probe.exe" : "probe");
	// Isolate Bun's compile file cache from other in-process bundle tests.
	const build = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/filesnap-build-probe.ts"), binary], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [buildError, buildCode] = await Promise.all([new Response(build.stderr).text(), build.exited]);
	expect({ buildCode, buildError }).toEqual({ buildCode: 0, buildError: "" });
	await Promise.all([probe([binary], base), probe([binary], base)]);
	// A subsequent process must reuse the extracted executable successfully.
	await probe([binary], base);
}, 120_000);

test("npm bundles use the installed filesnap dependency without a separate global CLI", async () => {
	const base = await fixture();
	const output = await Bun.build({ entrypoints: [entrypoint], outdir: base, target: "bun", external: ["filesnap"] });
	if (!output.success) throw new AggregateError(output.logs, "Probe bundle failed");
	const launcher = createRequire(import.meta.url).resolve("filesnap/bin/filesnap.mjs");
	const dependency = path.resolve(launcher, "../..");
	const platformBinary = resolveFilesnapNpmBinary();
	const platformPackage = path.resolve(platformBinary, "../../../..");
	const slug = `${process.platform === "android" ? "linux" : process.platform}-${process.arch}`;
	await fs.cp(dependency, path.join(base, "node_modules/filesnap"), { recursive: true, dereference: true });
	await fs.cp(platformPackage, path.join(base, "node_modules", `filesnap-${slug}`), {
		recursive: true,
		dereference: true,
	});
	await probe([process.execPath, path.join(base, "filesnap-distribution-probe.js")], base);
}, 30_000);
