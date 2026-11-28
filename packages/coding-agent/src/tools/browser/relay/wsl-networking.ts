import * as fs from "node:fs";
import { isWsl } from "@oh-my-pi/pi-utils";

let wslNetworkingMode: string | undefined;
let retryAfter = 0;

/** Report the running distro's mode, or "unknown" when it cannot be determined. */
export function getWslNetworkingMode(): string | undefined {
	if (!isWsl()) return undefined;
	if (wslNetworkingMode !== undefined) return wslNetworkingMode;
	if (performance.now() < retryAfter) return "unknown";

	wslNetworkingMode = detectWslNetworkingMode();
	if (wslNetworkingMode !== undefined) return wslNetworkingMode;
	// An unavailable mode must not trigger a new subprocess on every open.
	retryAfter = performance.now() + 5_000;
	return "unknown";
}

function detectWslNetworkingMode(): string | undefined {
	try {
		const { exitCode, stdout } = Bun.spawnSync(["/bin/wslinfo", "--networking-mode"], {
			stderr: "ignore",
			timeout: 500,
			killSignal: "SIGKILL",
			maxBuffer: 1024,
		});
		if (exitCode === 0) {
			const mode = stdout.toString().trim();
			if (mode) return mode;
		}
	} catch {}
	// A native WSL1 root filesystem can identify older distros without wslinfo.
	try {
		if (/^\S+ \/ (?:lxfs|wslfs) /m.test(fs.readFileSync("/proc/mounts", "utf8"))) return "wsl1";
	} catch {}
}
