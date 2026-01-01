import * as cp from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface LSPServerConfig {
   command: string
   args?: string[]
   fileTypes: string[]
   rootMarkers: string[]
   initOptions?: Record<string, unknown>
   settings?: Record<string, unknown>
   disabled?: boolean
   // Extra capabilities this server supports
   capabilities?: {
      flycheck?: boolean // rust-analyzer: clippy/check
      ssr?: boolean // rust-analyzer: structural search-replace
      expandMacro?: boolean // rust-analyzer: macro expansion
      runnables?: boolean // rust-analyzer: test/binary discovery
   }
}

export interface LSPConfig {
   servers: Record<string, LSPServerConfig>
}

// Known server configurations with their capabilities
const KNOWN_SERVERS: Record<string, LSPServerConfig> = {
   rust: {
      command: 'rust-analyzer',
      args: [],
      fileTypes: ['.rs'],
      rootMarkers: ['Cargo.toml', 'rust-analyzer.toml'],
      initOptions: {
         checkOnSave: { command: 'clippy' },
         cargo: { allFeatures: true },
         procMacro: { enable: true },
      },
      capabilities: {
         flycheck: true,
         ssr: true,
         expandMacro: true,
         runnables: true,
      },
   },
   typescript: {
      command: 'typescript-language-server',
      args: ['--stdio'],
      fileTypes: ['.ts', '.tsx', '.js', '.jsx'],
      rootMarkers: ['package.json', 'tsconfig.json', 'jsconfig.json'],
   },
   go: {
      command: 'gopls',
      args: ['serve'],
      fileTypes: ['.go'],
      rootMarkers: ['go.mod', 'go.work'],
   },
   python: {
      command: 'pylsp',
      args: [],
      fileTypes: ['.py'],
      rootMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile'],
   },
   zig: {
      command: 'zls',
      args: [],
      fileTypes: ['.zig'],
      rootMarkers: ['build.zig', 'build.zig.zon'],
   },
   clangd: {
      command: 'clangd',
      args: ['--background-index'],
      fileTypes: ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp'],
      rootMarkers: ['compile_commands.json', 'CMakeLists.txt', '.clangd'],
   },
   lua: {
      command: 'lua-language-server',
      args: [],
      fileTypes: ['.lua'],
      rootMarkers: ['.luarc.json', '.luarc.jsonc', '.luacheckrc'],
   },
}

function commandExists(cmd: string): boolean {
   try {
      cp.execSync(`which ${cmd}`, { stdio: 'ignore' })
      return true
   } catch {
      return false
   }
}

function hasRootMarkers(dir: string, markers: string[]): boolean {
   return markers.some(m => fs.existsSync(path.join(dir, m)))
}

/**
 * Load LSP configuration.
 *
 * Priority:
 * 1. User config from .pi/lsp.json or ~/.pi/lsp.json
 * 2. Auto-detect from project markers + available binaries
 * 3. Empty config (no servers)
 */
export function loadConfig(cwd: string): LSPConfig {
   // Try to load user config
   const configPaths = [path.join(cwd, '.pi', 'lsp.json'), path.join(process.env.HOME || '', '.pi', 'lsp.json')]

   for (const configPath of configPaths) {
      if (fs.existsSync(configPath)) {
         try {
            const content = fs.readFileSync(configPath, 'utf-8')
            const parsed = JSON.parse(content)
            const servers = parsed.servers || parsed

            // Filter to only enabled servers with available commands
            const available: Record<string, LSPServerConfig> = {}
            for (const [name, config] of Object.entries(servers) as [string, LSPServerConfig][]) {
               if (config.disabled) continue
               if (!commandExists(config.command)) continue
               available[name] = config
            }

            return { servers: available }
         } catch {
            // Ignore parse errors, fall through to auto-detect
         }
      }
   }

   // Auto-detect: find servers based on project markers AND available binaries
   const detected: Record<string, LSPServerConfig> = {}

   for (const [name, config] of Object.entries(KNOWN_SERVERS)) {
      // Check if project has root markers for this language
      if (!hasRootMarkers(cwd, config.rootMarkers)) continue

      // Check if the language server binary is available
      if (!commandExists(config.command)) continue

      detected[name] = config
   }

   return { servers: detected }
}

export function getServerForFile(config: LSPConfig, filePath: string): [string, LSPServerConfig] | null {
   const ext = path.extname(filePath).toLowerCase()

   for (const [name, serverConfig] of Object.entries(config.servers)) {
      if (serverConfig.fileTypes.includes(ext)) {
         return [name, serverConfig]
      }
   }
   return null
}

export function hasCapability(
   config: LSPConfig,
   serverName: string,
   capability: keyof NonNullable<LSPServerConfig['capabilities']>
): boolean {
   const server = config.servers[serverName]
   return server?.capabilities?.[capability] === true
}

export function getActiveServerNames(config: LSPConfig): string[] {
   return Object.keys(config.servers)
}

export function isServerActive(config: LSPConfig, name: string): boolean {
   return name in config.servers
}

export { hasRootMarkers }
