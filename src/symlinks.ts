import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { copyFile, lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises'
import { platform } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { OmpFeature, OmpInstallEntry, PluginPackageJson, PluginRuntimeConfig } from '@omp/manifest'
import { getPluginSourceDir } from '@omp/manifest'
import { log, logError } from '@omp/output'
import { getProjectStoreDir, NODE_MODULES_DIR, PI_CONFIG_DIR, PLUGINS_DIR } from '@omp/paths'
import chalk from 'chalk'

/**
 * Get all install entries from package.json.
 * Features no longer have install entries - all files are always installed.
 */
export function getInstallEntries(pkgJson: PluginPackageJson): OmpInstallEntry[] {
   return pkgJson.omp?.install ?? []
}

/**
 * @deprecated Use getInstallEntries instead. Features no longer have install arrays.
 */
export function getEnabledInstallEntries(pkgJson: PluginPackageJson, _enabledFeatures?: string[]): OmpInstallEntry[] {
   return getInstallEntries(pkgJson)
}

/**
 * Get all available feature names from a plugin
 */
export function getAllFeatureNames(pkgJson: PluginPackageJson): string[] {
   return Object.keys(pkgJson.omp?.features || {})
}

/**
 * Get features that are enabled by default (default !== false)
 */
export function getDefaultFeatures(features: Record<string, OmpFeature>): string[] {
   return Object.entries(features)
      .filter(([_, f]) => f.default !== false)
      .map(([name]) => name)
}

const isWindows = platform() === 'win32'

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
 * Validates that a target path stays within the base directory.
 * Prevents path traversal attacks via malicious dest entries like '../../../etc/passwd'.
 * Uses path.relative() for cross-platform compatibility (handles both POSIX and Windows separators).
 */
function isPathWithinBase(basePath: string, targetPath: string): boolean {
   const normalizedBase = resolve(basePath)
   const resolvedTarget = resolve(basePath, targetPath)
   // Compute relative path from base to target
   const rel = relative(normalizedBase, resolvedTarget)
   // If relative path starts with '..' or is absolute, the target escapes the base
   // Empty string means they're the same directory (allowed)
   if (rel === '') return true
   // Check if path escapes (starts with .. or is absolute on Windows like C:\)
   if (rel.startsWith('..') || isAbsolute(rel)) return false
   return true
}

/**
 * Get the base directory for symlink destinations (always global)
 */
function getBaseDir(): string {
   return PI_CONFIG_DIR
}

export interface SymlinkResult {
   created: string[]
   errors: string[]
}

export interface SymlinkRemovalResult {
   removed: string[]
   errors: string[]
   skippedNonSymlinks: string[] // Files that exist but aren't symlinks
}

/**
 * Create symlinks (or copy files with copy:true) for a plugin's omp.install entries
 * @param skipDestinations - Set of destination paths to skip (e.g., due to conflict resolution)
 * @param enabledFeatures - Features to write into runtime.json (if plugin has one)
 */
export async function createPluginSymlinks(
   pluginName: string,
   pkgJson: PluginPackageJson,
   verbose = true,
   skipDestinations?: Set<string>,
   enabledFeatures?: string[]
): Promise<SymlinkResult> {
   const result: SymlinkResult = { created: [], errors: [] }
   const sourceDir = getPluginSourceDir(pluginName)

   const installEntries = getInstallEntries(pkgJson)
   if (installEntries.length === 0) {
      if (verbose) {
         log(chalk.dim('  No omp.install entries found'))
      }
      return result
   }

   const baseDir = getBaseDir()

   for (const entry of installEntries) {
      // Skip destinations that the user chose to keep from existing plugins
      if (skipDestinations?.has(entry.dest)) {
         if (verbose) {
            log(chalk.dim(`  Skipped: ${entry.dest} (conflict resolved to existing plugin)`))
         }
         continue
      }

      // Validate dest path stays within base directory (prevents path traversal attacks)
      if (!isPathWithinBase(baseDir, entry.dest)) {
         const msg = `Path traversal blocked: ${entry.dest} escapes base directory`
         result.errors.push(msg)
         if (verbose) {
            log(chalk.red(`  ✗ ${msg}`))
         }
         continue
      }

      try {
         const src = join(sourceDir, entry.src)
         const dest = join(baseDir, entry.dest)

         // Check if source exists
         if (!existsSync(src)) {
            result.errors.push(`Source not found: ${entry.src}`)
            if (verbose) {
               log(chalk.yellow(`  ⚠ Source not found: ${entry.src}`))
            }
            continue
         }

         // Create parent directory
         await mkdir(dirname(dest), { recursive: true })

         // Handle copy vs symlink
         if (entry.copy) {
            // For copy entries (like runtime.json), copy the file
            // But DON'T overwrite if it already exists (preserves user edits)
            if (!existsSync(dest)) {
               await copyFile(src, dest)
               result.created.push(entry.dest)
               if (verbose) {
                  log(chalk.dim(`  Copied: ${entry.dest} (from ${entry.src})`))
               }
            } else {
               if (verbose) {
                  log(chalk.dim(`  Exists: ${entry.dest} (preserved)`))
               }
            }
         } else {
            // Check destination type before removal to avoid deleting real files/directories
            try {
               const destStats = await lstat(dest)
               if (destStats.isSymbolicLink()) {
                  // Safe to remove existing symlink
                  await rm(dest, { force: true })
               } else {
                  // Destination is a real file or directory - refuse to delete
                  const destType = destStats.isDirectory() ? 'directory' : 'file'
                  const msg =
                     `Cannot create symlink at '${entry.dest}': destination is a real ${destType}, not a symlink. ` +
                     `Remove it manually if you want to replace it with a symlink.`
                  result.errors.push(msg)
                  if (verbose) {
                     log(chalk.red(`  ✗ ${msg}`))
                  }
                  continue
               }
            } catch (statErr) {
               // Destination doesn't exist - that's fine, no removal needed
               const error = statErr as NodeJS.ErrnoException
               if (error.code !== 'ENOENT') {
                  throw statErr
               }
            }

            // Create symlink (use junctions on Windows for directories to avoid admin requirement)
            try {
               if (isWindows) {
                  const stats = lstatSync(src)
                  if (stats.isDirectory()) {
                     await symlink(src, dest, 'junction')
                  } else {
                     await symlink(src, dest, 'file')
                  }
               } else {
                  await symlink(src, dest)
               }
            } catch (symlinkErr) {
               const error = symlinkErr as NodeJS.ErrnoException
               if (isWindows && error.code === 'EPERM') {
                  log(chalk.red(`  Permission denied creating symlink.`))
                  log(chalk.dim('  On Windows, enable Developer Mode or run as Administrator.'))
                  log(chalk.dim('  Settings > Update & Security > For developers > Developer Mode'))
               }
               throw symlinkErr
            }
            result.created.push(entry.dest)

            if (verbose) {
               log(chalk.dim(`  Linked: ${entry.dest} → ${entry.src}`))
            }
         }
      } catch (err) {
         const error = err as NodeJS.ErrnoException
         const msg = `Failed to install ${entry.dest}: ${formatPermissionError(error, join(baseDir, entry.dest))}`
         result.errors.push(msg)
         if (verbose) {
            log(chalk.red(`  ✗ ${msg}`))
            if (error.code === 'EACCES' || error.code === 'EPERM') {
               log(chalk.dim('  Check directory permissions or run with appropriate privileges.'))
            }
         }
      }
   }

   // If enabledFeatures provided and plugin has a runtime config, update it
   if (enabledFeatures !== undefined && pkgJson.omp?.runtime) {
      const runtimePath = getRuntimeConfigPath(pkgJson)
      if (runtimePath) {
         await writeRuntimeConfig(runtimePath, { features: enabledFeatures }, verbose)
      }
   }

   return result
}

/**
 * Read runtime.json config from a plugin's installed location
 * Returns {} on failure so callers can detect missing/corrupt config and fall back to defaults
 */
export function readRuntimeConfig(runtimePath: string): PluginRuntimeConfig {
   try {
      const content = readFileSync(runtimePath, 'utf-8')
      return JSON.parse(content) as PluginRuntimeConfig
   } catch (err) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'ENOENT') {
         // Return empty object (not {features: []}) so callers detect missing config
         // and can fall back to plugin defaults instead of treating as "all disabled"
         return {}
      }
      throw err
   }
}

