import * as os from "node:os";
import * as path from "node:path";
import { getWikigraphDb } from "../../wikigraph/db";
import { extractAtomicFacts } from "../../wikigraph/extract";
import { refreshWikigraphIndex } from "../../wikigraph/refresh";
import type { WikiNodeRow } from "../../wikigraph/types";
import { commandConsumed, parseSubcommand } from "../helpers/parse";
import type { SlashCommandResult, SlashCommandRuntime, TuiSlashCommandRuntime } from "../types";

function expandRoot(root: string, cwd: string): string {
	const withCwd = root.replaceAll("<cwd>", cwd);
	if (withCwd === "~") return os.homedir();
	if (withCwd.startsWith("~/") || withCwd.startsWith("~\\")) return path.join(os.homedir(), withCwd.slice(2));
	return withCwd;
}

function configuredRoots(runtime: SlashCommandRuntime | TuiSlashCommandRuntime): string[] {
	const cwd = "sessionManager" in runtime ? runtime.sessionManager.getCwd() : runtime.ctx.sessionManager.getCwd();
	const settingsSource = "settings" in runtime ? runtime.settings : runtime.ctx.settings;
	let roots: string[] = ["~/.ompk/agent/wiki", "<cwd>/.ompk/wiki"];
	try {
		const configured = settingsSource.get("wikigraph.roots" as never) as unknown;
		if (Array.isArray(configured)) roots = configured;
	} catch {
		// Defaults are safe when settings are unavailable in tests.
	}
	return roots.map(root => expandRoot(root, cwd));
}

async function runWikigraphCommand(
	args: string,
	runtime: SlashCommandRuntime | TuiSlashCommandRuntime,
	output: (text: string) => Promise<void> | void,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(args);
	if (verb === "" || verb === "build" || verb === "refresh") {
		const roots = rest ? rest.split(/\s+/).filter(Boolean) : configuredRoots(runtime);
		const result = await refreshWikigraphIndex(roots);
		const lines = [`WikiGraph indexed: ${result.updated} updated, ${result.added} added, ${result.removed} removed.`];
		if (result.warnings.length > 0) lines.push(...result.warnings.slice(0, 5));
		await output(lines.join("\n"));
		return commandConsumed();
	}
	if (verb === "extract") {
		if (!rest) {
			await output("Usage: /wikigraph extract <section-node-id>");
			return commandConsumed();
		}
		const db = await getWikigraphDb();
		const node = db.prepare<WikiNodeRow, [string]>("SELECT * FROM nodes WHERE id = ? AND kind = 'section'").get(rest);
		if (!node?.line_start || !node.line_end) {
			await output(`WikiGraph section not found or not citable: ${rest}`);
			return commandConsumed();
		}
		const body = (await Bun.file(node.path).text())
			.split(/\r?\n/)
			.slice(node.line_start - 1, node.line_end)
			.join("\n");
		const result = extractAtomicFacts(db, {
			sectionId: node.id,
			path: node.path,
			lineStart: node.line_start,
			lineEnd: node.line_end,
			body,
			factsPerSection: 5,
			minConfidence: 0.6,
		});
		await output(`WikiGraph extracted: ${result.inserted} facts, ${result.rejected} rejected.`);
		return commandConsumed();
	}
	if (verb === "repair") {
		const db = await getWikigraphDb();
		db.db.exec("DROP TABLE IF EXISTS nodes_fts; DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS nodes;");
		const result = await refreshWikigraphIndex(configuredRoots(runtime));
		await output(`WikiGraph repaired: ${result.updated} updated.`);
		return commandConsumed();
	}
	await output("Usage: /wikigraph [build [root...]|refresh [root...]|extract <section-node-id>|repair]");
	return commandConsumed();
}

export async function handleWikigraphCommand(
	commandArgs: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	return runWikigraphCommand(commandArgs, runtime, runtime.output);
}

export async function handleWikigraphCommandTui(commandArgs: string, runtime: TuiSlashCommandRuntime): Promise<void> {
	await runWikigraphCommand(commandArgs, runtime, text => runtime.ctx.showStatus(text));
	runtime.ctx.editor.setText("");
}
