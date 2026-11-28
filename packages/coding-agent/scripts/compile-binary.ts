import * as fs from "node:fs/promises";
import * as path from "node:path";
// Deep import: the pi-utils barrel loads the host native addon, which is
// absent on cross-compiling release runners.
import { USER_AGENT } from "@oh-my-pi/pi-utils/dirs";
import { embeddedAddonFiles, type NativeEmbedTarget } from "../../natives/scripts/embed-native";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { embeddedRelayExtensionFiles } from "./embed-relay-extension";
import { createJsonParsePlugin } from "./json-parse-plugin";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";

/** Native runtime dependencies always resolved from the on-demand install instead of embedded into compiled binaries. */
export const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = Object.freeze([
	"@huggingface/transformers",
	"fastembed",
	"onnxruntime-node",
]);

/** Inputs shared by local and release coding-agent binary builds. */
export interface CodingAgentCompileOptions {
	/** Absolute repository root used for package resolution. */
	readonly repoRoot: string;
	/** Absolute CLI entrypoint. */
	readonly entrypoint: string;
	/** Absolute standalone executable output path. */
	readonly outfile: string;
	/** Unbundled executable for the output's OS, architecture, libc and Bun version. */
	readonly executablePath: string;
	/** Bun uses this separately from executablePath for platform defines and virtual paths. */
	readonly target: Bun.Build.CompileTarget;
	/** Nix's sandbox builds its own addon; release runtimes already contain theirs. */
	readonly embeddedNative?: NativeEmbedTarget;
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
		const manifest = path.join(options.repoRoot, "packages", "natives", "native", "embedded-addon.js");
		const nativeFiles = options.embeddedNative
			? await embeddedAddonFiles(options.embeddedNative)
			: { [await fs.realpath(manifest)]: 'export * from "./linked-addon.js";' };
		const output = await Bun.build({
			entrypoints: [options.entrypoint],
			root: options.repoRoot,
			external: [...COMPILED_EXTERNAL_DEPENDENCIES],
			files: {
				...nativeFiles,
				...(await embeddedRelayExtensionFiles()),
			},
			define: {
				"process.env.PI_COMPILED": JSON.stringify("true"),
				"process.env.PI_DOCS_EMBED": JSON.stringify((await buildDocsIndexPayload()).payload),
			},
			// Precompiled bytecode skips parsing the ~20 MB bundle at boot:
			// `omp --version` 256 ms -> 30 ms on M4 Max (+52 MB binary).
			// Keep import.meta.resolve in bundled dependencies valid under bytecode.
			format: "esm",
			bytecode: true,
			splitting: true,
			// The legacy Pi registry lazily imports every exported module, so side-effect-only
			// modules (e.g. tui `painters/input.ts` and `widgets/input.ts`) become facade chunks
			// holding only identical imports of shared chunks: same content, same hash. Mirror
			// each source path so same-named modules in different directories never collide.
			naming: { chunk: "chunks/[dir]/[name]-[hash].[ext]" },
			minify: {
				identifiers: options.minifyIdentifiers ?? false,
				keepNames: true,
			},
			plugins: [createJsonParsePlugin(), await createLegacyPiVirtualModulePlugin()],
			compile: {
				// Bun's process-wide fetch User-Agent default. Any explicit
				// provider fingerprint (Anthropic/Codex OAuth) still wins.
				execArgv: [`--user-agent=${USER_AGENT}`],
				executablePath: options.executablePath,
				target: options.target,
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
