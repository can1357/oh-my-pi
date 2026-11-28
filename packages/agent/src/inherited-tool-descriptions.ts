import type { Tool } from "@oh-my-pi/pi-ai";

/**
 * Tool descriptions a fork sends in its owner's wording, so its requests open
 * with the owner's cached prefix.
 *
 * A fork (`/tan`) continues its owner's transcript, but its tools render their
 * descriptions from session state it does not share: no UI, no TUI transcript,
 * a headless approval mode. Any byte of that drift sits ahead of the transcript,
 * so the fork misses the owner's prompt cache entirely and, on prefix-bound
 * reasoning (Claude, GPT-6.2), the provider drops every inherited thinking block.
 *
 * Only wording is inherited: a tool whose wire schema differs from the owner's
 * keeps its own spec, so the model never sees arguments the fork's tool rejects.
 * A pin holds while the fork's own description still renders as it did when
 * pinned; once it changes (a setting, an MCP reload), the fork's own wording wins.
 */
export class InheritedToolDescriptions {
	#byName = new Map<string, { own: string; owner: string }>();

	/** Pin `owner`'s description of every tool `own` declares with the same wire schema but other wording. */
	constructor(own: readonly Tool[], owner: readonly Tool[]) {
		const ownerByName = new Map(owner.map(tool => [tool.name, tool]));
		for (const tool of own) {
			const ownerTool = ownerByName.get(tool.name);
			if (!ownerTool || ownerTool.description === tool.description) continue;
			if (wireShape(ownerTool) !== wireShape(tool)) continue;
			this.#byName.set(tool.name, { own: tool.description, owner: ownerTool.description });
		}
	}

	/** The description to send for `name`, given the one the fork renders now. */
	resolve(name: string, description: string): string {
		const pin = this.#byName.get(name);
		return pin?.own === description ? pin.owner : description;
	}
}

/** Every wire field of `tool` except its description. */
function wireShape(tool: Tool): string {
	const { description: _, ...shape } = tool;
	return JSON.stringify(shape);
}
