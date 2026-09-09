import { $which } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";
import type { DoctorCheck } from "./types";

export async function runDoctorChecks(): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];

	// Check external tools
	const tools = [
		{ name: "sd", description: "Find-replace" },
		{ name: "sg", description: "AST-grep" },
		{ name: "git", description: "Version control" },
	];

	for (const tool of tools) {
		const path = $which(tool.name);
		checks.push({
			name: tool.name,
			status: path ? "ok" : "warning",
			message: path ? `Found at ${path}` : `${tool.description} not found - some features may be limited`,
		});
	}

	// Check API keys
	const apiKeys = [
		{ name: "ANTHROPIC_API_KEY", description: "Anthropic API" },
		{ name: "OPENAI_API_KEY", description: "OpenAI API" },
		{ name: "EXA_API_KEY", description: "Exa search" },
	];

	for (const key of apiKeys) {
		const hasKey = !!Bun.env[key.name];
		checks.push({
			name: key.name,
			status: hasKey ? "ok" : "warning",
			message: hasKey ? "Configured" : `Not set - ${key.description} unavailable`,
		});
	}

	return checks;
}

export function formatDoctorResults(checks: DoctorCheck[]): string {
	// Note: This function returns plain text without theming as it may be called outside TUI context.
	// For TUI usage, the plugin CLI handler applies theme colors.
	const lines: string[] = ["System Health Check", "=".repeat(40), ""];

	for (const check of checks) {
		const icon =
			check.status === "ok"
				? theme.status.enabled
				: check.status === "warning"
					? theme.status.warning
					: theme.status.error;
		lines.push(`${icon} ${check.name}: ${check.message}`);
	}

	const errors = checks.filter(c => c.status === "error").length;
	const warnings = checks.filter(c => c.status === "warning").length;

	lines.push("");
	lines.push(`Summary: ${checks.length - errors - warnings} ok, ${warnings} warnings, ${errors} errors`);

	return lines.join("\n");
}
