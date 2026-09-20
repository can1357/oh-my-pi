import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";

const repoRoot = path.join(import.meta.dir, "..");

describe("Windows release binary target", () => {
	it("builds both Windows architecture release assets with their native runtimes", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64,win32-arm64`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();

		expect(output).toContain("Building packages/coding-agent/binaries/omp-windows-x64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-x64-baseline outfile=packages/coding-agent/binaries/omp-windows-x64.exe",
		);
		expect(output).toContain("Building packages/coding-agent/binaries/omp-windows-arm64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-arm64 outfile=packages/coding-agent/binaries/omp-windows-arm64.exe",
		);
		expect(output).toContain("external=fastembed,onnxruntime-node");
		expect(output).not.toContain("bun-windows-x64-modern");
	});

	it("resolves local Windows cross-build aliases for both architectures", () => {
		expect(resolveCrossBuild("win32-x64")).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("win32-arm64")).toEqual({
			id: "win32-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
		expect(resolveCrossBuild("windows-arm64")).toEqual({
			id: "windows-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
	});
});
