import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectAgentDir, isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import type { InteractiveModeContext } from "../../modes/types";
import bundledTemplate from "../../prompts/system/system-prompt.md" with { type: "text" };
import { discoverSystemPromptOverride, loadAppendSystemPrompt } from "../../system-prompt";
import { writeFileAtomically } from "../../utils/atomic-file";

type Scope = "local" | "global";
type Action = "edit" | "append" | "reset";

const USAGE =
	"Usage: /system-prompt [edit|append|reset] [local|global]. Reset removes only the selected base override, not append instructions.";

async function readIfPresent(filePath: string): Promise<string | undefined> {
	try {
		return await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

export async function handleSystemPromptCommand(args: string, ctx: InteractiveModeContext): Promise<void> {
	const words = args.trim().split(/\s+/).filter(Boolean);
	let action: Action = "edit";
	if (["edit", "append", "reset"].includes(words[0] ?? "")) action = words.shift() as Action;
	let scope = words.shift() as Scope | undefined;
	if (words.length > 0 || (scope !== undefined && scope !== "local" && scope !== "global")) {
		ctx.showWarning(USAGE);
		return;
	}
	if (ctx.session.isStreaming) {
		ctx.showWarning("Cannot change system prompt instructions while the session is streaming.");
		return;
	}
	try {
		if (!scope) {
			const selection = await ctx.showHookSelector(
				action === "append" ? "Append instructions: save scope" : "Base system prompt: save scope",
				["Local workspace", "Global"],
			);
			if (selection === undefined) return;
			scope = selection === "Local workspace" ? "local" : "global";
		}
		const cwd = ctx.sessionManager.getCwd();
		const agentDir = ctx.settings.getAgentDir();
		const directory = scope === "local" ? getProjectAgentDir(cwd) : agentDir;
		const literalPath = path.join(directory, "SYSTEM.md");
		const templatePath = path.join(directory, "SYSTEM_TEMPLATE.md");
		const literal = await readIfPresent(literalPath);
		const template = literal === undefined ? await readIfPresent(templatePath) : undefined;
		let sourcePath = literal !== undefined ? literalPath : templatePath;
		let content = literal ?? template;
		let kind: "text" | "template" = literal !== undefined ? "text" : "template";

		if (action === "reset") {
			if (content === undefined) {
				ctx.showStatus(`No saved ${scope} base override to reset. Append instructions are unchanged.`);
				return;
			}
			if (ctx.session.isStreaming) {
				ctx.showWarning("Cannot reset the system prompt while the session is streaming.");
				return;
			}
			await fs.unlink(sourcePath);
		} else {
			if (action === "append") {
				sourcePath = path.join(directory, "APPEND_SYSTEM.md");
				content = await readIfPresent(sourcePath);
				content ??=
					(await loadAppendSystemPrompt(cwd, agentDir, scope === "global" ? "user" : undefined))?.content ?? "";
				kind = "text";
			} else if (content === undefined) {
				const inherited = await discoverSystemPromptOverride(
					cwd,
					agentDir,
					scope === "global" ? "user" : undefined,
				);
				kind = inherited?.kind ?? "template";
				content = inherited?.content ?? bundledTemplate;
				sourcePath = kind === "text" ? literalPath : templatePath;
			}
			if (ctx.session.isStreaming) {
				ctx.showWarning("Cannot edit the system prompt while the session is streaming.");
				return;
			}
			const edited = await ctx.showHookEditor(
				`${scope === "local" ? "Local workspace" : "Global"} ${action === "append" ? "append instructions (plain text)" : kind === "template" ? "base system prompt (Handlebars source)" : "base system prompt (plain text)"}`,
				content,
			);
			if (edited === undefined) return;
			if (ctx.session.isStreaming) {
				ctx.showWarning("Cannot save the system prompt while the session is streaming.");
				return;
			}
			if (kind === "template") prompt.compile(edited);
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			if (ctx.session.isStreaming) {
				ctx.showWarning("Cannot save the system prompt while the session is streaming.");
				return;
			}
			await writeFileAtomically(sourcePath, edited);
		}
		resetCapabilities();
		try {
			await ctx.session.refreshBaseSystemPrompt();
		} catch (error) {
			ctx.showError(
				`${action === "reset" ? "Removed base override" : "Saved"}: ${sourcePath}. Session refresh failed: ${error instanceof Error ? error.message : String(error)}. The file change is saved; restart omp to apply it.`,
			);
			return;
		}
		ctx.showStatus(
			`${action === "reset" ? "Removed base override" : "Saved"}: ${sourcePath}. ${action === "reset" ? "Append instructions are unchanged. " : ""}Workspace overrides global; explicit CLI/SDK prompt inputs take precedence.`,
		);
	} catch (error) {
		ctx.showError(`System prompt update failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
