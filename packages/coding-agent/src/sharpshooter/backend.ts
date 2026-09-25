import { rm } from "node:fs/promises";
import { logger } from "@oh-my-pi/pi-utils";
import type { MemoryBackend, MemoryBackendSearchItem, MemoryBackendStatus } from "../memory-backend/types";
import { truncateApproxTokens } from "../mnemopi/config";
import type { AgentSession } from "../session/agent-session";
import { runSharpshooterConsolidation } from "./consolidate";
import { maybeStartSharpshooterExtraction, resolveSharpshooterModel } from "./extract";
import {
	readSharpshooterState,
	sharpshooterBankDir,
	sharpshooterBankId,
	sharpshooterLockPath,
	sharpshooterMemoryFilePath,
} from "./paths";
import { listSharpshooterDeltas, sharpshooterQueueDepth } from "./queue";
import { startSharpshooterScheduler } from "./scheduler";
import { SHARPSHOOTER_MEMORY_FILES } from "./types";

interface SharpshooterSessionResources {
	unsubscribe: () => void;
	disposeScheduler: () => void;
}

interface SharpshooterFileSnapshot {
	name: (typeof SHARPSHOOTER_MEMORY_FILES)[number];
	content: string;
	lines: number;
	bytes: number;
}

const kSharpshooterSessionResources = Symbol("sharpshooter.sessionResources");

interface SharpshooterAgentSession extends AgentSession {
	[kSharpshooterSessionResources]?: SharpshooterSessionResources;
}

/** Release session-owned extraction and scheduler subscriptions. */
export function releaseSharpshooterSession(session: AgentSession): void {
	const ownedSession = session as SharpshooterAgentSession;
	const resources = ownedSession[kSharpshooterSessionResources];
	if (!resources) return;
	delete ownedSession[kSharpshooterSessionResources];
	try {
		resources.unsubscribe();
	} finally {
		resources.disposeScheduler();
	}
}

async function readMemoryFile(
	agentDir: string,
	cwd: string,
	name: (typeof SHARPSHOOTER_MEMORY_FILES)[number],
): Promise<SharpshooterFileSnapshot> {
	const file = Bun.file(sharpshooterMemoryFilePath(agentDir, cwd, name));
	if (!(await file.exists())) return { name, content: "", lines: 0, bytes: 0 };
	const content = await file.text();
	const normalized = content.trimEnd();
	return {
		name,
		content,
		lines: normalized ? normalized.split(/\r?\n/).length : 0,
		bytes: file.size,
	};
}

function readMemoryFiles(agentDir: string, cwd: string): Promise<SharpshooterFileSnapshot[]> {
	return Promise.all(SHARPSHOOTER_MEMORY_FILES.map(name => readMemoryFile(agentDir, cwd, name)));
}

function formatTimestamp(timestamp: number | undefined): string {
	return timestamp ? new Date(timestamp).toISOString() : "never";
}

