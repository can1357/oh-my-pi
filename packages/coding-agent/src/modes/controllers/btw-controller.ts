import type { AssistantMessage } from "@pk-nerdsaver-ai/pi-ai";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };
import { copyToClipboard } from "../../utils/clipboard";
import { BtwPanelComponent } from "../components/btw-panel";
import type { InteractiveModeContext } from "../types";

interface BtwRequest {
	component: BtwPanelComponent;
	abortController: AbortController;
	question: string;
	leafId: string | null;
}

function assistantMessageWithReplyText(assistantMessage: AssistantMessage, replyText: string): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	let replacedText = false;
	for (const part of assistantMessage.content) {
		if (part.type === "thinking") {
			content.push({ type: "thinking", thinking: part.thinking });
			continue;
		}
		if (part.type === "redactedThinking") continue;
		if (part.type !== "text") {
			content.push(part);
			continue;
		}
		if (replacedText) continue;
		content.push({ type: "text", text: replyText });
		replacedText = true;
	}
	if (!replacedText) content.push({ type: "text", text: replyText });
	return { ...assistantMessage, content, providerPayload: undefined };
}

export class BtwController {
	#activeRequest: BtwRequest | undefined;
	#lastQuestion: string | undefined;
	#lastReplyText: string | undefined;
	#lastAssistantMessage: AssistantMessage | undefined;
	#lastLeafId: string | null | undefined;
	#branchInFlight = false;
	#lastCopyText: string | undefined;
	#copyInFlight = false;

	constructor(private readonly ctx: InteractiveModeContext) {}

	hasActiveRequest(): boolean {
		return this.#activeRequest !== undefined;
	}

	canBranch(): boolean {
		return (
			!this.#branchInFlight &&
			this.#activeRequest?.component.isBranchable() === true &&
			this.#lastQuestion !== undefined &&
			this.#lastReplyText !== undefined &&
			this.#lastAssistantMessage !== undefined &&
			this.#lastLeafId !== null &&
			this.#lastLeafId === this.ctx.sessionManager.getLeafId()
		);
	}

	canCopy(): boolean {
		return (
			!this.#copyInFlight && this.#activeRequest?.component.isCopyable() === true && this.#lastCopyText !== undefined
		);
	}

	async handleCopy(): Promise<boolean> {
		if (!this.canCopy() || this.#lastCopyText === undefined) return false;
		this.#copyInFlight = true;
		try {
			await copyToClipboard(this.#lastCopyText);
			this.ctx.showStatus("Copied /btw answer to clipboard");
			return true;
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return true;
		} finally {
			this.#copyInFlight = false;
		}
	}

	async handleBranch(): Promise<boolean> {
		if (!this.canBranch() || !this.#lastQuestion || !this.#lastAssistantMessage) return false;
		this.#branchInFlight = true;
		try {
			await this.ctx.handleBtwBranch(this.#lastQuestion, this.#lastAssistantMessage);
			return true;
		} finally {
			this.#branchInFlight = false;
		}
	}

	handleEscape(): boolean {
		if (!this.#activeRequest) return false;
		this.#closeActiveRequest({ abort: this.#activeRequest.abortController.signal.aborted === false });
		return true;
	}

	dispose(): void {
		this.#closeActiveRequest({ abort: true });
	}

	async start(question: string): Promise<void> {
		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) {
			this.ctx.showStatus("Usage: /btw <question>");
			return;
		}

		const model = this.ctx.session.model;
		if (!model) {
			this.ctx.showError("No active model available for /btw.");
			return;
		}

		this.#closeActiveRequest({ abort: true });

		const request: BtwRequest = {
			component: new BtwPanelComponent({ question: trimmedQuestion, tui: this.ctx.ui }),
			abortController: new AbortController(),
			question: trimmedQuestion,
			leafId: this.ctx.sessionManager.getLeafId(),
		};
		this.ctx.btwContainer.clear();
		this.ctx.btwContainer.addChild(request.component);
		this.ctx.ui.requestRender();
		this.#activeRequest = request;
		void this.#runRequest(request);
	}

	async #runRequest(request: BtwRequest): Promise<void> {
		try {
			const promptText = prompt.render(btwUserPrompt, { question: request.question });
			const { replyText, assistantMessage } = await this.ctx.session.runEphemeralTurn({
				promptText,
				onTextDelta: delta => {
					if (this.#isActiveRequest(request)) {
						request.component.appendText(delta);
					}
				},
				signal: request.abortController.signal,
			});

			if (!this.#isActiveRequest(request)) {
				return;
			}
			request.component.setAnswer(replyText);
			request.component.markComplete();
			const copyText = request.component.getCopyText();
			if (copyText !== undefined) {
				this.#lastQuestion = request.question;
				this.#lastReplyText = replyText;
				this.#lastCopyText = copyText;
				this.#lastAssistantMessage = assistantMessageWithReplyText(assistantMessage, replyText);
				this.#lastLeafId = request.leafId;
			} else {
				this.#clearCompletedState();
			}
		} catch (error) {
			if (!this.#isActiveRequest(request)) {
				return;
			}
			if (request.abortController.signal.aborted) {
				request.component.markAborted();
				return;
			}
			request.component.markError(error instanceof Error ? error.message : String(error));
		}
	}

	#closeActiveRequest(options: { abort: boolean }): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		this.#clearCompletedState();
		if (options.abort) {
			request.abortController.abort();
		}
		request.component.close();
		this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}

	#clearCompletedState(): void {
		this.#lastQuestion = undefined;
		this.#lastReplyText = undefined;
		this.#lastAssistantMessage = undefined;
		this.#lastCopyText = undefined;
		this.#lastLeafId = undefined;
	}

	#isActiveRequest(request: BtwRequest): boolean {
		return this.#activeRequest === request;
	}
}
