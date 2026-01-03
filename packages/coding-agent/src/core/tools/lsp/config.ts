import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { getConfigDirPaths } from "../../../config.js";
import type { ServerConfig } from "./types";

export interface LspConfig {
	servers: Record<string, ServerConfig>;
	/** Idle timeout in milliseconds. If set, LSP clients will be shutdown after this period of inactivity. Disabled by default. */
	idleTimeoutMs?: number;
}

// =============================================================================
// Predefined Server Configurations
// =============================================================================

/**
 * Comprehensive LSP server configurations.
 *
 * Each server can be customized via lsp.json config file with these options:
 * - command: Binary name or path
 * - args: Command line arguments
 * - fileTypes: File extensions this server handles
 * - rootMarkers: Files that indicate project root
 * - initOptions: LSP initialization options
 * - settings: LSP workspace settings
 * - disabled: Set to true to disable this server
 * - isLinter: If true, used only for diagnostics/actions (not type intelligence)
 */
export const SERVERS: Record<string, ServerConfig> = {
	// =========================================================================
	// Systems Languages
	// =========================================================================

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
		settings: {
			"rust-analyzer": {
				diagnostics: { enable: true },
				inlayHints: { enable: true },
			},
		},
		capabilities: {
			flycheck: true,
			ssr: true,
			expandMacro: true,
			runnables: true,
			relatedTests: true,
		},
	},

	clangd: {
		command: "clangd",
		args: ["--background-index", "--clang-tidy", "--header-insertion=iwyu"],
		fileTypes: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx", ".m", ".mm"],
		rootMarkers: ["compile_commands.json", "CMakeLists.txt", ".clangd", ".clang-format", "Makefile"],
	},

	zls: {
		command: "zls",
		args: [],
		fileTypes: [".zig"],
		rootMarkers: ["build.zig", "build.zig.zon", "zls.json"],
	},

	gopls: {
		command: "gopls",
		args: ["serve"],
		fileTypes: [".go", ".mod", ".sum"],
		rootMarkers: ["go.mod", "go.work", "go.sum"],
		settings: {
			gopls: {
				analyses: { unusedparams: true, shadow: true },
				staticcheck: true,
				gofumpt: true,
			},
		},
	},

	// =========================================================================
	// JavaScript/TypeScript Ecosystem
	// =========================================================================

	"typescript-language-server": {
		command: "typescript-language-server",
		args: ["--stdio"],
		fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
		initOptions: {
			hostInfo: "omp-coding-agent",
			preferences: {
				includeInlayParameterNameHints: "all",
				includeInlayVariableTypeHints: true,
				includeInlayFunctionParameterTypeHints: true,
			},
		},
	},

	biome: {
		command: "biome",
		args: ["lsp-proxy"],
		fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc"],
		rootMarkers: ["biome.json", "biome.jsonc"],
		isLinter: true,
	},

	eslint: {
		command: "vscode-eslint-language-server",
		args: ["--stdio"],
		fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"],
		rootMarkers: [
			".eslintrc",
			".eslintrc.js",
			".eslintrc.json",
			".eslintrc.yml",
			"eslint.config.js",
			"eslint.config.mjs",
		],
		isLinter: true,
		settings: {
			validate: "on",
			run: "onType",
		},
	},

	denols: {
		command: "deno",
		args: ["lsp"],
		fileTypes: [".ts", ".tsx", ".js", ".jsx"],
		rootMarkers: ["deno.json", "deno.jsonc", "deno.lock"],
		initOptions: {
			enable: true,
			lint: true,
			unstable: true,
		},
	},

	// =========================================================================
	// Web Technologies
	// =========================================================================

	"vscode-html-language-server": {
		command: "vscode-html-language-server",
		args: ["--stdio"],
		fileTypes: [".html", ".htm"],
		rootMarkers: ["package.json", ".git"],
		initOptions: {
			provideFormatter: true,
		},
	},

	"vscode-css-language-server": {
		command: "vscode-css-language-server",
		args: ["--stdio"],
		fileTypes: [".css", ".scss", ".sass", ".less"],
		rootMarkers: ["package.json", ".git"],
		initOptions: {
			provideFormatter: true,
		},
	},

	"vscode-json-language-server": {
		command: "vscode-json-language-server",
		args: ["--stdio"],
		fileTypes: [".json", ".jsonc"],
		rootMarkers: ["package.json", ".git"],
		initOptions: {
			provideFormatter: true,
		},
	},

	tailwindcss: {
		command: "tailwindcss-language-server",
		args: ["--stdio"],
		fileTypes: [".html", ".css", ".scss", ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte"],
		rootMarkers: ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.mjs", "tailwind.config.cjs"],
	},

	svelte: {
		command: "svelteserver",
		args: ["--stdio"],
		fileTypes: [".svelte"],
		rootMarkers: ["svelte.config.js", "svelte.config.mjs", "package.json"],
	},

	"vue-language-server": {
		command: "vue-language-server",
		args: ["--stdio"],
		fileTypes: [".vue"],
		rootMarkers: ["vue.config.js", "nuxt.config.js", "nuxt.config.ts", "package.json"],
	},

	astro: {
		command: "astro-ls",
		args: ["--stdio"],
		fileTypes: [".astro"],
		rootMarkers: ["astro.config.mjs", "astro.config.js", "astro.config.ts"],
	},

	// =========================================================================
	// Python
	// =========================================================================

	pyright: {
		command: "pyright-langserver",
		args: ["--stdio"],
		fileTypes: [".py", ".pyi"],
		rootMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
		settings: {
			python: {
				analysis: {
					autoSearchPaths: true,
					diagnosticMode: "openFilesOnly",
					useLibraryCodeForTypes: true,
				},
			},
		},
	},

	basedpyright: {
		command: "basedpyright-langserver",
		args: ["--stdio"],
		fileTypes: [".py", ".pyi"],
		rootMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py", "requirements.txt"],
		settings: {
			basedpyright: {
				analysis: {
					autoSearchPaths: true,
					diagnosticMode: "openFilesOnly",
					useLibraryCodeForTypes: true,
				},
			},
		},
	},

	pylsp: {
		command: "pylsp",
		args: [],
		fileTypes: [".py"],
		rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
	},

	ruff: {
		command: "ruff",
		args: ["server"],
		fileTypes: [".py", ".pyi"],
		rootMarkers: ["pyproject.toml", "ruff.toml", ".ruff.toml"],
		isLinter: true,
	},

	// =========================================================================
	// JVM Languages
	// =========================================================================

	jdtls: {
		command: "jdtls",
		args: [],
		fileTypes: [".java"],
		rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", ".project"],
	},

	"kotlin-language-server": {
		command: "kotlin-language-server",
		args: [],
		fileTypes: [".kt", ".kts"],
		rootMarkers: ["build.gradle", "build.gradle.kts", "pom.xml", "settings.gradle", "settings.gradle.kts"],
	},

	metals: {
		command: "metals",
		args: [],
		fileTypes: [".scala", ".sbt", ".sc"],
		rootMarkers: ["build.sbt", "build.sc", "build.gradle", "pom.xml"],
		initOptions: {
			statusBarProvider: "show-message",
			isHttpEnabled: true,
		},
	},

	// =========================================================================
	// Functional Languages
	// =========================================================================

	hls: {
		command: "haskell-language-server-wrapper",
		args: ["--lsp"],
		fileTypes: [".hs", ".lhs"],
		rootMarkers: ["stack.yaml", "cabal.project", "hie.yaml", "package.yaml", "*.cabal"],
		settings: {
			haskell: {
				formattingProvider: "ormolu",
				checkProject: true,
			},
		},
	},

	ocamllsp: {
		command: "ocamllsp",
		args: [],
		fileTypes: [".ml", ".mli", ".mll", ".mly"],
		rootMarkers: ["dune-project", "dune-workspace", "*.opam", ".ocamlformat"],
	},

	elixirls: {
		command: "elixir-ls",
		args: [],
		fileTypes: [".ex", ".exs", ".heex", ".eex"],
		rootMarkers: ["mix.exs", "mix.lock"],
		settings: {
			elixirLS: {
				dialyzerEnabled: true,
				fetchDeps: false,
			},
		},
	},

	erlangls: {
		command: "erlang_ls",
		args: [],
		fileTypes: [".erl", ".hrl"],
		rootMarkers: ["rebar.config", "erlang.mk", "rebar.lock"],
	},

	gleam: {
		command: "gleam",
		args: ["lsp"],
		fileTypes: [".gleam"],
		rootMarkers: ["gleam.toml"],
	},

	// =========================================================================
	// Ruby
	// =========================================================================

	solargraph: {
		command: "solargraph",
		args: ["stdio"],
		fileTypes: [".rb", ".rake", ".gemspec"],
		rootMarkers: ["Gemfile", ".solargraph.yml", "Rakefile"],
		initOptions: {
			formatting: true,
		},
		settings: {
			solargraph: {
				diagnostics: true,
				completion: true,
				hover: true,
				formatting: true,
				references: true,
				rename: true,
				symbols: true,
			},
		},
	},

	"ruby-lsp": {
		command: "ruby-lsp",
		args: [],
		fileTypes: [".rb", ".rake", ".gemspec", ".erb"],
		rootMarkers: ["Gemfile", ".ruby-version", ".ruby-gemset"],
		initOptions: {
			formatter: "auto",
		},
	},

	rubocop: {
		command: "rubocop",
		args: ["--lsp"],
		fileTypes: [".rb", ".rake"],
		rootMarkers: [".rubocop.yml", "Gemfile"],
		isLinter: true,
	},

	// =========================================================================
	// Shell / Scripting
	// =========================================================================

	bashls: {
		command: "bash-language-server",
		args: ["start"],
		fileTypes: [".sh", ".bash", ".zsh"],
		rootMarkers: [".git"],
		settings: {
			bashIde: {
				globPattern: "*@(.sh|.inc|.bash|.command)",
			},
		},
	},

	nushell: {
		command: "nu",
		args: ["--lsp"],
		fileTypes: [".nu"],
		rootMarkers: [".git"],
	},

	// =========================================================================
	// Lua
	// =========================================================================

	"lua-language-server": {
		command: "lua-language-server",
		args: [],
		fileTypes: [".lua"],
		rootMarkers: [".luarc.json", ".luarc.jsonc", ".luacheckrc", ".stylua.toml", "stylua.toml"],
		settings: {
			Lua: {
				runtime: { version: "LuaJIT" },
				diagnostics: { globals: ["vim"] },
				workspace: { checkThirdParty: false },
				telemetry: { enable: false },
			},
		},
	},

	// =========================================================================
	// PHP
	// =========================================================================

	intelephense: {
		command: "intelephense",
		args: ["--stdio"],
		fileTypes: [".php", ".phtml"],
		rootMarkers: ["composer.json", "composer.lock", ".git"],
	},

	phpactor: {
		command: "phpactor",
		args: ["language-server"],
		fileTypes: [".php"],
		rootMarkers: ["composer.json", ".phpactor.json", ".phpactor.yml"],
	},

	// =========================================================================
	// .NET
	// =========================================================================

	omnisharp: {
		command: "omnisharp",
		args: ["-z", "--hostPID", String(process.pid), "--encoding", "utf-8", "--languageserver"],
		fileTypes: [".cs", ".csx"],
		rootMarkers: ["*.sln", "*.csproj", "omnisharp.json", ".git"],
		settings: {
			FormattingOptions: { EnableEditorConfigSupport: true },
			RoslynExtensionsOptions: { EnableAnalyzersSupport: true },
		},
	},

	// =========================================================================
	// Configuration Languages
	// =========================================================================

	yamlls: {
		command: "yaml-language-server",
		args: ["--stdio"],
		fileTypes: [".yaml", ".yml"],
		rootMarkers: [".git"],
		settings: {
			yaml: {
				validate: true,
				format: { enable: true },
				hover: true,
				completion: true,
			},
			redhat: { telemetry: { enabled: false } },
		},
	},

	taplo: {
		command: "taplo",
		args: ["lsp", "stdio"],
		fileTypes: [".toml"],
		rootMarkers: [".taplo.toml", "taplo.toml", ".git"],
	},

	terraformls: {
		command: "terraform-ls",
		args: ["serve"],
		fileTypes: [".tf", ".tfvars"],
		rootMarkers: [".terraform", "terraform.tfstate", "*.tf"],
	},

	dockerls: {
		command: "docker-langserver",
		args: ["--stdio"],
		fileTypes: [".dockerfile"],
		rootMarkers: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", ".dockerignore"],
	},

	"helm-ls": {
		command: "helm_ls",
		args: ["serve"],
		fileTypes: [".yaml", ".yml", ".tpl"],
		rootMarkers: ["Chart.yaml", "Chart.yml"],
	},

	// =========================================================================
	// Nix
	// =========================================================================

	nixd: {
		command: "nixd",
		args: [],
		fileTypes: [".nix"],
		rootMarkers: ["flake.nix", "default.nix", "shell.nix"],
	},

	nil: {
		command: "nil",
		args: [],
		fileTypes: [".nix"],
		rootMarkers: ["flake.nix", "default.nix", "shell.nix"],
	},

	// =========================================================================
	// Other Languages
	// =========================================================================

	ols: {
		command: "ols",
		args: [],
		fileTypes: [".odin"],
		rootMarkers: ["ols.json", ".git"],
	},

	dartls: {
		command: "dart",
		args: ["language-server", "--protocol=lsp"],
		fileTypes: [".dart"],
		rootMarkers: ["pubspec.yaml", "pubspec.lock"],
		initOptions: {
			closingLabels: true,
			flutterOutline: true,
			outline: true,
		},
	},

	marksman: {
		command: "marksman",
		args: ["server"],
		fileTypes: [".md", ".markdown"],
		rootMarkers: [".marksman.toml", ".git"],
	},

	texlab: {
		command: "texlab",
		args: [],
		fileTypes: [".tex", ".bib", ".sty", ".cls"],
		rootMarkers: [".latexmkrc", "latexmkrc", ".texlabroot", "texlabroot", "Tectonic.toml"],
		settings: {
			texlab: {
				build: {
					executable: "latexmk",
					args: ["-pdf", "-interaction=nonstopmode", "-synctex=1", "%f"],
				},
				chktex: { onOpenAndSave: true },
			},
		},
	},

	graphql: {
		command: "graphql-lsp",
		args: ["server", "-m", "stream"],
		fileTypes: [".graphql", ".gql"],
		rootMarkers: [".graphqlrc", ".graphqlrc.json", ".graphqlrc.yml", ".graphqlrc.yaml", "graphql.config.js"],
	},

	prismals: {
		command: "prisma-language-server",
		args: ["--stdio"],
		fileTypes: [".prisma"],
		rootMarkers: ["schema.prisma", "prisma/schema.prisma"],
	},

	vimls: {
		command: "vim-language-server",
		args: ["--stdio"],
		fileTypes: [".vim", ".vimrc"],
		rootMarkers: [".git"],
		initOptions: {
			isNeovim: true,
			diagnostic: { enable: true },
		},
	},

	// =========================================================================
	// Emmet (HTML/CSS expansion)
	// =========================================================================

	"emmet-language-server": {
		command: "emmet-language-server",
		args: ["--stdio"],
		fileTypes: [".html", ".css", ".scss", ".less", ".jsx", ".tsx", ".vue", ".svelte"],
		rootMarkers: [".git"],
	},
};

