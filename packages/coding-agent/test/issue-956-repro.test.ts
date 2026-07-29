import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as mcpClient from "@pk-nerdsaver-ai/pi-coding-agent/mcp/client";
import { MCPCommandController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import {
	getConfigRootDir,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@pk-nerdsaver-ai/pi-utils";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

// Per-file spy tracking. `vi.restoreAllMocks()` IS `mock.restore()` — the same
// native function — and that global restore walks Bun's whole mock registry to
// unpatch spies. When one of them patched a sealed ESM module namespace, the
// walk segfaults the process (exit 132) once a later file in the same run
// imports an overlapping module graph, taking the shared-process bucket with it.
//
// The tracker is deliberately PER FILE. A module-shared array would let one
// file's teardown restore another file's still-live spies — the same cross-file
// leak, pointing the other way.
const trackedSpies: Array<{ mockRestore: () => void }> = [];
function trackedSpyOn<T extends object, K extends keyof T>(obj: T, key: K) {
	const spy = vi.spyOn(obj, key);
	trackedSpies.push(spy as unknown as { mockRestore: () => void });
	return spy;
}
function restoreTrackedSpies(): void {
	for (const spy of trackedSpies.splice(0).reverse()) spy.mockRestore();
}

describe("issue #956: interactive /mcp test", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-issue-956-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-issue-956-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);

		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify(
				{
					mcpServers: {
						github: {
							type: "stdio",
							command: "github-mcp-server",
							args: ["serve"],
						},
					},
				},
				null,
				2,
			),
		);
	});

	afterEach(async () => {
		restoreTrackedSpies();
		setProjectDir(originalProjectDir);
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	it("tests a connected server discovered from standalone .mcp.json", async () => {
		const transport = {
			connected: true,
			request: vi.fn(),
			notify: vi.fn(),
			close: vi.fn(async () => {}),
		};
		const connection = {
			name: "github",
			config: { type: "stdio" as const, command: "github-mcp-server", args: ["serve"] },
			transport,
			serverInfo: { name: "GitHub MCP", version: "1.0.0" },
			capabilities: {},
		};
		const showError = vi.fn();
		const showStatus = vi.fn();
		const requestRender = vi.fn();
		const addChild = vi.fn();
		const refreshMCPTools = vi.fn();
		const connectToServer = trackedSpyOn(mcpClient, "connectToServer").mockResolvedValue(connection);
		const listTools = trackedSpyOn(mcpClient, "listTools").mockResolvedValue([{ name: "search_issues" }] as never);
		const disconnectServer = trackedSpyOn(mcpClient, "disconnectServer").mockResolvedValue();
		const controller = new MCPCommandController({
			chatContainer: { addChild },
			present: (content: unknown) => {
				for (const item of Array.isArray(content) ? content : [content]) addChild(item);
				requestRender();
			},
			ui: { requestRender },
			editor: {},
			showError,
			showStatus,
			session: { refreshMCPTools },
			mcpManager: {
				prepareConfig: vi.fn(async config => config),
				getConnectionStatus: vi.fn(() => "connected"),
			},
		} as never);

		await controller.handle("/mcp test github");

		expect(showError).not.toHaveBeenCalled();
		expect(connectToServer).toHaveBeenCalledWith(
			"github",
			expect.objectContaining({ command: "github-mcp-server", args: ["serve"] }),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(listTools).toHaveBeenCalledWith(connection, expect.objectContaining({ signal: expect.any(AbortSignal) }));
		expect(disconnectServer).toHaveBeenCalledWith(connection);
		expect(requestRender).toHaveBeenCalled();
	});
});
