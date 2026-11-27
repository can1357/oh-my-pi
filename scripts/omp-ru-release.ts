#!/usr/bin/env bun
/** omp-ru release: manifest + atomic install for the verified binaries. */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.join(import.meta.dir, "..");
const binariesDir = path.join(repoRoot, "packages/coding-agent/binaries");
const installDir = path.join(process.env.HOME ?? "", ".local/bin");
const manifestPath = path.join(binariesDir, "omp-ru-manifest.json");

const TARGETS = ["omp-linux-x64", "omp-windows-x64.exe"] as const;

async function sha256(file: string): Promise<string> {
	return (await $`sha256sum ${file}`.quiet().text()).split(/\s+/)[0] ?? "";
}

const manifest: Record<string, unknown> = {
	upstreamVersion: "19.1.1",
	upstreamCommit: "31ffee513f27a01bba7d4dfbe12bae239cdc646a",
	ruRelease: "ru-19.1.1.1",
	nativeVersion: "19.1.1",
	generatedAt: new Date().toISOString(),
};

const entries: Record<string, string> = {};
for (const name of TARGETS) {
	const file = path.join(binariesDir, name);
	const stat = await fs.stat(file).catch(() => null);
	if (!stat) {
		console.error(`missing: ${file}`);
		process.exitCode = 1;
		continue;
	}
	const hash = await sha256(file);
	entries[name] = hash;
	manifest[name] = { sha256: hash, size: stat.size };
}

const catalogFiles = await Array.fromAsync(
	new Bun.Glob("ui-language*-ru.json").scan({ cwd: path.join(repoRoot, "packages/utils/src") }),
);
const catalogHashes: Record<string, string> = {};
let catalogCombined = "";
for (const name of catalogFiles.sort()) {
	const source = path.join(repoRoot, "packages/utils/src", name);
	catalogHashes[name] = await sha256(source);
	catalogCombined += `${name}:${catalogHashes[name]}\n`;
}
manifest.localeCatalogSha256 = Bun.SHA256.hash(catalogCombined, "hex");
manifest.localeCatalogFiles = catalogHashes;
manifest.builtBy = "OMP_BUILD_FLAVOR=ru RELEASE_TARGETS=linux-x64,win32-x64 bun run ci:release:build-binaries";

await Bun.write(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");
console.log(`manifest: ${manifestPath} (${catalogFiles.length} catalog fragments, ${TARGETS.length} binaries)`);

// Install only the Linux binary on this host; atomic rename with .bak rollback.
const linuxSource = path.join(binariesDir, "omp-linux-x64");
const target = path.join(installDir, "omp-ru");
await fs.mkdir(installDir, { recursive: true });
const staging = `${target}.new`;
await fs.copyFile(linuxSource, staging);
await fs.chmod(staging, 0o755);
if (await fs.stat(target).catch(() => null)) await fs.copyFile(target, `${target}.bak`);
await fs.rename(staging, target);
console.log(`installed: ${target}`);
console.log(`manifest entries: ${JSON.stringify(entries, null, "\t")}`);
