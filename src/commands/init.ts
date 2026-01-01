import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import chalk from 'chalk'

// init always operates on CWD, using local paths intentionally
const PROJECT_PI_DIR = resolve('.pi')
const PROJECT_OVERRIDES_JSON = resolve('.pi', 'overrides.json')

/**
 * Format permission-related errors with actionable guidance
 */
function formatPermissionError(err: NodeJS.ErrnoException, path: string): string {
   if (err.code === 'EACCES' || err.code === 'EPERM') {
      return `Permission denied: Cannot write to ${path}. Check directory permissions or run with appropriate privileges.`
   }
   return err.message
}

export interface InitOptions {
   force?: boolean
}

/**
 * Initialize .pi/overrides.json in current project for project-level plugin overrides
 */
export async function initProject(options: InitOptions = {}): Promise<void> {
   try {
      // Create .pi directory
      await mkdir(PROJECT_PI_DIR, { recursive: true })

      // Create overrides.json
      const overridesJson = {
         disabled: [],
         config: {},
      }

      // Use 'wx' flag for atomic create-if-not-exists (unless --force)
      const writeFlag = options.force ? 'w' : 'wx'
      await writeFile(PROJECT_OVERRIDES_JSON, JSON.stringify(overridesJson, null, 2), { flag: writeFlag })

      console.log(chalk.green(`✓ Created ${PROJECT_OVERRIDES_JSON}`))
      console.log()
      console.log(chalk.dim('Next steps:'))
      console.log(chalk.dim('  1. Disable plugins with: omp disable <name> -l'))
      console.log(chalk.dim('  2. Configure features with: omp features <name> -l'))
   } catch (err) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'EEXIST') {
         console.log(chalk.yellow(`${PROJECT_OVERRIDES_JSON} already exists.`))
         console.log(chalk.dim('Use --force to overwrite'))
      } else if (error.code === 'EACCES' || error.code === 'EPERM') {
         console.log(chalk.red(formatPermissionError(error, PROJECT_PI_DIR)))
         console.log(chalk.dim('  Check directory permissions or run with appropriate privileges.'))
      } else {
         console.log(chalk.red(`Error initializing project: ${error.message}`))
      }
      process.exitCode = 1
   }
}
