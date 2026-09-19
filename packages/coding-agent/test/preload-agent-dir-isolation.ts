/**
 * Bun test preload: point the agent directory resolver at a throwaway
 * per-run agent dir so no test file can read or pollute the real
 * ~/.omp/agent (session files included). Suites that need a specific
 * directory call setAgentDir themselves and restore with
 * __resetDirsFromEnvForTests(); their env snapshots captured after this
 * preload restore back to this isolated dir.
 *
 * Spawned child processes inherit PI_CODING_AGENT_DIR from the environment
 * setAgentDir installs, so CLI-boot tests stay isolated too.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setAgentDir } from "@oh-my-pi/pi-utils";

setAgentDir(fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-agent-dir-")));
