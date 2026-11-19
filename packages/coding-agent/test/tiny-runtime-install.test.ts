import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureOnnxRuntimeCudaProviders, formatOnnxRuntimeCudaDiagnostics } from "../src/subprocess/worker-runtime";

const tempDirs: string[] = [];
const CUDA_PROVIDER_FILES = [
	"libonnxruntime_providers_cuda.so",
	"libonnxruntime_providers_shared.so",
	"libonnxruntime_providers_tensorrt.so",
];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeRuntimeWithOnnxInstallScript(): Promise<string> {
	const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tiny-runtime-install-"));
	tempDirs.push(runtimeDir);
	const packageDir = path.join(runtimeDir, "node_modules", "onnxruntime-node");
	await Bun.write(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name: "onnxruntime-node", version: "1.24.3", main: "dist/index.js" }),
	);
	await Bun.write(path.join(packageDir, "dist", "index.js"), "module.exports = {};\n");
	await Bun.write(
		path.join(packageDir, "script", "install.js"),
		[
			"const fs = require('node:fs');",
			"const path = require('node:path');",
			"if (process.env.ONNXRUNTIME_NODE_INSTALL !== 'cuda12') process.exit(2);",
			"const dir = path.join(__dirname, '..', 'bin', 'napi-v6', 'linux', 'x64');",
			"fs.mkdirSync(dir, { recursive: true });",
			`for (const file of ${JSON.stringify(CUDA_PROVIDER_FILES)}) fs.writeFileSync(path.join(dir, file), '');`,
		].join("\n"),
	);
	return runtimeDir;
}

describe("tiny runtime CUDA provider repair", () => {
	it("runs onnxruntime-node's cuda12 installer when compiled runtime sidecars are missing", async () => {
		if (process.platform !== "linux" || process.arch !== "x64") return;
		const runtimeDir = await makeRuntimeWithOnnxInstallScript();

		await ensureOnnxRuntimeCudaProviders(runtimeDir, "cuda");

		const binDir = path.join(runtimeDir, "node_modules", "onnxruntime-node", "bin", "napi-v6", "linux", "x64");
		for (const file of CUDA_PROVIDER_FILES) {
			expect(await Bun.file(path.join(binDir, file)).exists()).toBe(true);
		}
	});

	it("repairs CUDA sidecars for generic accelerated device requests", async () => {
		if (process.platform !== "linux" || process.arch !== "x64") return;
		for (const device of ["auto", "gpu"] as const) {
			const runtimeDir = await makeRuntimeWithOnnxInstallScript();

			await ensureOnnxRuntimeCudaProviders(runtimeDir, device);

			const binDir = path.join(runtimeDir, "node_modules", "onnxruntime-node", "bin", "napi-v6", "linux", "x64");
			for (const file of CUDA_PROVIDER_FILES) {
				expect(await Bun.file(path.join(binDir, file)).exists()).toBe(true);
			}
		}
	});

	it("reports CUDA device visibility failures after provider sidecars exist", async () => {
		if (process.platform !== "linux" || process.arch !== "x64") return;
		const runtimeDir = await makeRuntimeWithOnnxInstallScript();
		await ensureOnnxRuntimeCudaProviders(runtimeDir, "cuda");

		const diagnostic = await formatOnnxRuntimeCudaDiagnostics(
			{ __ompRuntimeNodeModules: path.join(runtimeDir, "node_modules") },
			"cuda",
			new Error(
				"CUDA failure 100: no CUDA-capable device is detected ; GPU=-1 ; expr=cudaSetDevice(info_.device_id);",
			),
		);

		expect(diagnostic).toContain("CUDA runtime reports no CUDA-capable device");
		expect(diagnostic).toContain("make the NVIDIA GPU visible to this process/session");
	});

	it("surfaces a deferred sidecar install failure through the CUDA diagnostics helper", async () => {
		if (process.platform !== "linux" || process.arch !== "x64") return;
		const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tiny-runtime-install-"));
		tempDirs.push(runtimeDir);
		const packageDir = path.join(runtimeDir, "node_modules", "onnxruntime-node");
		await Bun.write(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name: "onnxruntime-node", version: "1.24.3", main: "dist/index.js" }),
		);
		await Bun.write(path.join(packageDir, "dist", "index.js"), "module.exports = {};\n");

		const diagnostic = await formatOnnxRuntimeCudaDiagnostics(
			{
				__ompRuntimeNodeModules: path.join(runtimeDir, "node_modules"),
				__ompCudaRepairError:
					"Failed to install ONNX Runtime CUDA provider binaries: connect ENETUNREACH api.nuget.org",
			},
			"cuda",
			new Error("OrtSessionOptionsAppendExecutionProvider_Cuda: Failed to load shared library"),
		);

		expect(diagnostic).toContain("ONNX Runtime CUDA provider install failed");
		expect(diagnostic).toContain("ENETUNREACH");
		expect(diagnostic).toContain("CPU inference remained available");
	});
});
