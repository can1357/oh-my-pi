#!/usr/bin/env bun
import * as path from "node:path";

const distRoot = path.resolve(process.argv[2] ?? "dist");
const requiredAssets = [
	"index.html",
	"og-image.png",
	"robots.txt",
	"sitemap.xml",
	"csp.txt",
	"share-viewer/index.html",
] as const;

for (const relativePath of requiredAssets) {
	const assetPath = path.join(distRoot, relativePath);
	if (!(await Bun.file(assetPath).exists())) {
		throw new Error(`relay build is missing ${relativePath}`);
	}
}

const csp = (await Bun.file(path.join(distRoot, "csp.txt")).text()).trim();
if (!csp.startsWith("default-src ") || !csp.includes("script-src ")) {
	throw new Error("csp.txt does not contain a client Content-Security-Policy");
}

const viewer = await Bun.file(path.join(distRoot, "share-viewer", "index.html")).text();
if (!viewer.includes("__OMP_SESSION_DATA__")) {
	throw new Error("share viewer loader was not embedded");
}
if (viewer.includes("{{SESSION_DATA}}")) {
	throw new Error("share viewer still contains the session placeholder");
}

console.log(`Verified relay assets in ${distRoot}`);
