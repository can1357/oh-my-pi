import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import * as configModule from "@oh-my-pi/pi-coding-agent/config";
import * as shim from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import * as utils from "@oh-my-pi/pi-utils";

// Issue #5968: pi extensions import the SDK path helpers (`getAgentDir`,
// `getProjectDir`, `getPackageDir`) from `@earendil-works/pi-coding-agent`,
// which aliases to this shim. Only `getAgentDir` reached the surface via
// `export * from "../index"`; `getProjectDir` and `getPackageDir` were absent,
// so a named import of either threw Bun's static "Export named X not found"
// error and any importing extension failed validation. These pin the full
// path-helper surface through the public package specifier.
describe("legacy shim path helpers", () => {
	afterEach(() => vi.restoreAllMocks());

	it("exports the three pi SDK path helpers as callable functions", () => {
		expect(typeof shim.getAgentDir).toBe("function");
		expect(typeof shim.getProjectDir).toBe("function");
		expect(typeof shim.getPackageDir).toBe("function");
	});

	it("getPackageDir resolves the coding-agent package root in source mode", () => {
		// omp's canonical helper returns the package root containing package.json
		// (pi's "install directory of the coding-agent package" semantics).
		const dir = shim.getPackageDir();
		expect(path.basename(dir)).toBe("coding-agent");
	});

	// Pi's getPackageDir() is string-valued: extensions do
	// `path.join(getPackageDir(), ...)`. omp's canonical helper returns
	// `undefined` inside a `bun --compile` binary (import.meta.dir is
	// /$bunfs/root, no package.json — issue #1423), which would crash every
	// such call in the shipped binary. The shim MUST fall back to a real
	// directory instead of forwarding undefined.
	it("getPackageDir returns a string even when the canonical helper yields undefined", () => {
		spyOn(configModule, "getPackageDir").mockReturnValue(undefined);
		const dir = shim.getPackageDir();
		expect(typeof dir).toBe("string");
		expect(dir.length).toBeGreaterThan(0);
	});

	it("getPackageDir falls back to the executable directory in compiled-binary mode", () => {
		spyOn(configModule, "getPackageDir").mockReturnValue(undefined);
		spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		expect(shim.getPackageDir()).toBe(path.dirname(process.execPath));
	});
});
