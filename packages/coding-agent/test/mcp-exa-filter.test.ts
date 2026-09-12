/**
 * Regression: Exa MCP servers are filtered out by default because the native
 * Exa integration covers `web_search_exa`. But a config that explicitly
 * requests Exa tools the native integration does NOT provide (e.g.
 * `web_fetch_exa`, `web_search_advanced_exa`) must stay mounted as an MCP
 * server instead of being dropped.
 */
import { describe, expect, test } from "bun:test";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { filterExaMCPServers, shouldFilterBrowserMCPForPrelude } from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

const SOURCE: SourceMeta = {
	provider: "test",
	providerName: "Test",
	path: "/tmp/mcp.json",
	level: "user",
};

describe("browser prelude MCP filtering", () => {
	test("filters only when unrestricted browser and Eval are all active", () => {
		expect(
			shouldFilterBrowserMCPForPrelude({
				restrictToolNames: false,
				browserEnabled: true,
				evalRegistered: true,
				evalActive: true,
			}),
		).toBe(true);
		for (const options of [
			{ restrictToolNames: false, browserEnabled: false, evalRegistered: true, evalActive: true },
			{ restrictToolNames: true, browserEnabled: true, evalRegistered: true, evalActive: true },
			{ restrictToolNames: false, browserEnabled: true, evalRegistered: false, evalActive: false },
			{ restrictToolNames: false, browserEnabled: true, evalRegistered: true, evalActive: false },
		]) {
			expect(shouldFilterBrowserMCPForPrelude(options)).toBe(false);
		}
	});
});

