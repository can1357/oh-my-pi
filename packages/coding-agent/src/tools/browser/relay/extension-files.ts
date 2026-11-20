/**
 * The relay extension's files as omp installs them, and the checks that let a
 * relay rewrite an installed copy in place (extension self-update).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBrowserRelayDir, isEnoent } from "@oh-my-pi/pi-utils";
import { replaceFileAtomically } from "../../../utils/atomic-file";
import { embeddedRelayBuild, embeddedRelayFiles } from "./extension-assets";
import {
	type RelayExtensionStamp,
	readRelayExtensionStamp,
	stampRelayExtensionManifest,
	stampRelayExtensionScript,
} from "./protocol";

/** The extension build these omp files are (a digest of the unstamped files); stamped into every install. */
export const RELAY_EXTENSION_BUILD: string = embeddedRelayBuild;

type ExtensionFiles = Record<string, string | Buffer> & {
	"background.js": string;
	"manifest.json": string;
};

/** The extension files `omp browser-relay install` writes, stamped with the installing omp's version. */
export function relayExtensionFiles(ompVersion: string): ExtensionFiles {
	const files: ExtensionFiles = {
		"manifest.json": stampRelayExtensionManifest(embeddedRelayFiles["manifest.json"], ompVersion),
		"background.js": stampRelayExtensionScript(
			embeddedRelayFiles["background.js"],
			ompVersion,
			RELAY_EXTENSION_BUILD,
		),
	};
	const assets: Readonly<Record<string, string | { base64: string }>> = embeddedRelayFiles;
	for (const name in assets) {
		if (name === "background.js" || name === "manifest.json") continue;
		const content = assets[name]!;
		files[name] = typeof content === "string" ? content : Buffer.from(content.base64, "base64");
	}
	return files;
}

/** Where `omp browser-relay install` puts the extension without `--dir` (~/.omp/browser-relay/extension). */
export function defaultRelayExtensionDir(): string {
	return path.join(getBrowserRelayDir(), "extension");
}

/**
 * Write the extension files of `ompVersion` into `dir`. Each changed file is
 * written beside its target and renamed over it, so Chrome never reads a
 * partly written file: a reload that meets a broken manifest unloads the
 * extension until the user reloads it by hand. Publish the manifest after its
 * assets and `background.js` last, so a write that fails midway leaves the
 * worker reporting the old version. Returns whether any file was published.
 */
export async function writeRelayExtension(dir: string, ompVersion: string): Promise<boolean> {
	const files = relayExtensionFiles(ompVersion);
	let changed = false;
	for (const name in files) {
		if (name === "background.js" || name === "manifest.json") continue;
		if (await publishExtensionFile(path.join(dir, name), files[name]!)) changed = true;
	}
	if (await publishExtensionFile(path.join(dir, "manifest.json"), files["manifest.json"])) changed = true;
	return (await publishExtensionFile(path.join(dir, "background.js"), files["background.js"])) || changed;
}

async function publishExtensionFile(target: string, content: string | Buffer): Promise<boolean> {
	const bytes = typeof content === "string" ? Buffer.from(content) : content;
	const current = await Bun.file(target)
		.arrayBuffer()
		.catch((error: unknown) => {
			if (isEnoent(error)) return null;
			throw error;
		});
	if (current !== null && bytes.equals(Buffer.from(current))) return false;

	const staged = `${target}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(staged, bytes);
		await replaceFileAtomically(staged, target);
	} catch (error) {
		await fs.rm(staged, { force: true }).catch(() => {});
		throw error;
	}
	return true;
}

/**
 * The id Chrome gives the extension loaded unpacked from `dir`, or null when `dir` does not exist. Chrome makes the
 * path absolute (`base::MakeAbsoluteFilePath`: `realpath` on macOS and Linux, `_wfullpath` on Windows, which keeps
 * links) and hashes it with {@link extensionIdForPath}.
 *
 * The manifest deliberately has no `key`: a key would change the id of a folder Chrome already loaded, and Chrome
 * keeps the old record, whose id no longer matches the folder, which then fails every later startup load of that
 * folder (`InstalledLoader::LoadAllExtensions` marks the path invalid). Path ids keep every install updatable in place.
 */
export async function unpackedExtensionId(dir: string): Promise<string | null> {
	try {
		await fs.access(dir);
		return extensionIdForPath(process.platform === "win32" ? path.resolve(dir) : await fs.realpath(dir));
	} catch {
		return null;
	}
}

/**
 * Chromium's `crx_file::id_util::GenerateIdForPath`: the first 128 bits of the SHA-256 of the path's native
 * bytes (UTF-16LE on Windows, after upper-casing a drive letter), written as letters a-p.
 */
export function extensionIdForPath(absolutePath: string, platform: NodeJS.Platform = process.platform): string {
	const bytes =
		platform === "win32"
			? Buffer.from(
					absolutePath.replace(/^[a-z]:/, drive => drive.toUpperCase()),
					"utf16le",
				)
			: Buffer.from(absolutePath, "utf8");
	const hex = Bun.SHA256.hash(bytes, "hex").slice(0, 32);
	return hex.replace(/./g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

/**
 * The stamp of the `background.js` in `dir`: the build Chrome runs once it (re)loads that folder. Null when the
 * script is absent, unreadable or unstamped.
 */
export async function installedRelayExtensionStamp(dir: string): Promise<RelayExtensionStamp | null> {
	try {
		const head = await Bun.file(path.join(dir, "background.js")).slice(0, 256).text();
		return readRelayExtensionStamp(head);
	} catch {
		return null;
	}
}

/** The omp version stamped in `dir`'s manifest; "" when it has none or cannot be read. */
export async function installedRelayExtensionVersion(dir: string): Promise<string> {
	try {
		const manifest: unknown = await Bun.file(path.join(dir, "manifest.json")).json();
		if (typeof manifest === "object" && manifest !== null && "version_name" in manifest) {
			return typeof manifest.version_name === "string" ? manifest.version_name : "";
		}
	} catch {
		// Absent or unreadable: no stamp.
	}
	return "";
}
