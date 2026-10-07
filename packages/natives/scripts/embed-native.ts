import * as fs from "node:fs/promises";
import * as path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
	containsLegacyVersionSentinel,
	containsVersionStamp,
	VERSION_STAMP_MAGIC,
} from "../native/version-sentinel.js";

const defaultNativeDir = path.join(import.meta.dir, "../native");

/** Platform/architecture pair whose addons a standalone binary embeds. */
export interface NativeEmbedTarget {
	readonly platform: string;
	readonly arch: string;
}

/** Inputs for {@link embeddedAddonFiles}. */
export interface EmbedOptions extends NativeEmbedTarget {
	/** Directory holding the built `pi_natives.*.node` addons; defaults to this package's `native/`. */
	readonly nativeDir?: string;
	/** Release every embedded addon must be stamped with; defaults to this package's version. */
	readonly version?: string;
}

/**
 * Build the in-memory `Bun.build({ files })` overrides that embed one target's
 * addons into a standalone binary: a gzip tar of the addons and a replacement
 * for the checked-in null `native/embedded-addon.js` manifest that points at it.
 *
 * Nothing is written to disk. Bun.build shares the runtime's directory cache
 * and never re-reads it on a miss, so a process that imported pi-natives before
 * writing the archive cannot resolve it; in-memory files bypass that lookup.
 *
 * @throws when no addon exists for the target, or when an addon lacks the
 * `@oh-my-pi/pi-natives@<version>` version stamp and legacy sentinel.
 */
export async function embeddedAddonFiles({
	platform,
	arch,
	nativeDir = defaultNativeDir,
	version = packageJson.version,
}: EmbedOptions): Promise<Record<string, string | Uint8Array>> {
	const platformTag = `${platform}-${arch}`;
	const candidates =
		arch === "x64"
			? [
					{ variant: "modern", filename: `pi_natives.${platformTag}-modern.node` },
					{ variant: "baseline", filename: `pi_natives.${platformTag}-baseline.node` },
				]
			: [{ variant: "default", filename: `pi_natives.${platformTag}.node` }];

	// Override keys must equal the bundler's symlink-resolved module paths.
	const dir = await fs.realpath(nativeDir);
	const present = new Set(await fs.readdir(dir));
	const available = await Promise.all(
		candidates
			.filter(candidate => present.has(candidate.filename))
			.map(async candidate => ({ ...candidate, bytes: await fs.readFile(path.join(dir, candidate.filename)) })),
	);
	if (available.length === 0) {
		const expected = candidates.map(candidate => `  - ${candidate.filename}`).join("\n");
		throw new Error(`No native addons found for ${platformTag}. Expected one of:\n${expected}`);
	}
	for (const { filename, bytes } of available) {
		// Pre-stamp addons (npm releases and main builds before the stamp slot)
		// identify their release by the legacy export, which the loader accepts.
		if (!containsVersionStamp(bytes, version) && !containsLegacyVersionSentinel(bytes, version)) {
			const addonPath = path.join(dir, filename);
			throw new Error(
				`Native addon ${addonPath} does not carry the @oh-my-pi/pi-natives@${version} version stamp ` +
					`\`${VERSION_STAMP_MAGIC}${version}\`. Rebuild it (installs stamp automatically), run ` +
					`\`bun scripts/stamp-native-version.ts ${addonPath}\`, or fetch @oh-my-pi/pi-natives-${platformTag}@${version} before embedding.`,
			);
		}
	}

	const archiveFilename = `embedded-addons.${platformTag}.tar.gz`;
	const archive = new Bun.Archive(Object.fromEntries(available.map(({ filename, bytes }) => [filename, bytes])), {
		compress: "gzip",
		level: 9,
	});
	const files = available.map(({ variant, filename, bytes }) => ({ variant, filename, size: bytes.length }));
	const manifest = `import assetPath from ${JSON.stringify(`./${archiveFilename}`)} with { type: "file" };
import { fileURLToPath } from "node:url";

const archivePath =
	process.env.PI_ANDROID_BUNDLE === "1" ? fileURLToPath(new URL(assetPath, import.meta.url)) : assetPath;

export const embeddedAddon = {
	platformTag: ${JSON.stringify(platformTag)},
	version: ${JSON.stringify(version)},
	archive: { format: "tar.gz", filename: ${JSON.stringify(archiveFilename)}, filePath: archivePath },
	files: ${JSON.stringify(files)},
};
`;

	return {
		[path.join(dir, archiveFilename)]: await archive.bytes(),
		[path.join(dir, "embedded-addon.js")]: manifest,
	};
}
