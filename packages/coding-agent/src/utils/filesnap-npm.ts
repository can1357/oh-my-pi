import { createRequire } from "node:module";
import * as path from "node:path";

/** Resolve the official npm platform dependency, including cross-build targets. */
export function resolveFilesnapNpmBinary(platform: string = process.platform, arch: string = process.arch): string {
	if (platform === "android") platform = "linux";
	const triples: Record<string, string> = {
		"linux-x64": "x86_64-unknown-linux-musl",
		"linux-arm64": "aarch64-unknown-linux-musl",
		"darwin-x64": "x86_64-apple-darwin",
		"darwin-arm64": "aarch64-apple-darwin",
		"win32-x64": "x86_64-pc-windows-msvc",
		"win32-arm64": "aarch64-pc-windows-msvc",
	};
	const slug = `${platform}-${arch}`;
	const triple = triples[slug];
	if (!triple) throw new Error(`Unsupported filesnap platform: ${slug}`);
	const launcher = createRequire(import.meta.url).resolve("filesnap/bin/filesnap.mjs");
	const vendor = path.dirname(createRequire(launcher).resolve(`filesnap-${slug}/package.json`));
	return path.join(vendor, "vendor", triple, "bin", platform === "win32" ? "filesnap.exe" : "filesnap");
}
