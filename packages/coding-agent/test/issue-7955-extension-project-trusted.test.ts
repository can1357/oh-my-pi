import { describe, expect, it } from "bun:test";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

function createRunner(): ExtensionRunner {
	const runtime = {
		flagValues: new Map(),
		pendingProviderRegistrations: [],
	} as unknown as ExtensionRuntime;
	return new ExtensionRunner([], runtime, "/tmp", { getCwd: () => "/tmp" } as never, {} as never);
}

describe("ExtensionRunner project-trust context (issue #7955)", () => {
	it("exposes isProjectTrusted() so Pi-authored extensions can seed SettingsManager", () => {
		const ctx = createRunner().createContext();
		// Regression: this method was missing, so pi-cliproxyapi-provider's
		// session_start handler crashed with "ctx.isProjectTrusted is not a function".
		expect(typeof ctx.isProjectTrusted).toBe("function");
		expect(ctx.isProjectTrusted()).toBe(true);
	});

	it("command context inherits isProjectTrusted()", () => {
		const ctx = createRunner().createCommandContext();
		expect(ctx.isProjectTrusted()).toBe(true);
	});
});
