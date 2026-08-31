/**
 * Three things a 27B local model tripped on in a real-project benchmark:
 * the compact profile said "use `grep`" for a grep that only existed as
 * `xd://grep`, so it called `grep` by name; the device doc said "write JSON"
 * without showing a call, so it spent 25 minutes escaping a patch in bash; and
 * a 21-tool MCP server cost a full mounted name per tool on every request.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	listXdevTools,
	resolveMountedXdevExecutable,
	xdevDocs,
	xdevDocsAll,
} from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const EMPTY_TREE = { rootPath: "/tmp", rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] };

async function render(options: Parameters<typeof buildSystemPrompt>[0] = {}): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd: "/tmp",
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: ["read", "write", "bash"],
		xdevTools: [{ name: "grep", summary: "Grep file contents" }],
		personality: "none",
		workspaceTree: EMPTY_TREE,
		...options,
	});
	return systemPrompt.join("\n\n");
}

function session(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({}),
	};
}

describe("mounted-tool references", () => {
	it("reduced profiles name the device path for a mounted tool", async () => {
		const rendered = await render({ contextProfile: "balanced" });
		expect(rendered).toContain("`xd://grep`");
		expect(rendered).not.toMatch(/→ `grep`/);
	});

	it("full profile keeps the bare name, unchanged", async () => {
		const rendered = await render();
		expect(rendered).not.toContain("`xd://grep`");
	});
});

describe("device docs and catalog", () => {
	it("shows one worked write call under the schema", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xdev-compact-refs-"));
		try {
			const s = session(tempDir);
			await createTools(s);
			const xdev = s.xdev;
			if (!xdev) throw new Error("expected xdev state");
			const first = listXdevTools(xdev)[0]!;
			const docs = xdevDocs(xdev, first.name);
			expect(docs).toContain(`Execute by writing JSON to xd://${first.name}.`);
			expect(docs).toMatch(new RegExp(`Example: write\\(path="xd://${first.name}", content="\\{`));
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("keeps worked examples out of the legacy full-profile prompt docs", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xdev-compact-refs-"));
		try {
			const s = session(tempDir);
			await createTools(s);
			const xdev = s.xdev;
			if (!xdev) throw new Error("expected xdev state");
			expect(xdevDocsAll(xdev, "builtins")).not.toContain("Example: write(");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("factors a shared prefix out of an MCP server's catalog row", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xdev-compact-refs-"));
		try {
			const s = session(tempDir);
			await createTools(s);
			const xdev = s.xdev;
			if (!xdev) throw new Error("expected xdev state");
			const base = listXdevTools(xdev)[0]!;
			for (const suffix of ["read_note", "write_note", "search_notes"]) {
				const tool = Object.create(base) as Tool;
				Object.defineProperty(tool, "name", { value: `mcp__memory_${suffix}` });
				Object.defineProperty(tool, "summary", { value: `memory ${suffix}` });
				xdev.tools.set(tool.name, tool);
				xdev.mountedNames.add(tool.name);
			}
			const docs = xdevDocsAll(xdev, "catalog", [], true);
			expect(docs).toContain("- MCP server `memory` (3): xd://mcp__memory_{read_note|write_note|search_notes}");
			expect(docs).not.toContain("xd://mcp__memory_read_note,");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("bounds the static catalog and points omitted devices to query discovery", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xdev-compact-refs-"));
		try {
			const s = session(tempDir);
			await createTools(s);
			const xdev = s.xdev;
			if (!xdev) throw new Error("expected xdev state");
			const base = listXdevTools(xdev)[0]!;
			for (let index = 0; index < 75; index++) {
				const tool = Object.create(base) as Tool;
				const name = `zz_probe_${index.toString().padStart(2, "0")}`;
				Object.defineProperty(tool, "name", { value: name });
				Object.defineProperty(tool, "summary", { value: `probe ${index}` });
				xdev.tools.set(name, tool);
				xdev.mountedNames.add(name);
			}
			const docs = xdevDocsAll(xdev, "catalog", [], true);
			expect(docs).toContain("Static catalog truncated at 50 devices");
			expect(docs).not.toContain("xd://zz_probe_74");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("omits a worked call when the tool has no schema-valid authored example", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xdev-compact-refs-"));
		try {
			const s = session(tempDir);
			await createTools(s);
			const xdev = s.xdev;
			if (!xdev) throw new Error("expected xdev state");
			const base = listXdevTools(xdev)[0]!;
			const tool = Object.create(base) as Tool;
			Object.defineProperty(tool, "name", { value: "enum_only" });
			Object.defineProperty(tool, "parameters", { value: type({ op: "'list'|'status'" }) });
			Object.defineProperty(tool, "examples", { value: [] });
			xdev.tools.set(tool.name, tool);
			xdev.mountedNames.add(tool.name);

			expect(xdevDocs(xdev, tool.name)).not.toContain("Example: write(");
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});

describe("fallback tool resolution", () => {
	it("routes a call named xd://<tool> to the mounted device", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xdev-compact-refs-"));
		try {
			const s = session(tempDir);
			await createTools(s);
			const xdev = s.xdev;
			if (!xdev) throw new Error("expected xdev state");
			const first = listXdevTools(xdev)[0]!;
			expect(resolveMountedXdevExecutable(xdev, `xd://${first.name}`)?.name).toBe(first.name);
			expect(resolveMountedXdevExecutable(xdev, first.name)?.name).toBe(first.name);
			expect(resolveMountedXdevExecutable(xdev, "xd://no_such_device")).toBeUndefined();
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
