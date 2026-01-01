import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { logError } from '@omp/output'
import { GLOBAL_PACKAGE_JSON, getProjectOverridesPath, NODE_MODULES_DIR, PLUGINS_DIR } from '@omp/paths'
import chalk from 'chalk'

/**
 * Format permission-related errors with actionable guidance
 */
function formatPermissionError(err: NodeJS.ErrnoException, path: string): string {
   if (err.code === 'EACCES' || err.code === 'EPERM') {
      return `Permission denied: Cannot write to ${path}. Check directory permissions or run with appropriate privileges.`
   }
   return err.message
}

/**
 * OMP field in package.json - defines what files to install
 */
export interface OmpInstallEntry {
   src: string
   dest: string
   /** If true, this file is copied (not symlinked) and can be edited by omp */
   copy?: boolean
}

/**
 * Runtime configuration stored in plugin's runtime.json
 * This file is copied (not symlinked) and edited by omp features/config commands
 */
export interface PluginRuntimeConfig {
   features?: string[]
   options?: Record<string, unknown>
}

/**
 * Runtime variable definition with type, default, and metadata
 */
export interface OmpVariable {
   type: 'string' | 'number' | 'boolean' | 'string[]'
   default?: string | number | boolean | string[]
   description?: string
   required?: boolean
   /** Environment variable name if injected as env (e.g., "EXA_API_KEY") */
   env?: string
}

/**
 * Feature definition - metadata only, no install entries
 * All feature files are always installed; runtime.json controls which are active
 */
export interface OmpFeature {
   description?: string
   /** Runtime variables specific to this feature */
   variables?: Record<string, OmpVariable>
   /** Default enabled state (default: true) */
   default?: boolean
}

export interface OmpField {
   /** Top-level install entries (always installed, not feature-gated) */
   install?: OmpInstallEntry[]
   /** Path to tools factory (relative to package root, e.g. "tools" or "tools/index.ts") */
   tools?: string
   /** Path to runtime config JSON (relative to package root, e.g. "tools/runtime.json") */
   runtime?: string
   /** Top-level runtime variables (always available) */
   variables?: Record<string, OmpVariable>
   /** Named features with their own install entries and variables */
   features?: Record<string, OmpFeature>
   /** Disabled state (managed by omp, not plugin author) */
   disabled?: boolean
}

/**
 * Package.json structure for plugins
 */
export interface PluginPackageJson {
   name: string
   version: string
   description?: string
   keywords?: string[]
   omp?: OmpField
   dependencies?: Record<string, string>
   devDependencies?: Record<string, string>
   files?: string[]
}

/**
 * Per-plugin configuration stored in plugins.json
 */
export interface PluginConfig {
   /**
    * Enabled feature names:
    * - null/undefined: use plugin defaults (first install = all, reinstall = preserve)
    * - ["*"]: explicitly all features
    * - []: no optional features (core only)
    * - ["f1", "f2"]: specific features
    */
   features?: string[] | null
   /** Runtime variable overrides */
   variables?: Record<string, string | number | boolean | string[]>
}

/**
 * Global plugins.json structure (stored in ~/.pi/plugins/package.json)
 */
export interface PluginsJson {
   plugins: Record<string, string> // name -> version specifier
   devDependencies?: Record<string, string> // dev dependencies
   disabled?: string[] // disabled plugin names
   /** Per-plugin feature and variable config */
   config?: Record<string, PluginConfig>
   /** Auto-linked transitive omp dependencies (name -> parent plugin that pulled it in) */
   transitiveDeps?: Record<string, string>
}

/**
 * Project-level overrides (stored in .pi/overrides.json)
 * Allows disabling plugins and overriding config per-project without affecting global state
 */
export interface ProjectOverrides {
   disabled?: string[]
   config?: Record<string, PluginConfig>
}

/**
 * Initialize the global plugins directory with package.json
 */
export async function initGlobalPlugins(): Promise<void> {
   try {
      await mkdir(PLUGINS_DIR, { recursive: true })

      if (!existsSync(GLOBAL_PACKAGE_JSON)) {
         const packageJson = {
            name: 'pi-plugins',
            version: '1.0.0',
            private: true,
            description: 'Global pi plugins managed by omp',
            dependencies: {},
         }
         await writeFile(GLOBAL_PACKAGE_JSON, JSON.stringify(packageJson, null, 2))
      }
   } catch (err) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'EACCES' || error.code === 'EPERM') {
         throw new Error(formatPermissionError(error, PLUGINS_DIR))
      }
      throw err
   }
}

