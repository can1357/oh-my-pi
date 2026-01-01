import { checkbox } from '@inquirer/prompts'
import { loadPluginsJson, loadProjectOverrides, readPluginPackageJson, savePluginsJson, saveProjectOverrides } from '@omp/manifest'
import { getProjectRuntimeConfigPath, getRuntimeConfigPath, readRuntimeConfig, writeRuntimeConfig } from '@omp/symlinks'
import chalk from 'chalk'

export interface FeaturesOptions {
   global?: boolean
   local?: boolean
   json?: boolean
   enable?: string[]
   disable?: string[]
   set?: string
}

function resolveEnabledFeatures(
   allFeatureNames: string[],
   pluginFeatures: Record<string, { description?: string; default?: boolean }>,
   storedFeatures: string[] | null | undefined,
   runtimePath?: string | null
): string[] {
   if (Array.isArray(storedFeatures)) {
      if (storedFeatures.includes('*')) return allFeatureNames
      return storedFeatures
   }

   if (runtimePath) {
      const runtimeConfig = readRuntimeConfig(runtimePath)
      if (Array.isArray(runtimeConfig.features)) {
         if (runtimeConfig.features.includes('*')) return allFeatureNames
         return runtimeConfig.features
      }
   }

   // Compute defaults inline - features with default !== false
   return Object.entries(pluginFeatures)
      .filter(([_, f]) => f.default !== false)
      .map(([name]) => name)
}

/**
 * Interactive feature selection for a plugin
 * omp features @oh-my-pi/exa
 */
export async function interactiveFeatures(name: string, options: FeaturesOptions = {}): Promise<void> {
   const useLocal = Boolean(options.local)
   const pluginsJson = await loadPluginsJson()

   // Check if plugin exists
   if (!pluginsJson.plugins[name]) {
      console.log(chalk.yellow(`Plugin "${name}" is not installed.`))
      process.exitCode = 1
      return
   }

   const pkgJson = await readPluginPackageJson(name)
   if (!pkgJson) {
      console.log(chalk.red(`Could not read package.json for ${name}`))
      process.exitCode = 1
      return
   }

   const features = pkgJson.omp?.features
   if (!features || Object.keys(features).length === 0) {
      console.log(chalk.yellow(`Plugin "${name}" has no configurable features.`))
      return
   }

   const allFeatureNames = Object.keys(features)
   const globalRuntimePath = getRuntimeConfigPath(pkgJson)

   // Get runtime config path to write to
   const runtimePath = useLocal ? getProjectRuntimeConfigPath(pkgJson) : globalRuntimePath
   if (!runtimePath) {
      console.log(chalk.yellow(`Plugin "${name}" does not have a runtime.json config file.`))
      return
   }

   // Determine currently enabled features:
   // 1. Use global config (source of truth) or global runtime.json/defaults
   // 2. Merge project overrides (if -l), which take precedence
   const globalConfig = pluginsJson.config?.[name]
   let enabledFeatures = resolveEnabledFeatures(allFeatureNames, features, globalConfig?.features, globalRuntimePath)

   if (useLocal) {
      const projectOverrides = await loadProjectOverrides()
      const localConfig = projectOverrides.config?.[name]
      if (localConfig?.features !== undefined) {
         enabledFeatures = resolveEnabledFeatures(allFeatureNames, features, localConfig.features)
      }
   }

   // JSON output mode - just list
   if (options.json) {
      console.log(
         JSON.stringify(
            {
               plugin: name,
               features: Object.entries(features).map(([fname, fdef]) => ({
                  name: fname,
                  enabled: enabledFeatures.includes(fname),
                  default: fdef.default !== false,
                  description: fdef.description,
                  variables: fdef.variables ? Object.keys(fdef.variables) : [],
               })),
            },
            null,
            2
         )
      )
      return
   }

   // Non-interactive mode - just list
   if (!process.stdout.isTTY || !process.stdin.isTTY) {
      listFeaturesNonInteractive(name, features, enabledFeatures)
      return
   }

   // Interactive mode - checkbox prompt
   console.log(chalk.bold(`\nConfigure features for ${name}:\n`))

   const choices = Object.entries(features).map(([fname, fdef]) => {
      const optIn = fdef.default === false ? chalk.dim(' (opt-in)') : ''
      const desc = fdef.description ? chalk.dim(` - ${fdef.description}`) : ''
      return {
         name: `${fname}${optIn}${desc}`,
         value: fname,
         checked: enabledFeatures.includes(fname),
      }
   })

   try {
      const selected = await checkbox({
         message: 'Select features to enable:',
         choices,
         pageSize: 15,
      })

      // Apply changes
      await applyFeatureChanges(name, runtimePath, features, enabledFeatures, selected, useLocal)
   } catch (_err) {
      // User cancelled (Ctrl+C)
      console.log(chalk.dim('\nCancelled.'))
   }
}

