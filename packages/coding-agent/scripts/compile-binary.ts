// Deep import: the pi-utils barrel loads the host native addon, which is
// absent on cross-compiling release runners.
import { USER_AGENT } from "@oh-my-pi/pi-utils/dirs";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";

/** Native runtime dependencies always resolved from the on-demand install instead of embedded into compiled binaries. */
export const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = Object.freeze(["fastembed", "onnxruntime-node"]);

/** Inputs shared by local and release coding-agent binary builds. */
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
			plugins: [await createLegacyPiVirtualModulePlugin()],
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
