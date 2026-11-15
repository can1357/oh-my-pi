#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

export interface AgyTransportBuildOptions {
	out?: string;
	platform?: string;
	arch?: string;
}

/** Build the real helper for a source install or a standalone-binary target. */
export async function buildAgyTransport(options: AgyTransportBuildOptions = {}): Promise<string> {
	const platform = options.platform ?? process.env.GOOS ?? process.platform;
	const arch = options.arch ?? process.env.GOARCH ?? process.arch;
	const goos = platform === "win32" ? "windows" : platform;
	const goarch = arch === "x64" ? "amd64" : arch === "ia32" ? "386" : arch;
	const executable = options.out
		? path.resolve(options.out)
		: path.resolve(import.meta.dir, "../dist", `agy-transport${goos === "windows" ? ".exe" : ""}`);
	await fs.mkdir(path.dirname(executable), { recursive: true });
	const source = path.resolve(import.meta.dir, "../src/providers/agy-transport");
	// The native request graph contains legacy MessageSet descriptors.
	await $`go build -trimpath -buildvcs=false -tags=protolegacy -ldflags="-s -w" -o ${executable} .`
		.cwd(source)
		.env({ ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" });
	return executable;
}

if (import.meta.main) {
	const { values } = parseArgs({ options: { out: { type: "string" } } });
	console.log(await buildAgyTransport({ out: values.out }));
}
