import { normalizeToolNames } from "../tools/builtin-names";

/**
 * Capability names every harness is offered from startup.
 * Source: `ALWAYS_ON_CAPABILITIES` and `parity/always-on/manifest.json`.
 * `wait` is documented there and not mounted. `find`, `ast_grep`, `ast_edit`,
 * and `wait` are OMP built-ins, not capability tools. `run_command` is the
 * agentmux-mounted capability gateway and is not in this set.
 */
export const ALWAYS_ON_CAPABILITY_NAMES: readonly string[] = [
  "read",
  "write",
  "edit",
  "edit_replace",
  "edit_patch",
  "grep",
  "glob",
  "ask",
  "todo",
  "pin_decision",
  "resolve_decision",
  "eval",
  "task_fleet",
];

const HOOK_CONTEXT_SOURCE = "suggest_skills_tools_and_mcp";

/**
 * Registry keys named by the UserPromptSubmit hook's additionalContext.
 *
 * Path: system-context[source=suggest_skills_tools_and_mcp] > mcp-tools > tool > name.
 * `mcp__agentmux__*` names in that block are not deferred-tool selections.
 */
export function toolNamesFromPromptHookContext(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const blocks = text.matchAll(
    /<system-context\b[^>]*\bsource=["']suggest_skills_tools_and_mcp["'][^>]*>[\s\S]*?<\/system-context>/gi,
  );
  for (const block of blocks) {
    if (!block[0].includes(HOOK_CONTEXT_SOURCE)) continue;
    const sections = block[0].matchAll(/<mcp-tools\b[^>]*>[\s\S]*?<\/mcp-tools>/gi);
    for (const section of sections) {
      for (const nameMatch of section[0].matchAll(/<name>([^<]+)<\/name>/gi)) {
        const name = nameMatch[1]?.trim();
        if (!name || name.startsWith("mcp__agentmux__") || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names;
}
/** Join text parts so a before-model hook can see an injected system-context block. */
export function promptHookContextText(messages: readonly { content?: unknown }[]): string {
  return messages.map(messageText).filter(text => text.length > 0).join("\n");
}

function messageText(message: { content?: unknown }): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap(part => {
      if (typeof part === "string") return [part];
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return [part.text];
      return [];
    })
    .join("\n");
}

/**
 * Replace set for one model request.
 *
 * Non-deferred tools that are already enabled stay (OMP built-ins, agentmux,
 * including `run_command`). Registered always-on names stay. Hook matches are
 * added. Deferred tools the hook did not name this turn are left out.
 * Unregistered names are omitted; `setActiveToolsByName` would drop them.
 */
export function activeToolNamesForTurn(input: {
  enabled: readonly string[];
  registered: ReadonlySet<string>;
  deferredNames: ReadonlySet<string>;
  hookMatches: readonly string[];
}): string[] {
  const kept = input.enabled.filter(name => !input.deferredNames.has(name));
  const alwaysOn = ALWAYS_ON_CAPABILITY_NAMES.filter(name => input.registered.has(name));
  const matches = input.hookMatches.filter(
    name => input.registered.has(name) && !name.startsWith("mcp__agentmux__"),
  );
  return normalizeToolNames([...kept, ...alwaysOn, ...matches]);
}
