import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import packageManifest from "../package.json" with { type: "json" };
import {
	fastembedRuntimeInstallPlan,
	fastembedVersionsFrom,
	loadedFastembedVersions,
	prepareWindowsFastembedRuntime,
} from "../src/core/fastembed-runtime";

// The fastembed peer is pinned as an exact version (not `catalog:`) because
// `core/fastembed-runtime.ts` reads it to `bun install` the on-demand embedding
// runtime — including from bundles where the inlined manifest would otherwise
// carry an uninstallable `catalog:` spec (#2389). The runtime cache must keep
// fastembed's own ORT dependency intact because its native addon links against
// that exact bundled library name (#3054).
describe("fastembed runtime version pins", () => {
	test("pins are exact installable versions, not catalog or range specs", () => {
		expect(packageManifest.peerDependencies.fastembed).toMatch(/^\d+\.\d+\.\d+$/);
		expect(packageManifest.peerDependencies["onnxruntime-node"]).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("runtime install preserves fastembed's transitive onnxruntime pin", () => {
		const plan = fastembedRuntimeInstallPlan();
		expect(plan.install.dependencies).toEqual({
			fastembed: packageManifest.peerDependencies.fastembed,
		});
		expect(plan.install.overrides?.["onnxruntime-node"]).toBeUndefined();
		expect(plan.install.trustedDependencies).toEqual(["onnxruntime-node"]);
		expect(plan.versionKey).toContain("transitive-ort");
		expect(plan.versionKey).not.toContain("forced-ort");
	});

	test("runtime install overrides tokenizers to a release with linux-arm64 bindings", () => {
		const plan = fastembedRuntimeInstallPlan();
		expect(plan.install.overrides).toEqual({ "@anush008/tokenizers": "0.6.0" });
		expect(plan.versionKey).toContain("tokenizers-0.6.0");
	});

	test("Windows preload selects fastembed's ORT DLL before inherited paths", async () => {
		const requireTest = createRequire(import.meta.url);
		const fastembedManifest = requireTest.resolve("fastembed/package.json");
		const fastembedEntry = requireTest.resolve("fastembed");
		const inheritedPath = ["/stale-ort", "/system"].join(path.delimiter);
		const env: NodeJS.ProcessEnv = { PATH: inheritedPath };
		const { ortEntry, ortPackageDir, dllDir } = await prepareWindowsFastembedRuntime({
			fastembedEntry,
			fastembedPackageDir: path.dirname(fastembedManifest),
			arch: "x64",
			env,
		});
		const ortManifest: { version?: unknown } = requireTest(path.join(ortPackageDir, "package.json"));

		expect(ortManifest.version).toBe(packageManifest.peerDependencies["onnxruntime-node"]);
		expect(ortEntry.startsWith(`${ortPackageDir}${path.sep}`)).toBe(true);
		expect(await Bun.file(path.join(dllDir, "onnxruntime.dll")).exists()).toBe(true);
		expect(env.PATH).toBe(`${dllDir}${path.delimiter}${inheritedPath}`);
	});
});

describe("loadedFastembedVersions", () => {
	test("names the loaded fastembed, ORT and tokenizer installations", async () => {
		const versions = await loadedFastembedVersions();
		expect(versions.fastembed).toBe(packageManifest.peerDependencies.fastembed);
		expect(versions.onnxruntime).toBe(packageManifest.peerDependencies["onnxruntime-node"]);
		expect(versions.tokenizers).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe("fastembedVersionsFrom", () => {
	async function stub(root: string, name: string, manifest: Record<string, unknown>): Promise<void> {
		const dir = path.join(root, ...name.split("/"));
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
		await Bun.write(path.join(dir, "index.js"), "module.exports = {};\n");
	}

	test("finds a tokenizer hoisted above a nested fastembed, and one that hides its package.json", async () => {
		await using tmp = await TempDir.create("@mnemopi-fastembed-versions-");
		// workspace/node_modules/@anush008/tokenizers (hoisted); workspace/packages/app/node_modules/fastembed (nested).
		const hoisted = tmp.join("node_modules");
		const nested = tmp.join("packages", "app", "node_modules");
		await stub(hoisted, "@anush008/tokenizers", {
			version: "0.6.1",
			main: "index.js",
			exports: { ".": "./index.js" },
		});
		await stub(nested, "fastembed", { version: "1.2.3", main: "index.js" });
		await stub(path.join(nested, "fastembed", "node_modules"), "onnxruntime-node", {
			version: "1.4.5",
			main: "index.js",
		});

		const fastembedRequire = createRequire(path.join(nested, "fastembed", "index.js"));
		expect(fastembedVersionsFrom(fastembedRequire)).toEqual({
			fastembed: "1.2.3",
			onnxruntime: "1.4.5",
			tokenizers: "0.6.1",
		});
	});

	test("records a package that cannot be resolved as undefined instead of throwing", async () => {
		await using tmp = await TempDir.create("@mnemopi-fastembed-versions-");
		await stub(tmp.join("node_modules"), "fastembed", { version: "1.2.3", main: "index.js" });

		const fastembedRequire = createRequire(path.join(tmp.path(), "node_modules", "fastembed", "index.js"));
		expect(fastembedVersionsFrom(fastembedRequire)).toEqual({
			fastembed: "1.2.3",
			onnxruntime: undefined,
			tokenizers: undefined,
		});
	});
});
