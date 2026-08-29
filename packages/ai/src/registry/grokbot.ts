import { resolveGrokbotEnvApiKey } from "../providers/grokbot/auth";
import type { ProviderDefinition } from "./types";

/**
 * Grok Bot — sand InferenceService provider (`grokbot` / `grokbot-sand`).
 *
 * Distinct from:
 * - `cursor` / Cursor CLI (`cursor-agent` AgentService/Run)
 * - `xai` / `xai-oauth` / Grok CLI (xAI API keys or SuperGrok OAuth)
 *
 * Auth is a sand renewal credential (+ machine id checksum), not Cursor OAuth and not xAI.
 */
export const grokbotProvider = {
	id: "grokbot",
	name: "Grok Bot (sand Inference — not Cursor, not xAI)",
	envKeys: resolveGrokbotEnvApiKey,
} as const satisfies ProviderDefinition;
