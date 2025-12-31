import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PI_CONFIG_DIR, PROJECT_PI_DIR } from "@omp/paths";

const LOCK_TIMEOUT_MS = 60000; // 1 minute

export async function acquireLock(global = true): Promise<boolean> {
   const lockPath = global ? join(PI_CONFIG_DIR, ".lock") : join(PROJECT_PI_DIR, ".lock");

   try {
      await mkdir(dirname(lockPath), { recursive: true });

      // Check for existing lock
      if (existsSync(lockPath)) {
         const content = await readFile(lockPath, "utf-8");
         const { pid, timestamp } = JSON.parse(content);

         // Check if stale (older than timeout)
         if (Date.now() - timestamp > LOCK_TIMEOUT_MS) {
            // Stale lock, remove it
            await rm(lockPath, { force: true });
         } else {
            // Check if process is still alive
            try {
               process.kill(pid, 0); // Signal 0 = check existence
               return false; // Process alive, can't acquire
            } catch {
               // Process dead, remove stale lock
               await rm(lockPath, { force: true });
            }
         }
      }

      // Create lock
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
      return true;
   } catch {
      return false;
   }
}

export async function releaseLock(global = true): Promise<void> {
   const lockPath = global ? join(PI_CONFIG_DIR, ".lock") : join(PROJECT_PI_DIR, ".lock");
   await rm(lockPath, { force: true });
}
