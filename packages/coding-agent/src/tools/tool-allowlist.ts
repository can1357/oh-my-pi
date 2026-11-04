/**
 * `omp --tools <list>` as an allow-list for everything the model can invoke:
 * built-in tools, extension and custom tools, `xd://` devices and MCP tools.
 *
 * An entry is one of:
 * - a tool or device name (`read`, `envoy_send`, `mcp__github_create_issue`);
 * - `mcp:<server>`: every tool of that MCP server;
 * - `xd:*`: every tool that would be mounted as an `xd://` device.
 *
 * A tool the list does not name is neither offered nor mounted. With no MCP
 * entry (`mcp:<server>`, an `mcp__` name, or `xd:*`) the session starts no MCP
 * server at all, as with `--no-mcp`. The `xd://` transport (`write xd://<tool>`)
 * comes with any allowed device and executes only allowed devices; it writes
 * files only when `write` itself is listed.
 */
import type { ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import { isMCPToolName } from "./builtin-names";
import { isMountableUnderXdev } from "./xdev";

const MCP_SELECTOR_PREFIX = "mcp:";
const ALL_DEVICES_SELECTOR = "xd:*";

/** A tool as far as the allow-list needs to see it. */
export interface ToolAllowListSubject {
	readonly name: string;
	readonly loadMode?: ToolLoadMode;
	readonly mcpServerName?: unknown;
}

/** Whether an entry selects a group of tools rather than naming one. */
export function isToolAllowListSelector(entry: string): boolean {
	return entry === ALL_DEVICES_SELECTOR || entry.startsWith(MCP_SELECTOR_PREFIX);
}

/** A {@link ToolAllowList} as plain data. */
export interface ToolAllowListWire {
	names: string[];
	mcpServers: string[];
	allDevices: boolean;
}

/**
 * Whether the session's `--tools` list leaves `write` only as the `xd://`
 * transport. It then changes no file through any path: the `write` tool (not
 * even in the session's local:// sandbox), Cursor's native delete and resource
 * download frames, or anything else that asks whether `write` was granted.
 */
export function allowListDeniesWrite(list: ToolAllowList | undefined): boolean {
	return list !== undefined && !list.allows("write", undefined);
}

export class ToolAllowList {
	readonly #names: ReadonlySet<string>;
	readonly #mcpServers: ReadonlySet<string>;
	readonly #allDevices: boolean;

	private constructor(names: Set<string>, mcpServers: Set<string>, allDevices: boolean) {
		this.#names = names;
		this.#mcpServers = mcpServers;
		this.#allDevices = allDevices;
	}

	/** Parse `--tools` entries; names are matched exactly, selectors by kind. */
	static parse(entries: readonly string[]): ToolAllowList {
		const names = new Set<string>();
		const mcpServers = new Set<string>();
		let allDevices = false;
		for (const entry of entries) {
			if (entry === ALL_DEVICES_SELECTOR) allDevices = true;
			else if (entry.startsWith(MCP_SELECTOR_PREFIX)) {
				const server = entry.slice(MCP_SELECTOR_PREFIX.length);
				if (server.length > 0) mcpServers.add(server);
			} else names.add(entry);
		}
		return new ToolAllowList(names, mcpServers, allDevices);
	}

	/** This list plus the named tools. */
	withNames(names: readonly string[]): ToolAllowList {
		return new ToolAllowList(new Set([...this.#names, ...names]), new Set(this.#mcpServers), this.#allDevices);
	}

	/**
	 * This list as plain data, for another thread ({@link ToolAllowList.fromWire}).
	 * Names and selectors stay apart: a name added by {@link withNames} that looks
	 * like a selector (`mcp:x`) stays a name.
	 */
	toWire(): ToolAllowListWire {
		return { names: [...this.#names], mcpServers: [...this.#mcpServers], allDevices: this.#allDevices };
	}

	/** The list {@link toWire} described. */
	static fromWire(wire: ToolAllowListWire): ToolAllowList {
		return new ToolAllowList(new Set(wire.names), new Set(wire.mcpServers), wire.allDevices);
	}

	/** The entries that name one tool (selectors excluded). */
	get toolNames(): string[] {
		return [...this.#names];
	}

	/** Whether any entry can allow an MCP tool; without one no MCP server is started. */
	get allowsMCP(): boolean {
		return this.#allDevices || this.#mcpServers.size > 0 || [...this.#names].some(isMCPToolName);
	}

	/** Whether the model may be offered, or reach as a device, the tool registered as `name`. */
	allows(name: string, tool: ToolAllowListSubject | undefined): boolean {
		if (this.#names.has(name)) return true;
		if (!tool) return false;
		if (typeof tool.mcpServerName === "string" && this.#mcpServers.has(tool.mcpServerName)) return true;
		return this.#allDevices && isMountableUnderXdev(tool);
	}
}
