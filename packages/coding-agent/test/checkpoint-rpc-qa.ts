import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type {
	BranchSummaryEntry,
	CustomMessageEntry,
	SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";

function extractText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

function getToolSequence(events: AgentEvent[]): string[] {
	return events
		.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
		)
		.map(event => event.toolName);
}

function getLastAssistant(messages: AgentMessage[]): Extract<AgentMessage, { role: "assistant" }> | undefined {
	return [...messages]
		.reverse()
		.find((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant");
}

async function main() {
	const sessionDir = path.join(os.tmpdir(), `omp-checkpoint-rpc-qa-${Date.now()}`);
	const projectRoot = path.join(import.meta.dir, "..");
	const client = new RpcClient({
		cliPath: path.join(projectRoot, "src/cli.ts"),
		cwd: projectRoot,
		env: { PI_CODING_AGENT_DIR: sessionDir },
		args: ["--no-color"],
	});

	const streamedEvents: AgentEvent[] = [];
	client.onEvent(event => {
		streamedEvents.push(event);
	});

	try {
		await client.start();
		const availableModels = await client.getAvailableModels();
		const providerKeyMap: Record<string, string | undefined> = {
			anthropic: Bun.env.ANTHROPIC_API_KEY,
			openai: Bun.env.OPENAI_API_KEY,
			google: Bun.env.GEMINI_API_KEY ?? Bun.env.GOOGLE_API_KEY,
			xai: Bun.env.XAI_API_KEY,
			zai: Bun.env.ZAI_API_KEY,
			perplexity: Bun.env.PERPLEXITY_API_KEY,
		};
		const preferredProviders = ["zai", "google", "anthropic", "openai", "xai", "perplexity"];
		for (const provider of preferredProviders) {
			if (!providerKeyMap[provider]) continue;
			const providerModels = availableModels.filter(candidate => candidate.provider === provider);
			if (providerModels.length === 0) continue;
			const model =
				provider === "openai"
					? (providerModels.find(candidate => candidate.id.startsWith("gpt")) ?? providerModels[0])
					: providerModels[0];
			await client.setModel(provider, model.id);
			break;
		}

		const prompts = [
			[
				"QA instruction. Follow exactly:",
				"1) Call checkpoint with goal 'Validate rewind context behavior in RPC mode'.",
				"2) During that checkpoint, call find with pattern 'src/modes/rpc/*.ts'.",
				"3) Call read on 'src/modes/rpc/rpc-mode.ts' with limit 20.",
				"4) Call rewind with report containing two bullet points: findings and risks.",
				"5) Final assistant response must be exactly DONE.",
			].join("\n"),
			[
				"You did not complete QA steps.",
				"Now do only tool workflow:",
				"- checkpoint(goal='Validate rewind context behavior in RPC mode')",
				"- find(pattern='src/modes/rpc/*.ts')",
				"- read(path='src/modes/rpc/rpc-mode.ts', limit=20)",
				"- rewind(report with bullets 'findings' and 'risks')",
				"Then respond exactly DONE.",
			].join("\n"),
			[
				"Final attempt: MUST call checkpoint and rewind now, then reply DONE.",
				"Do not explain before tool calls.",
			].join("\n"),
		];

		for (const prompt of prompts) {
			await client.promptAndWait(prompt, undefined, 120000);
			const sequence = getToolSequence(streamedEvents);
			if (sequence.includes("checkpoint") && sequence.includes("rewind")) {
				break;
			}
		}

		const toolSequence = getToolSequence(streamedEvents);
		const messages = await client.getMessages();
		const stats = await client.getSessionStats();
		if (!stats.sessionFile) {
			throw new Error("Session file was not created.");
		}

		const sessionContent = await Bun.file(stats.sessionFile).text();
		const entries = parseSessionEntries(sessionContent);

		const sessionMessages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
		const branchSummaries = entries.filter((entry): entry is BranchSummaryEntry => entry.type === "branch_summary");
		const customMessages = entries.filter((entry): entry is CustomMessageEntry => entry.type === "custom_message");

		const hasCheckpoint = toolSequence.includes("checkpoint");
		const hasRewind = toolSequence.includes("rewind");
		const hasGlob = toolSequence.includes("glob");
		const hasRead = toolSequence.includes("read");

		const activeHasRewindReport = messages.some(
			message => message.role === "custom" && (message as { customType?: string }).customType === "rewind-report",
		);

		const activeToolResults = messages
			.filter((message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult")
			.map(message => message.toolName);

		const activeHasRewindResult = activeToolResults.includes("rewind");
		const activeHasGlobResult = activeToolResults.includes("glob");
		const activeHasReadResult = activeToolResults.includes("read");

		const rewindReportEntries = customMessages.filter(entry => entry.customType === "rewind-report");
		const rewindReportTexts = rewindReportEntries
			.map(entry => (typeof entry.content === "string" ? entry.content : ""))
			.filter(text => text.length > 0);
		const branchSummaryHasReport = branchSummaries.some(summary => rewindReportTexts.includes(summary.summary));
		const lastAssistant = getLastAssistant(messages);
		const lastAssistantText = lastAssistant ? extractText(lastAssistant) : "";
		const lastAssistantStopReason = lastAssistant?.stopReason ?? "(none)";
		const lastAssistantError = lastAssistant?.errorMessage ?? "";

		console.log("=== Checkpoint RPC QA Report ===");
		console.log(`Session dir: ${sessionDir}`);
		console.log(`Session file: ${stats.sessionFile}`);
		console.log(`Tool sequence: ${toolSequence.join(" -> ") || "(none)"}`);
		console.log(`Active message count: ${messages.length}`);
		console.log(`Session message entries: ${sessionMessages.length}`);
		console.log(`Branch summary entries: ${branchSummaries.length}`);
		console.log(`Rewind report custom entries: ${rewindReportEntries.length}`);
		console.log(`Last assistant stopReason: ${lastAssistantStopReason}`);
		console.log(`Last assistant text: ${lastAssistantText}`);
		if (lastAssistantError) {
			console.log(`Last assistant error: ${lastAssistantError}`);
		}
		console.log(`Active tool results: ${activeToolResults.join(", ") || "(none)"}`);

		if (!hasCheckpoint || !hasRewind) {
			throw new Error("Agent did not execute both checkpoint and rewind.");
		}
		if (!hasGlob || !hasRead) {
			throw new Error("Agent did not perform requested exploratory find/read inside checkpoint.");
		}
		if (!activeHasRewindReport) {
			throw new Error("Active context missing rewind-report custom message after rewind.");
		}
		if (activeHasRewindResult) {
			throw new Error("Active context still contains rewind tool result; rewind did not prune it.");
		}
		if (activeHasGlobResult || activeHasReadResult) {
			throw new Error("Active context still contains exploratory find/read tool results after rewind.");
		}
		if (rewindReportEntries.length === 0) {
			throw new Error("Session entries missing persisted rewind-report custom_message entry.");
		}
		if (!branchSummaryHasReport) {
			throw new Error("Session branch_summary does not contain rewind report content.");
		}
		if (lastAssistantText !== "DONE") {
			throw new Error(`Final assistant response mismatch; expected DONE, got: ${lastAssistantText}`);
		}

		console.log("PASS: Rewind pruned active context while preserving audit trail in session entries.");
	} finally {
		client.stop();
		if (fs.existsSync(sessionDir)) {
			fs.rmSync(sessionDir, { recursive: true, force: true });
		}
	}
}

main()
	.then(() => {
		process.exit(0);
	})
	.catch(error => {
		console.error("FAIL:", error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
