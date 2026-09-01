import * as stats from "@oh-my-pi/omp-stats";
import * as openUtils from "../../utils/open";

export const DEFAULT_STATS_DASHBOARD_PORT = 3847;

interface StatsDashboardServer {
	hostname: string;
	port: number;
	stop: () => void;
}

export interface StatsDashboardArgs {
	port: number;
	host: string;
}

export interface StatsDashboardLaunchResult {
	url: string;
	message: string;
}

let activeStatsServer: StatsDashboardServer | undefined;

const STATS_DASHBOARD_USAGE = "Usage: /stats [--port <port>] [--host <host>]";

function parsePort(value: string | undefined): number | string {
	if (!value) return `Missing port. ${STATS_DASHBOARD_USAGE}`;
	if (!/^\d+$/.test(value)) return `Invalid port: ${value}`;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) return `Invalid port: ${value}`;
	return port;
}

export function parseStatsDashboardArgs(args: string): StatsDashboardArgs | { error: string } {
	const tokens = args.split(/\s+/).filter(Boolean);
	let port = DEFAULT_STATS_DASHBOARD_PORT;
	let host = "127.0.0.1";

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--port" || token === "-p") {
			const parsed = parsePort(tokens[++i]);
			if (typeof parsed === "string") return { error: parsed };
			port = parsed;
			continue;
		}
		if (token.startsWith("--port=")) {
			const parsed = parsePort(token.slice("--port=".length));
			if (typeof parsed === "string") return { error: parsed };
			port = parsed;
			continue;
		}
		if (token === "--host") {
			const value = tokens[++i];
			if (!value) return { error: `Missing host. ${STATS_DASHBOARD_USAGE}` };
			host = value;
			continue;
		}
		if (token.startsWith("--host=")) {
			const value = token.slice("--host=".length);
			if (!value) return { error: `Missing host. ${STATS_DASHBOARD_USAGE}` };
			host = value;
			continue;
		}
		return { error: `Unknown option: ${token}. ${STATS_DASHBOARD_USAGE}` };
	}

	return { port, host };
}

export async function launchStatsDashboard(args: StatsDashboardArgs): Promise<StatsDashboardLaunchResult> {
	const { processed, files } = await stats.syncAllSessions();
	const total = await stats.getTotalMessageCount();
	let requestedAddressIgnored = false;

	if (!activeStatsServer) {
		activeStatsServer = await stats.startServer(args.port, args.host);
	} else if (args.port !== activeStatsServer.port || args.host !== activeStatsServer.hostname) {
		requestedAddressIgnored = true;
	}

	const url = stats.formatStatsDashboardUrl(activeStatsServer.hostname, activeStatsServer.port);
	openUtils.openPath(url);

	const serverLine = requestedAddressIgnored
		? `Dashboard already running at: ${url} (requested ${args.host}:${args.port} ignored)`
		: `Dashboard available at: ${url}`;

	return {
		url,
		message: `Synced ${processed} new entries from ${files} files (${total} total)\n${serverLine}`,
	};
}

export function stopStatsDashboard(): void {
	if (!activeStatsServer) return;
	activeStatsServer.stop();
	activeStatsServer = undefined;
	stats.closeDb();
}