describe("Exa MCP filtering", () => {
	test("filters an exa server restricted to the native web_search_exa tool", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: { type: "http", url: "https://mcp.exa.ai/mcp?tools=web_search_exa&exaApiKey=sk-1" },
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(result.configs).toEqual({});
		expect(result.exaApiKeys).toEqual(["sk-1"]);
	});

	test("keeps an exa server that requests tools beyond the native integration", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: {
				type: "http",
				url: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa&exaApiKey=sk-1",
			},
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(Object.keys(result.configs)).toEqual(["exa"]);
		expect(result.sources.exa).toEqual(SOURCE);
		expect(result.exaApiKeys).toEqual(["sk-1"]);
	});

	test("filters an exa server with no tools restriction", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: { type: "http", url: "https://mcp.exa.ai/mcp" },
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(result.configs).toEqual({});
	});

	test("keeps a stdio exa server that requests extra tools", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: {
				type: "stdio",
				command: "npx",
				args: ["-y", "exa-mcp-server", "--tools=web_search_exa,web_fetch_exa"],
			},
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(Object.keys(result.configs)).toEqual(["exa"]);
	});

	test("keeps a stdio exa server with a separate tools argument", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: {
				type: "stdio",
				command: "npx",
				args: ["-y", "exa-mcp-server", "--tools", "web_search_exa,web_fetch_exa"],
			},
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(Object.keys(result.configs)).toEqual(["exa"]);
	});

	test("keeps an unrestricted exa server whose allowlist selects a non-native tool", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: { type: "http", url: "https://mcp.exa.ai/mcp", enabledTools: ["web_fetch_exa"] },
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(Object.keys(result.configs)).toEqual(["exa"]);
	});

	test("filters an unrestricted exa server whose allowlist selects only native tools", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: { type: "http", url: "https://mcp.exa.ai/mcp", enabledTools: ["web_search_exa"] },
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(result.configs).toEqual({});
	});

	test("classifies an allowlist by the names it denotes, not its own spelling", () => {
		// An allowlist entry is a pattern, so a glob that can match only the
		// native tool selects nothing the native integration lacks and the server
		// must be dropped — otherwise the startup work this filter exists to
		// avoid still happens. A glob that can reach a non-native name keeps it.
		const configs: Record<string, MCPServerConfig> = {
			nativeOnlyClass: {
				type: "http",
				url: "https://mcp.exa.ai/mcp",
				enabledTools: ["web_search_ex[a]"],
			},
			nonNativeClass: {
				type: "http",
				url: "https://mcp.exa.ai/mcp",
				enabledTools: ["web_fetch_ex[a]"],
			},
			// A class admitting either spelling may select the non-native tool.
			ambiguousClass: {
				type: "http",
				url: "https://mcp.exa.ai/mcp",
				enabledTools: ["web_search_ex[ab]"],
			},
			// An entry whose names cannot be enumerated may select anything, so it
			// keeps the server rather than guessing.
			unbounded: {
				type: "http",
				url: "https://mcp.exa.ai/mcp",
				enabledTools: ["web_*"],
			},
		};
		const result = filterExaMCPServers(configs, {
			nativeOnlyClass: SOURCE,
			nonNativeClass: SOURCE,
			ambiguousClass: SOURCE,
			unbounded: SOURCE,
		});

		expect(Object.keys(result.configs).sort()).toEqual(["ambiguousClass", "nonNativeClass", "unbounded"]);
	});

	test("does not read an inherited object member as native", () => {
		// The native set is looked up by name, and a tool the server really
		// advertises may be called `constructor` or `__proto__`. An ordinary
		// object answers those from `Object.prototype`, which would classify a
		// selected non-native tool as covered and silently unmount the server.
		for (const name of ["constructor", "__proto__", "toString", "web_fetch_exa"]) {
			const configs: Record<string, MCPServerConfig> = {
				exa: { type: "http", url: "https://mcp.exa.ai/mcp", enabledTools: [name] },
			};
			const result = filterExaMCPServers(configs, { exa: SOURCE });

			expect(Object.keys(result.configs)).toEqual(["exa"]);
		}
		// The one name that IS native still drops the server.
		const native: Record<string, MCPServerConfig> = {
			exa: { type: "http", url: "https://mcp.exa.ai/mcp", enabledTools: ["web_search_exa"] },
		};
		expect(filterExaMCPServers(native, { exa: SOURCE }).configs).toEqual({});
	});

	test("drops an exa server whose restriction and filters leave no non-native tool", () => {
		// `tools=` enumerates what the server advertises, so an allowlist selects
		// FROM that set rather than adding to it: a native-only enumeration with
		// an allowlist naming a tool the server does not serve contributes
		// nothing beyond the native integration.
		const cases: Record<string, MCPServerConfig> = {
			nativeEnumAllowNonNative: {
				type: "http",
				url: "https://mcp.exa.ai/mcp?tools=web_search_exa",
				enabledTools: ["web_fetch_exa"],
			},
			extraEnumAllowNative: {
				type: "http",
				url: "https://mcp.exa.ai/mcp?tools=web_fetch_exa",
				enabledTools: ["web_search_exa"],
			},
			denyAll: { type: "http", url: "https://mcp.exa.ai/mcp", disabledTools: ["*"] },
			denyTheExtraTool: {
				type: "http",
				url: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa",
				disabledTools: ["web_fetch_exa"],
			},
		};
		const result = filterExaMCPServers(cases, {
			nativeEnumAllowNonNative: SOURCE,
			extraEnumAllowNative: SOURCE,
			denyAll: SOURCE,
			denyTheExtraTool: SOURCE,
		});

		expect(result.configs).toEqual({});
	});

	test("keeps an exa server whose denylist leaves its non-native tool reachable", () => {
		// The denylist subtracts from what the server advertises; denying only the
		// native tool leaves the extra one, which is why the server stays mounted.
		const configs: Record<string, MCPServerConfig> = {
			exa: {
				type: "http",
				url: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa",
				disabledTools: ["web_search_exa"],
			},
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(Object.keys(result.configs)).toEqual(["exa"]);
	});

	test("keeps a deny-only exa server unless the denylist denies every name", () => {
		// The server is mounted for tools the native integration lacks, so a
		// denylist that leaves any name reachable keeps it — including a broad
		// pattern like `*probe`, which matches some names but not `web_fetch_exa`.
		// Only an entry that is built of `*`/`?` and carries a `*` denies them all.
		for (const disabledTools of [["web_search_exa"], ["*probe"], ["web_*"], ["?*_exa"]]) {
			const keep = filterExaMCPServers(
				{ exa: { type: "http", url: "https://mcp.exa.ai/mcp", disabledTools } },
				{ exa: SOURCE },
			);
			expect(Object.keys(keep.configs)).toEqual(["exa"]);
		}
		// `?` demands a character, so an entry with two of them denies only names
		// of two or more — a one-character tool survives and the server must stay.
		for (const disabledTools of [["*"], ["**"], ["?*"], ["*?"]]) {
			const drop = filterExaMCPServers(
				{ exa: { type: "http", url: "https://mcp.exa.ai/mcp", disabledTools } },
				{ exa: SOURCE },
			);
			expect(drop.configs).toEqual({});
		}
		for (const disabledTools of [["??*"], ["*??"], ["?*?"]]) {
			const keep = filterExaMCPServers(
				{ exa: { type: "http", url: "https://mcp.exa.ai/mcp", disabledTools } },
				{ exa: SOURCE },
			);
			expect(Object.keys(keep.configs)).toEqual(["exa"]);
		}
	});

	test("keeps an exa server restricted only by a denylist", () => {
		// A denylist selects the complement of what it names, so it always leaves
		// the server's non-native tools reachable; dropping the server would take
		// `web_fetch_exa` with it.
		const configs: Record<string, MCPServerConfig> = {
			exa: { type: "http", url: "https://mcp.exa.ai/mcp", disabledTools: ["web_search_exa"] },
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(Object.keys(result.configs)).toEqual(["exa"]);
	});
});
