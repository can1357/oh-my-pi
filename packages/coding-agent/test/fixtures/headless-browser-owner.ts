import { launchHeadlessBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

// Launches a process-local headless browser, reports where it listens, and dies by SIGKILL (no
// cleanup hook runs) once the parent writes a line to stdin.
const { wsEndpoint, userDataDir } = await launchHeadlessBrowser({ headless: true });
process.stdout.write(`${JSON.stringify({ wsEndpoint, userDataDir })}\n`);
for await (const _ of console) process.kill(process.pid, "SIGKILL");
