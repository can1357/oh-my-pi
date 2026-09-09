// @ts-nocheck — example file; install @oh-my-pi/pi-coding-agent before running
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Safety hook: blocks any bash tool call that contains "rm -rf /".
 *
 * Demonstrates the tool_call blocking contract:
 *   return { block: true, reason: "..." }
 *
 * The `reason` string is returned to the LLM as the tool error text so the
 * agent understands why execution was prevented.
 */
export default function safetyHook(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;

    const command = String((event.input as { command?: unknown }).command ?? "");

    // Exact pattern match: "rm -rf /" (with any surrounding whitespace)
    if (/\brm\s+-rf\s+\//.test(command)) {
      return {
        block: true,
        reason: "safety-hook: refusing to delete root filesystem (rm -rf /)",
      };
    }
  });
}
