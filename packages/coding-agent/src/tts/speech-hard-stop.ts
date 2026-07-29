import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils";

/** Persistent hard-mute sentinel under `~/.ompk/agent/speech-disabled`. */
export function getSpeechHardStopPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "speech-disabled");
}

/** Optional shared sentinel used by pi-speak-extension. */
export function getLegacyVoiceDisablePath(): string | undefined {
	const local = process.env.LOCALAPPDATA || process.env.APPDATA;
	if (!local) return undefined;
	return join(local, "pi-speak", "voice-disabled");
}

export function isSpeechHardStopped(agentDir: string = getAgentDir()): boolean {
	if (existsSync(getSpeechHardStopPath(agentDir))) return true;
	const legacy = getLegacyVoiceDisablePath();
	return !!legacy && existsSync(legacy);
}

export function enableSpeechHardStop(agentDir: string = getAgentDir()): void {
	const path = getSpeechHardStopPath(agentDir);
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(path, "hard-stop\n", { encoding: "utf8" });
	const legacy = getLegacyVoiceDisablePath();
	if (legacy) {
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, "hard-stop\n", { encoding: "utf8" });
	}
}

export function clearSpeechHardStop(agentDir: string = getAgentDir()): void {
	for (const candidate of [getSpeechHardStopPath(agentDir), getLegacyVoiceDisablePath()]) {
		if (!candidate) continue;
		try {
			unlinkSync(candidate);
		} catch {
			// absent is fine
		}
	}
}
