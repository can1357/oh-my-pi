import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";

const ENGINE_NAMES: Record<ImageProtocol, string> = {
	[ImageProtocol.Kitty]: "kitty",
	[ImageProtocol.Iterm2]: "iterm2",
	[ImageProtocol.Sixel]: "sixel",
};

/**
 * Select `protocol` for components (`TERMINAL.imageProtocol`) and for terminal
 * engines created from now on, which resolve theirs from the environment
 * (`PI_FORCE_IMAGE_PROTOCOL`; `null` turns images off). Returns the restore.
 */
export function forceImageProtocol(protocol: ImageProtocol | null): () => void {
	const previousProtocol = TERMINAL.imageProtocol;
	const previousEnv = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	setTerminalImageProtocol(protocol);
	Bun.env.PI_FORCE_IMAGE_PROTOCOL = protocol === null ? "off" : ENGINE_NAMES[protocol];
	return () => {
		setTerminalImageProtocol(previousProtocol);
		if (previousEnv === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		else Bun.env.PI_FORCE_IMAGE_PROTOCOL = previousEnv;
	};
}
