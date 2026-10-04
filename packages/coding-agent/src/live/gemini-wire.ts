import { type } from "@oh-my-pi/omptype";

const transcription = type({ text: "string" });
export const geminiFunctionCall = type({ id: "string", name: "string", "args?": "unknown" });
export type GeminiFunctionCall = typeof geminiFunctionCall.infer;

/** Validate the fields consumed by this client once at the websocket boundary. */
export const geminiServerMessage = type({
	"setupComplete?": {},
	"error?": { "message?": "string" },
	"serverContent?": {
		"interrupted?": "boolean",
		"turnComplete?": "boolean",
		"generationComplete?": "boolean",
		"inputTranscription?": transcription,
		"interimInputTranscription?": transcription,
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

export const geminiDelegateArguments = type({ "request?": "string" });
export const geminiExecuteArguments = type({ "code?": "string", "language?": "'js' | 'py'" });
export const geminiDesktopArguments = type({ "code?": "string", "read_only?": "boolean" });
export const geminiCancelArguments = type({ "id?": "string" });
