/**
 * Workspace session/checkpoint/rollback builtins.
 *
 * - `/sessions` — opens the fullscreen session manager (TUI) or prints a
 *   top-N text table (text/ACP).
 * - `/checkpoint` — create/list/show git-backed workspace checkpoints.
 * - `/rollback` — restore the workspace to a checkpoint (direct in text/ACP;
 *   interactive selector in TUI).
 *
 * The create/list/show and direct-rollback logic is exported as pure-ish
 * command functions (`runCheckpointCommand`, `runRollbackCommand`) so they can
 * be exercised against an injected checkpoint service + output sink.
 */
import * as path from "node:path";
import { formatAge, formatNumber } from "@oh-my-pi/pi-utils";
import {
	type CheckpointMeta,
	WorkspaceCheckpointService as DefaultCheckpointService,
	type WorkspaceCheckpointService,
	type WorkspaceRollbackSessionSurface,
} from "../checkpoints";
import { isSettingsInitialized, settings } from "../config/settings";
import { CheckpointListComponent } from "../modes/components/checkpoint-list";
import type { InteractiveModeContext } from "../modes/types";
import { enumerateSessions, type SessionRow } from "../session/session-control";
import { commandConsumed } from "./helpers/parse";
import type { SlashCommandRuntime, SlashCommandSpec } from "./types";

const ENABLE_HINT = "Checkpoints are disabled. Enable with: /config set checkpoints.enabled true";

function ageSeconds(modifiedMs: number): number {
	return Math.max(1, Math.round((Date.now() - modifiedMs) / 1000));
}

function displayName(row: SessionRow): string {
	const title = row.info.title?.trim();
	if (title) return title;
	const first = row.info.firstMessage && row.info.firstMessage !== "(no messages)" ? row.info.firstMessage.trim() : "";
	return first || "Untitled";
}

// ===========================================================================
// /checkpoint
// ===========================================================================

export interface CheckpointCommandDeps {
	sessionId: string;
	cwd: string;
	output: (text: string) => void | Promise<void>;
	service?: WorkspaceCheckpointService;
	/** Whether `checkpoints.enabled` is on. Defaults to true. */
	enabled?: boolean;
}

