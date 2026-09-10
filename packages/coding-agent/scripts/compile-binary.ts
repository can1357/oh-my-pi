// Deep import: the pi-utils barrel loads the host native addon, which is
// absent on cross-compiling release runners.
import { USER_AGENT } from "@oh-my-pi/pi-utils/dirs";
import * as path from "node:path";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";

/** Native runtime dependencies always resolved from the on-demand install instead of embedded into compiled binaries. */
export const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = Object.freeze(["fastembed", "onnxruntime-node"]);

/** Module namespace for the generated `@node-llama-cpp/*` stand-ins. */
const GGML_PLATFORM_NAMESPACE = "omp-ggml-platform-binaries";

/** Module namespace for the generated stand-in replacing `getModuleVersion.js`. */
const GGML_MODULE_VERSION_NAMESPACE = "omp-ggml-module-version";

/** Module namespace for the generated stand-in replacing `binariesGithubRelease.js`. */
const GGML_RELEASE_MANIFEST_NAMESPACE = "omp-ggml-release-manifest";

/** Path of node-llama-cpp's pinned llama.cpp release manifest inside its package. */
const RELEASE_MANIFEST_PATH = ["llama", "binariesGithubRelease.json"];

/**
 * Read node-llama-cpp's pinned llama.cpp release (`llama/binariesGithubRelease.json`)
 * from the installed package at build time, so the compiled binary can answer
 * the module that reads it instead of opening a path inside the bunfs.
 */
async function readPinnedLlamaCppRelease(repoRoot: string): Promise<string> {
	const manifestPath = path.join(repoRoot, "node_modules", "node-llama-cpp", ...RELEASE_MANIFEST_PATH);
	const manifest = (await Bun.file(manifestPath).json()) as { release?: unknown };
	if (typeof manifest.release !== "string" || manifest.release === "") {
		throw new Error(`node-llama-cpp release manifest at ${manifestPath} has no release string`);
	}
	return manifest.release;
}

/**
 * `node-llama-cpp` finds its prebuilt llama/ggml libraries by importing
 * `@node-llama-cpp/<platform>` and calling `getBinsDir()`, then comparing that
 * package's version with `getModuleVersion()` (its own `package.json`). Both
 * steps are impossible inside a compiled binary: the platform packages hold
 * hundreds of MB of shared libraries (155 MB for CUDA alone) that must stay out
 * of the bundle, bare specifiers resolve only against the embedded module graph
 * (oven-sh/bun#1763), runtime `Bun.plugin` hooks never fire for them (Bun
 * 1.3.14), and reading `package.json` through the embedded filesystem fails.
 *
 * This plugin bundles node-llama-cpp's JS (deps included) and replaces the two
 * filesystem-dependent seams with generated modules that report the same
 * contract from the install tree on disk, failing closed when the installed
 * prebuilt is missing or comes from a different release.
 */
function ggmlPlatformBinariesPlugin(releaseVersion: string, pinnedRelease: string): Bun.BunPlugin {
	return {
		name: "omp-ggml-platform-binaries",
		setup(build) {
			build.onResolve({ filter: /^@node-llama-cpp\// }, args => ({
				path: args.path,
				namespace: GGML_PLATFORM_NAMESPACE,
			}));
			build.onLoad({ filter: /.*/, namespace: GGML_PLATFORM_NAMESPACE }, args => {
				return {
					loader: "js",
					contents: [
						`import * as path from "node:path";`,
						`import { readPackageVersion, resolvePackageDirFromExecutable } from "@oh-my-pi/pi-utils";`,
						`const PACKAGE = ${JSON.stringify(args.path)};`,
						`const VERSION = ${JSON.stringify(releaseVersion)};`,
						`/** Mirrors the platform package's getBinsDir(); an empty object means "unavailable". */`,
						`export function getBinsDir() {`,
						`	const packageDir = resolvePackageDirFromExecutable(PACKAGE);`,
						`	if (packageDir === null || readPackageVersion(packageDir) !== VERSION) return {};`,
						`	return { binsDir: path.join(packageDir, "bins"), packageVersion: VERSION };`,
						`}`,
					].join("\n"),
				};
			});
			// `getModuleVersion()` resolves its own package.json relative to the
			// module URL, which a compiled binary cannot read; serve the pinned
			// release instead so node-llama-cpp's version comparison is meaningful.
			build.onResolve({ filter: /getModuleVersion\.js$/ }, args =>
				args.namespace === "file" ? { path: "version", namespace: GGML_MODULE_VERSION_NAMESPACE } : undefined,
			);
			build.onLoad({ filter: /.*/, namespace: GGML_MODULE_VERSION_NAMESPACE }, () => ({
				loader: "js",
				contents: [
					`const VERSION = ${JSON.stringify(releaseVersion)};`,
					`/** Bundled stand-in for node-llama-cpp's package.json version lookup. */`,
					`export async function getModuleVersion() {`,
					`	return VERSION;`,
					`}`,
				].join("\n"),
			}));
			// `binariesGithubRelease.js` reads `llama/binariesGithubRelease.json`
			// from the package directory at module load (top-level await), a path
			// that does not exist inside a compiled binary; serve the pinned
			// release the build already knows.
			build.onResolve({ filter: /binariesGithubRelease\.js$/ }, args =>
				args.namespace === "file" ? { path: "release", namespace: GGML_RELEASE_MANIFEST_NAMESPACE } : undefined,
			);
			build.onLoad({ filter: /.*/, namespace: GGML_RELEASE_MANIFEST_NAMESPACE }, () => ({
				loader: "js",
				contents: [
					`const RELEASE = ${JSON.stringify(pinnedRelease)};`,
					`/** Pinned llama.cpp release baked at build time from the installed package. */`,
					`export const builtinLlamaCppRelease = RELEASE;`,
					`export const defaultLlamaCppRelease = RELEASE;`,
					`export async function getBinariesGithubRelease() {`,
					`	return RELEASE;`,
					`}`,
					`/** Only the update CLI writes this manifest; the binary never does. */`,
					`export async function setBinariesGithubRelease() {}`,
				].join("\n"),
			}));
		},
	};
}

