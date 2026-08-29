interface AdaptedDesktopCapabilities {
	readonly [key: string]: unknown;
	readonly ax: boolean;
	readonly backgroundWindowInput: boolean;
	readonly deliveryModes: readonly string[];
	readonly axPermission: string;
}

interface AdaptedDesktopSession {
	readonly capabilities: AdaptedDesktopCapabilities;
	listWindows(): Promise<Array<Record<string, unknown>>>;
	capture(target: string, caps?: unknown): Promise<Record<string, unknown>>;
	click(
		target: string,
		x: number,
		y: number,
		options?: { button?: string; count?: number; modifiers?: string[]; deliveryMode?: string },
	): Promise<void>;
	typeText(target: string, text: string, options?: { deliveryMode?: string }): Promise<void>;
	keyChord(target: string, keys: string[], options?: { deliveryMode?: string }): Promise<void>;
	close(): Promise<void>;
}

interface AdaptedDesktopSessionConstructor {
	new (options: Record<string, unknown>): AdaptedDesktopSession;
}

export function adaptDesktopSession(NativeDesktopSession: unknown): AdaptedDesktopSessionConstructor;
