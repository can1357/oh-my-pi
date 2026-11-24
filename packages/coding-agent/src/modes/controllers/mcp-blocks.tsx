/** @jsxImportSource @oh-my-pi/pi-tui */
/** Transcript blocks the `/mcp` command controller mounts (OAuth prompt, connection spinner, test hint). */
import { type Accessor, type JSXNode, onCleanup, signal } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { AnsiText } from "../../ui/transcript/ansi-text";
import { McpAuthorizationLink } from "../../ui/transcript/messages/mcp-auth";

const MANUAL_LOGIN_TIP = "Headless? Paste the redirect URL or code with /login <value>.";

/** One styled line one cell in. */
function Line(props: { readonly color: string; readonly text: string }): JSXNode {
	return <AnsiText text={currentTheme().fg(props.color, props.text)} padX={1} />;
}

/** The OAuth authorization prompt: what happens next, then the link to open or copy. */
export function mcpOAuthBlock(props: { url: string; launchUrl?: string; interruptKey: string }): JSXNode {
	return (
		<col>
			<Line color="accent" text="━━━ OAuth Authorization Required ━━━" />
			<spacer />
			<Line color="muted" text="Preparing browser authorization..." />
			<spacer />
			<Line
				color="muted"
				text={`Waiting for authorization... (Press ${props.interruptKey} to cancel, 5 minute timeout)`}
			/>
			<Line color="muted" text={MANUAL_LOGIN_TIP} />
			<spacer />
			<Line color="accent" text="━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" />
			<spacer />
			<Line color="success" text="→ Attempting to open browser..." />
			<spacer />
			<Line color="muted" text="Alternative if browser did not open:" />
			<McpAuthorizationLink url={props.url} launchUrl={props.launchUrl} />
		</col>
	);
}

/** A blank row, then one styled line one cell in (OAuth progress notes). */
export function mcpNoteBlock(color: string, text: string): JSXNode {
	return (
		<col>
			<spacer />
			<Line color={color} text={text} />
		</col>
	);
}

/**
 * "Connecting to …" with a spinner until `status` holds the outcome line (already styled). The
 * spinner's timer lives as long as the block's root.
 */
export function mcpConnectingBlock(name: string, status: Accessor<string | undefined>): JSXNode {
	const frame = signal(0);
	const timer = setInterval(() => {
		if (status() === undefined) frame.set(frame() + 1);
		else clearInterval(timer);
	}, 80);
	onCleanup(() => clearInterval(timer));
	const text = (): string => {
		const done = status();
		if (done !== undefined) return done;
		const frames = currentTheme().symbols.spinnerFrames;
		return currentTheme().fg("muted", `${frames[frame() % frames.length] ?? "|"} Connecting to "${name}"...`);
	};
	return (
		<col>
			<spacer />
			{() => <AnsiText text={text()} padX={1} />}
		</col>
	);
}

/** The `/mcp test` hint between border rules; `text` (already styled) changes as the test settles. */
export function mcpTestHintBlock(text: Accessor<string>): JSXNode {
	return (
		<col>
			<rule key="top" />
			{() => <AnsiText text={text()} padX={1} padY={1} />}
			<rule key="bottom" />
		</col>
	);
}
