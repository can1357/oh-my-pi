import type { Context, Message, Tool } from "@oh-my-pi/pi-ai";

/**
 * Last wire definition this Agent sent for each tool name, so a provider that keeps
 * withdrawn tools declared (Anthropic `tool_removal`) can re-declare them byte-identically.
 * Used by prepareProviderCall and Agent.buildSideRequestContext.
 */
export class SentToolDefinitions {
	#byName = new Map<string, Tool>();

	/** Remember the definitions a request is about to send. */
	record(tools: readonly Tool[]): void {
		for (const tool of tools) this.#byName.set(tool.name, tool);
	}

	/**
	 * `context` with {@link Context.inactiveTools} set to the definitions for names the latest
	 * `requestControls.tools.declared` in its messages holds that are not in its `tools`; cleared when
	 * there are none or the request declares no tools. Names never sent by this Agent are skipped: the
	 * provider drops them from the declaration.
	 */
	withInactiveTools(context: Context): Context {
		const inactiveTools = context.tools?.length ? this.#inactiveFor(context.messages, context.tools) : undefined;
		if (!inactiveTools && !context.inactiveTools) return context;
		return { ...context, inactiveTools };
	}

	#inactiveFor(messages: readonly Message[], active: readonly Tool[]): Tool[] | undefined {
		let declared: readonly string[] | undefined;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message?.role === "assistant" && message.requestControls?.tools) {
				declared = message.requestControls.tools.declared;
				break;
			}
		}
		if (!declared) return undefined;
		const activeNames = new Set(active.map(tool => tool.name));
		const inactive: Tool[] = [];
		for (const name of declared) {
			if (activeNames.has(name)) continue;
			const tool = this.#byName.get(name);
			if (tool) inactive.push(tool);
		}
		return inactive.length > 0 ? inactive : undefined;
	}
}
