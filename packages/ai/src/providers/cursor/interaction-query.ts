import {
	AgentClientMessageSchema,
	type AskQuestionArgs,
	type AskQuestionInteractionQuery,
	AskQuestionInteractionResponseSchema,
	AskQuestionRejectedSchema,
	type AskQuestionResult,
	AskQuestionResultSchema,
	AskQuestionSuccess_AnswerSchema,
	AskQuestionSuccessSchema,
	CreatePlanErrorSchema,
	CreatePlanRequestResponseSchema,
	CreatePlanResultSchema,
	ExaFetchRequestResponse_ApprovedSchema,
	ExaFetchRequestResponseSchema,
	ExaSearchRequestResponse_ApprovedSchema,
	ExaSearchRequestResponseSchema,
	type InteractionQuery,
	type InteractionResponse,
	InteractionResponseSchema,
	SwitchModeRequestResponse_RejectedSchema,
	SwitchModeRequestResponseSchema,
	WebFetchRequestResponse_ApprovedSchema,
	WebFetchRequestResponseSchema,
	WebSearchRequestResponse_ApprovedSchema,
	WebSearchRequestResponseSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { $env, disambiguateDisplayLabels, logger } from "@oh-my-pi/pi-utils";
import type { CursorAskAnswer } from "../../types";
import { frameConnectMessage } from "../connect-frame";

const NOT_IMPLEMENTED_SUFFIX = "not implemented by this client";

type ProtoUnknownField = { no: number; wireType: number; data: Uint8Array };
type ProtoUnknownBag = { $unknown?: ProtoUnknownField[] };

interface CursorInteractionWriter {
	write(frame: Uint8Array): void;
}

type InteractionQueryCase = NonNullable<InteractionQuery["query"]["case"]>;
type InteractionResult = Exclude<InteractionResponse["result"], { case: undefined; value?: undefined }>;

function isProtoUnknownField(value: unknown): value is ProtoUnknownField {
	if (!value || typeof value !== "object") return false;
	if (!("no" in value) || !("wireType" in value) || !("data" in value)) return false;
	return typeof value.no === "number" && typeof value.wireType === "number" && value.data instanceof Uint8Array;
}

/** Well-formed protobuf-es `$unknown` entries on `message`; anything else on the bag is ignored. */
export function protoUnknownFields(message: object): ProtoUnknownField[] {
	if (!("$unknown" in message) || !Array.isArray(message.$unknown)) return [];
	return message.$unknown.filter(isProtoUnknownField);
}

function attachUnknownApprovedField(response: InteractionResponse, fieldNo: number): void {
	const bag: ProtoUnknownBag = response; // protobuf-es unnamed oneof members live on $unknown
	// protobuf-es writes tag + raw(data); LEN fields need the length prefix in data.
	const field: ProtoUnknownField = { no: fieldNo, wireType: 2, data: new Uint8Array([0x02, 0x0a, 0x00]) };
	const existing = bag.$unknown;
	if (Array.isArray(existing)) {
		existing.push(field);
		return;
	}
	bag.$unknown = [field];
}

function log(type: string, subtype?: string, data?: unknown): void {
	if (!$env.DEBUG_CURSOR) return;
	logger.debug(`cursor interaction: ${type}${subtype ? `: ${subtype}` : ""}`, {
		...($env.DEBUG_CURSOR === "2" || $env.DEBUG_CURSOR === "verbose" ? { data } : undefined),
	});
}

function sendInteractionResponse(h2Request: CursorInteractionWriter, queryId: number, result: InteractionResult): void {
	const response = create(InteractionResponseSchema, { id: queryId, result });
	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "interactionResponse", value: response },
	});
	h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
	log("interactionResponse", result.case, { id: queryId });
}

function sendUnknownApprovedInteractionResponse(
	h2Request: CursorInteractionWriter,
	queryId: number,
	fieldNo: number,
): void {
	// `approved {}` on the matching response oneof: field N, empty message whose
	// first member is field 1 (`approved`) with an empty length-delimited payload.
	const response = create(InteractionResponseSchema, { id: queryId });
	attachUnknownApprovedField(response, fieldNo);
	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "interactionResponse", value: response },
	});
	h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
	log("interactionResponse", "unknownApproved", { id: queryId, field: fieldNo });
}

