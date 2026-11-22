#!/usr/bin/env bun
/**
 * Records which bundled modules each kind of omp process loads. `scripts/bundle-dist.ts` groups the npm
 * bundle's scripts by this profile (`scripts/bundle-profile.json`; see `scripts/bundle-groups.ts`).
 *
 *   bun scripts/bundle-profile.ts build dist/profile
 *     Splits the CLI build at every dynamic import into dist/profile, each script recording its own load.
 *     Keep the build inside the package so `@oh-my-pi/pi-natives` resolves to the workspace addon.
 *   OMP_BUNDLE_TRACE=<file> bun dist/profile/cli.js …
 *     Use omp as usual. Every process and worker thread it starts appends `pid, thread, role, script` lines.
 *   bun scripts/bundle-profile.ts collect dist/profile <trace-file>…
 *     Rewrites scripts/bundle-profile.json from the traces.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type BundleProfile, bundleModuleKey, profilePath } from "./bundle-groups";
import { cliBuildConfig } from "./bundle-dist";
import { buildDocsIndexPayload } from "./generate-docs-index";

/** Role of the main thread when no `__omp_worker_*` selector is present. */
const MAIN_ROLE = "session";

// Self-contained per script: chunks evaluate before the entry, so nothing can be shared through cli.js.
const tracer = `(globalThis.__ompBundleTrace??=(()=>{const f=process.env.OMP_BUNDLE_TRACE;if(!f)return()=>{};const fs=import.meta.require("node:fs");const t=import.meta.require("node:worker_threads").threadId;const r=process.argv.find(a=>a.startsWith("__omp_worker_"))?.slice(13)??${JSON.stringify(MAIN_ROLE)};return n=>{try{fs.appendFileSync(f,process.pid+"\\t"+t+"\\t"+r+"\\t"+n+"\\n")}catch{}}})())`;

async function build(dir: string): Promise<void> {
	await fs.rm(dir, { recursive: true, force: true });
	const docsPayload = await buildDocsIndexPayload();
	const output = await Bun.build({
		...(await cliBuildConfig(docsPayload.payload)),
		outdir: dir,
		splitting: true,
		naming: { entry: "cli.js", chunk: "cli-[name]-[hash].[ext]" },
		metafile: true,
	});
	if (!output.success || !output.metafile) {
		throw new Error(`Profile build failed:\n${output.logs.map(log => log.message).join("\n")}`);
	}
	let scripts = 0;
	for (const artifact of output.outputs) {
		if (artifact.kind !== "entry-point" && artifact.kind !== "chunk") continue;
		const name = path.basename(artifact.path);
		const lines = (await Bun.file(artifact.path).text()).split("\n");
		// After the shebang and `// @bun` pragma, which must stay first.
		let at = 0;
		while (at < lines.length && (lines[at].startsWith("#!") || lines[at].startsWith("//"))) at++;
		lines.splice(at, 0, `${tracer}(${JSON.stringify(name)});`);
		await Bun.write(artifact.path, lines.join("\n"));
		scripts++;
	}
	await Bun.write(path.join(dir, "metafile.json"), JSON.stringify(output.metafile));
	process.stdout.write(`Profile build: ${scripts} scripts in ${dir}\n`);
}

async function collect(dir: string, traceFiles: string[]): Promise<void> {
	const metafile: Bun.BuildMetafile = await Bun.file(path.join(dir, "metafile.json")).json();
	const modulesOfScript = new Map<string, string[]>();
	for (const [output, info] of Object.entries(metafile.outputs)) {
		modulesOfScript.set(path.basename(output), Object.keys(info.inputs).map(bundleModuleKey));
	}
	const rolesOfModule = new Map<string, Set<string>>();
	for (const file of traceFiles) {
		for (const line of (await Bun.file(file).text()).split("\n")) {
			const [, , role, script] = line.split("\t");
			if (!script) continue;
			const modules = modulesOfScript.get(script);
			if (!modules) throw new Error(`${file}: ${script} is not a script of the build in ${dir}`);
			for (const module of modules) {
				let roles = rolesOfModule.get(module);
				if (!roles) rolesOfModule.set(module, (roles = new Set()));
				roles.add(role);
			}
		}
	}
	// One line per module keeps regenerated profiles reviewable as diffs.
	const lines = [...rolesOfModule]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([module, roles]) => `\t\t${JSON.stringify(module)}: ${JSON.stringify([...roles].sort())}`);
	await Bun.write(profilePath, `{\n\t"modules": {\n${lines.join(",\n")}\n\t}\n}\n`);
	const profile: BundleProfile = await Bun.file(profilePath).json();
	const perRole = new Map<string, number>();
	for (const roles of Object.values(profile.modules))
		for (const role of roles) perRole.set(role, (perRole.get(role) ?? 0) + 1);
	process.stdout.write(
		`Wrote ${profilePath}: ${[...perRole].map(([role, count]) => `${role} ${count}`).join(", ")} modules\n`,
	);
}

const [command, dir, ...rest] = process.argv.slice(2);
if (command === "build" && dir) await build(path.resolve(dir));
else if (command === "collect" && dir && rest.length > 0) await collect(path.resolve(dir), rest);
else {
	process.stderr.write("Usage: bundle-profile.ts build <dir> | collect <dir> <trace-file>...\n");
	process.exit(2);
}
