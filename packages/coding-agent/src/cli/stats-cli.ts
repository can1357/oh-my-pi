/**
 * Stats CLI command handlers.
 *
 * Handles `omp stats` subcommand for viewing AI usage statistics.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import { formatDuration, formatNumber, formatPercent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { openPath } from "../utils/open";

/**
 * Single-line TTY progress bar. On a non-TTY stream we just stay quiet -
 * the final "Synced ..." summary still prints either way.
 */
function createSyncProgressReporter(): {
	onProgress: (event: { current: number; total: number; sessionFile: string }) => void;
	finish: () => void;
} {
	const stream = process.stderr;
	const isTty = stream.isTTY === true;
	let lastWidth = 0;
	let lastRender = 0;
	return {
		onProgress(event) {
			if (!isTty) return;
			const now = Date.now();
			// Throttle to ~30 fps and always force a render for the last file.
			if (event.current < event.total && now - lastRender < 33) return;
			lastRender = now;
			const label = chalk.dim(shortenSessionFile(event.sessionFile));
			const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
			const counter = chalk.cyan(`[${event.current}/${event.total}]`);
			const line = `${counter} ${pct}%  ${label}`;
			const columns = stream.columns ?? 120;
			const trimmed = truncateToWidth(line, columns - 1);
			stream.write(`\r${trimmed.padEnd(lastWidth)}`);
			lastWidth = trimmed.length;
		},
		finish() {
			if (!isTty || lastWidth === 0) return;
			stream.write(`\r${" ".repeat(lastWidth)}\r`);
			lastWidth = 0;
		},
	};
}

function shortenSessionFile(p: string): string {
	const marker = "/sessions/";
	const idx = p.indexOf(marker);
	return idx >= 0 ? p.slice(idx + marker.length) : p;
}

// =============================================================================
// Types
// =============================================================================

export interface StatsCommandArgs {
	port: number;
	host: string;
	json: boolean;
	summary: boolean;
	action?: string;
	name?: string;
}

