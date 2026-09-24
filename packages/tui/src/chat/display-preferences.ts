/** How the turn-time segment renders in transcript usage rows. */
export type TurnTimeStyle = "elapsed" | "range";

/** Process-wide display preferences applied by the host settings hooks. */
export interface ChatTranscriptDisplayPreferences {
	hideToolActivity: boolean;
	readToolResultPreview: boolean;
	showImages: boolean;
	cacheMissMarker: boolean;
	showTokenUsage: boolean;
	showTurnTime: boolean;
	turnTimeStyle: TurnTimeStyle;
}

/** Current transcript display preferences. */
export const chatTranscriptDisplayPreferences: ChatTranscriptDisplayPreferences = {
	hideToolActivity: false,
	readToolResultPreview: false,
	showImages: true,
	cacheMissMarker: false,
	showTokenUsage: false,
	showTurnTime: false,
	turnTimeStyle: "elapsed",
};

/** Apply host display preferences without pulling settings into the renderer. */
export function setChatTranscriptDisplayPreferences(preferences: Partial<ChatTranscriptDisplayPreferences>): void {
	Object.assign(chatTranscriptDisplayPreferences, preferences);
}
