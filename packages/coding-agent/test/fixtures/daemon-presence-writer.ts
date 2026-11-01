// Registers daemon project presence the way an omp process on another platform
// does, prints one line once the entry is on disk, then waits to be killed.
// argv: <platform> <projectDir> <runtimeDir>
import { registerDaemonProjectPresence } from "../../src/launch/presence";

const [platform, projectDir, runtimeDir] = process.argv.slice(2);
Object.defineProperty(process, "platform", { value: platform });
await registerDaemonProjectPresence(projectDir, runtimeDir);
process.stdout.write("registered\n");
setInterval(() => {}, 60_000);
