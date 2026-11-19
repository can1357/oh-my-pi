import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { formatExtensionLoadNotifications } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/load-errors";

describe("extension load startup notifications", () => {
	it("formats load failures as sanitized single-line warnings for TUI and print startup paths", () => {
		const homeDir = os.homedir();
		const extensionPath = path.join(homeDir, "omp-notification-fixture", "plugin\tname", "extension.ts");
		const tailMarker = "TAIL_MARKER_AFTER_TRUNCATION";
		const [message] = formatExtensionLoadNotifications([
			{
				path: extensionPath,
				error: `SyntaxError: Missing named export\n\tat extension loader\n${"x".repeat(200)}${tailMarker}`,
			},
		]);

		expect(message).toBeDefined();
		expect(message?.startsWith("Failed to load extension ~/omp-notification-fixture/plugin")).toBe(true);
		expect(message).toContain("name/extension.ts: SyntaxError: Missing named export at extension loader");
		expect(message).not.toContain(homeDir);
		expect(message).not.toContain("\n");
		expect(message).not.toContain("\t");
		expect(message).not.toContain(tailMarker);
	});
});
