export interface CapturedOpenAICompletionRequest {
	messages?: Array<{ content?: unknown }>;
}

export function startOpenAICompletionsUpstream(requests: CapturedOpenAICompletionRequest[]) {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push((await request.json()) as CapturedOpenAICompletionRequest);
			const chunks = [
				{
					id: "chatcmpl-remote-image",
					object: "chat.completion.chunk",
					created: 0,
					model: "vision-model",
					choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
				},
				{
					id: "chatcmpl-remote-image",
					object: "chat.completion.chunk",
					created: 0,
					model: "vision-model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
			];
			const sse = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
			return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
		},
	});
}
