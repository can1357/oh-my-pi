import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { isDeferredMCPServer } from "@oh-my-pi/pi-coding-agent/mcp/deferred-server";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
  ALWAYS_ON_CAPABILITY_NAMES,
  toolNamesFromPromptHookContext,
} from "@oh-my-pi/pi-coding-agent/session/prompt-tool-activation";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { afterEach, describe, expect, it } from "bun:test";

const ALWAYS_ON_PRESENT = ["read", "write", "edit", "grep", "glob", "ask", "todo", "eval"] as const;
const DEFERRED_TOOL = "mcp__contextforge_search";
const AGENTMUX_RUN_COMMAND = "mcp__capability_agentmux_capability_run_command";

function createTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: type({ value: "string" }),
    strict: true,
    async execute() {
      return { content: [{ type: "text", text: `${name} executed` }] };
    },
  };
}

function createMcpTool(name: string, serverName: string, mcpToolName: string): CustomTool {
  return {
    name,
    label: `${serverName}/${mcpToolName}`,
    description: `${serverName} ${mcpToolName}`,
    parameters: type({ q: "string" }),
    strict: true,
    mcpServerName: serverName,
    mcpToolName,
    async execute() {
      return { content: [{ type: "text", text: `${name} executed` }] };
    },
  } as CustomTool;
}

function hookContext(name: string): string {
  return `<system-context source="suggest_skills_tools_and_mcp" origin="runtime">
  <resources>
    <mcp-tools>
      <tool>
        <name>${name}</name>
        <name>mcp__agentmux__should_not_route_deferred_work</name>
      </tool>
    </mcp-tools>
    <skills>
      <skill><name>not-a-tool</name></skill>
    </skills>
  </resources>
</system-context>`;
}

describe("deferred MCP tool activation", () => {
  const sessions: AgentSession[] = [];

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.dispose();
  });

  it("keeps a deferred server's tools registered but out of the initial active set and xd:// inventory", async () => {
    expect(isDeferredMCPServer("contextforge")).toBe(true);
    expect(isDeferredMCPServer("contextforge-upstream")).toBe(true);
    expect(isDeferredMCPServer("capability-meta")).toBe(true);
    expect(isDeferredMCPServer("agentmux")).toBe(false);
    expect(isDeferredMCPServer("capability-always-on")).toBe(false);
    expect(isDeferredMCPServer("contextforge", false)).toBe(false);

    const promptToolNames: string[][] = [];
    const xdev: XdevState = {
      tools: new Map(),
      mountedNames: new Set(),
      builtInNames: new Set(["read", "write"]),
      isActive: () => true,
    };
    const toolRegistry = xdev.tools;
    for (const name of ALWAYS_ON_PRESENT) toolRegistry.set(name, createTool(name));
    const agent = new Agent({
      getApiKey: () => "test-key",
      initialState: {
        model: buildModel({
          id: "mock",
          name: "mock",
          api: "openai-responses",
          provider: "openai",
          baseUrl: "https://example.invalid",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 2048,
        }),
        systemPrompt: ["initial"],
        tools: ALWAYS_ON_PRESENT.map(name => toolRegistry.get(name)!),
        messages: [],
      },
      convertToLlm,
    });
    const session = new AgentSession({
      agent,
      sessionManager: SessionManager.inMemory(),
      settings: Settings.isolated({ "compaction.enabled": false }),
      modelRegistry: { getApiKey: async () => "test-key" } as never,
      toolRegistry,
      builtInToolNames: [...ALWAYS_ON_PRESENT],
      xdev,
      rebuildSystemPrompt: async toolNames => {
        promptToolNames.push([...toolNames]);
        return { systemPrompt: [`tools:${toolNames.join(",")}`] };
      },
    });
    sessions.push(session);

    const deferred = createMcpTool(DEFERRED_TOOL, "contextforge", "search");
    const runCommand = createMcpTool(AGENTMUX_RUN_COMMAND, "agentmux", "run_command");
    await session.refreshMCPTools([deferred, runCommand]);

    expect(toolRegistry.has(DEFERRED_TOOL)).toBe(true);
    expect(session.getEnabledToolNames()).not.toContain(DEFERRED_TOOL);
    expect(session.getMountedXdevToolNames()).not.toContain(DEFERRED_TOOL);
    expect(promptToolNames.at(-1)).not.toContain(DEFERRED_TOOL);
    expect(session.getEnabledToolNames()).toContain(AGENTMUX_RUN_COMMAND);
    for (const name of ALWAYS_ON_PRESENT) {
      expect(session.getEnabledToolNames()).toContain(name);
    }

    const selected = toolNamesFromPromptHookContext(hookContext(DEFERRED_TOOL));
    expect(selected).toEqual([DEFERRED_TOOL]);
    await session.applyPromptHookTools(hookContext(DEFERRED_TOOL));

    const enabled = session.getEnabledToolNames();
    expect(enabled).toContain(DEFERRED_TOOL);
    expect(enabled).toContain(AGENTMUX_RUN_COMMAND);
    expect(enabled).not.toContain("mcp__agentmux__should_not_route_deferred_work");
    for (const name of ALWAYS_ON_CAPABILITY_NAMES) {
      if ((ALWAYS_ON_PRESENT as readonly string[]).includes(name)) expect(enabled).toContain(name);
    }
    expect(promptToolNames.at(-1)).toContain(DEFERRED_TOOL);
    for (const name of ALWAYS_ON_PRESENT) {
      expect(promptToolNames.at(-1)).toContain(name);
    }
  });
});
