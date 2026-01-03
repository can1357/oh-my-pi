import type { DoctorCheck } from "./types";

export async function runDoctorChecks(): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];

	// Check external tools
	const tools = [
		{ name: "fd", description: "File finder" },
		{ name: "rg", description: "Ripgrep" },
		{ name: "sd", description: "Find-replace" },
		{ name: "sg", description: "AST-grep" },
		{ name: "git", description: "Version control" },
	];

	for (const tool of tools) {
		const path = Bun.which(tool.name);
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
		{ name: "PERPLEXITY_API_KEY", description: "Perplexity search" },
		{ name: "EXA_API_KEY", description: "Exa search" },
	];

	for (const key of apiKeys) {
		const hasKey = !!process.env[key.name];
		checks.push({
			name: key.name,
			status: hasKey ? "ok" : "warning",
			message: hasKey ? "Configured" : `Not set - ${key.description} unavailable`,
		});
	}

	return checks;
}

export function formatDoctorResults(checks: DoctorCheck[]): string {
	const lines: string[] = ["System Health Check", "=".repeat(40), ""];

	for (const check of checks) {
		const icon = check.status === "ok" ? "✓" : check.status === "warning" ? "!" : "✗";
		lines.push(`${icon} ${check.name}: ${check.message}`);
	}

	const errors = checks.filter((c) => c.status === "error").length;
	const warnings = checks.filter((c) => c.status === "warning").length;

	lines.push("");
	lines.push(`Summary: ${checks.length - errors - warnings} ok, ${warnings} warnings, ${errors} errors`);

	return lines.join("\n");
}