/**
 * Non-interactive feature listing
 */
function listFeaturesNonInteractive(
   name: string,
   features: Record<
      string,
      {
         description?: string
         default?: boolean
         variables?: Record<string, unknown>
      }
   >,
   enabledFeatures: string[]
): void {
   console.log(chalk.bold(`\nFeatures for ${name}:\n`))

   for (const [fname, fdef] of Object.entries(features)) {
      const isEnabled = enabledFeatures.includes(fname)
      const icon = isEnabled ? chalk.green('✓') : chalk.gray('○')
      const defaultStr = fdef.default === false ? chalk.dim(' (opt-in)') : ''

      console.log(`${icon} ${chalk.bold(fname)}${defaultStr}`)
      if (fdef.description) {
         console.log(chalk.dim(`    ${fdef.description}`))
      }
      if (fdef.variables && Object.keys(fdef.variables).length > 0) {
         console.log(chalk.dim(`    Variables: ${Object.keys(fdef.variables).join(', ')}`))
      }
   }

   console.log()
   console.log(chalk.dim(`Configure with: omp features ${name} --enable <feature> --disable <feature>`))
   console.log(chalk.dim(`Or set exactly: omp features ${name} --set feature1,feature2`))
}

/**
 * Apply feature changes - update runtime.json and config source (global or project overrides)
 */
async function applyFeatureChanges(
   name: string,
   runtimePath: string,
   _features: Record<
      string,
      {
         description?: string
         default?: boolean
         variables?: Record<string, unknown>
      }
   >,
   currentlyEnabled: string[],
   newEnabled: string[],
   useLocal: boolean,
   jsonMode?: boolean
): Promise<void> {
   // Compute what changed
   const toDisable = currentlyEnabled.filter(f => !newEnabled.includes(f))
   const toEnable = newEnabled.filter(f => !currentlyEnabled.includes(f))

   if (toDisable.length === 0 && toEnable.length === 0) {
      if (!jsonMode) console.log(chalk.yellow('\nNo changes to feature configuration.'))
      return
   }

   if (!jsonMode) {
      console.log(chalk.blue(`\nApplying changes...`))

      if (toDisable.length > 0) {
         console.log(chalk.dim(`  Disabling: ${toDisable.join(', ')}`))
      }
      if (toEnable.length > 0) {
         console.log(chalk.dim(`  Enabling: ${toEnable.join(', ')}`))
      }
   }

   // Write runtime.json FIRST (for runtime feature detection)
   // This order ensures consistency: if runtime.json write succeeds but config save fails,
   // the runtime behavior matches reality. If runtime.json fails, we bail before touching
   // config, avoiding state divergence.
   await writeRuntimeConfig(runtimePath, { features: newEnabled })

   if (useLocal) {
      const overrides = await loadProjectOverrides()
      if (!overrides.config) overrides.config = {}
      if (!overrides.config[name]) overrides.config[name] = {}
      overrides.config[name].features = newEnabled
      await saveProjectOverrides(overrides)
   } else {
      const pluginsJson = await loadPluginsJson()
      if (!pluginsJson.config) pluginsJson.config = {}
      if (!pluginsJson.config[name]) pluginsJson.config[name] = {}
      pluginsJson.config[name].features = newEnabled
      await savePluginsJson(pluginsJson)
   }

   if (!jsonMode) {
      console.log(chalk.green(`\n✓ Features updated`))
      if (newEnabled.length > 0) {
         console.log(chalk.dim(`  Enabled: ${newEnabled.join(', ')}`))
      } else {
         console.log(chalk.dim(`  Enabled: none`))
      }
   }
}

