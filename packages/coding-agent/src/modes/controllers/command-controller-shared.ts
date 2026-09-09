/**
 * Shared helpers for /mcp and /ssh command controllers.
 *
 * Captures argument parsing, source grouping, and chat-message rendering that
 * was duplicated between mcp-command-controller and ssh-command-controller.
 * Intentionally kept narrow: subcommand routing, help text, success/error
 * wording, and add-flow logic stay in the per-controller files because they
 * diverge in workflow.
 */
import { Text } from "@oh-my-pi/pi-tui";
import type { SourceMeta } from "../../capability/types";
import { shortenPath } from "../../tools/render-utils";
import { DynamicBorder } from "../components/dynamic-border";
import { TranscriptBlock } from "../components/transcript-container";
import { parseCommandArgs } from "../shared";
import type { InteractiveModeContext } from "../types";

export type ScopeValue = "project" | "user";

export type ScopeFlagResult = { ok: true; scope: ScopeValue } | { ok: false; error: string };

/**
 * Validate the value following a `--scope` flag.
 */
export function readScopeFlag(value: string | undefined): ScopeFlagResult {
	if (!value || (value !== "project" && value !== "user")) {
		return { ok: false, error: "Invalid --scope value. Use project or user." };
	}
	return { ok: true, scope: value };
}

export type RemoveArgs = { name: string | undefined; scope: ScopeValue };

export type ParseRemoveResult = { ok: true; value: RemoveArgs } | { ok: false; error: string };

/**
 * Parse the argument tail of `/<cmd> remove <name> [--scope project|user]`.
 *
 * `rest` is the text after the subcommand keyword. The caller is responsible
 * for emitting the command-specific "<entity> name required" usage hint when
 * `value.name` is undefined.
 */
export function parseRemoveArgs(rest: string): ParseRemoveResult {
	const tokens = parseCommandArgs(rest);

	let name: string | undefined;
	let scope: ScopeValue = "project";
	let i = 0;

	if (tokens.length > 0 && !tokens[0].startsWith("-")) {
		name = tokens[0];
		i = 1;
	}

	while (i < tokens.length) {
		const token = tokens[i];
		if (token === "--scope") {
			const r = readScopeFlag(tokens[i + 1]);
			if (!r.ok) return { ok: false, error: r.error };
			scope = r.scope;
			i += 2;
			continue;
		}
		return { ok: false, error: `Unknown option: ${token}` };
	}

	return { ok: true, value: { name, scope } };
}

/**
 * Group capability-loaded items by their source provider+path, yielding each
 * group with a display-ready `shortPath`.
 */
export function* groupBySource<T>(
	items: Iterable<T>,
	getSource: (item: T) => SourceMeta,
): Iterable<{ providerName: string; shortPath: string; items: T[] }> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const src = getSource(item);
		const key = `${src.providerName}|${src.path}`;
		let group = groups.get(key);
		if (!group) {
			group = [];
			groups.set(key, group);
		}
		group.push(item);
	}
	for (const [key, grouped] of groups) {
		const sepIdx = key.indexOf("|");
		yield {
			providerName: key.slice(0, sepIdx),
			shortPath: shortenPath(key.slice(sepIdx + 1)),
			items: grouped,
		};
	}
}

/**
 * Render a message block (DynamicBorder / Text / DynamicBorder) into the chat
 * container and request a render.
 */
export function showCommandMessage(ctx: InteractiveModeContext, text: string): void {
	const block = new TranscriptBlock();
	block.addChild(new DynamicBorder());
	block.addChild(new Text(text, 1, 1));
	block.addChild(new DynamicBorder());
	ctx.presentCommandOutput(block);
}