/**
 * Write runtime config to the store location
 */
export async function writeRuntimeConfig(runtimePath: string, config: PluginRuntimeConfig, verbose = false): Promise<void> {
   try {
      // Ensure store directory exists
      const storeDir = dirname(runtimePath)
      if (!existsSync(storeDir)) {
         await mkdir(storeDir, { recursive: true })
      }

      const existing = readRuntimeConfig(runtimePath)
      const merged: PluginRuntimeConfig = {
         features: config.features ?? existing.features ?? [],
         options: { ...existing.options, ...config.options },
      }
      writeFileSync(runtimePath, `${JSON.stringify(merged, null, 2)}\n`)
      if (verbose) {
         log(chalk.dim(`  Updated: ${runtimePath}`))
      }
   } catch (err) {
      const error = err as Error
      // Always warn about runtime config failures - they affect plugin behavior
      logError(chalk.yellow(`⚠ Failed to update runtime config at ${runtimePath}: ${error.message}`))
      if (process.env.DEBUG) {
         logError(chalk.dim(error.stack))
      }
   }
}

/**
 * Get the global store directory for runtime configs
 */
function getGlobalStoreDir(): string {
   return join(PLUGINS_DIR, 'store')
}

/**
 * Get the path to a plugin's runtime config in the global store
 * Uses the omp.runtime field from package.json
 * Store path: ~/.pi/plugins/store/@scope__name.json
 */
