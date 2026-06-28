#!/usr/bin/env bun

import { createRequire } from "node:module";
import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");
// Optional cross-compile target, e.g. CROSS_TARGET=linux-arm64 → bun build
// --target=bun-linux-arm64, embeds the matching native, outputs dist/omp-<target>.
const crossTarget = Bun.env.CROSS_TARGET || null;
const [crossPlatform, crossArch] = crossTarget ? crossTarget.split("-") : [null, null];
// x64 uses the baseline bun runtime so it runs under Rosetta / pre-AVX2 CPUs
// (the modern bun-linux-x64 target SIGILLs under Apple-Silicon Rosetta).
const bunTarget = crossTarget ? (crossTarget === "linux-x64" ? "bun-linux-x64-baseline" : `bun-${crossTarget}`) : null;
const outName = crossTarget ? `omp-${crossTarget}` : "omp";
const outputPath = path.join(packageDir, "dist", outName);

// Transformers.js is an optional, native-heavy dependency that is never bundled
// into the binary; the tiny-model worker `bun install`s it into a runtime cache
// on first use. The `catalog:` spec cannot be resolved from inside the compiled
// bunfs (issue #1763), so embed the concrete installed version here for the
// worker to pin its runtime install against.
const transformersVersion = (
	createRequire(import.meta.url)("@huggingface/transformers/package.json") as { version: string }
).version;

function shouldAdhocSignDarwinBinary(): boolean {
	return process.platform === "darwin" && !crossTarget;
}

async function runCommand(
	command: string[],
	env: NodeJS.ProcessEnv = Bun.env,
	cwd: string = packageDir,
): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function main(): Promise<void> {
	// Generate inside the try so the finally always restores the empty checked-in
	// placeholders (stats client archive, docs index) even on failure.
	try {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats"]);
		await runCommand(["bun", "run", "gen:docs"]);
		// `legacy-pi-bundled-registry.ts` static-imports
		// `@pk-nerdsaver-ai/pi-coding-agent/export/html` (one of pi-coding-agent's
		// named subpath exports, see scripts/generate-legacy-pi-bundled-registry.ts),
		// whose source pulls in `tool-views.generated.js`. The root
		// `package.json` "prepare" lifecycle hook builds that file on
		// `bun install`, but a clean binary build that skips install hooks
		// would `bun build --compile` against the registry entry and fail
		// resolving the missing generated bundle. Rebuilding the tool views
		// here makes the compile self-contained and matches what `prepack`
		// does for the npm bundle.
		await runCommand(["bun", "--cwd=../collab-web", "run", "gen:tool-views"]);
		await runCommand(
			["bun", "--cwd=../natives", "run", "gen:native"],
			crossTarget
				? { ...Bun.env, TARGET_PLATFORM: crossPlatform as string, TARGET_ARCH: crossArch as string }
				: Bun.env,
		);
		await runCommand(["bun", "run", "gen:mupdf"]);
		// Regenerate the bundled-pi registry + key set before the compile so any
		// new pi-* subpath export added under `packages/*/package.json` is served
		// from the host's in-process copy. Without this, `bun build --compile`
		// would freeze whatever the committed registry happened to enumerate at
		// the time of the last manual `--generate`, and a new subpath added
		// since then would crash extension validation with `Cannot find module`
		// (issue #3442). The generator also normalizes formatting, so the diff
		// against the committed copy stays clean.
		await runCommand(["bun", "scripts/generate-legacy-pi-bundled-registry.ts", "--generate"]);
		try {
			const buildEnv = shouldAdhocSignDarwinBinary() ? { ...Bun.env, BUN_NO_CODESIGN_MACHO_BINARY: "1" } : Bun.env;
			await runCommand(
				[
					"bun",
					"build",
					"--compile",
					...(bunTarget ? ["--target", bunTarget] : []),
					"--no-compile-autoload-bunfig",
					"--no-compile-autoload-dotenv",
					"--no-compile-autoload-tsconfig",
					"--no-compile-autoload-package-json",
					"--keep-names",
					"--define",
					'process.env.PI_COMPILED="true"',
					"--define",
					`process.env.PI_TINY_TRANSFORMERS_VERSION=${JSON.stringify(transformersVersion)}`,
					"--external",
					"fastembed",
					"--external",
					"onnxruntime-node",
					"--root",
					".",
					"./packages/coding-agent/src/cli.ts",
					// Legacy pi-* extension compat surfaces (host packages + shims)
					// were previously listed as explicit `--compile` entries so the
					// rewrite path could emit `/$bunfs/root/...` URLs against them.
					// Bun 1.3.14 made bunfs files unreachable at runtime (issue
					// #3423), so `legacy-pi-compat.ts` now serves them through a
					// virtual namespace backed by `legacy-pi-bundled-registry.ts`,
					// which static-imports each surface — the bundler already
					// includes them via the main module graph, so no `--compile`
					// extras are required.
					"--outfile",
					`packages/coding-agent/dist/${outName}`,
				],
				buildEnv,
				repoRoot,
			);

			// Bun 1.3.12 emits a truncated Mach-O signature on darwin builds.
			if (shouldAdhocSignDarwinBinary()) {
				await runCommand(["codesign", "--force", "--sign", "-", outputPath]);
			}
		} finally {
			await runCommand(["bun", "run", "gen:mupdf:reset"]);
			await runCommand(["bun", "--cwd=../natives", "run", "gen:native:reset"]);
		}
	} finally {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats:reset"]);
		await runCommand(["bun", "run", "gen:docs:reset"]);
	}
}

await main();
