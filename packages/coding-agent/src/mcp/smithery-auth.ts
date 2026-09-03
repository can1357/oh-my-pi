import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { withTimeoutSignal } from "../utils/fetch-timeout";

const SMITHERY_AUTH_FILENAME = "smithery.json";
const SMITHERY_URL = process.env.SMITHERY_URL || "https://smithery.ai";
const SMITHERY_AUTH_TIMEOUT_MS = 10_000;
const SMITHERY_POLL_TIMEOUT_MS = 30_000;

type SmitheryCliAuthSession = {
	sessionId: string;
	authUrl: string;
};

export type SmitheryCliPollResponse = {
	status: "pending" | "success" | "error";
	apiKey?: string;
	message?: string;
};

type SmitheryAuthPayload = {
	apiKey?: string;
};

function getSmitheryAuthPath(): string {
	return path.join(getAgentDir(), SMITHERY_AUTH_FILENAME);
}

function normalizeApiKey(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function getSmitheryLoginUrl(): string {
	return SMITHERY_URL;
}

export async function createSmitheryCliAuthSession(): Promise<SmitheryCliAuthSession> {
	const response = await fetch(`${SMITHERY_URL}/api/auth/cli/session`, {
		method: "POST",
		signal: withTimeoutSignal(SMITHERY_AUTH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Failed to create Smithery auth session: ${response.status} ${response.statusText}`);
	}
	return (await response.json()) as SmitheryCliAuthSession;
}

export async function pollSmitheryCliAuthSession(
	sessionId: string,
	signal?: AbortSignal,
): Promise<SmitheryCliPollResponse> {
	const response = await fetch(`${SMITHERY_URL}/api/auth/cli/poll/${sessionId}`, {
		signal: withTimeoutSignal(SMITHERY_POLL_TIMEOUT_MS, signal),
	});
	if (!response.ok) {
		if (response.status === 404 || response.status === 410) {
			throw new Error("Smithery login session expired. Please try again.");
		}
		throw new Error(`Smithery auth polling failed: ${response.status} ${response.statusText}`);
	}
	return (await response.json()) as SmitheryCliPollResponse;
}

export async function getSmitheryApiKey(): Promise<string | undefined> {
	const envKey = normalizeApiKey(process.env.SMITHERY_API_KEY);
	if (envKey) return envKey;

	const authPath = getSmitheryAuthPath();
	try {
		const payload = (await Bun.file(authPath).json()) as SmitheryAuthPayload;
		return normalizeApiKey(payload.apiKey);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		logger.warn("Failed to read Smithery auth file, treating as missing", { path: authPath, error });
		return undefined;
	}
}

export async function saveSmitheryApiKey(apiKey: string): Promise<void> {
	const normalized = normalizeApiKey(apiKey);
	if (!normalized) {
		throw new Error("Smithery API key cannot be empty.");
	}

	const authPath = getSmitheryAuthPath();
	const payload: SmitheryAuthPayload = { apiKey: normalized };
	await Bun.write(authPath, `${JSON.stringify(payload, null, 2)}\n`);
	try {
		await fs.chmod(authPath, 0o600);
	} catch (error) {
		logger.warn("Could not set restrictive permissions on Smithery auth file", { path: authPath, error });
	}
}

export async function clearSmitheryApiKey(): Promise<boolean> {
	const authPath = getSmitheryAuthPath();
	try {
		await fs.rm(authPath);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}