export function getRuntimeConfigPath(pkgJson: PluginPackageJson): string | null {
   if (!pkgJson.omp?.runtime) return null

   const storeDir = getGlobalStoreDir()
   const storeName = pkgJson.name.replace(/\//g, '__') // @oh-my-pi/exa -> @oh-my-pi__exa
   return join(storeDir, `${storeName}.json`)
}

/**
 * Get the path to a plugin's runtime config in the project store for local overrides
 * Store path: cwd/.pi/store/@scope__name.json
 */
export function getProjectRuntimeConfigPath(pkgJson: PluginPackageJson): string | null {
   if (!pkgJson.omp?.runtime) return null

   const storeName = pkgJson.name.replace(/\//g, '__') // @oh-my-pi/exa -> @oh-my-pi__exa
   return join(getProjectStoreDir(), `${storeName}.json`)
}

/**
 * Get the default runtime config path in node_modules (for copying defaults)
 */
export function getDefaultRuntimeConfigPath(pkgJson: PluginPackageJson): string | null {
   const runtimePath = pkgJson.omp?.runtime
   if (!runtimePath) return null

   const nodeModulesDir = NODE_MODULES_DIR
   return join(nodeModulesDir, pkgJson.name, runtimePath)
}

/**
 * Remove symlinks and copied files for a plugin's omp.install entries
 */
export async function removePluginSymlinks(_pluginName: string, pkgJson: PluginPackageJson, verbose = true): Promise<SymlinkRemovalResult> {
   const result: SymlinkRemovalResult = {
      removed: [],
      errors: [],
      skippedNonSymlinks: [],
   }

   const installEntries = getInstallEntries(pkgJson)
   if (installEntries.length === 0) {
      return result
   }

   const baseDir = getBaseDir()

   for (const entry of installEntries) {
      // Validate dest path stays within base directory (prevents path traversal attacks)
      if (!isPathWithinBase(baseDir, entry.dest)) {
         const msg = `Path traversal blocked: ${entry.dest} escapes base directory`
         result.errors.push(msg)
         if (verbose) {
            log(chalk.red(`  ✗ ${msg}`))
         }
         continue
      }

      const dest = join(baseDir, entry.dest)

      try {
         if (existsSync(dest)) {
            const stats = lstatSync(dest)

            // For copy entries (like runtime.json), we can safely remove them
            if (entry.copy) {
               await rm(dest, { force: true })
               result.removed.push(entry.dest)
               if (verbose) {
                  log(chalk.dim(`  Removed: ${entry.dest}`))
               }
               continue
            }

            // For symlinks, check they're actually symlinks
            if (!stats.isSymbolicLink()) {
               result.skippedNonSymlinks.push(dest)
               if (verbose) {
                  log(chalk.yellow(`  ⚠ Skipping ${entry.dest}: not a symlink (may contain user data)`))
               }
               continue
            }

            await rm(dest, { force: true, recursive: true })
            result.removed.push(entry.dest)
            if (verbose) {
               log(chalk.dim(`  Removed: ${entry.dest}`))
            }
         }
      } catch (err) {
         const error = err as NodeJS.ErrnoException
         const msg = `Failed to remove ${entry.dest}: ${formatPermissionError(error, dest)}`
         result.errors.push(msg)
         if (verbose) {
            log(chalk.yellow(`  ⚠ ${msg}`))
            if (error.code === 'EACCES' || error.code === 'EPERM') {
               log(chalk.dim('  Check directory permissions or run with appropriate privileges.'))
            }
         }
      }
   }

   return result
}

/**
 * Check symlink/file health for a plugin
 */
export async function checkPluginSymlinks(
   pluginName: string,
   pkgJson: PluginPackageJson
): Promise<{ valid: string[]; broken: string[]; missing: string[] }> {
   const result = {
      valid: [] as string[],
      broken: [] as string[],
      missing: [] as string[],
   }
   const sourceDir = getPluginSourceDir(pluginName)
   const baseDir = getBaseDir()

   const installEntries = getInstallEntries(pkgJson)
   if (installEntries.length === 0) {
      return result
   }

   for (const entry of installEntries) {
      // Skip entries with path traversal (treat as broken)
      if (!isPathWithinBase(baseDir, entry.dest)) {
         result.broken.push(entry.dest)
         continue
      }

      const src = join(sourceDir, entry.src)
      const dest = join(baseDir, entry.dest)

      if (!existsSync(dest)) {
         result.missing.push(entry.dest)
         continue
      }

      try {
         const stats = lstatSync(dest)

         // For copy entries, just check the file exists
         if (entry.copy) {
            if (stats.isFile()) {
               result.valid.push(entry.dest)
            } else {
               result.broken.push(entry.dest)
            }
            continue
         }

         // For symlinks, verify they point to valid sources
         if (stats.isSymbolicLink()) {
            const target = await readlink(dest)
            if (existsSync(src) && resolve(target) === resolve(src)) {
               result.valid.push(entry.dest)
            } else {
               result.broken.push(entry.dest)
            }
         } else {
            // Not a symlink, might be a file that was overwritten
            result.broken.push(entry.dest)
         }
      } catch {
         result.broken.push(entry.dest)
      }
   }

   return result
}

/**
 * Get plugin name from an installed symlink destination
 */
export async function getPluginForSymlink(dest: string, installedPlugins: Map<string, PluginPackageJson>): Promise<string | null> {
   for (const [name, pkgJson] of installedPlugins) {
      if (pkgJson.omp?.install) {
         for (const entry of pkgJson.omp.install) {
            if (entry.dest === dest) {
               return name
            }
         }
      }
   }
   return null
}

/**
 * Find all symlinks installed by plugins and trace them back
 */
export async function traceInstalledFile(
   filePath: string,
   installedPlugins: Map<string, PluginPackageJson>
): Promise<{ plugin: string; entry: OmpInstallEntry } | null> {
   // Normalize the path relative to the base directory
   const baseDir = getBaseDir()
   let relativePath = filePath
   const isWindows = platform() === 'win32'
   const normalizedFilePath = isWindows ? filePath.toLowerCase() : filePath
   const normalizedBaseDir = isWindows ? baseDir.toLowerCase() : baseDir
   if (normalizedFilePath.startsWith(normalizedBaseDir)) {
      relativePath = filePath.slice(baseDir.length + 1)
   }

   for (const [name, pkgJson] of installedPlugins) {
      if (pkgJson.omp?.install) {
         for (const entry of pkgJson.omp.install) {
            if (entry.dest === relativePath) {
               return { plugin: name, entry }
            }
         }
      }
   }

   return null
}
