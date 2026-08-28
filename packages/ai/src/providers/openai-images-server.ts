/**
 * OpenAI Images generations handler for the auth-gateway.
 *
 * pi-ai has no image-generation stream, so a valid `{ prompt }` request
 * returns 501 rather than a fake `b64_json` payload. Missing or non-string
 * `prompt` is 400. The named export exists so `server.ts` can wire
 * `POST /v1/images/generations` later.
 *
 * @see https://platform.openai.com/docs/api-reference/images/create
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { json } from "../auth-gateway/http";

const IMAGE_UNAVAILABLE = "image generation is not available on this gateway";

export async function handleImageGeneration(req: Request): Promise<Response> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await req.text());
	} catch (error) {
		return json(400, { error: `Invalid JSON body: ${String(error)}` });
	}

	if (!isRecord(parsed)) {
		return json(400, { error: "Invalid JSON body: expected an object" });
	}

	if (typeof parsed.prompt !== "string" || parsed.prompt.length === 0) {
		return json(400, { error: "Missing prompt" });
	}

	return json(501, { error: IMAGE_UNAVAILABLE });
}