/**
 * Configure features for an installed plugin via CLI flags
 * omp features @oh-my-pi/exa --enable websets --disable search
 * omp features @oh-my-pi/exa --set search,websets
 */
export async function configureFeatures(name: string, options: FeaturesOptions = {}): Promise<void> {
   const useLocal = Boolean(options.local)
   const pluginsJson = await loadPluginsJson()

   // Check if plugin exists
   if (!pluginsJson.plugins[name]) {
      console.log(chalk.yellow(`Plugin "${name}" is not installed.`))
      process.exitCode = 1
      return
   }

   const pkgJson = await readPluginPackageJson(name)
   if (!pkgJson) {
      console.log(chalk.red(`Could not read package.json for ${name}`))
      process.exitCode = 1
      return
   }

   const features = pkgJson.omp?.features
   if (!features || Object.keys(features).length === 0) {
      console.log(chalk.yellow(`Plugin "${name}" has no configurable features.`))
      process.exitCode = 1
      return
   }

   const allFeatureNames = Object.keys(features)
   const globalRuntimePath = getRuntimeConfigPath(pkgJson)
   const runtimePath = useLocal ? getProjectRuntimeConfigPath(pkgJson) : globalRuntimePath

   // Get runtime config path
   if (!runtimePath) {
      console.log(chalk.yellow(`Plugin "${name}" does not have a runtime.json config file.`))
      process.exitCode = 1
      return
   }

   // Determine currently enabled features:
   // 1. Use global config (source of truth) or global runtime.json/defaults
   // 2. Merge project overrides (if -l), which take precedence
   const globalConfig = pluginsJson.config?.[name]
   let currentlyEnabled = resolveEnabledFeatures(allFeatureNames, features, globalConfig?.features, globalRuntimePath)

   if (useLocal) {
      const projectOverrides = await loadProjectOverrides()
      const localConfig = projectOverrides.config?.[name]
      if (localConfig?.features !== undefined) {
         currentlyEnabled = resolveEnabledFeatures(allFeatureNames, features, localConfig.features)
      }
   }

   let newEnabled: string[]

   // Handle --set (explicit list)
   if (options.set !== undefined) {
      if (options.set === '*') {
         newEnabled = allFeatureNames
      } else if (options.set === '') {
         newEnabled = []
      } else {
         newEnabled = options.set
            .split(',')
            .map(f => f.trim())
            .filter(Boolean)
         // Validate
         for (const f of newEnabled) {
            if (!features[f]) {
               console.log(chalk.red(`Unknown feature "${f}". Available: ${allFeatureNames.join(', ')}`))
               process.exitCode = 1
               return
            }
         }
      }
   } else {
      // Handle --enable and --disable
      newEnabled = [...currentlyEnabled]

      if (options.enable) {
         for (const f of options.enable) {
            if (!features[f]) {
               console.log(chalk.red(`Unknown feature "${f}". Available: ${allFeatureNames.join(', ')}`))
               process.exitCode = 1
               return
            }
            if (!newEnabled.includes(f)) {
               newEnabled.push(f)
            }
         }
      }

      if (options.disable) {
         for (const f of options.disable) {
            if (!features[f]) {
               console.log(chalk.red(`Unknown feature "${f}". Available: ${allFeatureNames.join(', ')}`))
               process.exitCode = 1
               return
            }
            newEnabled = newEnabled.filter(e => e !== f)
         }
      }
   }

   await applyFeatureChanges(name, runtimePath, features, currentlyEnabled, newEnabled, useLocal, options.json)

   if (options.json) {
      console.log(JSON.stringify({ plugin: name, enabled: newEnabled }, null, 2))
   }
}

/**
 * Main features command handler
 * Routes to interactive or configure based on options
 */
export async function featuresCommand(name: string, options: FeaturesOptions = {}): Promise<void> {
   // If any modification options are passed, configure via CLI
   if (options.enable || options.disable || options.set !== undefined) {
      await configureFeatures(name, options)
   } else {
      // Otherwise, show interactive UI (or list in non-TTY mode)
      await interactiveFeatures(name, options)
   }
}
