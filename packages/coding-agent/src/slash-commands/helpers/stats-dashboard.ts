import * as stats from "@oh-my-pi/omp-stats";
import { openTernPage } from "../../tools/browser/tern/user-page";
import * as openUtils from "../../utils/open";

export const DEFAULT_STATS_DASHBOARD_PORT = 3847;

interface StatsDashboardServer {
	hostname: string;
	port: number;
	/** The `allowedHosts` it was started with: part of its in-process reuse key, so later calls pass them back. */
	allowedHosts: readonly string[];
	stop: () => void;
}

function sameHostList(a: readonly string[], b: readonly string[]): boolean {
	const left = a.map(name => name.trim().toLowerCase()).sort();
	const right = b.map(name => name.trim().toLowerCase()).sort();
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

export interface StatsDashboardArgs {
	port: number;
	host: string;
	/** Extra Host names the dashboard answers to (`--allowed-host`, repeatable). */
	allowedHosts: string[];
}

export interface StatsDashboardLaunchResult {
	url: string;
	message: string;
}

let activeStatsServer: StatsDashboardServer | undefined;

const STATS_DASHBOARD_USAGE = "Usage: /stats [--port <port>] [--host <host>] [--allowed-host <name>]...";

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
	const allowedHosts: string[] = [];

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
		if (token === "--allowed-host" || token.startsWith("--allowed-host=")) {
			const value = token === "--allowed-host" ? tokens[++i] : token.slice("--allowed-host=".length);
			if (!value) return { error: `Missing allowed host. ${STATS_DASHBOARD_USAGE}` };
			allowedHosts.push(value);
			continue;
		}
		return { error: `Unknown option: ${token}. ${STATS_DASHBOARD_USAGE}` };
	}

	return { port, host, allowedHosts };
}

/**
 * Start (or reuse) the dashboard and open it (in a Tern pane, in a browser
 * block beside omp's; elsewhere in the system browser), without waiting for
 * ingest: the server syncs sessions in the background and streams progress to the page.
 * `judge` powers the Frustration page's judge runs; a later launch replaces
 * the registered one, so the dashboard always judges through the most recent
 * session.
 */
export async function launchStatsDashboard(
	args: StatsDashboardArgs,
	judge?: stats.StatsJudgeProvider,
): Promise<StatsDashboardLaunchResult> {
	let requestedAddressIgnored = false;

	if (!activeStatsServer) {
		const server = await stats.startServer(args.port, args.host, { judge, allowedHosts: args.allowedHosts });
		activeStatsServer = { ...server, allowedHosts: args.allowedHosts };
	} else {
		requestedAddressIgnored =
			args.port !== activeStatsServer.port ||
			args.host !== activeStatsServer.hostname ||
			!sameHostList(args.allowedHosts, activeStatsServer.allowedHosts);
		// Resolves to the live in-process server (its reuse key includes the allowed hosts); only re-registers the judge.
		if (judge) {
			await stats.startServer(activeStatsServer.port, activeStatsServer.hostname, {
				judge,
				allowedHosts: [...activeStatsServer.allowedHosts],
			});
		}
	}

	const url = stats.formatStatsDashboardUrl(activeStatsServer.hostname, activeStatsServer.port);
	const page = await openTernPage(url, "beside");
	if (page) page.disconnect();
	else openUtils.openPath(url);

	const requested = [`${args.host}:${args.port}`, ...args.allowedHosts.map(name => `--allowed-host ${name}`)].join(
		" ",
	);
	const serverLine = requestedAddressIgnored
		? `Dashboard already running at: ${url} (requested ${requested} ignored)`
		: `Dashboard available at: ${url}`;

	return { url, message: `${serverLine} (sessions sync in the background)` };
}

export function stopStatsDashboard(): void {
	if (!activeStatsServer) return;
	activeStatsServer.stop();
	activeStatsServer = undefined;
	stats.closeDb();
}
