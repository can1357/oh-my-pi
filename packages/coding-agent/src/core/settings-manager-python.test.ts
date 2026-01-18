import { describe, expect, it } from "bun:test";
import { SettingsManager } from "./settings-manager";

describe("SettingsManager python settings", () => {
	it("defaults to ipy-only and session", () => {
		const settings = SettingsManager.inMemory();

		expect(settings.getPythonToolMode()).toBe("ipy-only");
		expect(settings.getPythonKernelMode()).toBe("session");
	});

	it("persists python tool and kernel modes", async () => {
		const settings = SettingsManager.inMemory();

		await settings.setPythonToolMode("bash-only");
		await settings.setPythonKernelMode("per-call");

		expect(settings.getPythonToolMode()).toBe("bash-only");
		expect(settings.getPythonKernelMode()).toBe("per-call");
		expect(settings.serialize().python?.toolMode).toBe("bash-only");
		expect(settings.serialize().python?.kernelMode).toBe("per-call");
	});
});
