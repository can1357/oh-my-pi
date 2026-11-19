import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Safety hook: blocks bash tool calls matching `rm -rf` followed by an absolute path.
 * This is a narrow example, not a shell parser or a complete deletion policy.
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

    // Matches root and other absolute targets such as /tmp; many equivalent commands do not match.
    if (/\brm\s+-rf\s+\//.test(command)) {
      return {
        block: true,
        reason: "safety-hook: refusing rm -rf with an absolute-path target",
      };
    }
  });
}
