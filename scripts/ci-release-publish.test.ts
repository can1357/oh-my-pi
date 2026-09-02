import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyPublishBin,
	bundleExternalFileDependencies,
	legalPayloadFiles,
	npmDistTag,
	packages,
	prepareNativeCorePackage,
	rewriteManifest,
	stageLegalPayloads,
} from "./ci-release-publish";

describe("npm dist-tags", () => {
	it("routes canaries while rejecting other prereleases", () => {
		expect(npmDistTag("0.13.0-canary.2")).toBe("canary");
		expect(npmDistTag("0.13.0")).toBe("latest");
		expect(() => npmDistTag("0.13.0-rc.1")).toThrow("Unsupported prerelease version");
	});
});

describe("published legal payloads", () => {
	it("selects the exact payload for MIT packages", () => {
		expect(legalPayloadFiles("MIT")).toEqual(["LICENSE", "THIRD-PARTY-NOTICES.txt"]);
		expect(() => legalPayloadFiles("MIT OR Apache-2.0")).toThrow("Unsupported package license: MIT OR Apache-2.0");
		expect(() => legalPayloadFiles(undefined)).toThrow("Unsupported package license: <missing>");
	});

	it("stages missing legal files without replacing package-local text", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-publish-legal-"));
		const pkgDir = path.join(root, "package");
		await fs.mkdir(pkgDir);
		try {
			await Promise.all([
				Bun.write(path.join(root, "LICENSE"), "root MIT\n"),
				Bun.write(path.join(root, "THIRD-PARTY-NOTICES.txt"), "notices\n"),
				Bun.write(path.join(pkgDir, "LICENSE"), "package MIT\n"),
			]);

			const files = await stageLegalPayloads(pkgDir, "MIT", true, root);
			expect(files).toEqual(["LICENSE", "THIRD-PARTY-NOTICES.txt"]);
			expect(await Bun.file(path.join(pkgDir, "LICENSE")).text()).toBe("package MIT\n");
			expect(await Bun.file(path.join(pkgDir, "THIRD-PARTY-NOTICES.txt")).text()).toBe("notices\n");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("lists every legal file explicitly in the native core package", async () => {
		const pkgDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-core-"));
		try {
			await Bun.write(
				path.join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@oh-my-pi/pi-natives",
					version: "15.5.15",
					license: "MIT",
				}),
			);
			const manifest = await prepareNativeCorePackage(pkgDir, false);
			expect(manifest.files).toEqual([
				"native/index.js",
				"native/index.d.ts",
				"native/clipboard.js",
				"native/clipboard.d.ts",
				"native/desktop.js",
				"native/desktop.d.ts",
				"native/desktop-adapter.js",
				"native/desktop-adapter.d.ts",
				"native/loader-state.js",
				"native/loader-state.d.ts",
				"native/embedded-addon.js",
				"README.md",
				"LICENSE",
				"THIRD-PARTY-NOTICES.txt",
			]);
		} finally {
			await fs.rm(pkgDir, { recursive: true, force: true });
		}
	});
});

describe("published manifest topology", () => {
	it("repoints omptype runtime entries to dist/js with a bun source condition", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/omptype");
		if (!pkg) throw new Error("omptype missing from publish set");
		expect(pkg.publishJs).toBe(true);

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.main).toBe("./dist/js/index.js");
		expect(manifest.types).toBe("./dist/types/index.d.ts");
		expect(manifest.files).toContain("dist/js");
		expect(manifest.files).toContain("dist/types");
		// `src` must stay packed — the `bun` condition resolves into it.
		expect(manifest.files).toContain("src");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				bun: "./src/index.ts",
				default: "./dist/js/index.js",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
			"./*.js": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
		});
	});

	it("keeps source-runtime packages on src with only types repointed", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/utils");
		if (!pkg) throw new Error("utils missing from publish set");

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.files).toEqual(expect.arrayContaining(["LICENSE", "THIRD-PARTY-NOTICES.txt"]));
		expect(manifest.main).toBe("./src/index.ts");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				import: "./src/index.ts",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				import: "./src/*.ts",
			},
			"./*.js": "./src/*.ts",
			"./ar": {
				types: "./dist/types/ar/index.d.ts",
				import: "./src/ar/index.ts",
			},
		});
	});
});

describe("published file: vendor bundling", () => {
	it("drops thinking-orbs file: spec and nests it for pack", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/coding-agent");
		if (!pkg) throw new Error("coding-agent missing from publish set");

		const manifest = await rewriteManifest(pkg, false);
		const dependencies = manifest.dependencies as Record<string, string>;
		expect(dependencies["thinking-orbs"]).toBeUndefined();
		expect(manifest.bundledDependencies).toEqual(["thinking-orbs"]);
		expect(manifest.files).toContain("node_modules/thinking-orbs");
	});

	it("applyPublishBin also nests thinking-orbs for tarball smoke", async () => {
		const manifest = await applyPublishBin("packages/coding-agent", false);
		const dependencies = manifest.dependencies as Record<string, string>;
		expect(manifest.bin).toEqual({ omp: "dist/cli.js" });
		expect(dependencies["thinking-orbs"]).toBeUndefined();
		expect(manifest.bundledDependencies).toEqual(["thinking-orbs"]);
		expect(manifest.files).toContain("node_modules/thinking-orbs");
	});

	it("copies file: deps into nested node_modules and omits the spec", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bundle-file-deps-"));
		const pkgDir = path.join(root, "package");
		const vendor = path.join(root, "vendor", "thinking-orbs");
		try {
			await fs.mkdir(vendor, { recursive: true });
			await fs.mkdir(pkgDir);
			await Bun.write(
				path.join(vendor, "package.json"),
				JSON.stringify({ name: "thinking-orbs", version: "0.0.1", type: "module", exports: { ".": "./index.js" } }),
			);
			await Bun.write(path.join(vendor, "index.js"), "export const x = 1;\n");
			const manifest = {
				name: "host-pkg",
				version: "1.0.0",
				files: ["src"],
				dependencies: { "thinking-orbs": "file:../vendor/thinking-orbs" },
			};
			await bundleExternalFileDependencies(manifest, pkgDir, true);
			expect(manifest.dependencies).toEqual({});
			expect(manifest.bundledDependencies).toEqual(["thinking-orbs"]);
			expect(manifest.files).toContain("node_modules/thinking-orbs");
			expect(await Bun.file(path.join(pkgDir, "node_modules/thinking-orbs/package.json")).json()).toEqual({
				name: "thinking-orbs",
				version: "0.0.1",
				type: "module",
				exports: { ".": "./index.js" },
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
