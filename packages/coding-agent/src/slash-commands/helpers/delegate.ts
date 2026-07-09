import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { InteractiveModeContext } from "../../modes/types";
import { parseUsingForm, resolveSlashSubagentModel, spawnSubagent } from "./subagent";

export function looksLikeBrowserAutomationTask(input: string): boolean {
	const tokens = [
		"browser",
		"web",
		"page",
		"tab",
		"click",
		"fill",
		"login",
		"ix bridge",
		"ix-bridge",
		"navigate",
		"screenshot",
		"snapshot",
		"dom",
		"form",
	];
	const lower = input.toLowerCase();
	return tokens.some(token => lower.includes(token));
}

export async function handleDelegateSlashCommand(args: string, ctx: InteractiveModeContext): Promise<void> {
	const trimmed = args.trim();
	if (!trimmed) {
		ctx.showError("Usage: /delegate [using <alias-or-model> | legacy] <task>");
		return;
	}

	// 1. Check if the user specified /delegate legacy
	const isLegacyCommand = /^[lL]egacy(?:\s|$)/i.test(trimmed);
	const delegateMode = ctx.settings.get("delegate.mode");

	if (isLegacyCommand || delegateMode === "legacy-endpoint") {
		const scriptPath = path.resolve(os.homedir(), ".claude/bin/dispatch-endpoint.mjs");
		try {
			await fs.stat(scriptPath);
		} catch {
			ctx.showError(
				`Legacy delegate endpoint not found: ${scriptPath}. Set delegate.mode=subagents or install dispatch-endpoint.mjs.`,
			);
			return;
		}

		// Extract tasks args if explicitly typed "/delegate legacy <args>"
		const legacyArgs = isLegacyCommand ? trimmed.slice("legacy".length).trim() : trimmed;

		const configPathSetting =
			ctx.settings.get("delegate.legacyEndpointConfigPath") || "~/.claude/custom-endpoint.json";
		const defaultPath = path.resolve(os.homedir(), ".claude/custom-endpoint.json");
		const resolvedConfigPath = configPathSetting.startsWith("~")
			? path.resolve(os.homedir(), configPathSetting.slice(1).replace(/^[/\\]/, ""))
			: path.resolve(configPathSetting);

		let backupContent: string | null = null;
		let replaced = false;

		if (resolvedConfigPath !== defaultPath) {
			try {
				const customContent = await fs.readFile(resolvedConfigPath, "utf8");
				try {
					backupContent = await fs.readFile(defaultPath, "utf8");
				} catch {
					// file did not exist
				}
				await fs.mkdir(path.dirname(defaultPath), { recursive: true });
				await fs.writeFile(defaultPath, customContent, "utf8");
				replaced = true;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.showError(`Failed to prepare legacy config file from ${resolvedConfigPath}: ${message}`);
				return;
			}
		}

		ctx.ui.stop();
		try {
			const child = spawn(process.execPath, [scriptPath, legacyArgs], {
				cwd: ctx.sessionManager.getCwd(),
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			const { promise, resolve, reject } = Promise.withResolvers<number>();
			child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
			child.once("error", error => reject(error));
			await promise;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.showError(`Failed to execute legacy delegate: ${message}`);
		} finally {
			if (replaced) {
				try {
					if (backupContent !== null) {
						await fs.writeFile(defaultPath, backupContent, "utf8");
					} else {
						await fs.rm(defaultPath, { force: true });
					}
				} catch {
					// ignore
				}
			}
			ctx.ui.start();
			ctx.ui.requestRender(true);
		}
		return;
	}

	// 2. subagents mode
	const usingForm = parseUsingForm(trimmed);
	let task = trimmed;
	let userModelOverride: string | null = null;

	if (usingForm) {
		if (!usingForm.modelInput) {
			ctx.showError("Usage: /delegate using <alias-or-model> <task>");
			return;
		}
		const resolvedModel = await resolveSlashSubagentModel(ctx, usingForm.modelInput);
		if (!resolvedModel) {
			ctx.showError(`No available delegate model matched "${usingForm.modelInput}" for lane "fast".`);
			return;
		}
		userModelOverride = resolvedModel.selector;
		task = usingForm.task;
	}

	// 3. Classify task for browser automation
	const isBrowserTask = looksLikeBrowserAutomationTask(task);
	if (isBrowserTask) {
		const modelSelector = userModelOverride || "browser-fast";
		const resolvedModel = await resolveSlashSubagentModel(ctx, modelSelector);
		if (!resolvedModel) {
			ctx.showError(`No available delegate model matched "${modelSelector}" for lane "fast".`);
			return;
		}

		const promptText = [
			"You are the browser-operation subagent. Do not edit files. Primary browser tool is IX Bridge. Use only the local IX Bridge HTTP API at http://127.0.0.1:18086. Do not use the built-in browser tool. Execute the bounded browser subgoal below and yield a concise report with actions taken, observed URL/title, success/failure, and escalation reason if blocked.",
			"",
			`Subgoal: ${task}`,
			"",
			"Command shapes:",
			"POST /ix-bridge/command - Payload: { lane, session, action, args } where action can be navigate, click, fill, type, press, wait, get_url, get_title, screenshot, browser_execute, snapshot, status, list_tabs",
			"POST /ix-bridge/status - Payload: { action: 'status' }",
		].join("\n");

		// Spawn the browser-operation subagent type (IX Bridge surface)
		const id = await spawnSubagent(
			ctx,
			{
				modelOverride: resolvedModel.selector,
				thinkingLevel: ThinkingLevel.Inherit,
				name: "browser-operation",
				task: promptText,
			},
			"browser-operation",
		);
		if (id) {
			ctx.showStatus(`Spawned delegate lane ${id} (browser-operation) on ${resolvedModel.selector}.`);
		}
		return;
	}

	// 4. Multi-lane spawn for non-browser task
	if (userModelOverride) {
		// Single lane with override
		const id = await spawnSubagent(
			ctx,
			{
				modelOverride: userModelOverride,
				thinkingLevel: ThinkingLevel.Inherit,
				name: "fast",
				task,
			},
			"task",
		);
		if (id) {
			ctx.showStatus(`Spawned delegate lane ${id} (fast) on ${userModelOverride}.`);
		}
		return;
	}

	// Determine lanes
	let lanes = ctx.settings.get("delegate.lanes") as Record<string, string>;
	if (!lanes || Object.keys(lanes).length === 0) {
		lanes = {
			fast: ctx.settings.get("delegate.promptModel") || "pi/smol",
			verifier: ctx.settings.get("delegate.verifierModel") || "pi/task",
		};
	}

	// Validate all lanes first
	const resolvedLanes: Record<string, string> = {};
	for (const [laneName, selector] of Object.entries(lanes)) {
		const resolvedModel = await resolveSlashSubagentModel(ctx, selector);
		if (!resolvedModel) {
			ctx.showError(`No available delegate model matched "${selector}" for lane "${laneName}".`);
			return;
		}
		resolvedLanes[laneName] = resolvedModel.selector;
	}

	// Spawn each lane
	for (const [laneName, selector] of Object.entries(resolvedLanes)) {
		const id = await spawnSubagent(
			ctx,
			{
				modelOverride: selector,
				thinkingLevel: ThinkingLevel.Inherit,
				name: laneName,
				task,
			},
			"task",
		);
		if (id) {
			ctx.showStatus(`Spawned delegate lane ${id} (${laneName}) on ${selector}.`);
		}
	}
}
