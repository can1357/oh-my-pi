import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import * as path from "node:path";
import packageManifest from "../package.json" with { type: "json" };
import {
	describeFastembedLoadFailure,
	fastembedLoadFailureHint,
	fastembedRuntimeInstallPlan,
	isRecoverableFastembedLoadError,
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

// #14346: on a host whose loader cannot resolve the C++ runtime the prebuilt
// onnxruntime addon links against, the only signal reaching the user was the
// raw loader string, which reads like a broken model download. These cover the
// mapping to an actionable remedy.
describe("fastembed native load failures", () => {
	test("names the missing system library and the OMP_NATIVE_LIBRARY_PATH remedy", () => {
		const libstdcxx = Object.assign(new Error("Cannot load library"), {
			cause: new Error("libstdc++.so.6: cannot open shared object file: No such file or directory"),
		});
		expect(fastembedLoadFailureHint(libstdcxx)).toContain("libstdc++.so.6");
		expect(fastembedLoadFailureHint(libstdcxx)).toContain("OMP_NATIVE_LIBRARY_PATH");

		const libgcc = Object.assign(new Error("Cannot load library"), {
			cause: "libgcc_s.so.1: cannot open shared object file",
		});
		expect(fastembedLoadFailureHint(libgcc)).toContain("libgcc_s.so.1");
	});

	test("finds the loader message at any depth of the cause chain", () => {
		// The loader text can sit two `cause` links down; matching only the
		// outermost message is what made this unreportable.
		const nested = Object.assign(new Error("FlagEmbedding.init failed"), {
			cause: Object.assign(new Error("require of onnxruntime_binding.node failed"), {
				cause: new Error("libstdc++.so.6: cannot open shared object file: No such file or directory"),
			}),
		});
		expect(fastembedLoadFailureHint(nested)).toContain("libstdc++.so.6");

		// A dlopen failure that names no system library is not this defect.
		const dlopen = Object.assign(new Error("Could not load the shared library libonnxruntime_binding.so"), {
			code: "ERR_DLOPEN_FAILED",
		});
		expect(fastembedLoadFailureHint(dlopen)).toBeUndefined();
	});

	test("leaves failures it cannot advise on untouched", () => {
		const plain = new Error("Protobuf parsing failed");
		expect(fastembedLoadFailureHint(plain)).toBeUndefined();
		expect(describeFastembedLoadFailure(plain)).toBe(plain);
		expect(describeFastembedLoadFailure("a string")).toBe("a string");
	});

	test("wraps a loader failure with the remedy while keeping the original text", () => {
		const original = new Error("libstdc++.so.6: cannot open shared object file: No such file or directory");
		const described = describeFastembedLoadFailure(original);
		if (!(described instanceof Error)) throw new Error("expected an Error");
		expect(described.message).toContain(original.message);
		expect(described.message).toContain("OMP_NATIVE_LIBRARY_PATH");
		expect(described.cause).toBe(original);
	});

	test("a dlopen failure is not retried as a missing install", () => {
		// Re-installing the same prebuilt addons cannot fix a broken dlopen, and
		// the runtime install costs ~270MB. Only "not installed here" retries.
		expect(isRecoverableFastembedLoadError({ code: "ERR_DLOPEN_FAILED" })).toBe(false);
		expect(isRecoverableFastembedLoadError({ code: "MODULE_NOT_FOUND" })).toBe(true);
		expect(isRecoverableFastembedLoadError({ code: "ERR_MODULE_NOT_FOUND" })).toBe(true);
		expect(isRecoverableFastembedLoadError(new Error("Cannot find module 'fastembed'"))).toBe(true);
		expect(isRecoverableFastembedLoadError(new Error("Protobuf parsing failed"))).toBe(false);
	});
});
