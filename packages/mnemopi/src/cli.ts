#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { dataDir as configuredDataDir, dbPath as configuredDbPath } from "./config";
import { BankManager, ValueError } from "./core/banks";
import { BeamMemory } from "./core/beam";
import type { ImportStats, RecallResult } from "./core/beam/types";
import { runDiagnostics } from "./diagnose";
import { main as runMcpMain } from "./mcp-server";

export interface CliIo {
	write(data: string): void;
}

export interface CliContext {
	readonly dataDir?: string;
	readonly dbPath?: string;
	readonly memory?: BeamMemory;
	readonly createMemory?: () => BeamMemory;
	readonly stdout?: CliIo;
	readonly stderr?: CliIo;
}

export class CliError extends Error {
	constructor(
		message: string,
		readonly exitCode = 2,
	) {
		super(message);
		this.name = "CliError";
	}
}

type CommandHandler = (args: readonly string[], context?: CliContext) => number | Promise<number>;

function out(context: CliContext | undefined, text = ""): void {
	(context?.stdout ?? Bun.stdout).write(`${text}\n`);
}

function err(context: CliContext | undefined, text = ""): void {
	(context?.stderr ?? Bun.stderr).write(`${text}\n`);
}

function fail(message: string, exitCode = 2): never {
	throw new CliError(`Error: ${message}`, exitCode);
}

function usage(message: string): never {
	throw new CliError(message, 2);
}

function parseFloatArg(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) fail(`${name} must be a number: ${value}`);
	return parsed;
}

function parseIntArg(value: string, name: string): number {
	if (!/^[+-]?\d+$/.test(value)) fail(`${name} must be an integer: ${value}`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) fail(`${name} must be an integer: ${value}`);
	return parsed;
}

function resolveDataDir(context?: CliContext): string {
	return context?.dataDir ?? configuredDataDir();
}

function resolveDbPath(context?: CliContext): string {
	return context?.dbPath ?? (context?.dataDir ? join(context.dataDir, "mnemopi.db") : configuredDbPath());
}

function getMemory(context?: CliContext): { memory: BeamMemory; owned: boolean } {
	if (context?.memory) return { memory: context.memory, owned: false };
	if (context?.createMemory) return { memory: context.createMemory(), owned: true };
	return { memory: new BeamMemory({ dbPath: resolveDbPath(context) }), owned: true };
}

async function withMemory<T>(context: CliContext | undefined, fn: (memory: BeamMemory) => T | Promise<T>): Promise<T> {
	const { memory, owned } = getMemory(context);
	try {
		const result = await fn(memory);
		// Drain background fact-extraction and embedding tasks before close so
		// short-lived owners (e.g. `mnemopi store …` / `mnemopi sleep …`) don't
		// race the SQLite handle shut from under in-flight `embed()` writes.
		if (owned) await memory.flushExtractions();
		return result;
	} finally {
		if (owned) memory.close();
	}
}

function asCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function memoryStats(memory: BeamMemory, dataDir?: string): Record<string, unknown> {
	const working = memory.getWorkingStats();
	const episodic = memory.getEpisodicStats();
	const triples = memory.db.query("SELECT COUNT(*) AS total FROM triples").get() as {
		total: number;
	};
	const banks = new BankManager(dataDir).listBanks();
	return {
		total_memories: asCount(working.total) + asCount(episodic.total),
		beam: {
			working_memory: working,
			episodic_memory: episodic,
			triples: { total: asCount(triples.total) },
		},
		banks,
		database: memory.dbPath ?? ":memory:",
	};
}

function formatImportStats(stats: ImportStats): string {
	const working = stats.working_memory;
	const episodic = stats.episodic_memory;
	const scratchpad = stats.scratchpad;
	const consolidation = stats.consolidation_log;
	return [
		`${asCount(working.inserted)} working`,
		`${asCount(episodic.inserted)} episodic`,
		`${asCount(scratchpad.inserted)} scratchpad`,
		`${asCount(consolidation.inserted)} consolidation`,
		`${asCount(working.skipped) + asCount(episodic.skipped)} skipped`,
		`${asCount(working.overwritten) + asCount(episodic.overwritten)} overwritten`,
	].join(", ");
}

export const cmdExport: CommandHandler = (args, context) => {
	if (args.length === 0) usage("Usage: mnemopi export <file.json>");
	const outputPath = args[0] ?? "";
	return withMemory(context, memory => {
		mkdirSync(dirname(outputPath), { recursive: true });
		const data = memory.exportToDict();
		writeFileSync(outputPath, JSON.stringify(data, null, 2));
		const working = Array.isArray(data.working_memory) ? data.working_memory.length : 0;
		const episodic = Array.isArray(data.episodic_memory) ? data.episodic_memory.length : 0;
		const scratchpad = Array.isArray(data.scratchpad) ? data.scratchpad.length : 0;
		const consolidation = Array.isArray(data.consolidation_log) ? data.consolidation_log.length : 0;
		out(
			context,
			`Exported ${working} working, ${episodic} episodic, ${scratchpad} scratchpad, ${consolidation} consolidation to ${outputPath}`,
		);
		return 0;
	});
};