function formatCost(n: number): string {
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

function normalizePremiumRequests(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Scaffold a blank starter site for the OMP Stats v1 API.
 * Creates a minimal package.json, index.ts, and README.md in the target directory.
 */
async function createSite(name: string): Promise<void> {
	// Validate: must be a simple relative name, no path traversal
	if (!name || name === '.' || name === '..' || path.isAbsolute(name) || name.includes('..')) {
		console.error(chalk.red('Invalid site name. Use a simple directory name (e.g. "my-dashboard").'));
		process.exit(1);
	}

	const targetDir = path.resolve(process.cwd(), name);

	// Fail if target already exists
	try {
		await fs.access(targetDir);
		console.error(chalk.red(`Directory already exists: ${targetDir}`));
		console.error(chalk.dim('Remove it first or choose a different name.'));
		process.exit(1);
	} catch {
		// ENOENT — proceed
	}

	await fs.mkdir(path.join(targetDir, 'src'), { recursive: true });

	// package.json
	const packageJson = {
		name,
		version: '0.1.0',
		private: true,
		type: 'module',
		scripts: {
			dev: 'bun run src/server.ts',
		},
		dependencies: {
			'@oh-my-pi/omp-stats': 'latest',
		},
	};
	await fs.writeFile(path.join(targetDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');

	// Dev server: serves static files, proxies /api/* to stats server.
	const serverCode = [
		'import * as http from "node:http";',
		'import * as fs from "node:fs";',
		'import * as path from "node:path";',
		'',
		'const PORT = 3000;',
		'const STATS_URL = "http://127.0.0.1:3847";',
		'',
		'const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };',
		'',
		'const server = http.createServer(async (req, res) => {',
		'	const url = new URL(req.url ?? "/", "http://localhost:" + PORT);',
		'',
		'	if (url.pathname.startsWith("/api/")) {',
		'		const upstream = new URL(url.pathname + url.search, STATS_URL);',
		'		const resp = await fetch(upstream, { method: req.method });',
		'		resp.headers.forEach((v, k) => res.setHeader(k, v));',
		'		res.writeHead(resp.status);',
		'		res.end(await resp.arrayBuffer());',
		'		return;',
		'	}',
		'',
		'	const filePath = url.pathname === "/" ? "./index.html" : "." + url.pathname;',
		'	try {',
		'		const content = fs.readFileSync(path.resolve(filePath));',
		'		const ext = path.extname(filePath);',
		'		res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });',
		'		res.end(content);',
		'	} catch {',
		'		res.writeHead(404);',
		'		res.end("Not Found");',
		'	}',
		'});',
		'',
		'server.listen(PORT, "127.0.0.1", () => {',
		'	console.log("Dev server: http://127.0.0.1:" + PORT);',
		'});',
		'',
	].join('\n');
	await fs.writeFile(path.join(targetDir, 'src', 'server.ts'), serverCode);

	// index.html — neutral unbranded page, fetches and renders one metric
	const indexHtml = [
		'<!DOCTYPE html>',
		'<html lang="en">',
		'<head>',
		'  <meta charset="UTF-8">',
		'  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
		`  <title>${name}</title>`,
		'</head>',
		'<body>',
		'  <h1 id="title"></h1>',
		'  <p id="value"></p>',
		'  <script>',
		'    (async function () {',
		'      var res = await fetch("/api/v1/overview?range=7d");',
		'      if (!res.ok) throw new Error("API " + res.status);',
		'      var data = await res.json();',
		'      document.getElementById("title").textContent = "Total requests in 7d";',
		'      document.getElementById("value").textContent = data.overall.totalRequests;',
		'    })().catch(function (err) {',
		'      document.getElementById("value").textContent = "Error: " + err.message;',
		'    });',
		'  </script>',
		'</body>',
		'</html>',
		'',
	].join('\n');
	await fs.writeFile(path.join(targetDir, 'index.html'), indexHtml);

	const readme = `# ${name}

A custom OMP Stats frontend using the v1 API.

## Quick Start

\`\`\`bash
bun install
bun run dev
\`\`\`

The dev server runs on port 3000 and proxies \`/api/*\` to the
OMP Stats server on port 3847.

## API

See \`@oh-my-pi/omp-stats/client-sdk\` for the typed SDK, or
fetch \`/api/v1/overview\`, \`/api/v1/models\`, etc. directly.
`;
	await fs.writeFile(path.join(targetDir, 'README.md'), readme);

	console.log(chalk.green(`Created site: ${targetDir}`));
	console.log(chalk.dim('  package.json'));
	console.log(chalk.dim('  index.html'));
	console.log(chalk.dim('  src/server.ts'));
	console.log(chalk.dim('  README.md'));
	console.log();
	console.log(`  cd ${name} && bun install && bun run dev`);
}



// =============================================================================
// Command Handler
// =============================================================================

export async function runStatsCommand(cmd: StatsCommandArgs): Promise<void> {
	// Lazy import to avoid loading stats module when not needed
	const { closeDb, formatStatsDashboardUrl, getDashboardStats, getTotalMessageCount, startServer, syncAllSessions } =
		await import("@oh-my-pi/omp-stats");


	// Handle create-site action before syncing (no DB needed)
	if (cmd.action === "create-site") {
		const name = cmd.name?.trim();
		if (!name) {
			console.error(chalk.red("Site name is required. Usage: omp stats create-site <name>"));
			process.exit(1);
		}
		await createSite(name);
		return;
	}

	// Sync session files first
	const progress = createSyncProgressReporter();
	process.stderr.write("Syncing session files...\n");
	const { processed, files } = await syncAllSessions({ onProgress: progress.onProgress });
	progress.finish();
	const total = await getTotalMessageCount();
	console.log(`Synced ${processed} new entries from ${files} files (${total} total)\n`);

	if (cmd.json) {
		const stats = await getDashboardStats();
		console.log(JSON.stringify(stats, null, 2));
		return;
	}

	if (cmd.summary) {
		await printStatsSummary();
		return;
	}

	// Start the dashboard server
	const { hostname, port } = await startServer(cmd.port, cmd.host);
	const url = formatStatsDashboardUrl(hostname, port);
	console.log(chalk.green(`Dashboard available at: ${url}`));

	// Open browser
	openPath(url);

	console.log("Press Ctrl+C to stop\n");

	// Keep process running
	process.on("SIGINT", () => {
		console.log("\nShutting down...");
		closeDb();
		process.exit(0);
	});

	// Keep the process alive
	await new Promise(() => {});
}

async function printStatsSummary(): Promise<void> {
	const { getDashboardStats } = await import("@oh-my-pi/omp-stats");
	const stats = await getDashboardStats();
	const { overall, byModel, byFolder } = stats;

	console.log(chalk.bold("\n=== AI Usage Statistics ===\n"));

	console.log(chalk.bold("Overall:"));
	console.log(`  Requests: ${formatNumber(overall.totalRequests)} (${formatNumber(overall.failedRequests)} errors)`);
	console.log(`  Error Rate: ${formatPercent(overall.errorRate)}`);
	console.log(`  Total Tokens: ${formatNumber(overall.totalInputTokens + overall.totalOutputTokens)}`);
	console.log(`  Input Tokens: ${formatNumber(overall.totalInputTokens)}`);
	console.log(`  Output Tokens: ${formatNumber(overall.totalOutputTokens)}`);
	console.log(`  Cache Rate: ${formatPercent(overall.cacheRate)}`);
	console.log(`  Cache Savings: ${formatPercent(overall.cacheSavings)}`);
	console.log(`  Total Cost: ${formatCost(overall.totalCost)}`);
	console.log(`  Premium Requests: ${formatNumber(normalizePremiumRequests(overall.totalPremiumRequests ?? 0))}`);
	console.log(`  Avg Duration: ${overall.avgDuration !== null ? formatDuration(overall.avgDuration) : "-"}`);
	console.log(`  Avg TTFT: ${overall.avgTtft !== null ? formatDuration(overall.avgTtft) : "-"}`);
	if (overall.avgTokensPerSecond !== null) {
		console.log(`  Avg Tokens/s: ${overall.avgTokensPerSecond.toFixed(1)}`);
	}

	if (byModel.length > 0) {
		console.log(chalk.bold("\nBy Model:"));
		for (const m of byModel.slice(0, 10)) {
			console.log(
				`  ${m.model}: ${formatNumber(m.totalRequests)} reqs, ${formatCost(m.totalCost)}, ${formatPercent(m.cacheRate)} cache rate, ${formatPercent(m.cacheSavings)} cache savings`,
			);
		}
	}

	if (byFolder.length > 0) {
		console.log(chalk.bold("\nBy Folder:"));
		for (const f of byFolder.slice(0, 10)) {
			console.log(`  ${f.folder}: ${formatNumber(f.totalRequests)} reqs, ${formatCost(f.totalCost)}`);
		}
	}

	console.log("");
}
