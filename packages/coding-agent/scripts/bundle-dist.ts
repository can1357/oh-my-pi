#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { buildDocsIndexPayload } from "./generate-docs-index";

const packageDir = path.join(import.meta.dir, "..");
const outDir = path.join(packageDir, "dist");
const cliPath = path.join(outDir, "cli.js");
const shebang = "#!/usr/bin/env bun\n";
const legacyHtmlExportAssetPattern = /^(?:template-[^.]+\.(?:css|html|js)|tool-views\.generated-[^.]+\.js)$/;

// Native / optional / platform-specific deps are loaded from installed files.
// `omp-legacy-pi-modules` exists only in compiled binaries via the build plugin;
// the npm bundle never executes that `isCompiledBinary()` branch.
const ALWAYS_EXTERNAL = [
	"@oh-my-pi/pi-natives",
	"@huggingface/transformers",
	"fastembed",
	"onnxruntime-node",
	"omp-legacy-pi-modules",
];

// Heavy, lazily-used third-party leaf deps. Each is a declared `dependency`, so the
// published package resolves it from node_modules at runtime; bundling only embeds a
// redundant copy that bloats dist/cli.js. NEVER add a patched dependency here — the
// bundle is where a root `patchedDependencies` patch is baked in, so an externalized
// import would load the unpatched npm package in users' installs (currently
// @ark/schema is patched, so it — and arktype, which pulls @ark/schema — stay
// bundled).
const RUNTIME_EXTERNAL = ["puppeteer-core", "@babel/parser"];

async function runCommand(command: string[]): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: packageDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

async function ensureShebang(): Promise<void> {
	const text = await Bun.file(cliPath).text();
	if (text.startsWith(shebang)) return;
	const withoutExisting = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;
	await Bun.write(cliPath, shebang + withoutExisting);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

async function cleanBundleOutputs(): Promise<void> {
	// dist/ is shared with the dev binary (dist/omp); only remove assets
	// emitted by this script.
	let entries: string[];
	try {
		entries = await fs.readdir(outDir);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	await Promise.all(
		entries
			.filter(
				entry =>
					entry === "cli.js" ||
					entry === "docs-index.generated.txt" ||
					entry.endsWith(".node") ||
					entry.endsWith(".js.map") ||
					(entry.startsWith("CHANGELOG-") && entry.endsWith(".md")) ||
					entry.startsWith("omp-apple-fm-") ||
					legacyHtmlExportAssetPattern.test(entry),
			)
			.map(entry => fs.rm(path.join(outDir, entry), { force: true })),
	);
}

async function main(): Promise<void> {
	const start = Bun.nanoseconds();
	await cleanBundleOutputs();
	// The npm bundle ships no stats dashboard sources, so embed the dashboard
	// archive the same way compiled binaries do (scripts/build-binary.ts). Reset
	// afterwards to keep the checked-in placeholder empty.
	await runCommand(["bun", "--cwd=../stats", "run", "gen:stats"]);
	// One payload for both consumers: inlined into dist/cli.js via `--define` for
	// the bundled CLI entrypoint, and written to dist/docs-index.generated.txt so
	// SDK consumers importing `@oh-my-pi/pi-coding-agent/*` (TypeScript source, no
	// build-time embed) can still resolve omp:// docs (see src/internal-urls/docs-index.ts).
	try {
		const docsPayload = await buildDocsIndexPayload();
		// Build in-process: the docs embed payload is far larger than Linux's
		// 128KiB per-argv-string cap, so it can never be passed as a CLI
		// `--define` (posix_spawn fails with E2BIG).
		const output = await Bun.build({
			entrypoints: [path.join(packageDir, "src/cli.ts")],
			outdir: outDir,
			target: "bun",
			external: [...ALWAYS_EXTERNAL, ...RUNTIME_EXTERNAL],
			define: {
				"process.env.PI_BUNDLED": JSON.stringify("true"),
				"process.env.PI_DOCS_EMBED": JSON.stringify(docsPayload.payload),
			},
			minify: {
				whitespace: true,
				syntax: true,
				identifiers: true,
				keepNames: true,
			},
			throw: false,
		});
		if (!output.success) {
			throw new Error(`CLI bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
		}
		await ensureShebang();
		await Bun.write(path.join(outDir, "docs-index.generated.txt"), docsPayload.payload);
	} finally {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats:reset"]);
	}
	const stat = await fs.stat(cliPath);
	const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;
	process.stdout.write(
		`Bundled coding-agent CLI to dist/cli.js (${formatBytes(stat.size)}) in ${elapsedMs.toFixed(0)}ms\n`,
	);
}

await main();
