import * as path from "node:path";
import { CONFIG_DIR_NAME, prompt } from "@oh-my-pi/pi-utils";
import { invalidate as invalidateCapabilityCache } from "../../capability";
import type { Rule } from "../../capability/rule";
import omfgUserPrompt from "../../prompts/system/omfg-user.md" with { type: "text" };
import { TtsrToolInspector } from "../../session/ttsr-outputs";
import { shortenPath } from "../../utils/render-utils";
import { OmfgPanel, OmfgPanelState } from "../../ui/overlays/panels/omfg-panel";
import type { InteractiveModeContext } from "../types";
import {
	buildOmfgRuleForPath,
	extractGeneratedRuleJson,
	historyOutputs,
	type OmfgRuleSourceLevel,
	type ParsedGeneratedRule,
	parseGeneratedRule,
	validateParsedRuleAgainstAssistantHistory,
} from "./omfg-rule";

interface OmfgRequest {
	panel: OmfgPanelState;
	abortController: AbortController;
	complaint: string;
}

interface OmfgCandidate extends ParsedGeneratedRule {
	validated: boolean;
}

interface GenerateCandidateOptions {
	initialFeedback?: string;
	previousRule?: string;
}

type SaveCandidateResult = { kind: "saved" | "aborted" | "rejected" } | { kind: "amend"; feedback: string };

const MAX_ATTEMPTS = 3;
const PROJECT_OPTION = "This project (.omp/rules)";
const GLOBAL_OPTION = "Global — all projects (~/.omp/agent/rules)";
const AMEND_OPTION = "Amend with feedback…";
/** Keep /omfg prompts in the composer slot: a picker sheet would cover the candidate rule above it. */
const OMFG_DIALOG = { inline: true } as const;

export class OmfgController {
	#activeRequest: OmfgRequest | undefined;
	readonly #inspector: TtsrToolInspector;

