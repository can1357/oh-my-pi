#!/usr/bin/env bun
/**
 * Generate a `sha256sum`-compatible checksums file for release assets.
 *
 * Usage:
 *   bun scripts/ci-release-checksums.ts <out-file> <asset>...
 *
 * Each `<asset>` is hashed and written as a `<sha256>  <basename>` line,
 * sorted by basename, so the result can be verified after download with
 * `sha256sum -c SHA256SUMS.txt` (or `shasum -a 256 -c` on macOS).
 *
 * Intended for the `release_github` CI job, run after the release binaries
 * and browser-relay archive are assembled and before the GitHub Release is
 * created, so the checksums file itself ships as one of the release assets.
 */

import * as path from "node:path";

export interface ChecksumEntry {
	name: string;
	sha256: string;
}

export function formatChecksums(entries: readonly ChecksumEntry[]): string {
	return entries
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(({ sha256, name }) => `${sha256}  ${name}\n`)
		.join("");
}

async function main(): Promise<void> {
	const [outFile, ...assetPaths] = process.argv.slice(2);
	if (!outFile || assetPaths.length === 0) {
		throw new Error("usage: ci-release-checksums.ts <out-file> <asset>...");
	}

	const entries = await Promise.all(
		assetPaths.map(async assetPath => {
			const hasher = new Bun.CryptoHasher("sha256");
			for await (const chunk of Bun.file(assetPath).stream()) {
				hasher.update(chunk);
			}
			return { name: path.basename(assetPath), sha256: hasher.digest("hex") };
		}),
	);

	await Bun.write(outFile, formatChecksums(entries));
	console.log(`Wrote ${entries.length} checksum(s) to ${outFile}`);
}

if (import.meta.main) {
	await main();
}