/** Answers a native `AskQuestion` query; resolves with the result Cursor receives. */
export type CursorAskQuestionResponder = (query: AskQuestionInteractionQuery) => Promise<AskQuestionResult>;

export function askQuestionRejected(reason: string): AskQuestionResult {
	return create(AskQuestionResultSchema, {
		result: { case: "rejected", value: create(AskQuestionRejectedSchema, { reason }) },
	});
}

/** Labels the local `ask` dialog keeps for its own rows, by whether the question is multi-select. */
export type CursorAskReservedLabels = (multi: boolean) => readonly string[];

/** Local `ask` kwargs for a Cursor `AskQuestion`, plus each question's display label → Cursor option id. */
export interface CursorAskPlan {
	args: Record<string, unknown>;
	optionIds: Map<string, string>[];
}

/**
 * Cursor allows duplicate labels and question ids; `ask` rejects them and
 * answers by label. Colliding labels — including the dialog's own rows — and
 * missing or repeated ids take a numeric suffix, so every Cursor option keeps
 * a label that maps back to its id.
 */
export function cursorAskToolArgs(
	args: AskQuestionArgs | undefined,
	reservedLabels?: CursorAskReservedLabels,
): CursorAskPlan {
	const source = args?.questions ?? [];
	const questionIds = disambiguateDisplayLabels(
		source.map((question, index) => question.id || `q${index + 1}`),
		[],
	);
	const optionIds: Map<string, string>[] = [];
	const questions = source.map((question, index) => {
		const multi = question.allowMultiple;
		const labels = disambiguateDisplayLabels(
			question.options.map(option => option.label),
			reservedLabels?.(multi) ?? [],
		);
		optionIds.push(new Map(labels.map((label, i) => [label, question.options[i]!.id])));
		const options = labels.map(label => ({ label }));
		return {
			id: questionIds[index],
			question: question.prompt,
			options,
			...(multi ? { multi: true } : {}),
		};
	});
	return { args: { i: args?.title || "Question from the model", questions }, optionIds };
}

/** `ask` answers by label, Cursor by option id. A label the question does not carry is dropped rather than guessed. */
export function askQuestionSuccess(
	args: AskQuestionArgs | undefined,
	optionIds: Map<string, string>[],
	answers: CursorAskAnswer[],
): AskQuestionResult {
	const questions = args?.questions ?? [];
	return create(AskQuestionResultSchema, {
		result: {
			case: "success",
			value: create(AskQuestionSuccessSchema, {
				answers: questions.map((question, index) => {
					const answer = answers[index];
					const idByLabel = optionIds[index];
					return create(AskQuestionSuccess_AnswerSchema, {
						questionId: question.id,
						selectedOptionIds: (answer?.selectedOptions ?? []).flatMap(label => idByLabel?.get(label) ?? []),
						freeformText: answer?.customInput ?? "",
					});
				}),
			}),
		},
	});
}

/**
 * Answer a Cursor `interaction_query` so the Run RPC can continue.
 *
 * Hosted web search / Exa / unnamed permission gates (field 9 = WebFetch on
 * current Cursor builds) block the turn until the client writes an
 * `interaction_response`. Dropping the frame leaves the HTTP/2 stream alive
 * on heartbeats that are not semantic progress; the lazy idle watchdog then
 * aborts with "Provider stream stalled while waiting for the next event".
 *
 * `AskQuestion` goes to `askQuestion` when the host can ask the user; async
 * questions and hosts without a responder are rejected. Other unsupported
 * interactive queries are rejected so the server is not stranded. VM setup is
 * left unanswered rather than reporting a fake success.
 */
