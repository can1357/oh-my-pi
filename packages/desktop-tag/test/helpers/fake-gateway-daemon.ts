/**
 * Tiny fake gateway used to drive `src/capture/daemon.ts` through its real
 * lifecycle. Mirrors the lock protocol of the actual gateway: it writes its own
 * pid to the pid file once "ready" (after a short delay so the controller can
 * observe the not-ready window), then stays alive until SIGTERM.
 *
 * Usage:  bun fake-gateway-daemon.ts <pidFile> [--exit-early]
 *
 * With --exit-early it prints a recognizable marker to stderr and exits 7
 * WITHOUT writing the pid file, simulating a gateway that dies during startup.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const pidFile = process.argv[2];
const exitEarly = process.argv.includes("--exit-early");

if (exitEarly) {
	// Direct fd write so the bytes survive the immediate process.exit(7).
	fs.writeSync(2, "fake gateway boom\n");
	process.exit(7);
}

// Echo the effective idle-exit env so tests can observe the controller's injection.
console.log(`CAPTURE_IDLE_EXIT_MS=${Bun.env.CAPTURE_IDLE_EXIT_MS ?? "<unset>"}`);

process.on("SIGTERM", () => {
	// Ignored on Windows (hard kill), authoritative cleanup there is the
	// controller removing the pid file after the process dies.
	try {
		const raw = fs.readFileSync(pidFile, "utf8").trim();
		let filePid: number | undefined;
		if (raw.startsWith("{")) {
			filePid = JSON.parse(raw).pid;
		} else {
			filePid = Number(raw);
		}
		if (filePid === process.pid) fs.unlinkSync(pidFile);
	} catch {
		// already gone
	}
	process.exit(0);
});

// Delay to let the controller observe the pre-ready poll window.
setTimeout(() => {
	fs.mkdirSync(path.dirname(pidFile), { recursive: true });
	const payload = {
		pid: process.pid,
		gatewayId: "fake-gateway-id",
		createdAt: Date.now(),
	};
	fs.writeFileSync(pidFile, JSON.stringify(payload));
}, 100);

setInterval(() => {}, 1 << 30);
