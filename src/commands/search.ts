import { npmSearch, requireNpm } from '@omp/npm'
import { log, outputJson, sanitize, setJsonMode, truncate } from '@omp/output'
import { createProgress } from '@omp/progress'
import chalk from 'chalk'

export interface SearchOptions {
   json?: boolean
   limit?: number
}

/**
 * Search npm for plugins with omp-plugin keyword
 */
export async function searchPlugins(query: string, options: SearchOptions = {}): Promise<void> {
   requireNpm()

   if (options.json) {
      setJsonMode(true)
   }

   const progress = createProgress(`Searching npm for "${query}"...`)

   try {
      const results = await npmSearch(query, 'omp-plugin')
      progress.succeed(`Search complete`)

      if (results.length === 0) {
         log(chalk.yellow('\nNo plugins found.'))
         log(chalk.dim('Try a different search term, or search without keyword:'))
         log(chalk.dim('  npm search omp-plugin'))
         process.exitCode = 1
         return
      }

      const limit = options.limit ?? 20
      const displayResults = results.slice(0, limit)

      if (options.json) {
         outputJson({ results: displayResults })
         return
      }

      log(chalk.bold(`\nFound ${results.length} plugin(s):\n`))

      for (const result of displayResults) {
         // Sanitize all npm metadata to prevent escape injection
         const name = sanitize(result.name)
         const version = sanitize(result.version)
         log(chalk.green('◆ ') + chalk.bold(name) + chalk.dim(` v${version}`))

         if (result.description) {
            const desc = truncate(sanitize(result.description), 100)
            log(chalk.dim(`    ${desc}`))
         }

         if (result.keywords?.length) {
            const otherKeywords = result.keywords.filter(k => k !== 'omp-plugin').map(sanitize)
            if (otherKeywords.length > 0) {
               log(chalk.dim(`    tags: ${otherKeywords.join(', ')}`))
            }
         }

         log()
      }

      if (results.length > limit) {
         log(chalk.dim(`... and ${results.length - limit} more. Use --limit to see more.`))
      }

      log(chalk.dim('Install with: omp install <package-name>'))
   } catch (err) {
      const error = err as Error
      if (error.message.includes('ENOTFOUND') || error.message.includes('ETIMEDOUT') || error.message.includes('EAI_AGAIN')) {
         log(chalk.red('\nNetwork error: Unable to reach npm registry.'))
         log(chalk.dim('  Check your internet connection and try again.'))
      } else {
         log(chalk.red(`\nSearch failed: ${error.message}`))
      }
      process.exitCode = 1
   }
}
