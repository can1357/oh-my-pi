import { describe, expect, it } from "bun:test";
import { nativeLibraryPathOverlay } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import { tinyWorkerEnvOverlay } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { tinyWorkerEndpoint, tinyWorkerLogPath } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";

describe("tinyWorkerEnvOverlay", () => {
	it("maps non-default settings onto the worker env vars when neither is already set", () => {
		expect(tinyWorkerEnvOverlay({}, "cuda", "fp16")).toEqual({
			PI_TINY_DEVICE: "cuda",
			PI_TINY_DTYPE: "fp16",
		});
	});

	it("lets a present env var win over the persisted setting", () => {
		expect(tinyWorkerEnvOverlay({ PI_TINY_DEVICE: "cpu" }, "cuda", "fp16")).toEqual({
			PI_TINY_DEVICE: "cpu",
			PI_TINY_DTYPE: "fp16",
		});
		expect(tinyWorkerEnvOverlay({ PI_TINY_DTYPE: "q8" }, "cuda", "fp16")).toEqual({
			PI_TINY_DEVICE: "cuda",
			PI_TINY_DTYPE: "q8",
		});
	});

	it("omits a var when its setting is the default sentinel or unset", () => {
		expect(tinyWorkerEnvOverlay({}, "default", "default")).toEqual({});
		expect(tinyWorkerEnvOverlay({}, undefined, undefined)).toEqual({});
	});
});

describe("nativeLibraryPathOverlay", () => {
	it("appends the advertised dirs after an inherited LD_LIBRARY_PATH", () => {
		expect(
			nativeLibraryPathOverlay(
				{ LD_LIBRARY_PATH: "/inherited", OMP_NATIVE_LIBRARY_PATH: "/store/gcc/lib" },
				"linux",
			),
		).toEqual({ LD_LIBRARY_PATH: "/inherited:/store/gcc/lib" });
	});

	it("uses the advertised dirs alone when nothing is inherited", () => {
		expect(
			nativeLibraryPathOverlay({ OMP_NATIVE_LIBRARY_PATH: "/store/gcc/lib:/store/libgcc/lib" }, "linux"),
		).toEqual({ LD_LIBRARY_PATH: "/store/gcc/lib:/store/libgcc/lib" });
	});

	it("stays out of the env on non-Linux platforms", () => {
		const env = { OMP_NATIVE_LIBRARY_PATH: "/store/gcc/lib" };
		expect(nativeLibraryPathOverlay(env, "darwin")).toEqual({});
		expect(nativeLibraryPathOverlay(env, "win32")).toEqual({});
	});

	it("stays out of the env on Linux when no dirs are advertised", () => {
		expect(nativeLibraryPathOverlay({ LD_LIBRARY_PATH: "/inherited" }, "linux")).toEqual({});
		expect(nativeLibraryPathOverlay({ OMP_NATIVE_LIBRARY_PATH: "" }, "linux")).toEqual({});
	});
});

describe("tinyWorkerLogPath", () => {
	// Regression: the log used to be `${endpoint}.log`, which on Windows turns
	// the named-pipe endpoint (`\\.\pipe\omp-tiny-…`) into an unopenable file
	// path and crashed `--smoke-test` with ENOENT.
	it("stays under the runtime directory instead of deriving from the endpoint", () => {
		const logPath = tinyWorkerLogPath("/runtime", "lfm2.5-230m", "onnx");
		expect(logPath.startsWith("/runtime/")).toBe(true);
		expect(logPath.endsWith(".log")).toBe(true);
		expect(logPath.includes(".sock")).toBe(false);
		if (process.platform === "win32") {
			expect(tinyWorkerEndpoint("/runtime", "lfm2.5-230m", "onnx").startsWith("\\\\.\\pipe\\")).toBe(true);
			expect(logPath.startsWith("\\\\.\\pipe\\")).toBe(false);
		}
	});
});
