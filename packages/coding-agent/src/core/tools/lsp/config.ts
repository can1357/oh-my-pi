import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import type { ServerConfig } from "./types.js";

export interface LspConfig {
	servers: Record<string, ServerConfig>;
}

// Predefined server configurations with capabilities
export const SERVERS: Record<string, ServerConfig> = {
	"rust-analyzer": {
		command: "rust-analyzer",
		args: [],
		fileTypes: [".rs"],
		rootMarkers: ["Cargo.toml", "rust-analyzer.toml"],
		initOptions: {
			checkOnSave: { command: "clippy" },
			cargo: { allFeatures: true },
			procMacro: { enable: true },
		},
		capabilities: {
			flycheck: true,
			ssr: true,
			expandMacro: true,
			runnables: true,
			relatedTests: true,
		},
	},
	"typescript-language-server": {
		command: "typescript-language-server",
		args: ["--stdio"],
		fileTypes: [".ts", ".tsx", ".js", ".jsx"],
		rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
	},
	gopls: {
		command: "gopls",
		args: ["serve"],
		fileTypes: [".go"],
		rootMarkers: ["go.mod", "go.work"],
	},
	pyright: {
		command: "pyright-langserver",
		args: ["--stdio"],
		fileTypes: [".py"],
		rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"],
	},
	zls: {
		command: "zls",
		args: [],
		fileTypes: [".zig"],
		rootMarkers: ["build.zig", "build.zig.zon", "zls.json"],
	},
	clangd: {
		command: "clangd",
		args: ["--background-index"],
		fileTypes: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"],
		rootMarkers: ["compile_commands.json", "CMakeLists.txt", ".clangd"],
	},
	"lua-language-server": {
		command: "lua-language-server",
		args: [],
		fileTypes: [".lua"],
		rootMarkers: [".luarc.json", ".luarc.jsonc", ".luacheckrc"],
	},
};

/**
 * Check if any root marker file exists in the directory
 */
export function hasRootMarkers(cwd: string, markers: string[]): boolean {
	return markers.some((marker) => existsSync(join(cwd, marker)));
}

/**
 * Load LSP configuration.
 *
 * Priority:
 * 1. Project-level config from .pi/lsp.json in cwd
 * 2. User-level config from ~/.pi/lsp.json
 * 3. Auto-detect from project markers + available binaries
 */
export function loadConfig(cwd: string): LspConfig {
	// Try to load user config
	const configPaths = [join(cwd, ".pi", "lsp.json"), join(homedir(), ".pi", "lsp.json")];

	for (const configPath of configPaths) {
		if (existsSync(configPath)) {
			try {
				const content = readFileSync(configPath, "utf-8");
				const parsed = JSON.parse(content);
				const servers = parsed.servers || parsed;

				// Filter to only enabled servers with available commands
				const available: Record<string, ServerConfig> = {};
				for (const [name, config] of Object.entries(servers) as [string, ServerConfig][]) {
					if (config.disabled) continue;
					if (!Bun.which(config.command)) continue;
					available[name] = config;
				}

				return { servers: available };
			} catch {
				// Ignore parse errors, fall through to auto-detect
			}
		}
	}

	// Auto-detect: find servers based on project markers AND available binaries
	const detected: Record<string, ServerConfig> = {};

	for (const [name, config] of Object.entries(SERVERS)) {
		// Check if project has root markers for this language
		if (!hasRootMarkers(cwd, config.rootMarkers)) continue;

		// Check if the language server binary is available
		if (!Bun.which(config.command)) continue;

		detected[name] = config;
	}

	return { servers: detected };
}

/**
 * Find the appropriate server for a file based on extension
 */
export function getServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const ext = extname(filePath).toLowerCase();

	for (const [name, serverConfig] of Object.entries(config.servers)) {
		if (serverConfig.fileTypes.includes(ext)) {
			return [name, serverConfig];
		}
	}
	return null;
}

/**
 * Check if a server has a specific capability
 */
export function hasCapability(
	config: ServerConfig,
	capability: keyof NonNullable<ServerConfig["capabilities"]>,
): boolean {
	return config.capabilities?.[capability] === true;
}
