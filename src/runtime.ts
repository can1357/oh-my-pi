import type { OmpVariable, PluginConfig, PluginPackageJson } from '@omp/manifest'
import { loadPluginsJson, loadProjectOverrides, readPluginPackageJson } from '@omp/manifest'

/**
 * Collect all variables from a plugin (top-level + enabled features)
 */
function collectVariables(pkgJson: PluginPackageJson, enabledFeatures: string[]): Record<string, OmpVariable> {
   const vars: Record<string, OmpVariable> = {}

   // Top-level variables
   if (pkgJson.omp?.variables) {
      Object.assign(vars, pkgJson.omp.variables)
   }

   // Variables from enabled features
   if (pkgJson.omp?.features) {
      for (const fname of enabledFeatures) {
         const feature = pkgJson.omp.features[fname]
         if (feature?.variables) {
            Object.assign(vars, feature.variables)
         }
      }
   }

   return vars
}

/**
 * Resolve which features are currently enabled
 *
 * - null/undefined: use plugin defaults (features with default !== false)
 * - ["*"]: explicitly all features
 * - []: no optional features
 * - ["f1", "f2"]: specific features
 */
function resolveEnabledFeatures(
   allFeatureNames: string[],
   storedFeatures: string[] | null | undefined,
   pluginFeatures: Record<string, { default?: boolean }>
): string[] {
   // Explicit "all features" request
   if (Array.isArray(storedFeatures) && storedFeatures.includes('*')) return allFeatureNames
   // Explicit feature list (including empty array = no features)
   if (Array.isArray(storedFeatures)) return storedFeatures
   // null/undefined = use defaults
   return Object.entries(pluginFeatures)
      .filter(([_, f]) => f.default !== false)
      .map(([name]) => name)
}

function mergePluginConfig(globalConfig?: PluginConfig, localConfig?: PluginConfig): PluginConfig | undefined {
   if (!globalConfig && !localConfig) return undefined

   const merged: PluginConfig = {}

   if (localConfig && 'features' in localConfig) {
      merged.features = localConfig.features
   } else if (globalConfig && 'features' in globalConfig) {
      merged.features = globalConfig.features
   }

   const mergedVars = {
      ...(globalConfig?.variables ?? {}),
      ...(localConfig?.variables ?? {}),
   }
   if (Object.keys(mergedVars).length > 0) {
      merged.variables = mergedVars
   }

   return merged
}

/**
 * Get all environment variables for enabled plugins
 */
export async function getPluginEnvVars(local = false): Promise<Record<string, string>> {
   const pluginsJson = await loadPluginsJson()
   const env: Record<string, string> = {}
   const disabled = new Set(pluginsJson.disabled || [])
   const configByPlugin: Record<string, PluginConfig> = { ...(pluginsJson.config || {}) }

   if (local) {
      const overrides = await loadProjectOverrides()
      for (const name of overrides.disabled || []) {
         disabled.add(name)
      }
      if (overrides.config) {
         for (const [name, localConfig] of Object.entries(overrides.config)) {
            const merged = mergePluginConfig(configByPlugin[name], localConfig)
            if (merged) {
               configByPlugin[name] = merged
            }
         }
      }
   }

   for (const pluginName of Object.keys(pluginsJson.plugins)) {
      // Skip disabled plugins
      if (disabled.has(pluginName)) continue

      const pkgJson = await readPluginPackageJson(pluginName)
      if (!pkgJson?.omp) continue

      const config = configByPlugin[pluginName]
      const allFeatureNames = Object.keys(pkgJson.omp.features || {})
      const enabledFeatures = resolveEnabledFeatures(allFeatureNames, config?.features, pkgJson.omp.features || {})

      // Collect variables from top-level and enabled features
      const variables = collectVariables(pkgJson, enabledFeatures)

      for (const [key, varDef] of Object.entries(variables)) {
         if (varDef.env) {
            const value = config?.variables?.[key] ?? varDef.default
            if (value !== undefined) {
               env[varDef.env] = String(value)
            }
         }
      }
   }

   return env
}

/**
 * Generate shell export statements
 * omp env > ~/.pi/env.sh && source ~/.pi/env.sh
 */
export async function generateEnvScript(local = false, shell: 'sh' | 'fish' = 'sh'): Promise<string> {
   const vars = await getPluginEnvVars(local)

   if (shell === 'fish') {
      // Fish doesn't expand variables in single quotes
      return Object.entries(vars)
         .map(([k, v]) => `set -gx ${k} '${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
         .join('\n')
   }

   // POSIX sh/bash/zsh - use single quotes with proper escaping
   // Replace ' with '\'' (end quote, escaped quote, start quote)
   return Object.entries(vars)
      .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
      .join('\n')
}

/**
 * Get environment variables as a JSON object for programmatic use
 */
export async function getEnvJson(local = false): Promise<Record<string, string>> {
   return getPluginEnvVars(local)
}
