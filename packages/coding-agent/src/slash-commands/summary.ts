import * as path from "node:path";
import { Markdown } from "@oh-my-pi/pi-tui";
import { sanitizeErrorLine } from "@oh-my-pi/pi-tui/chrome/error-block";
import { replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import { getMarkdownTheme } from "@oh-my-pi/pi-tui/theme";
import { oneLineLabel } from "@oh-my-pi/pi-tui/tools/task";
import { formatAge, prompt } from "@oh-my-pi/pi-utils";
import summaryReferencePrompt from "../prompts/system/summary-reference.md" with { type: "text" };
import { extractTextContent } from "../commit/utils";
import { AgentRegistry, type AgentRegistryApi } from "../registry/agent-registry";
import { registerPersistedSubagents, sessionFileBelongsToRoot } from "../registry/persisted-agents";
import { isLocalAgentSession } from "../session/agent-session-handle";
import { isTerminalTextAssistantAnswer } from "../session/queued-messages";
import type { FileEntry } from "../session/session-entries";
import { visitEntriesFromFileStream } from "../session/session-loader";
import type { SessionManager } from "../session/session-manager";
import { clearSubmittedText, refuseImages } from "./helpers/draft";
import type { SlashCommandSpec } from "./types";

export interface SessionSummary {
	agentName: string;
	source: string;
	entryIndex: number;
	timestamp: number;
	text: string;
}

export async function listSessionSummaries(
	manager: Pick<SessionManager, "getEntries" | "getSessionFile" | "getSessionId">,
	registry: AgentRegistryApi,
	shouldContinue: () => boolean = () => true,
): Promise<SessionSummary[]> {
	const entries = manager.getEntries();
	const rootFile = manager.getSessionFile();
	const rootSource = rootFile ? path.resolve(rootFile) : manager.getSessionId();
	const summaries: SessionSummary[] = [];
	const collect = (entry: FileEntry, entryIndex: number, source: string, agentName: string): void => {
		if (entry.type !== "message" || !isTerminalTextAssistantAnswer(entry.message)) return;
		const messageTime = new Date(entry.message.timestamp).getTime();
		const entryTime = Date.parse(entry.timestamp);
		summaries.push({
			agentName,
			source,
			entryIndex,
			timestamp: Number.isFinite(messageTime) ? messageTime : Number.isFinite(entryTime) ? entryTime : 0,
			text: extractTextContent(entry.message),
		});
	};
	if (!shouldContinue()) return [];
	entries.forEach((entry, index) => collect(entry, index, rootSource, "main"));
	if (rootFile) {
		// Discovery must not publish parked refs into the live roster.
		const localRegistry = new AgentRegistry();
		for (const ref of registry.list()) {
			if (ref.kind === "sub" && ref.sessionFile && sessionFileBelongsToRoot(ref.sessionFile, rootFile)) {
				localRegistry.register(ref);
			}
		}
		await registerPersistedSubagents(localRegistry, rootFile, { hydrateHistory: false, shouldContinue });
		const seen = new Set([rootSource]);
		for (const ref of localRegistry.list()) {
			if (!shouldContinue()) return [];
			if (ref.kind !== "sub" || !ref.sessionFile) continue;
			const source = path.resolve(ref.sessionFile);
			if (seen.has(source)) continue;
			seen.add(source);
			const agentName = ref.displayName || ref.id;
			if (ref.session && isLocalAgentSession(ref.session)) {
				ref.session.sessionManager.getEntries().forEach((entry, index) => collect(entry, index, source, agentName));
			} else {
				let index = 0;
				await visitEntriesFromFileStream(
					source,
					entry => {
						if (entry.type !== "session") collect(entry, index++, source, agentName);
					},
					{ shouldContinue },
				);
			}
		}
	}
	return summaries.sort(
		(a, b) =>
			b.timestamp - a.timestamp ||
			(a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
			b.entryIndex - a.entryIndex,
	);
}

function displayTime(item: SessionSummary): string {
	return item.timestamp === 0 ? "Unknown time" : new Date(item.timestamp).toISOString();
}

export const SUMMARY_SLASH_COMMAND: SlashCommandSpec = {
	name: "summary",
	icon: "news",
	description: "Browse past summaries from this session's agent tree",
	allowArgs: true,
	subcommands: [{ name: "last", description: "Open the most recent summary" }],
	subcommandOptional: true,
	handleTui: async (command, runtime) => {
		if (refuseImages(command, runtime)) return;
		clearSubmittedText(runtime);
		const args = command.args.trim();
		const { ctx } = runtime;
		if (args !== "" && args !== "last") {
			ctx.showWarning("Usage: /summary [last]");
			return;
		}
		const session = ctx.session;
		const manager = ctx.sessionManager;
		const id = manager.getSessionId();
		const file = manager.getSessionFile();
		const shouldContinue = () =>
			ctx.session === session &&
			ctx.sessionManager === manager &&
			manager.getSessionId() === id &&
			manager.getSessionFile() === file;
		try {
			const items = await listSessionSummaries(manager, AgentRegistry.global(), shouldContinue);
			if (!shouldContinue()) return;
			if (!items.length) {
				ctx.showStatus("No past summaries in this session's agent tree.", { dim: true });
				return;
			}
			let item: SessionSummary | undefined = items[0];
			if (!args) {
				const now = Date.now();
				const byLabel = new Map(
					items.map((summary, index) => [
						`${index + 1}. ${summary.timestamp ? formatAge(Math.max(1, Math.round((now - summary.timestamp) / 1000))) : "Unknown time"} · ${oneLineLabel(summary.agentName)}`,
						summary,
					]),
				);
				const selected = await ctx.showHookSelector(
					"Session summaries",
					Array.from(byLabel, ([label, summary]) => ({
						label,
						preview: summary.text,
					})),
				);
				if (!shouldContinue()) return;
				item = selected === undefined ? undefined : byLabel.get(selected);
			}
			if (!item) return;
			const summary = item;
			const reference = prompt.compile(summaryReferencePrompt)({
				agentName: oneLineLabel(summary.agentName),
				timestamp: displayTime(summary),
				lines: summary.text.split(/\r?\n/),
			});
			const action = {
				label: "Inject",
				keys: ctx.keybindings.getKeys("app.summary.inject"),
				closeOnAction: true,
				onAction: () => {
					if (!shouldContinue() || ctx.focusedAgentId || ctx.collabGuest || session.isSessionTransitioning) return;
					if (!ctx.editor.getExpandedText().includes(reference.trim())) {
						ctx.editor.insertText(reference, { at: "start" });
						ctx.editor.moveToMessageEnd();
					}
					ctx.ui.requestRender();
				},
			};
			ctx.showCommandReport({
				title: `Summary · ${oneLineLabel(item.agentName)}`,
				body: new Markdown(replaceTabs(item.text), 0, 0, getMarkdownTheme()),
				action: ctx.focusedAgentId || ctx.collabGuest ? undefined : action,
			});
		} catch (error) {
			if (shouldContinue()) ctx.showError(sanitizeErrorLine(error));
		}
	},
};
