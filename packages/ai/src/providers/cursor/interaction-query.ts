import type http2 from "node:http2";
import {
	AgentClientMessageSchema,
	AskQuestionInteractionResponseSchema,
	AskQuestionRejectedSchema,
	AskQuestionResultSchema,
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
import { $env } from "@oh-my-pi/pi-utils";

const NOT_IMPLEMENTED_SUFFIX = "not implemented by this client";

type ProtoUnknownField = { no: number; wireType: number; data: Uint8Array };
type ProtoUnknownBag = { $unknown?: ProtoUnknownField[] };

type InteractionQueryCase = NonNullable<InteractionQuery["query"]["case"]>;
type InteractionResult = Exclude<InteractionResponse["result"], { case: undefined; value?: undefined }>;

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function isProtoUnknownField(value: unknown): value is ProtoUnknownField {
	if (!value || typeof value !== "object") return false;
	if (!("no" in value) || !("wireType" in value) || !("data" in value)) return false;
	return typeof value.no === "number" && typeof value.wireType === "number" && value.data instanceof Uint8Array;
}

function protoUnknownFields(message: object): ProtoUnknownField[] {
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
	const verbose = $env.DEBUG_CURSOR === "2" || $env.DEBUG_CURSOR === "verbose";
	const dataStr = verbose && data ? ` ${JSON.stringify(data)?.slice(0, 500)}` : "";
	console.error(`[CURSOR] ${type}${subtype ? `: ${subtype}` : ""}${dataStr}`);
}

function sendInteractionResponse(h2Request: http2.ClientHttp2Stream, queryId: number, result: InteractionResult): void {
	const response = create(InteractionResponseSchema, { id: queryId, result });
	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "interactionResponse", value: response },
	});
	h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
	log("interactionResponse", result.case, { id: queryId });
}

function sendUnknownApprovedInteractionResponse(
	h2Request: http2.ClientHttp2Stream,
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

/**
 * Answer a Cursor `interaction_query` so the Run RPC can continue.
 *
 * Hosted web search / Exa / unnamed permission gates (field 9 = WebFetch on
 * current Cursor builds) block the turn until the client writes an
 * `interaction_response`. Dropping the frame leaves the HTTP/2 stream alive
 * on heartbeats that are not semantic progress; the lazy idle watchdog then
 * aborts with "Provider stream stalled while waiting for the next event".
 *
 * Unsupported interactive queries are rejected so the server is not stranded.
 * VM setup is left unanswered rather than reporting a fake success.
 */
export function handleInteractionQuery(query: InteractionQuery, h2Request: http2.ClientHttp2Stream): void {
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
		case "askQuestionInteractionQuery":
			sendInteractionResponse(h2Request, query.id, {
				case: "askQuestionInteractionResponse",
				value: create(AskQuestionInteractionResponseSchema, {
					result: create(AskQuestionResultSchema, {
						result: {
							case: "rejected",
							value: create(AskQuestionRejectedSchema, {
								reason: `Interactive questions are ${NOT_IMPLEMENTED_SUFFIX}`,
							}),
						},
					}),
				}),
			});
			return;
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