export async function handleInteractionQuery(
	query: InteractionQuery,
	h2Request: CursorInteractionWriter,
	askQuestion?: CursorAskQuestionResponder,
): Promise<void> {
	const queryCase = query.query.case;
	log("interactionQuery", queryCase, query.query.value);
	if (!queryCase) {
		const unknown = protoUnknownFields(query).find(field => field.wireType === 2 && field.no >= 2);
		if (unknown) {
			log("warn", "unknownInteractionQueryApproved", { id: query.id, field: unknown.no });
			sendUnknownApprovedInteractionResponse(h2Request, query.id, unknown.no);
			return;
		}
		log("warn", "unknownInteractionQuery", { id: query.id });
		return;
	}

	switch (queryCase) {
		case "webSearchRequestQuery":
			sendInteractionResponse(h2Request, query.id, {
				case: "webSearchRequestResponse",
				value: create(WebSearchRequestResponseSchema, {
					result: { case: "approved", value: create(WebSearchRequestResponse_ApprovedSchema, {}) },
				}),
			});
			return;
		case "exaSearchRequestQuery":
			sendInteractionResponse(h2Request, query.id, {
				case: "exaSearchRequestResponse",
				value: create(ExaSearchRequestResponseSchema, {
					result: { case: "approved", value: create(ExaSearchRequestResponse_ApprovedSchema, {}) },
				}),
			});
			return;
		case "exaFetchRequestQuery":
			sendInteractionResponse(h2Request, query.id, {
				case: "exaFetchRequestResponse",
				value: create(ExaFetchRequestResponseSchema, {
					result: { case: "approved", value: create(ExaFetchRequestResponse_ApprovedSchema, {}) },
				}),
			});
			return;
		case "webFetchRequestQuery":
			// Hosted WebFetch permission prompt. Field 9 is what cursor-grok-4.6-xhigh
			// sends after "I'll fetch the page…"; answering lets the server continue.
			sendInteractionResponse(h2Request, query.id, {
				case: "webFetchRequestResponse",
				value: create(WebFetchRequestResponseSchema, {
					result: { case: "approved", value: create(WebFetchRequestResponse_ApprovedSchema, {}) },
				}),
			});
			return;
		case "askQuestionInteractionQuery": {
			const ask = query.query.value;
			let result: AskQuestionResult;
			if (!askQuestion) {
				result = askQuestionRejected(`Interactive questions are ${NOT_IMPLEMENTED_SUFFIX}`);
			} else if (ask.args?.runAsync || ask.args?.asyncOriginalToolCallId) {
				// `asyncOriginalToolCallId` marks the synthetic completion of an earlier async question.
				result = askQuestionRejected(`Async questions are ${NOT_IMPLEMENTED_SUFFIX}`);
			} else {
				try {
					result = await askQuestion(ask);
				} catch (error) {
					result = askQuestionRejected(error instanceof Error ? error.message : String(error));
				}
			}
			sendInteractionResponse(h2Request, query.id, {
				case: "askQuestionInteractionResponse",
				value: create(AskQuestionInteractionResponseSchema, { result }),
			});
			return;
		}
		case "switchModeRequestQuery":
			sendInteractionResponse(h2Request, query.id, {
				case: "switchModeRequestResponse",
				value: create(SwitchModeRequestResponseSchema, {
					result: {
						case: "rejected",
						value: create(SwitchModeRequestResponse_RejectedSchema, {
							reason: `Mode switches are ${NOT_IMPLEMENTED_SUFFIX}`,
						}),
					},
				}),
			});
			return;
		case "createPlanRequestQuery":
			sendInteractionResponse(h2Request, query.id, {
				case: "createPlanRequestResponse",
				value: create(CreatePlanRequestResponseSchema, {
					result: create(CreatePlanResultSchema, {
						result: {
							case: "error",
							value: create(CreatePlanErrorSchema, {
								error: `Plan files are ${NOT_IMPLEMENTED_SUFFIX}`,
							}),
						},
					}),
				}),
			});
			return;
		case "setupVmEnvironmentArgs":
			// Result oneof is success-only. Do not invent a VM; silence is better
			// than a false SetupVmEnvironmentSuccess (review of #8047).
			log("warn", "unhandledInteractionQuery", { queryCase, id: query.id });
			return;
		default: {
			const _exhaustive: InteractionQueryCase = queryCase;
			log("warn", "unhandledInteractionQuery", { queryCase: _exhaustive, id: query.id });
		}
	}
}
