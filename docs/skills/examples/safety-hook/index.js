/**
 * Safety hook: blocks any bash tool call that contains "rm -rf /".
 *
 * Demonstrates the tool_call blocking contract:
 *   return { block: true, reason: "..." }
 *
 * The `reason` string is returned to the LLM as the tool error text so the
 * agent understands why execution was prevented.
 */
export default function safetyHook(pi) {
    pi.on("tool_call", async (event) => {
        if (event.toolName !== "bash")
            return;
        const command = String(event.input.command ?? "");
        // Exact pattern match: "rm -rf /" (with any surrounding whitespace)
        if (/\brm\s+-rf\s+\//.test(command)) {
            return {
                block: true,
                reason: "safety-hook: refusing to delete root filesystem (rm -rf /)",
            };
        }
    });
}