/** Run the `/checkpoint` command. Headless-safe (no TUI state). */
export async function runCheckpointCommand(args: string, deps: CheckpointCommandDeps): Promise<void> {
	const service = deps.service ?? DefaultCheckpointService.global();
	const trimmed = args.trim();
	const verb = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? "";

	if (deps.enabled === false) {
		await deps.output(ENABLE_HINT);
		return;
	}

	try {
		if (verb === "list") {
			await listCheckpoints(service, deps, trimmed.slice("list".length).trim());
			return;
		}
		if (verb === "show") {
			await showCheckpoint(service, deps, trimmed.slice("show".length).trim());
			return;
		}
		await createCheckpoint(service, deps, trimmed);
	} catch (error) {
		await deps.output(`Checkpoint error: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function createCheckpoint(
	service: WorkspaceCheckpointService,
	deps: CheckpointCommandDeps,
	rest: string,
): Promise<void> {
	const label = rest.replace(/^["']|["']$/g, "").trim() || undefined;
	const before = await service.latest(deps.sessionId, deps.cwd);
	const meta = await service.create({
		sessionId: deps.sessionId,
		cwd: deps.cwd,
		reason: "manual",
		label,
	});
	if (before && before.id === meta.id) {
		await deps.output(`Checkpoint ${meta.id} already current (unchanged)`);
		return;
	}
	const secondLine = meta.label ? `label: ${meta.label}` : `reason: ${meta.reason}`;
	await deps.output(`Checkpoint ${meta.id} created\n${secondLine}`);
}

async function listCheckpoints(
	service: WorkspaceCheckpointService,
	deps: CheckpointCommandDeps,
	_idPrefix: string,
): Promise<void> {
	const metas = await service.list(deps.sessionId, deps.cwd);
	if (metas.length === 0) {
		await deps.output("No checkpoints for this session.");
		return;
	}
	const lines = ["Checkpoints (newest first):"];
	for (const meta of metas) {
		const age = formatAge(ageSeconds(new Date(meta.createdAt).getTime()));
		const bytes = meta.bytesCaptured > 0 ? `${formatNumber(meta.bytesCaptured)} B` : "—";
		lines.push(`${meta.id}  ${meta.label ?? meta.reason}  ${age}  ${bytes}`);
	}
	await deps.output(lines.join("\n"));
}

async function showCheckpoint(
	service: WorkspaceCheckpointService,
	deps: CheckpointCommandDeps,
	idPrefix: string,
): Promise<void> {
	if (!idPrefix) {
		await deps.output("Usage: /checkpoint show <id-prefix>");
		return;
	}
	const meta = await service.get(deps.sessionId, deps.cwd, idPrefix);
	if (!meta) {
		await deps.output(`No checkpoint matches "${idPrefix}".`);
		return;
	}
	const created = new Date(meta.createdAt);
	const lines = [
		`Checkpoint ${meta.id}`,
		`  reason: ${meta.reason}`,
		`  label: ${meta.label ?? "—"}`,
		`  created: ${created.toISOString()}`,
		`  bytes captured: ${meta.bytesCaptured > 0 ? formatNumber(meta.bytesCaptured) : "—"}`,
		`  skipped files: ${meta.skippedFiles.length}`,
		`  repo: ${meta.identity.repoRoot}`,
		`  worktree: ${meta.identity.worktreePath}`,
		`  head: ${meta.headShaAtCapture ?? "—"}`,
		`  tree: ${meta.treeSha}`,
	];
	await deps.output(lines.join("\n"));
}

// ===========================================================================
// /rollback
// ===========================================================================

export interface RollbackCommandDeps {
	sessionId: string;
	cwd: string;
	output: (text: string) => void | Promise<void>;
	service?: WorkspaceCheckpointService;
	/** Surface notified after a successful rollback (transcript entry). */
	notify?: WorkspaceRollbackSessionSurface;
	/** Optional status line (TUI). */
	showStatus?: (text: string) => void;
}

/** Run `/rollback <id-prefix>` directly. Headless-safe. */
export async function runRollbackCommand(args: string, deps: RollbackCommandDeps): Promise<void> {
	const service = deps.service ?? DefaultCheckpointService.global();
	const idPrefix = args.trim();
	if (!idPrefix) {
		await deps.output("Usage: /rollback <checkpoint-id-prefix>");
		return;
	}
	try {
		const meta = await service.get(deps.sessionId, deps.cwd, idPrefix);
		if (!meta) {
			await deps.output(`No checkpoint matches "${idPrefix}".`);
			return;
		}
		const result = await service.rollback(meta, {
			sessionId: deps.sessionId,
			cwd: deps.cwd,
			notify: deps.notify,
		});
		if (!result.ok) {
			await deps.output(`Rollback failed: ${result.error ?? "unknown error"}`);
			return;
		}
		const lines = [
			`Rolled back to checkpoint ${meta.id}`,
			`Restored files: ${result.restoredFiles}`,
			`Removed files: ${result.removedFiles}`,
			`Safety checkpoint: ${result.safetyCheckpoint?.id ?? "—"}`,
		];
		await deps.output(lines.join("\n"));
		deps.showStatus?.(`Rolled back to ${meta.id}. Run /checkpoint list to inspect.`);
	} catch (error) {
		await deps.output(`Rollback error: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// ===========================================================================
// Slash command specs
// ===========================================================================

function checkpointEnabled(): boolean {
	return isSettingsInitialized() ? Boolean(settings.get("checkpoints.enabled")) : false;
}

function openRollbackOverlay(ctx: InteractiveModeContext): void {
	const sessionId = ctx.session.sessionId;
	const cwd = ctx.sessionManager.getCwd();
	const service = DefaultCheckpointService.global();
	const component = new CheckpointListComponent({
		sessionId,
		cwd,
		ui: ctx.ui,
		requestRender: () => ctx.ui.requestRender(),
		service,
		onRollback: async (meta: CheckpointMeta) => {
			const result = await service.rollback(meta, { sessionId, cwd, notify: ctx.sessionManager });
			if (!result.ok) {
				ctx.showStatus(`Rollback failed: ${result.error ?? "unknown error"}`);
				return;
			}
			ctx.showStatus(
				`Rolled back to ${meta.id} (restored ${result.restoredFiles}, removed ${result.removedFiles}). Run /checkpoint list to inspect.`,
			);
		},
		onClose: () => {
			overlay?.hide();
			ctx.ui.requestRender();
		},
	});
	const overlay = ctx.ui.showOverlay(component, { width: "100%", margin: 0, fullscreen: true });
	ctx.ui.setFocus(component);
}

export const BUILTIN_WORKSPACE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "sessions",
		icon: "session",
		description: "Manage sessions: open, archive, pause, kill, resume",
		handle: async (_command, runtime: SlashCommandRuntime) => {
			const cwd = runtime.cwd;
			const sessionFile = runtime.sessionManager.getSessionFile();
			const sessionDir = sessionFile ? path.dirname(sessionFile) : undefined;
			const rows = await enumerateSessions({ cwd, sessionDir, filter: "all", sort: "recent" });
			const top = rows.slice(0, 20);
			if (top.length === 0) {
				await runtime.output("No sessions found.");
				return commandConsumed();
			}
			const lines = ["Sessions:"];
			for (const row of top) {
				const state = row.isCurrent ? (row.liveState ?? "current") : (row.info.status ?? "-");
				const age = formatAge(ageSeconds(row.info.modified.getTime()));
				const cost = row.cost != null ? `$${formatNumber(row.cost)}` : "-";
				lines.push(`${row.isCurrent ? "*" : " "} ${displayName(row)}  ${state}  ${age}  ${cost}`);
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			runtime.ctx.showSessionsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "checkpoint",
		icon: "compress",
		description: "Create, list, or inspect a workspace checkpoint",
		allowArgs: true,
		acpDescription: "Create, list, or inspect a workspace checkpoint",
		acpInputHint: "[<label>] | list | show <id>",
		handle: async (command, runtime: SlashCommandRuntime) => {
			await runCheckpointCommand(command.args, {
				sessionId: runtime.session.sessionId,
				cwd: runtime.cwd,
				output: runtime.output,
				enabled: checkpointEnabled(),
			});
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			await runCheckpointCommand(command.args, {
				sessionId: runtime.ctx.session.sessionId,
				cwd: runtime.ctx.sessionManager.getCwd(),
				output: text => runtime.ctx.showStatus(text),
				enabled: checkpointEnabled(),
			});
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "rollback",
		icon: "history",
		description: "Roll the workspace back to a checkpoint",
		allowArgs: true,
		acpDescription: "Roll the workspace back to a checkpoint",
		acpInputHint: "<checkpoint-id-prefix>",
		handle: async (command, runtime: SlashCommandRuntime) => {
			await runRollbackCommand(command.args, {
				sessionId: runtime.session.sessionId,
				cwd: runtime.cwd,
				output: runtime.output,
				notify: runtime.sessionManager,
				showStatus: text => runtime.output(text),
			});
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const args = command.args.trim();
			if (!args) {
				openRollbackOverlay(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			const sessionId = runtime.ctx.session.sessionId;
			const cwd = runtime.ctx.sessionManager.getCwd();
			const service = DefaultCheckpointService.global();
			const meta = await service.get(sessionId, cwd, args);
			if (!meta) {
				runtime.ctx.showStatus(`No checkpoint matches "${args}".`);
				runtime.ctx.editor.setText("");
				return;
			}
			const ok = await runtime.ctx.showHookConfirm(
				"Rollback workspace",
				`Roll back to checkpoint ${meta.id} (${meta.label ?? meta.reason})? A safety checkpoint of the current state is created first.`,
			);
			if (!ok) {
				runtime.ctx.showStatus("Rollback cancelled");
				runtime.ctx.editor.setText("");
				return;
			}
			await runRollbackCommand(args, {
				sessionId,
				cwd,
				output: text => runtime.ctx.showStatus(text),
				notify: runtime.ctx.sessionManager,
				showStatus: text => runtime.ctx.showStatus(text),
			});
			runtime.ctx.editor.setText("");
		},
	},
];
