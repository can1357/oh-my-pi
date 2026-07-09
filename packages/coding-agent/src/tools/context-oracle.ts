import type { AgentTool, AgentToolResult } from "@pk-nerdsaver-ai/pi-agent-core";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import { ContextOracle, type ContextOracleResult, createContextOracleCache } from "../context-layer/context-oracle";
import type { Theme } from "../modes/theme/theme";
import contextOracleDescription from "../prompts/tools/context-oracle.md" with { type: "text" };
import type { ToolSession } from ".";

const contextOracleSchema = type({
	action: type('"ask" | "symbol" | "file" | "diagnostics" | "editImpact"').describe("context action"),
	"query?": type("string").describe("precise repo/code question"),
	"file?": type("string").describe("file path for file-scoped questions"),
	"line?": type("number").describe("1-indexed line for LSP symbol operations"),
	"symbol?": type("string").describe("symbol name at line or workspace symbol query"),
	"scope?": type("string").describe("diagnostics scope: file path, glob, or *"),
	"maxEvidence?": type("number>0").describe("maximum evidence items to return"),
	"maxAnswerChars?": type("number>0").describe("maximum answer characters"),
	"timeout?": type("number>0").describe("LSP timeout in seconds"),
});

type ContextOracleParams = typeof contextOracleSchema.infer;

export interface ContextOracleDetails extends ContextOracleResult {
	action: ContextOracleParams["action"];
	modelConfigured?: string;
	deterministicMode: boolean;
}

function renderResult(details: ContextOracleDetails): string {
	return JSON.stringify(
		{
			answer: details.answer,
			confidence: details.confidence,
			evidence: details.evidence,
			suggestedNextReads: details.suggestedNextReads,
			tokenEstimate: details.tokenEstimate,
			deterministicMode: details.deterministicMode,
			modelConfigured: details.modelConfigured,
		},
		null,
		2,
	);
}

export class ContextOracleTool implements AgentTool<typeof contextOracleSchema, ContextOracleDetails, Theme> {
	readonly name = "context_oracle";
	readonly label = "Context Oracle";
	readonly loadMode = "discoverable";
	readonly summary = "Ask a lightweight repo context service for cited LSP/file/diagnostic evidence";
	readonly description: string;
	readonly parameters = contextOracleSchema;
	readonly strict = true;
	readonly approval = "read" as const;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(contextOracleDescription);
	}

	static createIf(session: ToolSession): ContextOracleTool | null {
		return session.settings.get("contextLayer.enabled") ? new ContextOracleTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: ContextOracleParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ContextOracleDetails>> {
		this.session.contextOracleCache ??= createContextOracleCache();
		const oracle = new ContextOracle(this.session);
		const options = {
			file: params.file,
			line: params.line,
			symbol: params.symbol,
			scope: params.scope,
			maxEvidence: params.maxEvidence,
			maxAnswerChars: params.maxAnswerChars,
			timeout: params.timeout,
		};
		let result: ContextOracleResult;
		switch (params.action) {
			case "ask":
				result = await oracle.ask(params.query ?? params.symbol ?? params.file ?? "", options, signal);
				break;
			case "symbol":
				result = await oracle.getSymbolContext(params.symbol ?? params.query ?? "", options, signal);
				break;
			case "file":
				result = params.file
					? await oracle.getFileContext(params.file, options, signal)
					: { answer: "file is required", confidence: "low", evidence: [] };
				break;
			case "diagnostics":
				result = await oracle.getDiagnosticsContext(params.scope ?? params.file ?? "*", options, signal);
				break;
			case "editImpact":
				result = await oracle.getEditImpact(params.symbol ?? params.query ?? params.file ?? "", options, signal);
				break;
		}
		const model = this.session.settings.get("contextLayer.model");
		const details: ContextOracleDetails = {
			...result,
			action: params.action,
			deterministicMode: !model,
			...(model ? { modelConfigured: model } : {}),
		};
		return { content: [{ type: "text", text: renderResult(details) }], details };
	}
}

export { contextOracleSchema };