export const cmdImport: CommandHandler = (args, context) => {
	if (args.length === 0) usage("Usage: mnemopi import <file.json>");
	const inputPath = args[0] ?? "";
	if (!existsSync(inputPath)) fail(`Import file not found: ${inputPath}`, 1);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(inputPath, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) fail(`Invalid JSON: ${error.message}`, 1);
		throw error;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		fail("Import file must contain a Mnemopi export object", 1);
	return withMemory(context, memory => {
		const stats = memory.importFromDict(parsed as Record<string, unknown>);
		out(context, `Imported ${formatImportStats(stats)} from ${inputPath}`);
		return 0;
	});
};

export const cmdMcp: CommandHandler = async args => {
	await runMcpMain(args);
	return 0;
};

export const cmdRemember: CommandHandler = (args, context) => {
	if (args.length === 0) usage("Usage: mnemopi store <content> [source] [importance]");
	const content = args[0] ?? "";
	const source = args[1] ?? "cli";
	const importance = args[2] === undefined ? 0.5 : parseFloatArg(args[2], "importance");
	return withMemory(context, memory => {
		const memoryId = memory.remember(content, { source, importance, extractEntities: true });
		out(context, `Stored: ${memoryId}`);
		return 0;
	});
};

export const cmdRecall: CommandHandler = async (args, context) => {
	if (args.length === 0) usage("Usage: mnemopi recall <query> [top_k]");
	const query = args[0] ?? "";
	const topK = args[1] === undefined ? 5 : parseIntArg(args[1], "top_k");
	const { memory, owned } = getMemory(context);
	try {
		const results = await memory.recall(query, topK);
		out(context, `\nResults for: ${query}\n`);
		for (const result of results) {
			const content = result.content ?? "";
			const score = typeof result.score === "number" ? result.score : 0;
			out(context, `  ID: ${result.id ?? "?"}`);
			out(context, `  Content: ${content.slice(0, 150)}${content.length > 150 ? "..." : ""}`);
			out(context, `  Score: ${score.toFixed(3)}`);
			if ((result as RecallResult & { entity_match?: unknown }).entity_match) out(context, "  [entity match]");
			out(context);
		}
		return 0;
	} finally {
		if (owned) memory.close();
	}
};

export const cmdUpdate: CommandHandler = (args, context) => {
	if (args.length < 2) usage("Usage: mnemopi update <memory_id> <new_content> [importance]");
	const memoryId = args[0] ?? "";
	const content = args[1] ?? "";
	const importance = args[2] === undefined ? null : parseFloatArg(args[2], "importance");
	return withMemory(context, memory => {
		if (!memory.updateWorking(memoryId, content, importance)) fail(`Memory not found: ${memoryId}`, 1);
		out(context, `Updated: ${memoryId}`);
		return 0;
	});
};

export const cmdDelete: CommandHandler = (args, context) => {
	if (args.length === 0) usage("Usage: mnemopi delete <memory_id>");
	const memoryId = args[0] ?? "";
	return withMemory(context, memory => {
		if (!memory.forgetWorking(memoryId)) fail(`Memory not found: ${memoryId}`, 1);
		out(context, `Deleted: ${memoryId}`);
		return 0;
	});
};

export const cmdStats: CommandHandler = (_args, context) =>
	withMemory(context, memory => {
		const stats = memoryStats(memory, resolveDataDir(context));
		const beam = stats.beam as Record<string, Record<string, unknown>>;
		const wm = beam.working_memory ?? {};
		const ep = beam.episodic_memory ?? {};
		const triples = beam.triples ?? {};
		out(context, "\nMnemopi Stats\n");
		out(context, `  Total memories: ${asCount(stats.total_memories)}`);
		out(context, `  Working memory: ${asCount(wm.total)}`);
		out(context, `  Episodic memory: ${asCount(ep.total)}`);
		out(context, `  Knowledge triples: ${asCount(triples.total)}`);
		const banks = Array.isArray(stats.banks) ? stats.banks : [];
		if (banks.length > 0) out(context, `\n  Banks: ${banks.join(", ")}`);
		out(context, `  DB path: ${typeof stats.database === "string" ? stats.database : "N/A"}`);
		return 0;
	});

export const cmdSleep: CommandHandler = (_args, context) =>
	withMemory(context, memory => {
		const result = memory.sleepAllSessions(false);
		out(context, `Consolidation complete: ${JSON.stringify(result)}`);
		return 0;
	});