/**
 * Load plugins.json from global ~/.pi/plugins/package.json
 */
export async function loadPluginsJson(): Promise<PluginsJson> {
   try {
      const data = await readFile(GLOBAL_PACKAGE_JSON, 'utf-8')
      const parsed = JSON.parse(data)

      // Global uses standard package.json format
      return {
         plugins: parsed.dependencies || {},
         devDependencies: parsed.devDependencies || {},
         disabled: parsed.omp?.disabled || [],
         config: parsed.omp?.config || {},
         transitiveDeps: parsed.omp?.transitiveDeps || {},
      }
   } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
         return { plugins: {}, devDependencies: {}, disabled: [], config: {}, transitiveDeps: {} }
      }
      throw err
   }
}

/**
 * Save plugins.json to global ~/.pi/plugins/package.json
 */
export async function savePluginsJson(data: PluginsJson): Promise<void> {
   try {
      await mkdir(dirname(GLOBAL_PACKAGE_JSON), { recursive: true })

      // Read existing package.json and update dependencies
      let existing: Record<string, unknown> = {}
      try {
         existing = JSON.parse(await readFile(GLOBAL_PACKAGE_JSON, 'utf-8'))
      } catch {
         existing = {
            name: 'pi-plugins',
            version: '1.0.0',
            private: true,
            description: 'Global pi plugins managed by omp',
         }
      }

      existing.dependencies = data.plugins
      if (data.devDependencies && Object.keys(data.devDependencies).length > 0) {
         existing.devDependencies = data.devDependencies
      } else {
         delete existing.devDependencies
      }

      // Build omp field with disabled, config, and transitiveDeps
      const ompField: Record<string, unknown> = (existing.omp as Record<string, unknown>) || {}
      if (data.disabled?.length) {
         ompField.disabled = data.disabled
      } else {
         delete ompField.disabled
      }
      if (data.config && Object.keys(data.config).length > 0) {
         ompField.config = data.config
      } else {
         delete ompField.config
      }
      if (data.transitiveDeps && Object.keys(data.transitiveDeps).length > 0) {
         ompField.transitiveDeps = data.transitiveDeps
      } else {
         delete ompField.transitiveDeps
      }
      if (Object.keys(ompField).length > 0) {
         existing.omp = ompField
      } else {
         delete existing.omp
      }

      await writeFile(GLOBAL_PACKAGE_JSON, JSON.stringify(existing, null, 2))
   } catch (err) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'EACCES' || error.code === 'EPERM') {
         throw new Error(formatPermissionError(error, GLOBAL_PACKAGE_JSON))
      }
      throw err
   }
}

/**
 * Load project overrides from .pi/overrides.json
 * Returns empty object if file doesn't exist
 */
export async function loadProjectOverrides(): Promise<ProjectOverrides> {
   const path = getProjectOverridesPath()
   if (!path) {
      return {}
   }

   try {
      const data = await readFile(path, 'utf-8')
      const parsed = JSON.parse(data)
      return {
         disabled: parsed.disabled || [],
         config: parsed.config || {},
      }
   } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
         return {}
      }
      throw err
   }
}

/**
 * Save project overrides to .pi/overrides.json
 */
export async function saveProjectOverrides(data: ProjectOverrides): Promise<void> {
   const path = getProjectOverridesPath()
   if (!path) {
      throw new Error("No project root found. Run 'omp init' to create .pi/overrides.json")
   }

   try {
      await mkdir(dirname(path), { recursive: true })

      const output: Record<string, unknown> = {}
      if (data.disabled?.length) {
         output.disabled = data.disabled
      }
      if (data.config && Object.keys(data.config).length > 0) {
         output.config = data.config
      }

      await writeFile(path, JSON.stringify(output, null, 2))
   } catch (err) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'EACCES' || error.code === 'EPERM') {
         throw new Error(formatPermissionError(error, path))
      }
      throw err
   }
}

