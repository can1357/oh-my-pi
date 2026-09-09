/**
 * System information collection for debug reports.
 */

import * as os from "node:os";
import { formatBytes, getProjectDir, VERSION } from "@oh-my-pi/pi-utils";

export interface SystemInfo {
	os: string;
	arch: string;
	cpu: string;
	memory: {
		total: number;
		free: number;
	};
	versions: {
		app: string;
		bun: string;
		node: string;
	};
	cwd: string;
	shell: string;
	terminal: string | undefined;
}

/** Map Darwin kernel major version to macOS marketing name. */
function macosMarketingName(release: string): string | undefined {
	const major = Number.parseInt(release.split(".")[0] ?? "", 10);
	if (Number.isNaN(major)) return undefined;
	const names: Record<number, string> = {
		25: "Tahoe",
		24: "Sequoia",
		23: "Sonoma",
		22: "Ventura",
		21: "Monterey",
		20: "Big Sur",
	};
	return names[major];
}

/** Collect system information */
export async function collectSystemInfo(): Promise<SystemInfo> {
	let cpuModel = "Unknown CPU";
	try {
		cpuModel = os.cpus()[0]?.model ?? cpuModel;
	} catch {
		// Keep debug report collection best-effort when CPU probing fails.
	}

	// Try to get shell from environment
	const shell = Bun.env.SHELL ?? Bun.env.ComSpec ?? "unknown";
	const terminal = Bun.env.TERM_PROGRAM ?? Bun.env.TERM ?? undefined;

	let osStr = `${os.type()} ${os.release()} (${os.platform()})`;
	if (os.platform() === "darwin") {
		const name = macosMarketingName(os.release());
		if (name) osStr = `${osStr} ${name}`;
	}

	return {
		os: osStr,
		arch: os.arch(),
		cpu: cpuModel,
		memory: {
			total: os.totalmem(),
			free: os.freemem(),
		},
		versions: {
			app: VERSION,
			bun: Bun.version,
			node: process.version,
		},
		cwd: getProjectDir(),
		shell,
		terminal,
	};
}

/** Format system info for display */
export function formatSystemInfo(info: SystemInfo): string {
	const lines = [
		"System Information",
		"━━━━━━━━━━━━━━━━━━",
		`OS:      ${info.os}`,
		`Arch:    ${info.arch}`,
		`CPU:     ${info.cpu}`,
		`Memory:  ${formatBytes(info.memory.total)} (${formatBytes(info.memory.free)} free)`,
		`Bun:     ${info.versions.bun}`,
		`App:     omp ${info.versions.app}`,
		`Node:    ${info.versions.node} (compat)`,
		`CWD:     ${info.cwd}`,
		`Shell:   ${info.shell}`,
	];
	if (info.terminal) {
		lines.push(`Terminal: ${info.terminal}`);
	}
	return lines.join("\n");
}

/** Sanitize environment variables by redacting sensitive values */
export function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
	const SENSITIVE_PATTERNS = [/key/i, /secret/i, /token/i, /pass/i, /auth/i, /credential/i, /api/i, /private/i];

	const result: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) continue;
		const isSensitive = SENSITIVE_PATTERNS.some(p => p.test(k));
		result[k] = isSensitive ? "[REDACTED]" : v;
	}
	return result;
}
