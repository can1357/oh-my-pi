import { describe, expect, it } from "bun:test";
import { isLspmuxSupported, wrapWithLspmux } from "@oh-my-pi/pi-coding-agent/lsp/lspmux";

const running = { available: true, running: true, binaryPath: "C:\\bin\\lspmux.exe", config: null };

describe("isLspmuxSupported", () => {
	it("recognizes rust-analyzer from a Windows path with .exe", () => {
		expect(isLspmuxSupported("C:\\Users\\dev\\.cargo\\bin\\rust-analyzer.exe")).toBe(true);
	});

	it("recognizes rust-analyzer from a POSIX path", () => {
		expect(isLspmuxSupported("/home/dev/.cargo/bin/rust-analyzer")).toBe(true);
	});

	it("rejects servers outside the supported set", () => {
		expect(isLspmuxSupported("C:\\tools\\gopls.exe")).toBe(false);
	});
});

describe("wrapWithLspmux", () => {
	it("routes an absolute Windows rust-analyzer path through lspmux client", () => {
		expect(wrapWithLspmux("C:\\Users\\dev\\.cargo\\bin\\rust-analyzer.exe", [], running)).toEqual({
			command: "C:\\bin\\lspmux.exe",
			args: ["client"],
			env: { LSPMUX_SERVER: "C:\\Users\\dev\\.cargo\\bin\\rust-analyzer.exe" },
		});
	});

	it("uses lspmux's default server for bare rust-analyzer without args", () => {
		expect(wrapWithLspmux("rust-analyzer", [], running)).toEqual({ command: "C:\\bin\\lspmux.exe", args: [] });
	});
});
