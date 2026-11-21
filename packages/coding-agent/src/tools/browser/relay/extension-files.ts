/**
 * The relay extension's files as omp installs them, and the checks that let a
 * relay rewrite an installed copy in place (extension self-update).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBrowserRelayDir, isEnoent } from "@oh-my-pi/pi-utils";
import { replaceFileAtomically } from "../../../utils/atomic-file";
import { embeddedRelayExtensionZstPath } from "./embedded-extension";
import {
	type RelayExtensionStamp,
	readRelayExtensionStamp,
	stampRelayExtensionManifest,
	stampRelayExtensionScript,
} from "./protocol";

/** The unstamped extension files, binary ones base64-encoded, as packages/browser-relay/scripts/build-extension.ts writes them. */
export interface RelayExtensionBundle {
	/** Digest of the unstamped files; stamped into every install so a relay can spot a stale build. */
	build: string;
	files: Record<string, string | { base64: string }>;
}

/** Where a source checkout keeps the generated extension; builds embed it instead. */
const GENERATED_EXTENSION = path.join(import.meta.dir, "extension.generated.json");

let loading: Promise<RelayExtensionBundle> | undefined;

/**
 * The extension this omp installs: loaded lazily from the embedded zstd asset in
 * binaries and bundles, or read from `extension.generated.json` in a source
 * checkout. Coalesces concurrent loads without pinning the ~2 MiB bundle after
 * callers finish.
 *
 * @throws Error naming `bun run gen:relay-extension` when a source checkout has not generated the extension.
 */
export function loadRelayExtension(): Promise<RelayExtensionBundle> {
	if (loading) return loading;
	const pending: Promise<RelayExtensionBundle> = embeddedRelayExtensionZstPath
		? Bun.file(embeddedRelayExtensionZstPath)
				.bytes()
				.then(bytes => Bun.zstdDecompress(bytes))
				.then((raw): RelayExtensionBundle => JSON.parse(raw.toString("utf8")))
		: Bun.file(GENERATED_EXTENSION)
				.json()
				.catch((error: unknown) => {
					if (!isEnoent(error)) throw error;
					throw new Error(
						`This omp checkout has not built the omp extension (${GENERATED_EXTENSION} is missing). Run \`bun run gen:relay-extension\` at the repository root.`,
					);
				});
	loading = pending;
	const settle = (): void => {
		if (loading === pending) loading = undefined;
	};
	pending.then(settle, settle);
	return pending;
}

type ExtensionFiles = Record<string, string | Buffer> & {
	"background.js": string;
	"manifest.json": string;
};

/**
 * The extension files `omp browser-relay install` writes, stamped with the installing omp's version.
 *
 * @throws Error when the extension is missing (see {@link loadRelayExtension}) or lacks its manifest or service worker.
 */
export async function relayExtensionFiles(
	ompVersion: string,
	bundle: Promise<RelayExtensionBundle> = loadRelayExtension(),
): Promise<ExtensionFiles> {
	const { build, files: assets } = await bundle;
	const manifest = assets["manifest.json"];
	const script = assets["background.js"];
	if (typeof manifest !== "string" || typeof script !== "string")
		throw new Error("The omp extension lacks manifest.json or background.js");
	const files: ExtensionFiles = {
		"manifest.json": stampRelayExtensionManifest(manifest, ompVersion),
		"background.js": stampRelayExtensionScript(script, ompVersion, build),
	};
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
 * worker reporting the old version. Returns whether any file was published. Callers writing several folders pass
 * one `bundle` so the extension loads once.
 */
export async function writeRelayExtension(
	dir: string,
	ompVersion: string,
	bundle?: Promise<RelayExtensionBundle>,
): Promise<boolean> {
	const files = await relayExtensionFiles(ompVersion, bundle);
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
