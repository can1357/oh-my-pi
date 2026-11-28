#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { embeddedRelayExtensionFiles } from "./embed-relay-extension";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { createJsonParsePlugin } from "./json-parse-plugin";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";
import { buildGroupedBundle, profilePath } from "./bundle-groups";

const packageDir = path.join(import.meta.dir, "..");
const defaultOutDir = path.join(packageDir, "dist");
// Chunks sit flat beside cli.js, so `import.meta.dir` stays `dist/` and chunk-relative asset URLs resolve.
export const chunkNaming = "cli-[name]-[hash].[ext]";
const chunkPattern = /^cli-.+\.js$/;
const shebang = "#!/usr/bin/env bun\n";
// Remove old inline-viewer sidecars left in an existing output directory.
const obsoleteHtmlExportAssetPattern =
	/^(?:template-[^.]+\.(?:css|html|js)|tool-views\.generated-[^.]+\.js|(?:marked|highlight)\.min-[^.]+\.js)$/;

// Native/platform dependencies and on-demand model runtimes stay outside the bundle.
const ALWAYS_EXTERNAL = ["@oh-my-pi/pi-natives", "@huggingface/transformers", "fastembed", "onnxruntime-node"];

/**
 * Embeds `@oh-my-pi/pi-natives/THIRD-PARTY-NOTICES.txt` even though the natives package is external. An external
 * text import would be hoisted to a top-level import of `dist/cli.js`, reading the installed addon's notices on every
 * launch instead of only for `omp --license`.
 */
const inlineNativeNoticesPlugin: Bun.BunPlugin = {
	name: "inline-native-notices",
	setup(build) {
		build.onResolve({ filter: /^@oh-my-pi\/pi-natives\/THIRD-PARTY-NOTICES\.txt$/ }, () => ({
			path: path.join(packageDir, "../natives/THIRD-PARTY-NOTICES.txt"),
		}));
	},
};

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

/**
 * Runs `build` with the stats dashboard archive generated: the npm bundle ships no dashboard sources, so
 * it embeds the archive the same way compiled binaries do (scripts/build-binary.ts). Resets the
 * checked-in placeholder afterwards.
 */
export async function withEmbeddedStatsDashboard<T>(build: () => Promise<T>): Promise<T> {
	await runCommand(["bun", "--cwd=../stats", "run", "gen:stats"]);
	try {
		return await build();
	} finally {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats:reset"]);
	}
}

async function ensureShebang(cliPath: string): Promise<void> {
	const text = await Bun.file(cliPath).text();
	if (text.startsWith(shebang)) return;
	const withoutExisting = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;
	await Bun.write(cliPath, shebang + withoutExisting);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

async function cleanBundleOutputs(outDir: string): Promise<void> {
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
					chunkPattern.test(entry) ||
					entry === "docs-index.generated.txt" ||
					entry.endsWith(".node") ||
					entry.endsWith(".js.map") ||
					/\.json-[^/]+\.zst$/.test(entry) ||
					(entry.startsWith("CHANGELOG-") && entry.endsWith(".md")) ||
					obsoleteHtmlExportAssetPattern.test(entry),
			)
			.map(entry => fs.rm(path.join(outDir, entry), { force: true })),
	);
}

/**
 * The build of `src/cli.ts` every npm bundle shares; `scripts/bundle-profile.ts` traces this exact build.
 * `docsEmbed` is the `PI_DOCS_EMBED` payload. Built in-process: that payload is far larger than Linux's
 * 128KiB per-argv-string cap, so it can never be passed as a CLI `--define` (posix_spawn fails with E2BIG).
 */
export async function cliBuildConfig(docsEmbed: string) {
	return {
		entrypoints: [path.join(packageDir, "src/cli.ts")],
		target: "bun",
		// Also refreshes `src/.../extension.generated.json`, which SDK consumers of `src` read.
		files: await embeddedRelayExtensionFiles(),
		plugins: [createJsonParsePlugin(), await createLegacyPiVirtualModulePlugin(), inlineNativeNoticesPlugin],
		external: [...ALWAYS_EXTERNAL, ...RUNTIME_EXTERNAL],
		define: {
			"process.env.PI_BUNDLED": JSON.stringify("true"),
			"process.env.PI_DOCS_EMBED": JSON.stringify(docsEmbed),
		},
		minify: {
			whitespace: true,
			syntax: true,
			identifiers: true,
			keepNames: true,
		},
		throw: false,
	} satisfies Bun.BuildConfig;
}

/**
 * Builds the npm CLI bundle into `outDir`; release scripts use the package `dist` directory by default.
 * The bundle is code-split with modules grouped by the processes that load them (see
 * `scripts/bundle-groups.ts`).
 */
export async function bundleDist(outDir: string = defaultOutDir): Promise<void> {
	const cliPath = path.join(outDir, "cli.js");
	const start = Bun.nanoseconds();
	await cleanBundleOutputs(outDir);
	let scripts = 0;
	let scriptBytes = 0;
	await withEmbeddedStatsDashboard(async () => {
		// One payload for both consumers: inlined into the CLI bundle via `define` for
		// the bundled CLI entrypoint, and written to dist/docs-index.generated.txt so
		// SDK consumers importing `@oh-my-pi/pi-coding-agent/*` (TypeScript source, no
		// build-time embed) can still resolve omp:// docs (see src/internal-urls/docs-index.ts).
		const docsPayload = await buildDocsIndexPayload();
		const output = await buildGroupedBundle(
			{
				...(await cliBuildConfig(docsPayload.payload)),
				outdir: outDir,
				naming: { entry: "cli.js", chunk: chunkNaming },
			},
			await Bun.file(profilePath).json(),
		);
		if (!output.success) {
			const messages = output.logs.map(log =>
				log.position ? `${log.position.file}:${log.position.line}: ${log.message}` : log.message,
			);
			throw new Error(`CLI bundle failed:\n${messages.join("\n")}`);
		}
		for (const artifact of output.outputs) {
			if (artifact.kind !== "entry-point" && artifact.kind !== "chunk") continue;
			scripts++;
			scriptBytes += artifact.size;
		}
		await ensureShebang(cliPath);
		await Bun.write(path.join(outDir, "docs-index.generated.txt"), docsPayload.payload);
	});
	const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;
	process.stdout.write(
		`Bundled coding-agent CLI to ${cliPath} (${scripts} scripts, ${formatBytes(scriptBytes)}) in ${elapsedMs.toFixed(0)}ms\n`,
	);
}

if (import.meta.main) await bundleDist();
