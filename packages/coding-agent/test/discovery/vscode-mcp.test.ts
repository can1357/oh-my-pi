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

	test("keeps an unset VS Code predefined variable literal without flagging it", async () => {
		// Names no environment defines, so the test never mutates them.
		const unset = "OMP_VSCODE_MCP_TEST_UNSET_3C8E51";
		const placeholder = (name: string): string => `\${${name}}`;
		expect(Bun.env.workspaceFolder).toBeUndefined();
		expect(Bun.env[unset]).toBeUndefined();
		const filePath = path.join(tempCwd, ".vscode", "mcp.json");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(
			filePath,
			JSON.stringify({
				mcp: {
					servers: {
						local: {
							command: "node",
							args: [`${placeholder("workspaceFolder")}/server.js`, placeholder(unset)],
						},
					},
				},
			}),
		);

		const result = await loadVscodeMcp(tempCwd);
		const local = result.items.find(server => server.name === "local");

		expect(local?.args).toEqual([`${placeholder("workspaceFolder")}/server.js`, placeholder(unset)]);
		expect(local?.unresolvedEnv).toEqual([{ variable: unset, field: "args[1]" }]);
	});
});
