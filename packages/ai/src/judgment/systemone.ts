/**
 * TypeSafe System One dialects. The request body (`{ model, state, questions }`)
 * and answer map are TypeSafe's own, forwarded verbatim:
 *
 * - `typesafe`: `POST {baseUrl}/v1/systemone` — TypeSafe and every System One
 *   server (OpenJEV, Kev, self-hosted Clef, OpenCode Zen, Command Code).
 * - `openrouter-decisions`: `POST {baseUrl}/decisions` under OpenRouter's
 *   `/api/alpha`; usage adds the billed `cost` in USD.
 * - `workers-ai-systemone`: Cloudflare Workers AI's `POST {baseUrl}/{model}`
 *   (`/client/v4/accounts/<account>/ai/run/@cf/cloudflare/clef`). The body
 *   names the model by its last path segment (`clef`), the response arrives in
 *   Cloudflare's `{ result, success, errors }` envelope, and the credential is
 *   a Cloudflare API token plus the account id the URL needs.
 */
import { parseCloudflareCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare";
import { $env, isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { tokenUsage } from "./types";
import { type DecodedJudgment, finiteNumber, type JudgmentWire } from "./wire";

function decodeSystemOne(payload: unknown): DecodedJudgment | undefined {
	if (!isRecord(payload) || !isRecord(payload.answers)) return undefined;
	const usage = isRecord(payload.usage) ? payload.usage : {};
	return {
		model: typeof payload.model === "string" ? payload.model : undefined,
		answers: payload.answers,
		refused: [],
		usage: tokenUsage(finiteNumber(usage.input_tokens), finiteNumber(usage.output_tokens), finiteNumber(usage.cost)),
	};
}

/** A System One dialect posting the verbatim request to `path` under the base URL with the key as bearer. */
function systemOneWire(path: string): JudgmentWire {
	return {
		target: (baseUrl, _model, key) => ({ url: `${baseUrl}${path}`, token: key }),
		encode: (request, model) => ({ state: request.state, model, questions: request.questions }),
		decode: decodeSystemOne,
	};
}

/** TypeSafe's own route, shared by every System One server. */
export const typesafeWire = systemOneWire("/v1/systemone");

/** OpenRouter Decisions: the System One body under `/api/alpha`. */
export const openrouterDecisionsWire = systemOneWire("/decisions");

/** Cloudflare Workers AI decision models (Clef) through the account-scoped `ai/run` route. */
export const workersAiWire: JudgmentWire = {
	target(baseUrl, model, key) {
		const credential = parseCloudflareCredential(key);
		const accountId = credential?.accountId ?? $env.CLOUDFLARE_ACCOUNT_ID?.trim();
		if (!accountId) {
			throw new AIError.ConfigurationError(
				"Cloudflare account ID is required: log in to Cloudflare Workers AI again or set CLOUDFLARE_ACCOUNT_ID",
			);
		}
		return { url: `${baseUrl.replace("<account>", accountId)}/${model}`, token: credential?.token ?? key };
	},
	encode: (request, model) => ({
		state: request.state,
		model: model.slice(model.lastIndexOf("/") + 1),
		questions: request.questions,
	}),
	decode: payload => (isRecord(payload) ? decodeSystemOne(payload.result) : undefined),
};
