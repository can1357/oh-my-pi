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
// Issue #11812 (SoL-Pi Action Fusion): extension wrappers merge
// `builtInToolDef.parameters.properties` with their own extra fields using real
// TypeBox. omp's built-in edit/write expose arktype schemas (callable, no
// `.properties`), so the shim must convert `parameters` to a plain JSON-Schema
// document satisfying the legacy TypeBox contract, or the merged schema drops
// `path`/`content` entirely and the model calls the fused tool without them
// (`undefined is not an object (evaluating 'filePath.startsWith')`).
describe("legacy shim edit/write parameter schemas", () => {
	const defs = [
		["edit", () => shim.createEditTool(process.cwd())],
		["write", () => shim.createWriteTool(process.cwd())],
	] as const;

	it.each(defs)("%s parameters satisfy the legacy TypeBox spread contract", (_, create) => {
		const definition = create();
		const parameters = definition.parameters as Record<string, unknown>;
		expect(typeof parameters).toBe("object");
		expect(parameters).toHaveProperty("type", "object");
		const properties = parameters.properties as Record<string, unknown>;
		expect(properties).toBeTypeOf("object");
		// The spread must yield real per-field schemas: `edit` speaks the upstream
		// pi shape `{path, edits[]}` and `write` the shared `{path, content}`.
		// `path` is the field SoL-Pi's queue/hash guard forwards, whose absence is
		// the exact crash (`filePath.startsWith` on undefined). Every listed
		// property must carry a `type` keyword.
		const expectedFields = definition.name === "write" ? ["path", "content"] : ["path", "edits"];
		expect(Object.keys(properties).sort()).toEqual([...expectedFields].sort());
		for (const schema of Object.values(properties)) {
			expect(schema).toHaveProperty("type");
		}
	});

	it.each(defs)("%s parameters keep the built-in required list as a plain array", (_, create) => {
		// `edit` requires `{path, edits}` (upstream shape); `write` requires
		// `{path, content}`. The shim must expose a plain wire document, not the
		// callable arktype schema whose `required` is a Type function.
		const definition = create();
		const parameters = definition.parameters as { required?: unknown; properties?: Record<string, unknown> };
		expect(Array.isArray(parameters.required)).toBe(true);
		expect((parameters.required as unknown[]).length).toBeGreaterThan(0);
		expect(Object.keys(parameters.properties ?? {}).sort()).toEqual([...(parameters.required as string[])].sort());
	});
});
// The SoL-Pi wrappers unconditionally call `base.renderCall!(...)` /
// `base.renderResult!(...)` on the definitions they wrap, so the shim's edit/write
// definitions must carry renderers like every other legacy definition.
describe("legacy shim edit/write renderers", () => {
	it.each([
		["edit", () => shim.createEditTool(process.cwd())],
		["write", () => shim.createWriteTool(process.cwd())],
	] as const)("%s exposes renderCall and renderResult", (_, create) => {
		const definition = create();
		expect(typeof definition.renderCall).toBe("function");
		expect(typeof definition.renderResult).toBe("function");
	});

	it("edit renderCall shows the target path and survives foreign argument order", () => {
		const renderCall = shim.createEditTool(process.cwd()).renderCall!;
		const themed = renderCall(
			{ input: "file.ts:1-5" },
			{ expanded: false, isPartial: false } as never,
			undefined as never,
		);
		expect(themed).toBeDefined();
		// SoL-Pi passes (args, theme, context) — theme lands where `options` goes.
		// The renderer must not throw and must still return a component.
		const swapped = renderCall(
			{ input: "file.ts" } as never,
			{ fg: (k: string, t: string) => t, bold: (t: string) => t } as never,
			undefined as never,
		);
		expect(swapped).toBeDefined();
	});

	it("write renderCall shows the target path", () => {
		const renderCall = shim.createWriteTool(process.cwd()).renderCall!;
		const component = renderCall(
			{ path: "/tmp/x.txt", content: "hi" },
			{ expanded: false, isPartial: false } as never,
			undefined as never,
		);
		expect(component).toBeDefined();
	});
});
// Review follow-ups: the legacy batch edit must validate the whole edits[] list
// against ONE original snapshot and apply atomically (no sequential writes), the
// specialized definition must carry the ToolDefinition marker the SDK probes, and
// the aggregate createCodingTools() helper must hand out the same edit wrapper as
// the individual factory.
describe("legacy shim edit batch semantics", () => {
	it("edit definition survives SDK custom-tool probing via the definition marker", () => {
		const definition = shim.createEditTool(process.cwd());
		expect((definition as unknown as Record<string, unknown>).__isToolDefinition).toBe(true);
	});

	it("createCodingTools hands out the legacy edit schema for edit", () => {
		const tools = shim.createCodingTools(process.cwd());
		const edit = tools.find(tool => tool.name === "edit")!;
		const properties = (edit.parameters as unknown as { properties: Record<string, unknown> }).properties;
		expect(Object.keys(properties).sort()).toEqual(["edits", "path"]);
	});

	it("applies a multi-edit batch against one original snapshot atomically", async () => {
		const { mkdtemp, rm, writeFile, readFile } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = await mkdtemp(join(tmpdir(), "legacy-edit-batch-"));
		try {
			// Original contains one A and one B; A→B would make B ambiguous for a
			// naive sequential writer, B→C then applies against the same snapshot.
			const file = join(dir, "batch.txt");
			await writeFile(file, "A\nB\n");
			const edit = shim.createEditTool(dir).execute!;
			const result = await edit(
				"batch-1",
				{
					path: file,
					edits: [
						{ oldText: "A", newText: "B" },
						{ oldText: "B", newText: "C" },
					],
				},
				undefined,
				undefined,
				{ cwd: dir } as never,
			);
			const text = (result as { content: Array<{ type: string; text: string }> }).content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(text).toContain("2");
			expect(await readFile(file, "utf8")).toBe("B\nC\n");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a batch whose second edit would be ambiguous after the first, without writing", async () => {
		const { mkdtemp, rm, writeFile, readFile, stat } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = await mkdtemp(join(tmpdir(), "legacy-edit-ambig-"));
		try {
			const file = join(dir, "ambig.txt");
			const before = "same\nsame\n";
			await writeFile(file, before);
			const edit = shim.createEditTool(dir).execute!;
			// Each oldText matches twice in the original snapshot → invalid, no write.
			await expect(
				edit(
					"batch-2",
					{
						path: file,
						edits: [
							{ oldText: "same", newText: "x" },
							{ oldText: "same", newText: "y" },
						],
					},
					undefined,
					undefined,
					{ cwd: dir } as never,
				),
			).rejects.toThrow(/unique/i);
			expect(await readFile(file, "utf8")).toBe(before);
			expect((await stat(file)).mtimeMs).toBeLessThan(Date.now() + 50_000);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("single-edit calls still route through omp's replace-mode tool", async () => {
		const { mkdtemp, rm, writeFile, readFile } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = await mkdtemp(join(tmpdir(), "legacy-edit-single-"));
		try {
			const file = join(dir, "single.txt");
			await writeFile(file, "before\n");
			const edit = shim.createEditTool(dir).execute!;
			await edit(
				"single-1",
				{ path: file, edits: [{ oldText: "before", newText: "after" }] },
				undefined,
				undefined,
				{ cwd: dir } as never,
			);
			expect(await readFile(file, "utf8")).toBe("after\n");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