/**
 * Validates a plugin name against npm naming rules and path traversal attacks.
 * - Scoped packages: @scope/name (scope and name must be valid npm names)
 * - Unscoped packages: name only (no / or \ allowed)
 * - No path traversal sequences (../, ..\, etc.)
 * Returns true if valid, false otherwise.
 */
export function isValidPluginName(pluginName: string): boolean {
   // Check for path traversal attempts
   if (pluginName.includes('..') || pluginName.includes('\\')) {
      return false
   }

   // npm package name rules (simplified):
   // - Can't start with . or _
   // - No uppercase letters
   // - No special characters except - and .
   // - Max 214 chars
   const validNpmName = /^(?:@[a-z0-9][-a-z0-9._]*\/)?[a-z0-9][-a-z0-9._]*$/

   if (!validNpmName.test(pluginName)) {
      return false
   }

   // Additional validation: scoped packages should only have exactly one /
   if (pluginName.startsWith('@')) {
      const slashCount = (pluginName.match(/\//g) || []).length
      if (slashCount !== 1) {
         return false
      }
   } else {
      // Unscoped packages should have no /
      if (pluginName.includes('/')) {
         return false
      }
   }

   return true
}

/**
 * Validates that a resolved path stays within the node_modules base directory.
 * Uses path.relative() for cross-platform compatibility.
 */
function isPluginPathWithinNodeModules(nodeModules: string, pluginName: string): boolean {
   const normalizedBase = resolve(nodeModules)
   const resolvedTarget = resolve(nodeModules, pluginName)
   const rel = relative(normalizedBase, resolvedTarget)
   if (rel === '') return false // Can't be node_modules itself
   if (rel.startsWith('..') || isAbsolute(rel)) return false
   return true
}

/**
 * Read a plugin's package.json from node_modules
 */
export async function readPluginPackageJson(pluginName: string): Promise<PluginPackageJson | null> {
   // Validate plugin name to prevent path traversal attacks
   if (!isValidPluginName(pluginName)) {
      throw new Error(`Invalid plugin name: ${pluginName}`)
   }

   // Double-check the resolved path stays within node_modules
   if (!isPluginPathWithinNodeModules(NODE_MODULES_DIR, pluginName)) {
      throw new Error(`Plugin path escapes node_modules: ${pluginName}`)
   }

   const pkgPath = join(NODE_MODULES_DIR, pluginName, 'package.json')

   try {
      const data = await readFile(pkgPath, 'utf-8')
      return JSON.parse(data) as PluginPackageJson
   } catch (err) {
      const error = err as NodeJS.ErrnoException
      // ENOENT is expected when checking if a plugin is installed
      if (error.code === 'ENOENT') {
         return null
      }
      // JSON parse errors indicate corrupt package.json - throw to distinguish from missing
      if (error instanceof SyntaxError) {
         throw new Error(`Corrupt package.json for '${pluginName}': ${error.message}`)
      }
      // Other errors (permission issues, etc.) - log and throw
      logError(chalk.yellow(`⚠ Failed to read package.json for '${pluginName}': ${error.message}`))
      if (process.env.DEBUG) {
         logError(chalk.dim((error as Error).stack))
      }
      throw error
   }
}

/**
 * Get the source directory for a plugin in node_modules.
 * Throws on invalid plugin names to prevent path traversal attacks.
 */
export function getPluginSourceDir(pluginName: string): string {
   // Validate plugin name to prevent path traversal attacks
   if (!isValidPluginName(pluginName)) {
      throw new Error(`Invalid plugin name: ${pluginName}`)
   }

   // Double-check the resolved path stays within node_modules
   if (!isPluginPathWithinNodeModules(NODE_MODULES_DIR, pluginName)) {
      throw new Error(`Plugin path escapes node_modules: ${pluginName}`)
   }

   return join(NODE_MODULES_DIR, pluginName)
}

/**
 * Get all installed plugins with their info
 */
export async function getInstalledPlugins(): Promise<Map<string, PluginPackageJson>> {
   const pluginsJson = await loadPluginsJson()
   const plugins = new Map<string, PluginPackageJson>()

   for (const name of Object.keys(pluginsJson.plugins)) {
      const pkgJson = await readPluginPackageJson(name)
      if (pkgJson) {
         plugins.set(name, pkgJson)
      }
   }

   return plugins
}
