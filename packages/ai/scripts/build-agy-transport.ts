#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

export interface AgyTransportBuildOptions {
	out?: string;
	platform?: string;
	arch?: string;
	runtimeTarget?: Bun.Build.CompileTarget;
}

/** Build the Rust helper for a source install or a standalone-binary target. */
export async function buildAgyTransport(options: AgyTransportBuildOptions = {}): Promise<string> {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const cpu =
		arch === "x64" || arch === "x86_64" ? "x86_64" : arch === "arm64" || arch === "aarch64" ? "aarch64" : null;
	const musl = options.runtimeTarget?.includes("-musl") ?? false;
	const targetOs =
		platform === "win32" || platform === "windows"
			? "windows"
			: platform === "darwin"
				? "apple-darwin"
				: platform === "linux"
					? `unknown-linux-${musl ? "musl" : "gnu"}`
					: null;
	if (!cpu || !targetOs) throw new Error(`Unsupported Antigravity transport target: ${platform}-${arch}`);
	const triple =
		targetOs === "windows"
			? `${cpu}-pc-windows-${process.platform === "win32" && cpu === "x86_64" ? "gnu" : "msvc"}`
			: `${cpu}-${targetOs}`;
	const filename = `agy-transport${targetOs === "windows" ? ".exe" : ""}`;
	const executable = path.resolve(options.out ?? path.join(import.meta.dir, "../dist", filename));
	const manifest = path.resolve(import.meta.dir, "../src/providers/agy-transport-rs/Cargo.toml");
	// CMake caches absolute source paths and generators. Sharing one Cargo target
	// dir across worktrees or installed SDK copies can reuse an incompatible cache.
	const cacheKey = `oms-agy-transport-${Bun.SHA256.hash(manifest, "hex").slice(0, 16)}`;
	await fs.mkdir(path.dirname(executable), { recursive: true });
	const prebuilt = process.env.OMS_AGY_TRANSPORT_BINARY;
	if (prebuilt) {
		if (process.env.OMS_AGY_TRANSPORT_TRIPLE !== triple || !path.isAbsolute(prebuilt)) {
			throw new Error(
				`Expected an absolute Antigravity helper for ${triple} (OMS_AGY_TRANSPORT_BINARY and OMS_AGY_TRANSPORT_TRIPLE)`,
			);
		}
		await fs.copyFile(prebuilt, executable);
		return executable;
	}
	// The pinned Windows GNU Rust toolchain on this workstation crashes during
	// startup. Cross-build the standalone binary with stable Rust and MinGW in
	// WSL; the vendored BoringSSL links its C++ runtime statically.
	if (process.platform === "win32" && triple === "x86_64-pc-windows-gnu") {
		const script = [
			"set -euo pipefail",
			'manifest="$(wslpath -u "$1")"',
			'output="$(wslpath -u "$2")"',
			// oxlint-disable-next-line eslint/no-template-curly-in-string -- Bash expands this, not Bun.
			'export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/' + cacheKey + '}"',
			"export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc",
			"export CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc",
			"export CXX_x86_64_pc_windows_gnu=x86_64-w64-mingw32-g++",
			'cargo +stable build --locked --release --target x86_64-pc-windows-gnu --manifest-path "$manifest"',
			'cp "$CARGO_TARGET_DIR/x86_64-pc-windows-gnu/release/agy-transport.exe" "$output"',
		].join("; ");
		const command = ["wsl", "-e", "bash", "-lc", script, "_", manifest, executable];
		const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
		if ((await proc.exited) !== 0) throw new Error(`Antigravity transport build failed: ${command[0]}`);
	} else {
		const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(os.homedir(), ".cache", cacheKey);
		const command = ["cargo", "build", "--locked", "--release", "--target", triple, "--manifest-path", manifest];
		const proc = Bun.spawn(command, {
			env: { ...process.env, CARGO_TARGET_DIR: targetDir },
			stdout: "inherit",
			stderr: "inherit",
		});
		if ((await proc.exited) !== 0) throw new Error(`Antigravity transport build failed: ${triple}`);
		await fs.copyFile(path.join(targetDir, triple, "release", filename), executable);
	}
	return executable;
}

if (import.meta.main) {
	const { values } = parseArgs({ options: { out: { type: "string" } } });
	console.log(await buildAgyTransport({ out: values.out }));
}