export const sharpshooterBackend: MemoryBackend = {
	id: "sharpshooter",

	start(options): void {
		if (options.taskDepth > 0) return;
		const { session, settings, modelRegistry, agentDir } = options;
		try {
			releaseSharpshooterSession(session);
			const disposeScheduler = startSharpshooterScheduler({
				agentDir,
				cwd: settings.getCwd(),
				settings,
				modelRegistry,
				sessionId: session.sessionId,
			});
			try {
				const unsubscribe = session.subscribe(event => {
					// message_start is the only event that carries the committed user
					// prompt itself (agent_start fires before the transcript appends),
					// and it also covers mid-turn steering prompts.
					if (event.type !== "message_start" || event.message.role !== "user") return;
					maybeStartSharpshooterExtraction({ session, settings, modelRegistry, agentDir, message: event.message });
				});
				// Backend startup can race the first turn's events (print mode
				// submits while resolveMemoryBackend is still importing us).
				// Catch up when the newest transcript message is already a user prompt.
				if (session.messages.at(-1)?.role === "user") {
					maybeStartSharpshooterExtraction({ session, settings, modelRegistry, agentDir });
				}
				(session as SharpshooterAgentSession)[kSharpshooterSessionResources] = {
					unsubscribe,
					disposeScheduler,
				};
			} catch (error) {
				disposeScheduler();
				throw error;
			}
		} catch (error) {
			logger.warn("Sharpshooter: backend startup failed; memory backend inert.", { error: String(error) });
		}
	},

	async buildDeveloperInstructions(agentDir, settings): Promise<string | undefined> {
		const files = await readMemoryFiles(agentDir, settings.getCwd());
		const populated = files.filter(file => file.content.trim().length > 0);
		if (populated.length === 0) return undefined;
		const parts = [
			"Project decision memory (sharpshooter). These are friction-earned decisions; follow them unless the user overrides.",
		];
		for (const file of populated) parts.push(`## ${file.name.slice(0, -3)}\n\n${file.content.trim()}`);
		return truncateApproxTokens(parts.join("\n\n"), settings.get("sharpshooter.injectionTokenLimit"));
	},

	async clear(agentDir, cwd): Promise<void> {
		await rm(sharpshooterBankDir(agentDir, cwd), { recursive: true, force: true });
	},

	async enqueue(agentDir, cwd, session): Promise<void> {
		if (!session) {
			logger.debug("Sharpshooter: consolidation skipped without an active session.");
			return;
		}
		await runSharpshooterConsolidation({
			agentDir,
			cwd,
			settings: session.settings,
			modelRegistry: session.modelRegistry,
			sessionId: session.sessionId,
			force: true,
		});
	},

	async status({ agentDir, cwd }): Promise<MemoryBackendStatus> {
		const [files, queueDepth, state] = await Promise.all([
			readMemoryFiles(agentDir, cwd),
			sharpshooterQueueDepth(agentDir, cwd),
			readSharpshooterState(agentDir, cwd),
		]);
		const fileSummary = files.map(file => `${file.name}: ${file.lines} lines`).join(", ");
		return {
			backend: "sharpshooter",
			active: true,
			writable: false,
			searchable: true,
			scope: sharpshooterBankId(cwd),
			message: `${fileSummary}; queue: ${queueDepth}; last consolidated: ${formatTimestamp(state.lastConsolidatedAt)}`,
		};
	},

	async stats(agentDir, cwd): Promise<string> {
		const [files, sessions, state] = await Promise.all([
			readMemoryFiles(agentDir, cwd),
			listSharpshooterDeltas(agentDir, cwd),
			readSharpshooterState(agentDir, cwd),
		]);
		const queueDepth = sessions.reduce((sum, group) => sum + group.deltas.length, 0);
		const lines = ["# Sharpshooter Memory Stats", "", "## Files"];
		for (const file of files) lines.push(`- ${file.name}: ${file.lines} lines, ${file.bytes} bytes`);
		lines.push("", "## Queue", `- Total: ${queueDepth} deltas across ${sessions.length} sessions`);
		for (const group of sessions) lines.push(`- ${group.sessionId}: ${group.deltas.length} deltas`);
		lines.push("", "## Consolidation");
		if (state.lastResult) {
			lines.push(
				`- Last result: ${formatTimestamp(state.lastResult.at)} — ${state.lastResult.sessions} sessions, ${state.lastResult.deltas} deltas, ${state.lastResult.model}`,
			);
		} else {
			lines.push("- Last result: none");
		}
		lines.push(
			state.lastError
				? `- Last error: ${formatTimestamp(state.lastError.at)} — ${state.lastError.message}`
				: "- Last error: none",
		);
		return lines.join("\n");
	},

	async diagnose(agentDir, cwd, session): Promise<string> {
		const state = await readSharpshooterState(agentDir, cwd);
		const intervalMinutes = session?.settings.get("sharpshooter.intervalMinutes") ?? 5;
		const intervalMs = Math.max(0, intervalMinutes) * 60_000;
		const dueInMs = Math.max(0, state.lastConsolidatedAt + intervalMs - Date.now());
		const model = session ? await resolveSharpshooterModel(session.settings, session.modelRegistry) : undefined;
		return [
			"# Sharpshooter Diagnostics",
			"",
			`- Model: ${model ? `${model.provider}/${model.id}` : "unavailable"}`,
			`- Interval: ${intervalMinutes} minutes`,
			`- Lock: ${sharpshooterLockPath(agentDir, cwd)}`,
			`- Due in: ${Math.ceil(dueInMs / 1000)} seconds`,
			state.lastError
				? `- Last error: ${formatTimestamp(state.lastError.at)} — ${state.lastError.message}`
				: "- Last error: none",
		].join("\n");
	},

	async queuePreview({ agentDir, cwd }): Promise<string> {
		const sessions = await listSharpshooterDeltas(agentDir, cwd);
		if (sessions.length === 0) return "Queue is empty.";
		const lines = ["# Pending Sharpshooter Deltas"];
		for (const group of sessions) {
			lines.push("", `## Session ${group.sessionId}`);
			for (const { delta } of group.deltas) {
				lines.push(
					`- \`${delta.kind}\` ${delta.statement} _(friction: corrective=${delta.friction.corrective}, regression=${delta.friction.regression}, subtle=${delta.friction.subtle})_`,
				);
			}
		}
		return lines.join("\n");
	},

	async search({ agentDir, cwd }, query, options) {
		if (options?.signal?.aborted) {
			return { backend: "sharpshooter", query, count: 0, items: [], message: "Search aborted." };
		}
		const needle = query.toLowerCase();
		if (!needle) return { backend: "sharpshooter", query, count: 0, items: [] };
		const files = await readMemoryFiles(agentDir, cwd);
		const items: MemoryBackendSearchItem[] = [];
		for (const file of files) {
			for (const line of file.content.split(/\r?\n/)) {
				if (line.toLowerCase().includes(needle)) items.push({ content: line, source: file.name });
			}
		}
		const limit = Math.max(0, options?.limit ?? items.length);
		const limited = items.slice(0, limit);
		return { backend: "sharpshooter", query, count: limited.length, items: limited };
	},
};
