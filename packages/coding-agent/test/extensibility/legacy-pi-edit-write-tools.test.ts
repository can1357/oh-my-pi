import { describe, expect, it } from "bun:test";
import * as shim from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

// Issue #7094: pi extensions import the edit/write tool factories
// (`createEditTool`, `createEditToolDefinition`, `createWriteTool`,
// `createWriteToolDefinition`) from `@earendil-works/pi-coding-agent`, which
// aliases to this shim. The shim exported the other five tool factories
// (read/bash/grep/find/ls) but omitted edit and write, so a named import of
// either threw Bun's static "Export named X not found" error and any importing
// extension (e.g. gentle-pi) failed validation. These pin the factory surface
// and the tool definitions they build.
describe("legacy shim edit/write tool factories", () => {
	it("exports the edit/write factories as callable functions", () => {
		expect(typeof shim.createEditTool).toBe("function");
		expect(typeof shim.createEditToolDefinition).toBe("function");
		expect(typeof shim.createWriteTool).toBe("function");
		expect(typeof shim.createWriteToolDefinition).toBe("function");
	});

	it("builds edit and write tool definitions bound to the built-in tools", () => {
		const edit = shim.createEditTool(process.cwd());
		expect(edit.name).toBe("edit");
		expect(typeof edit.execute).toBe("function");

		const write = shim.createWriteTool(process.cwd());
		expect(write.name).toBe("write");
		expect(typeof write.execute).toBe("function");
	});

	it("rejects the unsupported operations seam", () => {
		expect(() => shim.createEditTool(process.cwd(), { operations: {} as never })).toThrow(
			/operations is not supported/,
		);
		expect(() => shim.createWriteTool(process.cwd(), { operations: {} as never })).toThrow(
			/operations is not supported/,
		);
	});
});
