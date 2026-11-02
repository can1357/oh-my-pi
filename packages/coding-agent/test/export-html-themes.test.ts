import { describe, expect, it } from "bun:test";
import { parseExportArgs } from "@oh-my-pi/pi-coding-agent/export/html";

describe("HTML export themes", () => {
	it("parses the optional user-theme flag before or after the output path", () => {
		expect(parseExportArgs("--themes export.html")).toEqual({ outputPath: "export.html", useUserThemes: true });
		expect(parseExportArgs("export.html --themes")).toEqual({ outputPath: "export.html", useUserThemes: true });
		expect(parseExportArgs("")).toEqual({ outputPath: undefined, useUserThemes: false });
		expect(() => parseExportArgs("one.html two.html")).toThrow("Usage: /export [--themes] [path]");
	});
});
