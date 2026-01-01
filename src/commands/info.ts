import { npmInfo, requireNpm } from '@omp/npm'
import { log, outputJson, setJsonMode } from '@omp/output'
import { createProgress } from '@omp/progress'
import chalk from 'chalk'

export interface InfoOptions {
   json?: boolean
   versions?: boolean
   allVersions?: boolean
}

/**
 * Show detailed info about a package before install
 */
export async function showInfo(packageName: string, options: InfoOptions = {}): Promise<void> {
   requireNpm()

   if (options.json) {
      setJsonMode(true)
   }

   const progress = createProgress(`Fetching info for ${packageName}...`)

   try {
      const info = await npmInfo(packageName)

      if (!info) {
         progress.fail(`Package not found: ${packageName}`)
         process.exitCode = 1
         return
      }

      progress.succeed(`Found ${info.name}@${info.version}`)

      if (options.json) {
         outputJson(info)
         return
      }

      log()
      log(chalk.bold.green(info.name) + chalk.dim(` v${info.version}`))
      log()

      if (info.description) {
         log(chalk.white(info.description))
         log()
      }

      // Author
      if (info.author) {
         const authorStr =
            typeof info.author === 'string' ? info.author : `${info.author.name}${info.author.email ? ` <${info.author.email}>` : ''}`
         log(chalk.dim('author: ') + authorStr)
      }

      // Homepage
      if (info.homepage) {
         log(chalk.dim('homepage: ') + info.homepage)
      }

      // Repository
      if (info.repository) {
         const repoUrl = typeof info.repository === 'string' ? info.repository : info.repository.url
         log(chalk.dim('repo: ') + repoUrl)
      }

      // Keywords
      if (info.keywords?.length) {
         log(chalk.dim('keywords: ') + info.keywords.join(', '))
      }

      // Dependencies
      if (info.dependencies && Object.keys(info.dependencies).length > 0) {
         log(chalk.dim('\ndependencies:'))
         for (const [depName, depVersion] of Object.entries(info.dependencies)) {
            log(chalk.dim(`  ${depName}: ${depVersion}`))
         }
      }

      // Is it an omp plugin?
      const isOmpPlugin = info.keywords?.includes('omp-plugin')
      if (isOmpPlugin) {
         log(chalk.green('\n✓ This is an omp plugin'))
      } else {
         log(chalk.yellow('\n⚠ This package does not have the omp-plugin keyword'))
         log(chalk.dim('  It may work, but might not have omp.install configuration'))
      }

      // Show what files will be installed
      if (info.omp?.install?.length) {
         log(chalk.dim('\nFiles to install:'))
         for (const entry of info.omp.install) {
            log(chalk.dim(`  ${entry.src} → ${entry.dest}`))
         }
      }

      // Versions
      if (options.versions || options.allVersions) {
         if (info['dist-tags']) {
            log(chalk.dim('\ndist-tags:'))
            for (const [tag, version] of Object.entries(info['dist-tags'])) {
               log(chalk.dim(`  ${tag}: `) + version)
            }
         }

         if (info.versions?.length) {
            log(chalk.dim('\nall versions:'))
            if (options.allVersions) {
               // Show all versions
               log(chalk.dim(`  ${info.versions.join(', ')}`))
            } else {
               // Show last 10
               const versionsToShow = info.versions.slice(-10)
               log(chalk.dim(`  ${versionsToShow.join(', ')}`))
               if (info.versions.length > 10) {
                  log(chalk.dim(`  ... and ${info.versions.length - 10} more (use --all-versions to see all)`))
               }
            }
         }
      }

      log()
      log(chalk.dim(`Install with: omp install ${packageName}`))
   } catch (err) {
      log(chalk.red(`Error fetching info: ${(err as Error).message}`))
      process.exitCode = 1
   }
}