/**
 * The pinned node-llama-cpp release whose prebuilt platform binaries the ggml
 * embedding backend loads. `pi-mnemopi` declares it as an optional peer with an
 * exact version so the compiled binary can compare a discovered prebuilt
 * against a single known release.
 */
async function resolveNodeLlamaCppRelease(repoRoot: string): Promise<string> {
	const manifest = (await Bun.file(path.join(repoRoot, "packages", "mnemopi", "package.json")).json()) as {
		peerDependencies?: Record<string, string>;
	};
	const pinned = manifest.peerDependencies?.["node-llama-cpp"];
	if (typeof pinned !== "string" || pinned === "") {
		throw new Error("packages/mnemopi/package.json must pin an exact node-llama-cpp peer version");
	}
	return pinned;
}

/** Inputs shared for local and release coding-agent binary builds. */
export interface CodingAgentCompileOptions {
	/** Absolute repository root used for package resolution. */
	readonly repoRoot: string;
	/** Absolute CLI entrypoint. */
	readonly entrypoint: string;
	/** Absolute standalone executable output path. */
	readonly outfile: string;
	/** Concrete Transformers.js version baked into the tiny-model worker. */
	readonly transformersVersion: string;
	/** Optional cross-compilation runtime target. */
	readonly target?: Bun.Build.CompileTarget;
	/** Optional unmodified Bun executable used as the standalone runtime template. */
	readonly executablePath?: string;
	/** Match release builds that minify identifiers while retaining names. */
	readonly minifyIdentifiers?: boolean;
	/** Disable Bun's built-in Darwin signing before the caller re-signs. */
	readonly skipBuiltinCodesign?: boolean;
}

/**
 * Compile the coding-agent executable with its legacy Pi compatibility module
 * graph supplied by an in-memory build plugin rather than generated files.
 */
export async function compileCodingAgent(options: CodingAgentCompileOptions): Promise<void> {
	const previousCodesignSetting = Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
	if (options.skipBuiltinCodesign) {
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = "1";
	}
	try {
		const output = await Bun.build({
			entrypoints: [options.entrypoint],
			root: options.repoRoot,
			external: [...COMPILED_EXTERNAL_DEPENDENCIES],
			define: {
				"process.env.PI_COMPILED": JSON.stringify("true"),
				"process.env.PI_TINY_TRANSFORMERS_VERSION": JSON.stringify(options.transformersVersion),
				"process.env.PI_DOCS_EMBED": JSON.stringify((await buildDocsIndexPayload()).payload),
			},
			minify: {
				identifiers: options.minifyIdentifiers ?? false,
				keepNames: true,
			},
			plugins: [
				await createLegacyPiVirtualModulePlugin(),
				ggmlPlatformBinariesPlugin(
					await resolveNodeLlamaCppRelease(options.repoRoot),
					await readPinnedLlamaCppRelease(options.repoRoot),
				),
			],
			compile: {
				// Bun's process-wide fetch User-Agent default. Any explicit
				// provider fingerprint (Anthropic/Codex OAuth) still wins.
				execArgv: [`--user-agent=${USER_AGENT}`],
				...(options.executablePath
					? { executablePath: options.executablePath }
					: options.target
						? { target: options.target }
						: {}),
				outfile: options.outfile,
				autoloadBunfig: false,
				autoloadDotenv: false,
				autoloadTsconfig: false,
				autoloadPackageJson: false,
			},
			throw: false,
		});
		if (!output.success) {
			throw new Error(`Coding-agent binary bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
		}
	} finally {
		if (previousCodesignSetting === undefined) {
			delete Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
		} else {
			Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = previousCodesignSetting;
		}
	}
}
