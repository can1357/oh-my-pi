import { resolve } from 'node:path'
import type { PluginPackageJson } from '@omp/manifest'

export interface Conflict {
   dest: string
   plugins: Array<{ name: string; src: string }>
}

export interface IntraPluginDuplicate {
   dest: string
   sources: string[]
}

/**
 * Normalize a destination path for comparison.
 * Uses path.resolve() to handle ./foo vs foo, trailing slashes, etc.
 */
function normalizeDest(dest: string): string {
   // Resolve relative to a fixed base to normalize without needing actual filesystem
   return resolve('/', dest)
}

/**
 * Detect duplicate destinations within a single plugin's omp.install array
 */
export function detectIntraPluginDuplicates(pkgJson: PluginPackageJson): IntraPluginDuplicate[] {
   const duplicates: IntraPluginDuplicate[] = []

   if (!pkgJson.omp?.install?.length) {
      return duplicates
   }

   const destMap = new Map<string, string[]>()

   for (const entry of pkgJson.omp.install) {
      const normalizedDest = normalizeDest(entry.dest)
      const sources = destMap.get(normalizedDest) || []
      sources.push(entry.src)
      destMap.set(normalizedDest, sources)
   }

   for (const [dest, sources] of destMap) {
      if (sources.length > 1) {
         duplicates.push({ dest, sources })
      }
   }

   return duplicates
}

/**
 * Detect conflicts between a new plugin (and its transitive dependencies) and existing plugins.
 *
 * @param newPluginName - The name of the new plugin being installed
 * @param newPkgJson - The package.json of the new plugin
 * @param existingPlugins - Map of already-installed plugins
 * @param transitiveDeps - Optional map of transitive dependency package.json files to check
 */
export function detectConflicts(
   newPluginName: string,
   newPkgJson: PluginPackageJson,
   existingPlugins: Map<string, PluginPackageJson>,
   transitiveDeps?: Map<string, PluginPackageJson>
): Conflict[] {
   const conflicts: Conflict[] = []

   // Build a map of existing destinations (normalized)
   const destMap = new Map<string, Array<{ name: string; src: string }>>()

   for (const [name, pkgJson] of existingPlugins) {
      if (pkgJson.omp?.install) {
         for (const entry of pkgJson.omp.install) {
            const normalizedDest = normalizeDest(entry.dest)
            const existing = destMap.get(normalizedDest) || []
            existing.push({ name, src: entry.src })
            destMap.set(normalizedDest, existing)
         }
      }
   }

   // Collect all install entries from new plugin and its transitive deps
   const newInstallEntries: Array<{ pluginName: string; src: string; dest: string }> = []

   if (newPkgJson.omp?.install?.length) {
      for (const entry of newPkgJson.omp.install) {
         newInstallEntries.push({ pluginName: newPluginName, src: entry.src, dest: entry.dest })
      }
   }

   // Add transitive dependency install entries
   if (transitiveDeps) {
      for (const [depName, depPkgJson] of transitiveDeps) {
         if (depPkgJson.omp?.install) {
            for (const entry of depPkgJson.omp.install) {
               newInstallEntries.push({ pluginName: depName, src: entry.src, dest: entry.dest })
            }
         }
      }
   }

   // Check for conflicts between new entries and existing destinations
   // Also check for conflicts within the new entries themselves
   const newDestMap = new Map<string, Array<{ name: string; src: string }>>()

   for (const { pluginName, src, dest } of newInstallEntries) {
      const normalizedDest = normalizeDest(dest)

      // Check against existing plugins
      const existing = destMap.get(normalizedDest)
      if (existing && existing.length > 0) {
         // Check if we already have a conflict for this dest
         const existingConflict = conflicts.find(c => normalizeDest(c.dest) === normalizedDest)
         if (existingConflict) {
            // Add this plugin to existing conflict if not already present
            if (!existingConflict.plugins.some(p => p.name === pluginName && p.src === src)) {
               existingConflict.plugins.push({ name: pluginName, src })
            }
         } else {
            conflicts.push({
               dest,
               plugins: [...existing, { name: pluginName, src }],
            })
         }
      }

      // Track for intra-new-plugins conflict detection
      const newExisting = newDestMap.get(normalizedDest) || []
      newExisting.push({ name: pluginName, src })
      newDestMap.set(normalizedDest, newExisting)
   }

   // Check for conflicts within the new plugin + transitive deps
   for (const [normalizedDest, sources] of newDestMap) {
      if (sources.length > 1) {
         // Multiple new sources targeting same dest - but only if not already in conflicts
         const existingConflict = conflicts.find(c => normalizeDest(c.dest) === normalizedDest)
         if (!existingConflict) {
            // Find original dest string from first entry
            const originalEntry = newInstallEntries.find(e => normalizeDest(e.dest) === normalizedDest)
            conflicts.push({
               dest: originalEntry?.dest || normalizedDest,
               plugins: sources,
            })
         }
      }
   }

   return conflicts
}

/**
 * Detect all conflicts among a set of plugins
 */
export function detectAllConflicts(plugins: Map<string, PluginPackageJson>): Conflict[] {
   const conflicts: Conflict[] = []
   const destMap = new Map<string, Array<{ name: string; src: string; originalDest: string }>>()

   for (const [name, pkgJson] of plugins) {
      if (pkgJson.omp?.install) {
         for (const entry of pkgJson.omp.install) {
            const normalizedDest = normalizeDest(entry.dest)
            const existing = destMap.get(normalizedDest) || []
            existing.push({ name, src: entry.src, originalDest: entry.dest })
            destMap.set(normalizedDest, existing)
         }
      }
   }

   // Find destinations with multiple sources
   for (const [, sources] of destMap) {
      if (sources.length > 1) {
         conflicts.push({
            dest: sources[0].originalDest,
            plugins: sources.map(s => ({ name: s.name, src: s.src })),
         })
      }
   }

   return conflicts
}

/**
 * Format conflicts for display
 */
export function formatConflicts(conflicts: Conflict[]): string[] {
   return conflicts.map(conflict => {
      const plugins = conflict.plugins.map(p => p.name).join(' and ')
      return `${plugins} both install ${conflict.dest}`
   })
}
