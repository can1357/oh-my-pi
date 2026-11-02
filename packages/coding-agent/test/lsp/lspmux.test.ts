import { describe, expect, it, onTestFinished } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectLspmux, isLspmuxSupported, wrapWithLspmux } from "@oh-my-pi/pi-coding-agent/lsp/lspmux";

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

describe("detectLspmux", () => {
	it.skipIf(process.platform === "win32")(
		"looks for lspmux again once PATH changes, as when a plugin puts it on PATH",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lspmux-path-"));
			const savedPath = process.env.PATH;
			onTestFinished(() => {
				if (savedPath === undefined) delete process.env.PATH;
				else process.env.PATH = savedPath;
				fs.rmSync(root, { recursive: true, force: true });
			});
			const empty = path.join(root, "empty");
			const bin = path.join(root, "bin");
			fs.mkdirSync(empty);
			fs.mkdirSync(bin);
			// `lspmux status` exits 0: a running server.
			fs.writeFileSync(path.join(bin, "lspmux"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

			process.env.PATH = empty;
			expect(await detectLspmux()).toMatchObject({ available: false, binaryPath: null });
			process.env.PATH = [bin, empty].join(path.delimiter);
			expect(await detectLspmux()).toMatchObject({
				available: true,
				running: true,
				binaryPath: path.join(bin, "lspmux"),
			});
		},
	);
});