	constructor(private readonly ctx: InteractiveModeContext) {
		this.#inspector = new TtsrToolInspector(
			() => ctx.session.agent.state.tools,
			() => ctx.sessionManager.getCwd(),
		);
	}

	hasActiveRequest(): boolean {
		return this.#activeRequest !== undefined;
	}

	handleEscape(): boolean {
		if (!this.#activeRequest) return false;
		this.#closeActiveRequest({ abort: this.#activeRequest.abortController.signal.aborted === false });
		return true;
	}

	dispose(): void {
		this.#closeActiveRequest({ abort: true });
	}

	async start(complaint: string): Promise<void> {
		const trimmedComplaint = complaint.trim();
		if (!trimmedComplaint) {
			this.ctx.showStatus("Usage: /omfg <complaint>");
			return;
		}

		const model = this.ctx.session.model;
		if (!model) {
			this.ctx.showError("No active model available for /omfg.");
			return;
		}

		this.#closeActiveRequest({ abort: true });

		const request: OmfgRequest = {
			panel: new OmfgPanelState(),
			abortController: new AbortController(),
			complaint: trimmedComplaint,
		};
		this.ctx.shell.dock.slot("omfg").set(() =>
			OmfgPanel({
				complaint: trimmedComplaint,
				state: request.panel,
				onCancel: () => this.handleEscape(),
				onDismiss: () => this.handleEscape(),
			}),
		);
		this.#activeRequest = request;
		void this.#runRequest(request);
	}

	async #runRequest(request: OmfgRequest): Promise<void> {
		try {
			let candidate = await this.#generateCandidate(request);
			for (;;) {
				if (!this.#isActiveRequest(request)) return;
				if (!candidate) {
					request.panel.markError("The model did not return a valid TTSR rule.");
					return;
				}

				if (!candidate.validated) {
					request.panel.setStatus("confirming", "Couldn't confirm a conversation match.");
					const shouldSave = await this.ctx.showHookConfirm(
						"Validation",
						"Couldn't confirm this rule matches the conversation. Save anyway?",
						OMFG_DIALOG,
					);
					if (!this.#isActiveRequest(request)) return;
					if (!shouldSave) {
						request.panel.markRejected();
						return;
					}
				}

				const saveResult = await this.#saveCandidate(request, candidate);
				if (!this.#isActiveRequest(request)) return;
				if (saveResult.kind !== "amend") {
					return;
				}

				candidate = await this.#generateCandidate(request, {
					initialFeedback: `User requested this amendment before saving:\n${saveResult.feedback}`,
					previousRule: candidate.fileContent,
				});
			}
		} catch (error) {
			if (!this.#isActiveRequest(request)) {
				return;
			}
			if (request.abortController.signal.aborted) {
				request.panel.markAborted();
				return;
			}
			request.panel.markError(error instanceof Error ? error.message : String(error));
		}
	}

	async #generateCandidate(
		request: OmfgRequest,
		options: GenerateCandidateOptions = {},
	): Promise<OmfgCandidate | undefined> {
		const failedAttempts = options.initialFeedback ? [options.initialFeedback] : [];
		let previousRule = options.previousRule;
		let lastCandidate: ParsedGeneratedRule | undefined;

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			if (this.#shouldStop(request)) return undefined;
			request.panel.setRule("");
			request.panel.setStatus("generating", `Attempt ${attempt}/${MAX_ATTEMPTS} · generating…`);
			const promptText = prompt.render(omfgUserPrompt, {
				complaint: request.complaint,
				feedback: failedAttempts.length > 0 ? failedAttempts.join("\n\n") : undefined,
				previousRule,
			});
			const { replyText } = await this.ctx.session.runEphemeralTurn({
				promptText,
				purpose: "omfg",
				dedupeReply: false,
				onTextDelta: delta => {
					if (this.#isActiveRequest(request)) {
						request.panel.appendDraft(delta);
					}
				},
				signal: request.abortController.signal,
			});
			if (this.#shouldStop(request)) return undefined;

			const parsed = parseGeneratedRule(replyText);
			if ("error" in parsed) {
				const failedRule = extractGeneratedRuleJson(replyText) ?? replyText.trim();
				failedAttempts.push(
					`Attempt ${attempt} failed: invalid rule (${parsed.error}).\nFailed candidate:\n${failedRule}`,
				);
				previousRule = failedRule;
				request.panel.setStatus("validating", `Attempt ${attempt}/${MAX_ATTEMPTS} · ${parsed.error}`);
				continue;
			}

			request.panel.setRule(parsed.fileContent);
			request.panel.setStatus("validating", `Attempt ${attempt}/${MAX_ATTEMPTS} · validating…`);
			const validated = await validateParsedRuleAgainstAssistantHistory(
				parsed,
				historyOutputs(this.ctx.session.messages, this.#inspector),
				parsed.rule.question !== undefined ? this.ctx.session.ruleJudge() : undefined,
			);
			if (this.#shouldStop(request)) return undefined;
			if (validated.repairedCondition) {
				request.panel.setRule(validated.candidate.fileContent);
			}
			if (validated.validation.matched) {
				return { ...validated.candidate, validated: true };
			}
			// Regenerating cannot conjure a judge; let the user decide on this candidate.
			if (validated.validation.judgeUnavailable) {
				return { ...validated.candidate, validated: false };
			}

			lastCandidate = validated.candidate;
			const failure =
				validated.validation.feedback ?? "The rule condition did not match any earlier assistant output.";
			failedAttempts.push(
				`Attempt ${attempt} failed validation:\n${failure}\nFailed candidate:\n${validated.candidate.fileContent}`,
			);
			previousRule = validated.candidate.fileContent;
		}

		return lastCandidate ? { ...lastCandidate, validated: false } : undefined;
	}

	async #saveCandidate(request: OmfgRequest, candidate: OmfgCandidate): Promise<SaveCandidateResult> {
		if (this.#shouldStop(request)) return { kind: "aborted" };

		for (;;) {
			request.panel.setStatus("saving", "Choose where to save or amend the TTSR rule…");
			const location = await this.ctx.showHookSelector(
				"Save TTSR rule where?",
				[PROJECT_OPTION, GLOBAL_OPTION, AMEND_OPTION],
				OMFG_DIALOG,
			);
			if (!this.#isActiveRequest(request)) return { kind: "aborted" };
			if (!location) {
				request.panel.markAborted();
				this.#closeActiveRequest({ abort: false });
				return { kind: "aborted" };
			}

			if (location === AMEND_OPTION) {
				request.panel.setStatus("confirming", "Describe how to amend the rule…");
				const amendment = await this.ctx.showHookInput(
					"Amend TTSR rule",
					"e.g. Make it specific to Ruby string eval in tool:write(*.rb)",
				);
				if (!this.#isActiveRequest(request)) return { kind: "aborted" };
				const feedback = amendment?.trim();
				if (!feedback) continue;
				return { kind: "amend", feedback };
			}

			const target = this.#resolveTarget(location, candidate.rule.name);
			if (await Bun.file(target.filePath).exists()) {
				const shouldOverwrite = await this.ctx.showHookConfirm(
					"Overwrite TTSR rule?",
					`${shortenPath(target.filePath)} already exists. Overwrite it?`,
					OMFG_DIALOG,
				);
				if (!this.#isActiveRequest(request)) return { kind: "aborted" };
				if (!shouldOverwrite) {
					request.panel.markRejected();
					return { kind: "rejected" };
				}
			}

			request.panel.setStatus("saving", `Saving ${candidate.rule.name}…`);
			await Bun.write(target.filePath, candidate.fileContent);
			// Drop the cached directory snapshot the discovery layer reads, so the next
			// session-scoped rebuild's rule rediscovery observes this new file instead of
			// a stale listing that would make `replaceTtsrRules` evict the live rule
			// registered below (issue #10940 review). Invalidating the file clears its
			// parent (rules dir); invalidating that dir clears its parent (the config dir)
			// so a first-ever rule in a freshly created `.omp/rules` is still discovered.
			invalidateCapabilityCache(target.filePath);
			invalidateCapabilityCache(path.dirname(target.filePath));
			if (!this.#isActiveRequest(request)) return { kind: "aborted" };

			const savedRule = buildOmfgRuleForPath(
				candidate.rule.name,
				candidate.fileContent,
				target.filePath,
				target.level,
			);
			this.#registerLive(savedRule);
			// Dismiss on success; errors keep the panel so the user can read them.
			this.#closeActiveRequest({ abort: false });
			this.ctx.showStatus(`Saved TTSR rule to ${shortenPath(target.filePath)}`);
			return { kind: "saved" };
		}
	}

	#resolveTarget(location: string, ruleName: string): { filePath: string; level: OmfgRuleSourceLevel } {
		if (location === GLOBAL_OPTION) {
			return {
				filePath: path.join(this.ctx.settings.getAgentDir(), "rules", `${ruleName}.md`),
				level: "user",
			};
		}
		return {
			filePath: path.join(this.ctx.sessionManager.getCwd(), CONFIG_DIR_NAME, "rules", `${ruleName}.md`),
			level: "project",
		};
	}

	#registerLive(rule: Rule): void {
		this.ctx.session.ttsrManager?.addRule(rule);
	}

	#closeActiveRequest(options: { abort: boolean }): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		if (options.abort) {
			request.abortController.abort();
		}
		request.panel.close();
		this.ctx.shell.dock.slot("omfg").clear();
	}

	#isActiveRequest(request: OmfgRequest): boolean {
		return this.#activeRequest === request;
	}

	#shouldStop(request: OmfgRequest): boolean {
		return !this.#isActiveRequest(request) || request.abortController.signal.aborted;
	}
}
