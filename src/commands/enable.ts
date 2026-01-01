import { writeLoader } from '@omp/loader'
import { loadPluginsJson, loadProjectOverrides, readPluginPackageJson, savePluginsJson, saveProjectOverrides } from '@omp/manifest'
import { checkPluginSymlinks, createPluginSymlinks, removePluginSymlinks } from '@omp/symlinks'
import chalk from 'chalk'

export interface EnableDisableOptions {
   global?: boolean
   local?: boolean
   json?: boolean
}

/**
 * Enable a disabled plugin (re-create symlinks or update project overrides)
 */
export async function enablePlugin(name: string, options: EnableDisableOptions = {}): Promise<void> {
   const useProjectOverrides = options.local === true
   const pluginsJson = await loadPluginsJson()

   // Check if plugin exists
   if (!pluginsJson.plugins[name]) {
      if (!options.json) {
         console.log(chalk.yellow(`Plugin "${name}" is not installed globally.`))
      }
      process.exitCode = 1
      return
   }

   if (useProjectOverrides) {
      const overrides = await loadProjectOverrides()

      const disabled = overrides.disabled ?? []

      // Check if already enabled for project
      if (!disabled.includes(name)) {
         if (!options.json) {
            console.log(chalk.yellow(`Plugin "${name}" is already enabled for this project.`))
         }
         process.exitCode = 1
         return
      }

      try {
         overrides.disabled = disabled.filter(n => n !== name)
         await saveProjectOverrides(overrides)

         if (options.json) {
            console.log(JSON.stringify({ name, enabled: true }, null, 2))
         } else {
            console.log(chalk.green(`✓ Enabled "${name}" for this project`))
         }
      } catch (err) {
         if (!options.json) {
            console.log(chalk.red(`Error enabling plugin for project: ${(err as Error).message}`))
         }
         process.exitCode = 1
      }
      return
   }

   // Check if already enabled globally
   if (!pluginsJson.disabled?.includes(name)) {
      if (!options.json) {
         console.log(chalk.yellow(`Plugin "${name}" is already enabled globally.`))
      }
      process.exitCode = 1
      return
   }

   try {
      // Read package.json
      const pkgJson = await readPluginPackageJson(name)
      if (!pkgJson) {
         if (!options.json) {
            console.log(chalk.red(`Could not read package.json for ${name}`))
         }
         process.exitCode = 1
         return
      }

      // Check if symlinks are already in place
      const symlinkStatus = await checkPluginSymlinks(name, pkgJson)
      let symlinksCreated = false

      if (symlinkStatus.valid.length > 0 && symlinkStatus.broken.length === 0 && symlinkStatus.missing.length === 0) {
         if (!options.json) {
            console.log(chalk.yellow(`Plugin "${name}" symlinks are already in place.`))
         }
      } else {
         // Re-create symlinks
         if (!options.json) {
            console.log(chalk.blue(`Enabling ${name} globally...`))
         }
         await createPluginSymlinks(name, pkgJson)
         symlinksCreated = true
      }

      // Remove from disabled list
      pluginsJson.disabled = (pluginsJson.disabled ?? []).filter(n => n !== name)
      try {
         await savePluginsJson(pluginsJson)
      } catch (saveErr) {
         // Rollback symlinks if we created them
         if (symlinksCreated) {
            await removePluginSymlinks(name, pkgJson).catch(() => {})
         }
         throw saveErr
      }

      // Ensure the OMP loader is in place
      await writeLoader()

      if (options.json) {
         console.log(JSON.stringify({ name, enabled: true }, null, 2))
      } else {
         console.log(chalk.green(`✓ Enabled "${name}" globally`))
      }
   } catch (err) {
      if (!options.json) {
         console.log(chalk.red(`Error enabling plugin globally: ${(err as Error).message}`))
      }
      process.exitCode = 1
   }
}

/**
 * Disable a plugin (remove symlinks or update project overrides)
 */
export async function disablePlugin(name: string, options: EnableDisableOptions = {}): Promise<void> {
   const useProjectOverrides = options.local === true
   const pluginsJson = await loadPluginsJson()

   // Check if plugin exists
   if (!pluginsJson.plugins[name]) {
      if (!options.json) {
         console.log(chalk.yellow(`Plugin "${name}" is not installed globally.`))
      }
      process.exitCode = 1
      return
   }

   if (useProjectOverrides) {
      const overrides = await loadProjectOverrides()

      // Check if already disabled for project
      if (overrides.disabled?.includes(name)) {
         if (!options.json) {
            console.log(chalk.yellow(`Plugin "${name}" is already disabled for this project.`))
         }
         process.exitCode = 1
         return
      }

      try {
         overrides.disabled = [...(overrides.disabled ?? []), name]
         await saveProjectOverrides(overrides)

         if (options.json) {
            console.log(JSON.stringify({ name, enabled: false }, null, 2))
         } else {
            console.log(chalk.green(`✓ Disabled "${name}" for this project`))
            console.log(chalk.dim('  Global install unchanged; project override added'))
            console.log(chalk.dim(`  Re-enable for this project with: omp enable -l ${name}`))
         }
      } catch (err) {
         if (!options.json) {
            console.log(chalk.red(`Error disabling plugin for project: ${(err as Error).message}`))
         }
         process.exitCode = 1
      }
      return
   }

   // Check if already disabled globally
   if (pluginsJson.disabled?.includes(name)) {
      if (!options.json) {
         console.log(chalk.yellow(`Plugin "${name}" is already disabled globally.`))
      }
      process.exitCode = 1
      return
   }

   try {
      // Read package.json
      const pkgJson = await readPluginPackageJson(name)
      if (!pkgJson) {
         if (!options.json) {
            console.log(chalk.red(`Could not read package.json for ${name}`))
         }
         process.exitCode = 1
         return
      }

      // Remove symlinks
      if (!options.json) {
         console.log(chalk.blue(`Disabling ${name} globally...`))
      }
      await removePluginSymlinks(name, pkgJson)

      // Add to disabled list
      if (!pluginsJson.disabled) {
         pluginsJson.disabled = []
      }
      pluginsJson.disabled.push(name)
      try {
         await savePluginsJson(pluginsJson)
      } catch (saveErr) {
         // Rollback: re-create symlinks since we removed them
         await createPluginSymlinks(name, pkgJson).catch(() => {})
         throw saveErr
      }

      if (options.json) {
         console.log(JSON.stringify({ name, enabled: false }, null, 2))
      } else {
         console.log(chalk.green(`✓ Disabled "${name}" globally`))
         console.log(chalk.dim('  Plugin is still installed globally, symlinks removed'))
         console.log(chalk.dim(`  Re-enable globally with: omp enable ${name}`))
      }
   } catch (err) {
      if (!options.json) {
         console.log(chalk.red(`Error disabling plugin globally: ${(err as Error).message}`))
      }
      process.exitCode = 1
   }
}
