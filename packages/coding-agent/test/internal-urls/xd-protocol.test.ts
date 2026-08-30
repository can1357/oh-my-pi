import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { XdProtocolHandler, xdevToolUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/xd-protocol";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import {
	resolveMountedXdevTool,
	XDEV_DISCOVERY_LIMIT,
	type XdevState,
	xdevListing,
} from "@oh-my-pi/pi-coding-agent/tools/xdev";

function device(name: string, summary: string, description = summary): Tool {
	return {
		name,
		label: name,
		description,
		summary,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

function stateFor(tools: readonly Tool[]): XdevState {
	return {
		tools: new Map(tools.map(tool => [tool.name, tool])),
		mountedNames: new Set(tools.map(tool => tool.name)),
		builtInNames: new Set(),
		isActive: () => false,
	};
}

function readContext(state: XdevState): { xd: { read(name: string | null, query?: string): Promise<string> } } {
	return {
		xd: {
			read: async (name, query) => (name === null ? xdevListing(state, query) : `docs:${name}`),
		},
	};
}

describe("xd:// discovery protocol", () => {
	it("returns a deterministic bounded root catalog with an omitted count and search hint", async () => {
		const tools = Array.from({ length: XDEV_DISCOVERY_LIMIT + 5 }, (_, index) => {
			const suffix = String(XDEV_DISCOVERY_LIMIT + 4 - index).padStart(3, "0");
			const summary = suffix === "000" ? `first\n\tline \u001b[31m${"x".repeat(220)}` : `summary ${suffix}`;
			return device(`tool_${suffix}`, summary);
		});
		const state = stateFor(tools);
		const reorderedContent = xdevListing(stateFor([...tools].reverse()));
		const resource = await new XdProtocolHandler().resolve(parseInternalUrl("xd://"), readContext(state));
		const routes = resource.content.split("\n").filter(line => line.startsWith("xd://tool_"));

		expect(routes).toHaveLength(XDEV_DISCOVERY_LIMIT);
		expect(routes[0]).toStartWith("xd://tool_000");
		expect(routes.at(-1)).toStartWith("xd://tool_049");
		expect(resource.content).not.toContain("xd://tool_050");
		expect(routes[0]).not.toContain("\u001b");
		expect(routes[0]?.length).toBeLessThanOrEqual("xd://tool_000 — ".length + 200);
		expect(resource.content).toContain("Mounted tool devices (50 of 55)");
		expect(resource.content).toContain("Results truncated at 50; 5 omitted.");
		expect(resource.content).toContain("narrower xd://?q=<term> search");
		expect(resource.content).toBe(reorderedContent);
	});

	it("searches names, summaries, and full descriptions case-insensitively", async () => {
		const state = stateFor([
			device("GitHub_name", "Ordinary helper"),
			device("summary_match", "GITHUB repository helper"),
			device("description_match", "Ordinary helper", "Manages GitHub issues"),
			device("unrelated", "Calendar helper"),
		]);
		const resource = await new XdProtocolHandler().resolve(parseInternalUrl("xd://?q=gItHuB"), readContext(state));

		expect(resource.content).toContain('Mounted tool devices matching "gItHuB" (3 of 3)');
		expect(resource.content).toContain("xd://GitHub_name");
		expect(resource.content).toContain("xd://summary_match");
		expect(resource.content).toContain("xd://description_match");
		expect(resource.content).not.toContain("xd://unrelated");
	});

	it("bounds search results and reports how to refine them", async () => {
		const matches = Array.from({ length: XDEV_DISCOVERY_LIMIT + 2 }, (_, index) =>
			device(`connector_${String(index).padStart(2, "0")}`, "Repository helper", "Manages GitHub issues"),
		);
		const state = stateFor(matches);
		const resource = await new XdProtocolHandler().resolve(parseInternalUrl("xd://?q=github"), readContext(state));
		const routes = resource.content.split("\n").filter(line => line.startsWith("xd://connector_"));

		expect(routes).toHaveLength(XDEV_DISCOVERY_LIMIT);
		expect(resource.content).toContain("Results truncated at 50; 2 omitted.");
		expect(resource.content).toContain("narrower xd://?q=<term> search");
	});

	it("threads root search through the public read tool", async () => {
		const state = stateFor([
			device("issue_lookup", "Repository helper", "Manages GitHub issues"),
			device("calendar", "Calendar helper"),
		]);
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({}),
			xdev: state,
		};
		const result = await new ReadTool(session).execute("read-xd-search", { path: "xd://?q=GITHUB" });
		const text = result.content.find(entry => entry.type === "text")?.text ?? "";

		expect(text).toContain("xd://issue_lookup — Repository helper");
		expect(text).not.toContain("xd://calendar");
	});

	it("keeps prefixed, underscored, and URL-special device names exact and reversible", async () => {
		const name = "mcp__server_prefix_tool/lookup?mode#draft%";
		const tool = device(name, "Looks up a server resource");
		const state = stateFor([tool]);
		const route = xdevToolUrl(name);
		let resolvedName: string | null | undefined;
		const resource = await new XdProtocolHandler().resolve(parseInternalUrl(route), {
			xd: {
				read: async exactName => {
					resolvedName = exactName;
					return `docs:${exactName}`;
				},
			},
		});

		expect(route).toBe("xd://mcp__server_prefix_tool%2Flookup%3Fmode%23draft%25");
		expect(xdevListing(state)).toContain(route);
		expect(resolvedName).toBe(name);
		expect(resource.content).toBe(`docs:${name}`);
		expect(resolveMountedXdevTool(state, route)).toBe(tool);
	});

	it("rejects write queries without dispatching and preserves exact write dispatch", async () => {
		const handler = new XdProtocolHandler();
		const calls: Array<{ name: string | null; content: string }> = [];
		const context = {
			xd: {
				write: async (name: string | null, content: string) => {
					calls.push({ name, content });
				},
			},
		};

		await expect(handler.write(parseInternalUrl("xd://device?q=unsafe"), "{}", context)).rejects.toThrow(
			"Queries are not allowed on xd:// writes",
		);
		expect(calls).toEqual([]);
		await expect(handler.write(parseInternalUrl("xd://"), "{}", context)).rejects.toThrow(
			"writes require an exact device URL",
		);
		expect(calls).toEqual([]);

		const exactName = "mcp__server_tool/special?value";
		await handler.write(parseInternalUrl(xdevToolUrl(exactName)), '{"value":1}', context);
		expect(calls).toEqual([{ name: exactName, content: '{"value":1}' }]);
	});
});
