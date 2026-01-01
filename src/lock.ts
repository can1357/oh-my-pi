import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PI_CONFIG_DIR } from '@omp/paths'

const LOCK_TIMEOUT_MS = 60000 // 1 minute

function getLockPath(): string {
   return join(PI_CONFIG_DIR, '.lock')
}

function isProcessAlive(pid: number): boolean {
   try {
      process.kill(pid, 0) // Signal 0 = check existence
      return true
   } catch (err: unknown) {
      // ESRCH = no such process = definitely dead
      // EPERM = no permission to signal = process exists but owned by another user
      // Any other error = treat as alive (don't risk deleting active lock)
      if (err instanceof Error && 'code' in err && err.code === 'ESRCH') {
         return false
      }
      return true
   }
}

async function tryCleanStaleLock(lockPath: string): Promise<boolean> {
   let content: string
   try {
      content = await readFile(lockPath, 'utf-8')
   } catch (err: unknown) {
      // ENOENT = file doesn't exist = already cleaned
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
         return true
      }
      // Other read errors (permission, etc) = don't touch
      return false
   }

   let pid: number
   let timestamp: number
   try {
      const parsed = JSON.parse(content)
      pid = parsed.pid
      timestamp = parsed.timestamp
      // Validate required fields exist and are numbers
      if (typeof pid !== 'number' || typeof timestamp !== 'number') {
         return false
      }
   } catch {
      // JSON parse error = lock file being written or corrupted - don't touch
      return false
   }

   const isStale = Date.now() - timestamp > LOCK_TIMEOUT_MS
   const isDeadProcess = !isProcessAlive(pid)

   if (isStale || isDeadProcess) {
      try {
         await rm(lockPath, { force: true })
         return true
      } catch {
         // Failed to remove = don't claim we cleaned it
         return false
      }
   }
   return false
}

export async function acquireLock(): Promise<boolean> {
   const lockPath = getLockPath()

   try {
      await mkdir(dirname(lockPath), { recursive: true })

      const lockContent = JSON.stringify({ pid: process.pid, timestamp: Date.now() })

      // Atomic exclusive creation - fails if file already exists
      await writeFile(lockPath, lockContent, { flag: 'wx' })
      return true
   } catch (err: unknown) {
      // EEXIST means file already exists - check if it's stale
      if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
         const cleaned = await tryCleanStaleLock(lockPath)
         if (cleaned) {
            // Retry atomic creation after cleaning stale lock
            try {
               const lockContent = JSON.stringify({ pid: process.pid, timestamp: Date.now() })
               await writeFile(lockPath, lockContent, { flag: 'wx' })
               return true
            } catch {
               return false
            }
         }
      }
      return false
   }
}

export async function releaseLock(): Promise<void> {
   const lockPath = getLockPath()

   // NOTE: TOCTOU race exists between reading lock, checking PID, and rm().
   // Another process could acquire the lock between our check and removal.
   // Proper fix requires file locking primitives (flock) not worth the complexity.
   try {
      // Validate PID ownership before releasing
      const content = await readFile(lockPath, 'utf-8')
      const { pid } = JSON.parse(content)

      if (pid !== process.pid) {
         // Lock is owned by another process - do not release
         return
      }

      await rm(lockPath, { force: true })
   } catch {
      // Lock file doesn't exist or is malformed - nothing to release
   }
}
