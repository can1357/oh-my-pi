import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

describe("main.ts telemetry lazy boundary", () => {
	it("does not unconditionally await telemetry-export on the normal startup path", () => {
		const mainSource = fs.readFileSync(path.join(import.meta.dir, "../src/main.ts"), "utf8");

		// The static import must be present (not dynamic)
		expect(mainSource).toMatch(/import\s*\{[^}]*initTelemetryExport[^}]*\}\s*from\s*["']\.\/telemetry-export["']/);

		// Find the initTelemetryExport call and verify it's not preceded by an unconditional await import
		const initCallMatch = mainSource.match(/await\s+logger\.time\(\s*["']initTelemetryExport["']/);
		expect(initCallMatch).not.toBeNull();

		// Check that there's no `await import("./telemetry-export")` before the initTelemetryExport call
		const beforeInitCall = mainSource.slice(0, initCallMatch!.index);
		expect(beforeInitCall).not.toMatch(/await\s+import\(["']\.\/telemetry-export["']\)/);
	});

	it("does not unconditionally await pi-catalog/models on the normal startup path", () => {
		const mainSource = fs.readFileSync(path.join(import.meta.dir, "../src/main.ts"), "utf8");

		// The pi-catalog/models import must be inside the isTelemetryExportEnabled() guard
		const catalogImportMatch = mainSource.match(/await\s+import\(["']@oh-my-pi\/pi-catalog\/models["']\)/);
		expect(catalogImportMatch).not.toBeNull();

		// Find the isTelemetryExportEnabled check that precedes it
		const beforeCatalogImport = mainSource.slice(0, catalogImportMatch!.index);
		expect(beforeCatalogImport).toMatch(/if\s*\(\s*isTelemetryExportEnabled\(\)\s*\)/);
	});
});
