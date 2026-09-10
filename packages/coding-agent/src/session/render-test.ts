import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { RenderWorkflow } from "./render-workflow";

export interface RenderTestOptions {
	repeat: number;
	/** Delay between simulated provider chunks, in milliseconds. */
	delayMs: number;
}

export function validateRenderTestOptions(options: RenderTestOptions): void {
	if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 100) {
		throw new RangeError("Render repetitions must be an integer between 1 and 100.");
	}
	if (!Number.isInteger(options.delayMs) || options.delayMs < 1 || options.delayMs > 1000) {
		throw new RangeError("Render delay must be an integer between 1 and 1000 ms.");
	}
}

/** Scripted provider deltas decoded by agent-core, followed by real sandboxed tool execution. */
export function createRenderTestAgent(model: Model, options: RenderTestOptions, workflow: RenderWorkflow): Agent {
	validateRenderTestOptions(options);
	let outputRow = 0;
	return new Agent({
		initialState: { model, tools: workflow.tools, systemPrompt: [] },
		getToolContext: () => workflow.context,
		streamFn: (selectedModel, context, streamOptions) => {
			const stream = new AssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: selectedModel.api,
				provider: selectedModel.provider,
				model: selectedModel.id,
				timestamp: Date.now(),
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const pause = async (ms: number): Promise<void> => {
				streamOptions?.signal?.throwIfAborted();
				await Bun.sleep(ms);
				streamOptions?.signal?.throwIfAborted();
			};
			const emitBlock = async (kind: "thinking" | "text", body: string): Promise<void> => {
				const contentIndex = message.content.length;
				const block =
					kind === "thinking" ? { type: "thinking" as const, thinking: "" } : { type: "text" as const, text: "" };
				message.content.push(block);
				stream.push({
					type: kind === "thinking" ? "thinking_start" : "text_start",
					contentIndex,
					partial: message,
				});
				for (let offset = 0; offset < body.length; offset += 48) {
					await pause(options.delayMs);
					const delta = body.slice(offset, offset + 48);
					if (block.type === "thinking") block.thinking += delta;
					else block.text += delta;
					stream.push({
						type: kind === "thinking" ? "thinking_delta" : "text_delta",
						contentIndex,
						delta,
						partial: message,
					});
				}
				stream.push({
					type: kind === "thinking" ? "thinking_end" : "text_end",
					contentIndex,
					content: body,
					partial: message,
				});
			};
			const produce = async (): Promise<void> => {
				const step = await workflow.next(context);
				await pause(Math.max(500, options.delayMs * 20));
				stream.push({ type: "start", partial: message });
				if (step?.introduction) {
					await emitBlock(
						"thinking",
						Array.from(
							{ length: 56 },
							(_, i) =>
								`THINK_${step.repetition}_${i + 1}: synthetic reasoning fixture; inspect wrapping, scrolling and transition to visible text.\n`,
						).join(""),
					);
					await emitBlock(
						"text",
						Array.from(
							{ length: 60 },
							() =>
								`PLAIN_${++outputRow}: plain streaming fixture with a deliberately long sentence that wraps on narrow terminals and preserves every numbered row.  \n`,
						).join(""),
					);
					const markdown: string[] = [`\n## Repetition ${step.repetition}: varied Markdown\n\n`];
					for (let row = 0; row < 60; row++)
						markdown.push(
							`> QUOTE_${++outputRow}: **Long streamed quotation**, *emphasis*, and \`inline code\`.  \n`,
						);
					markdown.push("\n```typescript\n");
					for (let row = 0; row < 60; row++)
						markdown.push(
							`const marker${++outputRow} = "CODE_${outputRow}: narrow and wide terminal wrapping — diacritice șțîâă";\n`,
						);
					markdown.push("```\n\n");
					for (let section = 0; section < 6; section++) {
						markdown.push(
							`### Section ${section + 1}\n\n`,
							`> QUOTE_${++outputRow}: **bold**, *emphasis*, and \`inline code\`.\n\n`,
						);
						markdown.push(
							"| Marker | State |\n| --- | --- |\n",
							`| TABLE_${++outputRow} | streaming |\n\n`,
							`- LIST_${++outputRow}: first item\n  - nested item with **formatting**\n\n`,
						);
					}
					await emitBlock("text", markdown.join(""));
				} else if (!step?.silent) {
					await emitBlock(
						"text",
						`\n\`\`\`text\nSTEP_${++outputRow}: ${step ? `repetition ${step.repetition}, ${step.calls.map(call => call.name).join(" → ")}` : "workflow complete"}\n\`\`\`\n`,
					);
				}
				for (const call of step?.calls ?? []) {
					const contentIndex = message.content.length;
					message.content.push(call);
					stream.push({ type: "toolcall_start", contentIndex, partial: message });
					const args = JSON.stringify(call.arguments);
					for (let offset = 0; offset < args.length; offset += 48) {
						await pause(options.delayMs);
						stream.push({
							type: "toolcall_delta",
							contentIndex,
							delta: args.slice(offset, offset + 48),
							partial: message,
						});
					}
					stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
				}
				message.stopReason = step ? "toolUse" : "stop";
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end(message);
			};
			void produce().catch(error => {
				const reason = streamOptions?.signal?.aborted ? "aborted" : "error";
				message.stopReason = reason;
				message.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason, error: message });
				stream.end(message);
			});
			return stream;
		},
	});
}
