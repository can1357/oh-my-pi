// Process fixture — real timers are required (ts-no-test-timers exception): the
// launcher boots a real broker-spawned owner over a real PTY and waits for its
// on-disk publication. Awaited signals are file markers and socket frames,
// never fixed delays.
import * as fs from "node:fs";
import * as path from "node:path";
import { probeSessionAttach } from "../../src/launch/session-attach";
import { type BrokeredOwner, bootBrokeredOwner } from "../../src/launch/session-boot";

interface LauncherConfig {
	readonly projectDir: string;
	readonly endpointDir: string;
	readonly runtimeDir: string;
	readonly argv: string[];
	readonly expectedSessionId?: string;
	readonly reportFile: string;
	readonly stopFile: string;
}

interface LauncherReport {
	error?: string;
	name?: string;
	id?: string;
	pid?: number;
	sessionId?: string;
	endpointDir?: string;
	probe?: string;
}

const [configFile] = process.argv.slice(2);
if (!configFile) throw new Error("usage: session-boot-rundir-launcher <configFile>");
const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as LauncherConfig;

const report: LauncherReport = {};
let owner: BrokeredOwner | undefined;
try {
	owner = await bootBrokeredOwner({
		projectDir: config.projectDir,
		endpointDir: config.endpointDir,
		argv: config.argv,
		timeoutMs: 45_000,
		...(config.expectedSessionId === undefined ? {} : { expectedSessionId: config.expectedSessionId }),
	});
	const probe = await probeSessionAttach(owner.sessionId, { endpointDir: owner.endpointDir, timeoutMs: 5_000 });
	report.name = owner.name;
	report.id = owner.daemon.id;
	report.pid = owner.daemon.pid;
	report.sessionId = owner.sessionId;
	report.endpointDir = owner.endpointDir;
	report.probe = probe.status;
} catch (error) {
	report.error = error instanceof Error ? error.message : String(error);
	process.exitCode = 1;
}
fs.writeFileSync(config.reportFile, JSON.stringify(report));

while (!fs.existsSync(config.stopFile)) await Bun.sleep(20);

if (owner !== undefined) {
	await owner.client.request({ op: "stop", name: owner.name, id: owner.daemon.id, timeoutMs: 5_000 }).catch(() => {});
	await owner.client.request({ op: "shutdown" }).catch(() => {});
	owner.client.close();
}

const pids = new Set<number>();
if (report.pid !== undefined) pids.add(report.pid);
const brokerPid = Number(
	(
		await Bun.file(path.join(config.runtimeDir, "broker.pid"))
			.text()
			.catch(() => "")
	).trim(),
);
if (Number.isInteger(brokerPid) && brokerPid > 0) pids.add(brokerPid);
for (const pid of pids) {
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
}
const deadline = Date.now() + 5_000;
while (Date.now() < deadline) {
	const alive = [...pids].some(pid => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	});
	if (!alive) break;
	await Bun.sleep(25);
}
for (const pid of pids) {
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
}
