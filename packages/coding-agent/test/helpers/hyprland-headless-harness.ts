/**
 * Focus-safe GUI harness for computer.decide() e2e tests.
 *
 * Default tier is rootless Xvfb (Tier 1) — GTK never touches the host
 * compositor. Optional Hyprland headless output (Tier 2) is opt-in for grim
 * capture tests only.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";

export const GUI_E2E_SCRIPT =
	process.env.GUI_E2E_SCRIPT ?? "/workspace/.files/scripts/gui-e2e-display.sh";
export const E2E_OUTPUT = process.env.GUI_E2E_OUTPUT ?? "HERMES_UI_TEST";
export const E2E_WORKSPACE = Number(process.env.GUI_E2E_WORKSPACE ?? "99");
export const PROTECTED_WORKSPACES = new Set([1, 2, 8]);

export type GuiE2eTier = "xvfb" | "hypr-headless";

const GTK_FIXTURE = path.join(import.meta.dir, "../fixtures/omp-e2e-gtk-app.py");
const E2E_APP_ID = "hermes.e2e.decide";

export interface HyprlandFocusSnapshot {
	focusedPhysicalMonitor: string | null;
	physicalMonitorWorkspaces: Record<string, number | string>;
}

export interface GuiE2eLease {
	lease_id: string;
	tier: GuiE2eTier;
	display?: string;
	output?: string;
	window_class?: string;
}

function canRunGuiE2e(): boolean {
	if (process.platform !== "linux") return false;
	if (!fs.existsSync(GUI_E2E_SCRIPT)) return false;
	if (!fs.existsSync(GTK_FIXTURE)) return false;
	try {
		const probe = Bun.spawnSync(["bash", GUI_E2E_SCRIPT, "--dry-run", "--tier", "xvfb", "start"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return probe.exitCode === 0;
	} catch {
		return false;
	}
}

/** Opt-in only — never auto-run GUI e2e on a shared desktop. */
export const SHOULD_RUN_COMPUTER_E2E =
	process.env.PI_COMPUTER_E2E === "1" || process.env.PI_HYPRLAND_E2E === "1";

/** @deprecated use SHOULD_RUN_COMPUTER_E2E */
export const SHOULD_RUN_HYPRLAND_E2E = SHOULD_RUN_COMPUTER_E2E;

/** Grim capture on Hyprland headless output — separate opt-in. */
export const SHOULD_RUN_HYPRLAND_GRIM_E2E =
	SHOULD_RUN_COMPUTER_E2E &&
	process.env.PI_HYPRLAND_GRIM_E2E === "1" &&
	canRunHyprHeadlessE2e();

function canRunHyprHeadlessE2e(): boolean {
	if (!canRunGuiE2e()) return false;
	try {
		const probe = Bun.spawnSync(["hyprctl", "-j", "monitors"], { stdout: "pipe", stderr: "pipe" });
		return probe.exitCode === 0 && probe.stdout.length > 2;
	} catch {
		return false;
	}
}

function resolveTier(): GuiE2eTier {
	const requested = process.env.GUI_E2E_TIER;
	if (requested === "hypr-headless") return "hypr-headless";
	return "xvfb";
}