// =============================================================================
// Configuration Loading
// =============================================================================

/**
 * Check if any root marker file exists in the directory
 */
export function hasRootMarkers(cwd: string, markers: string[]): boolean {
	return markers.some((marker) => {
		// Handle glob-like patterns (e.g., "*.cabal")
		if (marker.includes("*")) {
			try {
				const { globSync } = require("node:fs");
				const matches = globSync(join(cwd, marker));
				return matches.length > 0;
			} catch {
				// globSync not available, skip glob patterns
				return false;
			}
		}
		return existsSync(join(cwd, marker));
	});
}

// =============================================================================
// Local Binary Resolution
// =============================================================================

/**
 * Local bin directories to check before $PATH, ordered by priority.
 * Each entry maps a root marker to the bin directory to check.
 */
const LOCAL_BIN_PATHS: Array<{ markers: string[]; binDir: string }> = [
	// Node.js - check node_modules/.bin/
	{ markers: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"], binDir: "node_modules/.bin" },
	// Python - check virtual environment bin directories
	{ markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], binDir: ".venv/bin" },
	{ markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], binDir: "venv/bin" },
	{ markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], binDir: ".env/bin" },
	// Ruby - check vendor bundle and binstubs
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "vendor/bundle/bin" },
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "bin" },
	// Go - check project-local bin
	{ markers: ["go.mod", "go.sum"], binDir: "bin" },
];

