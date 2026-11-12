import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCustomTools } from "../../src/extensibility/custom-tools/loader";

let tempRoot: string | undefined;

afterEach(async () => {
	if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
	tempRoot = undefined;
});

function root(): string {
	if (!tempRoot) throw new Error("Temporary tool root was not created.");
	return tempRoot;
}

/** Writes a tool module and makes sure its mtime differs from any previous write of the same path. */
async function writeTool(name: string, source: string): Promise<string> {
	tempRoot ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-custom-tool-refresh-"));
	const filePath = path.join(tempRoot, name);
	await Bun.write(filePath, source);
	const bumped = new Date(Date.now() + writeCount++ * 1000);
	await fs.utimes(filePath, bumped, bumped);
	return filePath;
}
let writeCount = 1;

function toolSource(name: string, description: string): string {
	return [
		"export default api => ({",
		`\tname: ${JSON.stringify(name)},`,
		`\tlabel: ${JSON.stringify(name)},`,
		`\tdescription: ${JSON.stringify(description)},`,
		"\tparameters: api.arktype({}),",
		"\tasync execute() {",
		'\t\treturn { content: [{ type: "text", text: "ok" }] };',
		"\t},",
		"});",
	].join("\n");
}

describe("custom tool refresh", () => {
	it("registers a tool whose file appeared after the initial load", async () => {
		const first = await writeTool("first.ts", toolSource("first_tool", "first"));
		const loaded = await loadCustomTools([{ path: first }], root(), []);
		expect(loaded.tools.map(t => t.tool.name)).toEqual(["first_tool"]);

		const second = await writeTool("second.ts", toolSource("second_tool", "second"));
		const refresh = await loaded.refresh([{ path: first }, { path: second }]);

		expect(refresh.added.map(t => t.tool.name)).toEqual(["second_tool"]);
		expect(refresh.replaced).toEqual([]);
		expect(refresh.removed).toEqual([]);
		expect(refresh.errors).toEqual([]);
		expect(loaded.tools.map(t => t.tool.name)).toEqual(["first_tool", "second_tool"]);
	});

	it("replaces a tool whose file was edited and leaves untouched modules alone", async () => {
		const edited = await writeTool("edited.ts", toolSource("edited_tool", "before"));
		const untouched = await writeTool("untouched.ts", toolSource("untouched_tool", "same"));
		const loaded = await loadCustomTools([{ path: edited }, { path: untouched }], root(), []);
		const untouchedBefore = loaded.tools.find(t => t.tool.name === "untouched_tool");

		await writeTool("edited.ts", toolSource("edited_tool", "after the edit"));
		const refresh = await loaded.refresh([{ path: edited }, { path: untouched }]);

		expect(refresh.replaced.map(r => [r.previous.tool.description, r.next.tool.description])).toEqual([
			["before", "after the edit"],
		]);
		expect(refresh.added).toEqual([]);
		expect(refresh.removed).toEqual([]);
		expect(loaded.tools.find(t => t.tool.name === "untouched_tool")).toBe(untouchedBefore);
		expect(loaded.tools.find(t => t.tool.name === "edited_tool")?.tool.description).toBe("after the edit");
	});

	it("removes the tools of a module that is no longer discovered", async () => {
		const keep = await writeTool("keep.ts", toolSource("keep_tool", "keep"));
		const gone = await writeTool("gone.ts", toolSource("gone_tool", "gone"));
		const loaded = await loadCustomTools([{ path: keep }, { path: gone }], root(), []);

		await fs.rm(gone);
		const refresh = await loaded.refresh([{ path: keep }]);

		expect(refresh.removed.map(t => t.tool.name)).toEqual(["gone_tool"]);
		expect(refresh.added).toEqual([]);
		expect(refresh.replaced).toEqual([]);
		expect(loaded.tools.map(t => t.tool.name)).toEqual(["keep_tool"]);
	});

	it("reports a module that throws and still loads the others", async () => {
		const good = await writeTool("good.ts", toolSource("good_tool", "good"));
		const loaded = await loadCustomTools([{ path: good }], root(), []);

		const broken = await writeTool("broken.ts", "throw new Error('boom at import');");
		const late = await writeTool("late.ts", toolSource("late_tool", "late"));
		const refresh = await loaded.refresh([{ path: good }, { path: broken }, { path: late }]);

		expect(refresh.added.map(t => t.tool.name)).toEqual(["late_tool"]);
		expect(refresh.errors).toHaveLength(1);
		expect(refresh.errors[0]?.path).toBe(broken);
		expect(refresh.errors[0]?.error).toContain("boom at import");
		expect(loaded.tools.map(t => t.tool.name)).toEqual(["good_tool", "late_tool"]);
	});

	it("keeps the previous tools of a module whose edit no longer imports", async () => {
		const flaky = await writeTool("flaky.ts", toolSource("flaky_tool", "works"));
		const loaded = await loadCustomTools([{ path: flaky }], root(), []);
		const previous = loaded.tools[0];

		await writeTool("flaky.ts", "export default api => { throw new Error('half-saved'); };");
		const refresh = await loaded.refresh([{ path: flaky }]);

		expect(refresh.errors.map(e => e.error)).toEqual([expect.stringContaining("half-saved")]);
		expect(refresh.removed).toEqual([]);
		expect(refresh.replaced).toEqual([]);
		expect(loaded.tools[0]).toBe(previous);
	});

	it("does not re-report a failed module until it changes, unless asked to retry", async () => {
		const broken = await writeTool("broken.ts", "throw new Error('still broken');");
		const loaded = await loadCustomTools([{ path: broken }], root(), []);
		expect(loaded.errors).toHaveLength(1);

		expect((await loaded.refresh([{ path: broken }])).errors).toEqual([]);
		expect((await loaded.refresh([{ path: broken }], { retryFailed: true })).errors).toHaveLength(1);

		await writeTool("broken.ts", toolSource("fixed_tool", "fixed"));
		const fixed = await loaded.refresh([{ path: broken }]);
		expect(fixed.added.map(t => t.tool.name)).toEqual(["fixed_tool"]);
		expect(fixed.errors).toEqual([]);
	});

	it("rejects a re-imported tool that collides with a built-in or another module's tool", async () => {
		const owner = await writeTool("owner.ts", toolSource("owned_tool", "owner"));
		const loaded = await loadCustomTools([{ path: owner }], root(), ["bash"]);

		const clashBuiltIn = await writeTool("clash-builtin.ts", toolSource("bash", "shadow"));
		const clashOwned = await writeTool("clash-owned.ts", toolSource("owned_tool", "duplicate"));
		const refresh = await loaded.refresh([{ path: owner }, { path: clashBuiltIn }, { path: clashOwned }]);

		expect(refresh.added).toEqual([]);
		expect(refresh.errors.map(e => e.error)).toEqual([
			'Tool name "bash" conflicts with existing tool',
			'Tool name "owned_tool" conflicts with existing tool',
		]);
		expect(loaded.tools.map(t => t.tool.name)).toEqual(["owned_tool"]);
	});
});
