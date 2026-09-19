/**
 * `omp seats` — compact fleet summary of operator cockpit seats.
 *
 * Connects to the running cockpit WebSocket, waits for the snapshot,
 * extracts seat data, and renders a one-glance overview.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { readOperatorWebToken } from "../operator-web/token";

interface SeatInfo {
	seatId: string;
	sessionId: string;
	model: string;
	lifecycle: string;
	attention?: string;
	isStreaming: boolean;
}

interface SeatsSummary {
	seats: SeatInfo[];
	modelCounts: Record<string, number>;
	lifecycleCounts: Record<string, number>;
	errorCount: number;
}

function summarize(seats: SeatInfo[]): SeatsSummary {
	const modelCounts: Record<string, number> = {};
	const lifecycleCounts: Record<string, number> = {};
	let errorCount = 0;

	for (const seat of seats) {
		modelCounts[seat.model] = (modelCounts[seat.model] ?? 0) + 1;
		lifecycleCounts[seat.lifecycle] = (lifecycleCounts[seat.lifecycle] ?? 0) + 1;
		if (typeof seat.attention === "string" && seat.attention.startsWith("error:")) errorCount++;
	}

	return { seats, modelCounts, lifecycleCounts, errorCount };
}

function renderCompact(summary: SeatsSummary): void {
	const { seats, modelCounts, lifecycleCounts, errorCount } = summary;
	const total = seats.length;

	const errorStr = errorCount > 0 ? chalk.red(` ${errorCount} error(s)`) : "";
	console.log(chalk.bold(`Seats: ${total}${errorStr}\n`));

	const modelParts = Object.entries(modelCounts)
		.sort((a, b) => b[1] - a[1])
		.map(([model, count]) => {
			const short = model.includes("/") ? model.split("/")[1] : model;
			return `${short}×${count}`;
		});
	console.log(`  ${chalk.dim("models:")} ${modelParts.join("  ")}`);

	const lcParts = Object.entries(lifecycleCounts)
		.sort((a, b) => b[1] - a[1])
		.map(([lc, count]) => {
			const icon = lc === "live" ? "●" : lc === "detached" ? "○" : "◐";
			return `${icon} ${lc}×${count}`;
		});
	console.log(`  ${chalk.dim("state:")}  ${lcParts.join("  ")}`);

	console.log("");
	for (const seat of seats) {
		const shortModel = seat.model.includes("/") ? seat.model.split("/")[1] : seat.model;
		const lcIcon = seat.lifecycle === "live" ? chalk.green("●") : seat.lifecycle === "detached" ? chalk.dim("○") : chalk.yellow("◐");
		const streamIcon = seat.isStreaming ? chalk.cyan("⟳") : " ";
		const att = typeof seat.attention === "string" ? seat.attention : undefined;
		const errorIcon = att?.startsWith("error:") ? chalk.red(" ✗") : att === "finished" ? chalk.dim(" ✓") : "";
		const seatNum = seat.seatId.split(":").pop();
		const attentionStr = att ? chalk.dim(` ${att}`) : "";
		console.log(`  ${lcIcon} #${seatNum} ${shortModel.padEnd(20)} ${streamIcon}${errorIcon}${attentionStr}`);
	}
}

async function fetchSeatsViaWebSocket(host: string, port: number): Promise<SeatInfo[]> {
	const token = await readOperatorWebToken();
	if (!token) throw new Error("No operator web token found. Is the operator running?");

	const url = `ws://${host}:${port}/api/v1/ws`;
	const { promise, resolve, reject } = Promise.withResolvers<SeatInfo[]>();

	const ws = new WebSocket(url, ["omp-operator-v2", `omp-token.${token}`]);

	const timeout = setTimeout(() => {
		ws.close();
		reject(new Error("Timeout waiting for cockpit snapshot"));
	}, 10000);

	ws.addEventListener("message", (event) => {
		try {
			const data = JSON.parse(String(event.data));
			if (data.t === "snapshot" && data.snapshot?.seats) {
				clearTimeout(timeout);
				ws.close();
				const seats: SeatInfo[] = data.snapshot.seats.map((s: Record<string, unknown>) => {
					const modelObj = s.model as Record<string, unknown> | undefined;
					const modelStr = modelObj ? `${modelObj.provider ?? ""}/${modelObj.id ?? ""}` : String(s.model ?? "unknown");
					return {
						seatId: String(s.seatId ?? ""),
						sessionId: String(s.sessionId ?? ""),
						model: modelStr,
						lifecycle: String(s.lifecycle ?? "unknown"),
						attention: typeof s.attention === "string" ? s.attention : undefined,
						isStreaming: Boolean(s.isStreaming),
					};
				});
				resolve(seats);
			}
		} catch {
			// ignore parse errors from other messages
		}
	});

	ws.addEventListener("error", () => {
		clearTimeout(timeout);
		reject(new Error(`Failed to connect to cockpit at ${url}`));
	});

	ws.addEventListener("close", (event) => {
		clearTimeout(timeout);
		if (!event.wasClean) {
			reject(new Error(`Cockpit connection closed (code ${event.code})`));
		}
	});

	return promise;
}

export interface SeatsCommandArgs {
	flags: {
		json?: boolean;
		host?: string;
		port?: number;
	};
}

export async function runSeatsCommand(cmd: SeatsCommandArgs): Promise<void> {
	const host = cmd.flags.host ?? "127.0.0.1";
	const port = cmd.flags.port ?? 4180;

	try {
		const seats = await fetchSeatsViaWebSocket(host, port);
		const summary = summarize(seats);

		if (cmd.flags.json) {
			console.log(JSON.stringify(summary, null, 2));
		} else {
			renderCompact(summary);
		}
	} catch (err) {
		if (cmd.flags.json) {
			console.log(JSON.stringify({ error: (err as Error).message }));
		} else {
			console.error(chalk.red(`Error: ${(err as Error).message}`));
		}
		process.exit(1);
	}
}
