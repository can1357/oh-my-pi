import { describe, expect, it } from "bun:test";
import { initTelemetryExport, isTelemetryExportEnabled } from "../src/telemetry-export";

// Bun internal: moduleLoadList is not in public types
const processWithModuleLoadList = process as unknown as { moduleLoadList: string[] };

describe("telemetry lazy boundary", () => {
	it("does not load telemetry implementation modules when export is disabled", async () => {
		const before = new Set(processWithModuleLoadList.moduleLoadList);
		await initTelemetryExport(false);
		const newModules = processWithModuleLoadList.moduleLoadList.filter(m => !before.has(m));
		const telemetryModules = newModules.filter(
			m => m.includes("telemetry-export-otlp") || m.includes("opentelemetry"),
		);
		expect(telemetryModules).toEqual([]);
		expect(isTelemetryExportEnabled()).toBe(false);
	});
});
