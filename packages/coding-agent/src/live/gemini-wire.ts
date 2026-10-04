import { type } from "@oh-my-pi/omptype";

const transcription = type({ text: "string", "finished?": "boolean" });
export const geminiFunctionCall = type({ id: "string", name: "string", "args?": "unknown" });
export type GeminiFunctionCall = typeof geminiFunctionCall.infer;

/** Validate the fields consumed by this client once at the websocket boundary. */
export const geminiServerMessage = type({
	"setupComplete?": {},
	"error?": { "message?": "string" },
	"serverContent?": {
		"interrupted?": "boolean",
		"turnComplete?": "boolean",
		"inputTranscription?": transcription,
		"outputTranscription?": transcription,
		"interactionStatus?": "string",
		"interaction_status?": "string",
		"modelTurn?": {
			"parts?": type({ "inlineData?": { data: "string", mimeType: "string" } }).array(),
		},
	},
	"toolCall?": { functionCalls: geminiFunctionCall.array() },
	"toolCallCancellation?": { ids: "string[]" },
});

export const geminiToolArguments = type({ "request?": "string" });
