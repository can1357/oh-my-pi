import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Global pi configuration directory
export const PI_CONFIG_DIR = join(homedir(), '.pi')

// Global plugins directory
export const PLUGINS_DIR = join(PI_CONFIG_DIR, 'plugins')

// npm node_modules within plugins directory
export const NODE_MODULES_DIR = join(PLUGINS_DIR, 'node_modules')

// Global package.json for plugin management
export const GLOBAL_PACKAGE_JSON = join(PLUGINS_DIR, 'package.json')

// Global omp lock file (separate from npm's package-lock.json)
export const GLOBAL_LOCK_FILE = join(PLUGINS_DIR, 'omp-lock.json')

// Global store directory for plugin configs
export const GLOBAL_STORE_DIR = join(PLUGINS_DIR, 'store')

// Global agent directory
export const GLOBAL_AGENT_DIR = join(PI_CONFIG_DIR, 'agent')

/**
 * Find the project root by walking up parent directories looking for .pi/overrides.json.
 * Similar to how git finds .git directories.
 *
 * @returns The absolute path to the project root, or null if not found
 */
export function findProjectOverridesRoot(): string | null {
   let dir = process.cwd()
   const root = resolve('/')

   while (dir !== root) {
      if (existsSync(join(dir, '.pi', 'overrides.json'))) {
         return dir
      }
      const parent = dirname(dir)
      if (parent === dir) break // Reached filesystem root
      dir = parent
   }

   return null
}

/**
 * Check if a project-local .pi/overrides.json exists in the current directory or any parent
 */
export function hasProjectOverrides(): boolean {
   return findProjectOverridesRoot() !== null
}

/**
 * Get the project overrides.json path.
 * Uses findProjectOverridesRoot() to locate the project, or falls back to cwd/.pi/overrides.json.
 */
export function getProjectOverridesPath(): string {
   const projectRoot = findProjectOverridesRoot()
   if (projectRoot) {
      return join(projectRoot, '.pi', 'overrides.json')
   }
   // Fallback to cwd (e.g., for init command)
   return resolve('.pi', 'overrides.json')
}

/**
 * Get the project store directory for project-level config overrides.
 * Uses findProjectOverridesRoot() to locate the project, or falls back to cwd/.pi/store.
 */
export function getProjectStoreDir(): string {
   const projectRoot = findProjectOverridesRoot()
   if (projectRoot) {
      return join(projectRoot, '.pi', 'store')
   }
   // Fallback to cwd
   return resolve('.pi', 'store')
}

/**
 * Get the agent directory (where symlinks are installed).
 * Always returns global agent directory.
 */
export function getAgentDir(): string {
   return GLOBAL_AGENT_DIR
}
