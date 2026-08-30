import * as fs from "node:fs";
import { ensureRuntimeInstalled } from "../../src/runtime-install";

const runtimeDir = Bun.argv[2];
const dependencySpec = Bun.argv[3];
const readyPath = Bun.argv[4];
if (!runtimeDir || !dependencySpec || !readyPath) {
	throw new Error("runtime-install-holder requires runtime, dependency, and readiness paths");
}

await ensureRuntimeInstalled({
	runtimeDir,
	install: { dependencies: { "omp-runtime-fixture": dependencySpec } },
	probePackage: "omp-runtime-fixture",
	onPhase: phase => {
		if (phase !== "download") return;
		fs.writeFileSync(readyPath, "ready");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	},
});
