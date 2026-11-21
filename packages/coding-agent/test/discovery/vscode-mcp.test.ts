import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function loadVscodeMcp(cwd: string) {
	return loadCapability<MCPServer>(mcpCapability.id, { cwd, providers: ["vscode"] });
}

describe("VS Code MCP discovery", () => {
	let tempCwd = "";

	beforeEach(async () => {
		tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vscode-mcp-"));
	});

	afterEach(async () => {
		await removeWithRetries(tempCwd);
	});

	test("a project without .vscode/mcp.json yields no warning", async () => {
		const result = await loadVscodeMcp(tempCwd);

		expect(result.items).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("an unparsable .vscode/mcp.json still warns", async () => {
		const filePath = path.join(tempCwd, ".vscode", "mcp.json");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, "{ not json");

		const result = await loadVscodeMcp(tempCwd);

		expect(result.items).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain(`Invalid JSON in ${filePath}`);
	});

	test("a .vscode/mcp.json that is a directory still warns", async () => {
		const filePath = path.join(tempCwd, ".vscode", "mcp.json");
		await fs.mkdir(filePath, { recursive: true });

		const result = await loadVscodeMcp(tempCwd);

		expect(result.items).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain(`Failed to read ${filePath}`);
	});

	// Root reads through mode 000, and Windows ignores it.
	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"an unreadable .vscode/mcp.json still warns",
		async () => {
			const filePath = path.join(tempCwd, ".vscode", "mcp.json");
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, JSON.stringify({ mcp: { servers: {} } }));
			await fs.chmod(filePath, 0o000);

			const result = await loadVscodeMcp(tempCwd);

			expect(result.items).toEqual([]);
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]).toContain(`Failed to read ${filePath}`);
		},
	);
});