function runScript(args: string[]): { exitCode: number; stdout: string; stderr: string } {
	const proc = Bun.spawnSync(["bash", GUI_E2E_SCRIPT, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GUI_E2E_LEASE_DIR: process.env.GUI_E2E_LEASE_DIR ?? `${os.tmpdir()}/omp-computer-decide-e2e`,
		},
	});
	return {
		exitCode: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

function readLease(leaseId: string): GuiE2eLease {
	const result = runScript(["--lease-id", leaseId, "status"]);
	if (result.exitCode !== 0) {
		throw new Error(`gui-e2e status failed: ${result.stderr || result.stdout}`);
	}
	return JSON.parse(result.stdout) as GuiE2eLease;
}

function hyprJson<T>(args: string[]): T {
	const proc = Bun.spawnSync(["hyprctl", ...args], { stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) {
		throw new Error(`hyprctl ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	}
	return JSON.parse(proc.stdout.toString()) as T;
}

export function snapshotHyprlandFocus(): HyprlandFocusSnapshot {
	type Monitor = {
		name: string;
		focused?: boolean;
		activeWorkspace?: { id?: number; name?: string };
	};

	const monitors = hyprJson<Monitor[]>(["-j", "monitors"]);
	const focusedPhysicalMonitor =
		monitors.find(m => m.focused && m.name !== E2E_OUTPUT)?.name ??
		monitors.find(m => m.name !== E2E_OUTPUT)?.name ??
		null;

	const physicalMonitorWorkspaces: Record<string, number | string> = {};
	for (const monitor of monitors) {
		if (monitor.name === E2E_OUTPUT) continue;
		const ws = monitor.activeWorkspace?.id ?? monitor.activeWorkspace?.name;
		if (ws !== undefined) physicalMonitorWorkspaces[monitor.name] = ws;
	}

	return { focusedPhysicalMonitor, physicalMonitorWorkspaces };
}

export function assertFocusUnchanged(before: HyprlandFocusSnapshot, after: HyprlandFocusSnapshot): void {
	if (before.focusedPhysicalMonitor !== after.focusedPhysicalMonitor) {
		throw new Error(
			`focused physical monitor changed: ${before.focusedPhysicalMonitor} -> ${after.focusedPhysicalMonitor}`,
		);
	}
	for (const [monitor, wsBefore] of Object.entries(before.physicalMonitorWorkspaces)) {
		const wsAfter = after.physicalMonitorWorkspaces[monitor];
		if (String(wsBefore) !== String(wsAfter)) {
			throw new Error(`physical monitor ${monitor} workspace changed: ${wsBefore} -> ${wsAfter}`);
		}
	}
}

function countHyprClients(): number {
	type Client = { class?: string; title?: string };
	const clients = hyprJson<Client[]>(["-j", "clients"]);
	return clients.length;
}

function assertNoHostPopupLeak(beforeClientCount: number): void {
	const after = countHyprClients();
	if (after > beforeClientCount) {
		type Client = { class?: string; title?: string; workspace?: { name?: string } };
		const clients = hyprJson<Client[]>(["-j", "clients"]);
		const leaked = clients.filter(c => /OMP E2E|HermesE2E|hermes\.e2e/i.test(`${c.class ?? ""} ${c.title ?? ""}`));
		if (leaked.length > 0) {
			throw new Error(
				`e2e window leaked onto host compositor: ${leaked.map(c => `${c.class}@${c.workspace?.name}`).join(", ")}`,
			);
		}
	}
}

/** @deprecated alias — prefer GuiE2eHarness */
export class HyprlandHeadlessHarness extends GuiE2eHarness {}

export class GuiE2eHarness {
	readonly runId: string;
	readonly windowClass: string;
	readonly leaseId: string;
	readonly tier: GuiE2eTier;
	private started = false;
	private display: string | null = null;
	private hostClientCountBefore = 0;
	private gtkPid: number | null = null;
	private savedDisplay: string | undefined;
	private savedGdkBackend: string | undefined;
	beforeFocus: HyprlandFocusSnapshot | null = null;

	constructor(runId = Snowflake.next(), tier: GuiE2eTier = resolveTier()) {
		this.runId = runId;
		this.tier = tier;
		this.windowClass = E2E_APP_ID;
		this.leaseId = runId;
	}

	start(): void {
		if (this.started) return;
		if (this.tier === "hypr-headless" && PROTECTED_WORKSPACES.has(E2E_WORKSPACE)) {
			throw new Error(`refusing protected e2e workspace ${E2E_WORKSPACE}`);
		}
		this.beforeFocus = snapshotHyprlandFocus();
		this.hostClientCountBefore = countHyprClients();

		const args = [
			"--tier",
			this.tier,
			"--workspace",
			String(E2E_WORKSPACE),
			"--class",
			this.windowClass,
			"--lease-id",
			this.leaseId,
			"start",
		];
		if (this.tier === "hypr-headless") {
			args.splice(args.length - 1, 0, "--output", E2E_OUTPUT);
		}

		const result = runScript(args);
		if (result.exitCode !== 0) {
			throw new Error(`gui-e2e start failed: ${result.stderr || result.stdout}`);
		}

		const lease = readLease(this.leaseId);
		this.display = lease.display ?? null;
		if (this.tier === "xvfb" && !this.display) {
			throw new Error("xvfb lease missing DISPLAY");
		}
		if (this.tier === "xvfb" && this.display) {
			this.savedDisplay = process.env.DISPLAY;
			this.savedGdkBackend = process.env.GDK_BACKEND;
			process.env.DISPLAY = this.display;
			process.env.GDK_BACKEND = "x11";
		}
		this.started = true;
	}

	stop(): void {
		if (!this.started) return;
		if (this.gtkPid !== null) {
			try {
				process.kill(this.gtkPid, "SIGTERM");
			} catch {
				// already exited
			}
			this.gtkPid = null;
		}
		Bun.spawnSync(["pkill", "-f", "omp-e2e-gtk-app.py"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		runScript(["--lease-id", this.leaseId, "stop"]);
		if (this.tier === "xvfb") {
			if (this.savedDisplay === undefined) delete process.env.DISPLAY;
			else process.env.DISPLAY = this.savedDisplay;
			if (this.savedGdkBackend === undefined) delete process.env.GDK_BACKEND;
			else process.env.GDK_BACKEND = this.savedGdkBackend;
		}
		this.started = false;
	}

	launchGtkFixture(buttonLabels = "Save,Cancel"): void {
		if (!this.started) this.start();
		if (!fs.existsSync(GTK_FIXTURE)) {
			throw new Error(`missing GTK fixture: ${GTK_FIXTURE}`);
		}

		const launchEnv =
			this.tier === "xvfb"
				? { ...process.env, DISPLAY: this.display!, GDK_BACKEND: "x11" }
				: { ...process.env, GDK_BACKEND: "wayland" };
		const proc = Bun.spawn(["python3", GTK_FIXTURE, buttonLabels], {
			env: launchEnv,
			stdout: "ignore",
			stderr: "pipe",
		});
		this.gtkPid = proc.pid;
		if (this.tier === "xvfb") {
			assertNoHostPopupLeak(this.hostClientCountBefore);
		}
	}

	async waitForGtkWindow(timeoutMs = 15000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const { createDesktopSession } = await import("@oh-my-pi/pi-natives/desktop");
			const session = createDesktopSession({ display: "all" });
			try {
				const wins = await session.listWindows();
				if (wins.some(w => /OMP E2E Decide/i.test(String(w.title)))) return;
			} finally {
				await session.close();
			}
			await Bun.sleep(250);
		}
		throw new Error("timed out waiting for OMP E2E GTK window in AT-SPI");
	}

	async queryButtons(): Promise<Array<{ ref: string; role: string; title?: string }>> {
		const { createDesktopSession } = await import("@oh-my-pi/pi-natives/desktop");
		const session = createDesktopSession({ display: "all" });
		try {
			const target = (await session.listWindows()).find(w => /OMP E2E Decide/i.test(String(w.title)));
			if (!target) throw new Error("GTK fixture window not found in AT-SPI");
			const nodes = await session.axQuery(target.id, { role: "button" });
			return nodes.map(node => ({ ref: node.ref, role: node.role, title: node.title }));
		} finally {
			await session.close();
		}
	}

	captureHeadlessPng(destination: string): void {
		if (this.tier !== "hypr-headless") {
			throw new Error("grim capture requires hypr-headless tier");
		}
		const proc = Bun.spawnSync(["grim", "-o", E2E_OUTPUT, destination], { stdout: "pipe", stderr: "pipe" });
		if (proc.exitCode !== 0) {
			throw new Error(`grim failed: ${proc.stderr.toString()}`);
		}
	}

	assertClientOnHeadlessOutput(): void {
		if (this.tier !== "hypr-headless") {
			assertNoHostPopupLeak(this.hostClientCountBefore);
			return;
		}
		type Client = { class?: string; workspace?: { name?: string } };
		const clients = hyprJson<Client[]>(["-j", "clients"]);
		const match = clients.find(c => c.class === E2E_APP_ID);
		if (!match) throw new Error(`no harness client for class ${E2E_APP_ID}`);
		if (String(match.workspace?.name) !== String(E2E_WORKSPACE)) {
			throw new Error(`client mapped to ws ${match.workspace?.name}, expected ${E2E_WORKSPACE}`);
		}
	}

	assertIsolationHeld(): void {
		if (!this.beforeFocus) throw new Error("missing before focus snapshot");
		assertFocusUnchanged(this.beforeFocus, snapshotHyprlandFocus());
		assertNoHostPopupLeak(this.hostClientCountBefore);
	}
}
