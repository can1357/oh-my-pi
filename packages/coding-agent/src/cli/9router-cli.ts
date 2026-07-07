/**
 * `omp 9router` — route oh-my-pi model roles through the local 9router gateway.
 *
 * Probes 9router, selects the first working combo per model role, and writes the
 * chosen selectors into settings.modelRoles so the resolver uses them.
 */

import { APP_NAME, getProjectDir } from "@pk-nerdsaver-ai/pi-utils";
import type { ModelRole } from "../config/model-roles";
import {
	applyNineRouterRouting,
	type NineRouterRoutingResult,
	type NineRouterSlot,
} from "../config/nine-router-controller";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";

export type NineRouterAction = "route";

export interface NineRouterCommandArgs {
	action: NineRouterAction;
	flags: {
		"api-key"?: string;
		json?: boolean;
		mode?: "list" | "probe";
		"probe-timeout"?: number;
		"probe-tokens"?: number;
		roles?: string[];
		"slots-file"?: string;
		config?: string[];
	};
}

function writeLine(line = ""): void {
	process.stdout.write(`${line}\n`);
}

async function readSlotsFile(path: string): Promise<NineRouterSlot[]> {
	const text = await Bun.file(path).text();
	const parsed = Bun.JSON5.parse(text) as { slots?: NineRouterSlot[] };
	if (!Array.isArray(parsed.slots)) {
		throw new Error(`slots file must contain a { slots: [...] } array: ${path}`);
	}
	return parsed.slots;
}

function renderRouteTable(result: NineRouterRoutingResult): string[] {
	const lines: string[] = [];
	if (result.routes.length === 0) {
		lines.push("No routes applied.");
		return lines;
	}
	const header = ["role", "selected", "available", "probed"];
	const widths = header.map((h, i) =>
		Math.max(
			Bun.stringWidth(h),
			...result.routes.map(row => {
				const cell =
					i === 0
						? row.role
						: i === 1
							? (row.selected ?? "-")
							: i === 2
								? String(row.available.length)
								: String(row.probed.length);
				return Bun.stringWidth(cell);
			}),
		),
	);
	const pad = (text: string, i: number): string => text + " ".repeat(Math.max(0, widths[i] - Bun.stringWidth(text)));
	lines.push(header.map((h, i) => pad(h, i)).join("  "));
	lines.push(header.map((_, i) => "-".repeat(widths[i])).join("  "));
	for (const row of result.routes) {
		lines.push(
			[
				pad(row.role, 0),
				pad(row.selected ?? "-", 1),
				pad(String(row.available.length), 2),
				pad(String(row.probed.length), 3),
			].join("  "),
		);
	}
	return lines;
}

export async function runNineRouterCommand(command: NineRouterCommandArgs): Promise<void> {
	const cwd = getProjectDir();
	const authStorage = await discoverAuthStorage();
	try {
		const settings = await Settings.init({ cwd, configFiles: command.flags.config });
		const slots = command.flags["slots-file"] ? await readSlotsFile(command.flags["slots-file"]) : undefined;
		const roles = command.flags.roles
			?.flatMap(r => r.split(",").map(s => s.trim()))
			.filter(Boolean)
			.map(r => r as ModelRole)
			.filter(Boolean);
		const result = await applyNineRouterRouting(settings, {
			apiKey: command.flags["api-key"],
			mode: command.flags.mode,
			probeTimeoutMs: command.flags["probe-timeout"],
			probeMaxTokens: command.flags["probe-tokens"],
			roles,
			slots,
		});

		if (command.flags.json) {
			writeLine(JSON.stringify(result, null, 2));
			return;
		}

		for (const line of renderRouteTable(result)) {
			writeLine(line);
		}
		if (result.errors.length > 0) {
			writeLine();
			for (const error of result.errors) {
				writeLine(`error: ${error}`);
			}
		}
		if (result.routes.some(r => r.selected === null)) {
			writeLine();
			writeLine("Some roles could not be routed. Check that 9router is running and the combo names are configured.");
		}
	} finally {
		authStorage.close();
	}
}

export function buildNineRouterHelp(): string {
	return `Route model roles through the local 9router gateway.

Usage:
  ${APP_NAME} 9router route
  ${APP_NAME} 9router route --mode probe
  ${APP_NAME} 9router route --roles default,smol,fast-context

Options:
  --mode <list|probe>      Availability check: list (default) or probe
  --probe-timeout <ms>     Timeout for each probe completion (default 10000)
  --probe-tokens <n>       Max tokens for each probe completion (default 8)
  --roles <role1,role2>    Route only these roles
  --slots-file <path>      JSON/JSON5 file with a custom { slots: [...] } map
  --json                   Output machine-readable JSON
  --config <path>          Extra config.yml-style overlay (repeatable)
`;
}