/**
 * Resolve a command to an executable path.
 * Checks project-local bin directories first, then falls back to $PATH.
 *
 * @param command - The command name (e.g., "typescript-language-server")
 * @param cwd - Working directory to search from
 * @returns Absolute path to the executable, or null if not found
 */
export function resolveCommand(command: string, cwd: string): string | null {
	// Check local bin directories based on project markers
	for (const { markers, binDir } of LOCAL_BIN_PATHS) {
		if (hasRootMarkers(cwd, markers)) {
			const localPath = join(cwd, binDir, command);
			if (existsSync(localPath)) {
				return localPath;
			}
		}
	}

	// Fall back to $PATH
	return Bun.which(command);
}

/**
 * Configuration file search paths (in priority order).
 * Supports both visible and hidden variants at each config location.
 */
function getConfigPaths(cwd: string): string[] {
	const filenames = ["lsp.json", ".lsp.json"];
	const paths: string[] = [];

	// Project root files (highest priority)
	for (const filename of filenames) {
		paths.push(join(cwd, filename));
	}

	// Project config directories (.omp/, .pi/, .claude/)
	const projectDirs = getConfigDirPaths("", { user: false, project: true, cwd });
	for (const dir of projectDirs) {
		for (const filename of filenames) {
			paths.push(join(dir, filename));
		}
	}

	// User config directories (~/.omp/agent/, ~/.pi/agent/, ~/.claude/)
	const userDirs = getConfigDirPaths("", { user: true, project: false });
	for (const dir of userDirs) {
		for (const filename of filenames) {
			paths.push(join(dir, filename));
		}
	}

	// User home root files (lowest priority fallback)
	for (const filename of filenames) {
		paths.push(join(homedir(), filename));
	}

	return paths;
}