export const cmdScratchpad: CommandHandler = (args, context) => {
	if (args.length === 0) usage("Usage: mnemopi scratchpad <read|write|clear> [content]");
	const subcmd = args[0];
	return withMemory(context, memory => {
		if (subcmd === "read") {
			for (const item of memory.scratchpadRead() as Array<{ id?: string; content?: string }>) {
				out(context, `  ID: ${item.id ?? "?"}`);
				out(context, `  Content: ${item.content ?? ""}`);
			}
			return 0;
		}
		if (subcmd === "write") {
			if (args.length < 2) usage("Usage: mnemopi scratchpad write <content>");
			const id = memory.scratchpadWrite(args[1] ?? "");
			out(context, `Scratchpad stored: ${id}`);
			return 0;
		}
		if (subcmd === "clear") {
			memory.scratchpadClear();
			out(context, "Scratchpad cleared");
			return 0;
		}
		fail(`Unknown scratchpad command: ${subcmd}`);
	});
};

export const cmdBank: CommandHandler = (args, context) => {
	if (args.length === 0) usage("Usage: mnemopi bank <list|create|delete> [name]");
	const manager = new BankManager(resolveDataDir(context));
	const subcmd = args[0];
	try {
		if (subcmd === "list") {
			out(context, "\nMemory Banks:\n");
			for (const bank of manager.listBanks()) out(context, `  - ${bank}`);
			return 0;
		}
		if (subcmd === "create") {
			if (args.length < 2) fail("Usage: mnemopi bank create <name>");
			const name = args[1] ?? "";
			manager.createBank(name);
			out(context, `Created bank: ${name}`);
			return 0;
		}
		if (subcmd === "delete") {
			if (args.length < 2) fail("Usage: mnemopi bank delete <name>");
			const name = args[1] ?? "";
			if (!manager.deleteBank(name)) fail(`Bank not found: ${name}`, 1);
			out(context, `Deleted bank: ${name}`);
			return 0;
		}
		fail(`Unknown bank command: ${subcmd}`);
	} catch (error) {
		if (error instanceof CliError) throw error;
		if (error instanceof ValueError) fail(error.message);
		throw error;
	}
};

export const cmdDiagnose: CommandHandler = (_args, context) => {
	const result = runDiagnostics({
		dbPath: resolveDbPath(context),
		dataDir: resolveDataDir(context),
	});
	out(context, "\nMnemopi Diagnostics\n");
	out(context, `  Checks passed: ${result.checks_passed}/${result.checks_total}`);
	if (result.key_findings.length > 0) {
		out(context, "\n  Key findings:");
		for (const finding of result.key_findings) out(context, `    - ${finding}`);
	} else {
		out(context, "\n  No issues detected");
	}
	return result.checks_failed === 0 ? 0 : 1;
};

export const COMMANDS: Readonly<Record<string, CommandHandler>> = {
	store: cmdRemember,
	remember: cmdRemember,
	recall: cmdRecall,
	search: cmdRecall,
	update: cmdUpdate,
	edit: cmdUpdate,
	delete: cmdDelete,
	forget: cmdDelete,
	stats: cmdStats,
	export: cmdExport,
	import: cmdImport,
	sleep: cmdSleep,
	consolidate: cmdSleep,
	scratchpad: cmdScratchpad,
	sp: cmdScratchpad,
	bank: cmdBank,
	diagnose: cmdDiagnose,
	doctor: cmdDiagnose,
	mcp: cmdMcp,
};

export function printHelp(context?: CliContext): void {
	out(context, "Mnemopi - Local AI Memory System\n");
	out(context, "Usage: mnemopi <command> [args]\n");
	out(context, "Commands:");
	out(context, "  store <content> [source] [importance]  Store a memory");
	out(context, "  recall <query> [top_k]                 Search memories");
	out(context, "  update <id> <content> [importance]     Update a memory");
	out(context, "  delete <id>                            Delete a memory");
	out(context, "  export <file.json>                     Export memories");
	out(context, "  import <file.json>                     Import memories");
	out(context, "  stats                                  Show statistics");
	out(context, "  sleep                                  Run consolidation");
	out(context, "  scratchpad read|write|clear [content]  Manage scratchpad");
	out(context, "  diagnose                               Run diagnostics");
	out(context, "  bank list|create|delete [name]         Manage memory banks");
	out(context, "  mcp [args]                             Run MCP server");
}

export async function runCli(args: readonly string[] = Bun.argv.slice(2), context?: CliContext): Promise<number> {
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
		printHelp(context);
		return 0;
	}
	const command = args[0] ?? "";
	const handler = COMMANDS[command];
	if (!handler) {
		err(context, `Unknown command: ${command}`);
		err(context, "Run 'mnemopi --help' for usage.");
		return 2;
	}
	try {
		return await handler(args.slice(1), context);
	} catch (error) {
		if (error instanceof CliError) {
			err(context, error.message);
			return error.exitCode;
		}
		throw error;
	}
}

if (import.meta.main) {
	const code = await runCli();
	process.exit(code);
}