/**
 * Load LSP configuration.
 *
 * Priority:
 * 1. Project root: lsp.json, .lsp.json
 * 2. Project config dirs: .omp/lsp.json, .pi/lsp.json, .claude/lsp.json (+ hidden variants)
 * 3. User config dirs: ~/.omp/agent/lsp.json, ~/.pi/agent/lsp.json, ~/.claude/lsp.json (+ hidden variants)
 * 4. User home root: ~/lsp.json, ~/.lsp.json
 * 5. Auto-detect from project markers + available binaries
 *
 * Config file format:
 * ```json
 * {
 *   "servers": {
 *     "typescript-language-server": {
 *       "command": "typescript-language-server",
 *       "args": ["--stdio", "--log-level", "4"],
 *       "disabled": false
 *     },
 *     "my-custom-server": {
 *       "command": "/path/to/server",
 *       "args": ["--stdio"],
 *       "fileTypes": [".xyz"],
 *       "rootMarkers": [".xyz-project"]
 *     }
 *   }
 * }
 * ```
 */
export function loadConfig(cwd: string): LspConfig {
	const configPaths = getConfigPaths(cwd);

	for (const configPath of configPaths) {
		if (existsSync(configPath)) {
			try {
				const content = readFileSync(configPath, "utf-8");
				const parsed = JSON.parse(content);

				// Support both { servers: {...} } and direct server map
				const servers = parsed.servers || parsed;

				// Merge with defaults and filter to available
				const merged: Record<string, ServerConfig> = { ...SERVERS };

				for (const [name, config] of Object.entries(servers) as [string, Partial<ServerConfig>][]) {
					if (merged[name]) {
						// Merge with existing config
						merged[name] = { ...merged[name], ...config };
					} else {
						// Add new server config
						merged[name] = config as ServerConfig;
					}
				}

				// Filter to only enabled servers with available commands
				const available: Record<string, ServerConfig> = {};
				for (const [name, config] of Object.entries(merged)) {
					if (config.disabled) continue;
					const resolved = resolveCommand(config.command, cwd);
					if (!resolved) continue;
					available[name] = { ...config, resolvedCommand: resolved };
				}

				return { servers: available };
			} catch {
				// Ignore parse errors, continue to next config or auto-detect
			}
		}
	}

	// Auto-detect: find servers based on project markers AND available binaries
	const detected: Record<string, ServerConfig> = {};

	for (const [name, config] of Object.entries(SERVERS)) {
		// Check if project has root markers for this language
		if (!hasRootMarkers(cwd, config.rootMarkers)) continue;

		// Check if the language server binary is available (local or $PATH)
		const resolved = resolveCommand(config.command, cwd);
		if (!resolved) continue;

		detected[name] = { ...config, resolvedCommand: resolved };
	}

	return { servers: detected };
}

// =============================================================================
// Server Selection
// =============================================================================

/**
 * Find all servers that can handle a file based on extension.
 * Returns servers sorted with primary (non-linter) servers first.
 */
export function getServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	const ext = extname(filePath).toLowerCase();
	const matches: Array<[string, ServerConfig]> = [];

	for (const [name, serverConfig] of Object.entries(config.servers)) {
		if (serverConfig.fileTypes.includes(ext)) {
			matches.push([name, serverConfig]);
		}
	}

	// Sort: primary servers (non-linters) first, then linters
	return matches.sort((a, b) => {
		const aIsLinter = a[1].isLinter ? 1 : 0;
		const bIsLinter = b[1].isLinter ? 1 : 0;
		return aIsLinter - bIsLinter;
	});
}

/**
 * Find the primary server for a file (prefers type-checkers over linters).
 * Used for operations like definition, hover, references that need type intelligence.
 */
export function getServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const servers = getServersForFile(config, filePath);
	return servers.length > 0 ? servers[0] : null;
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
