/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A wait in the composer's place (sharing a session, signing in, opening the
 * session history): a spinner beside the message. A cancellable one adds an
 * `esc cancel` hint; Escape (or the native `cancel` action) calls `onAbort`.
 */
import type { JSXNode, Reactive } from "@oh-my-pi/pi-tui";
import "../../styles/panels/bordered-loader";
import { Hints } from "./common";
import { matchesSelectCancel } from "../../../config/keybindings/matchers";
import { cancelKbd } from "../../keys/hints";

export interface BorderedLoaderProps {
	readonly message: Reactive<string>;
	/** Cancel the wait (escape); without it the wait cannot be cancelled and shows no hint. */
	readonly onAbort?: () => void;
}

export function BorderedLoader(props: BorderedLoaderProps): JSXNode {
	const message = () => (typeof props.message === "function" ? props.message() : props.message);
	return (
		<card
			role="omp.hook.loader"
			onKey={key => {
				if (!matchesSelectCancel(key) || !props.onAbort) return false;
				props.onAbort();
				return true;
			}}
			onAction={act => {
				if (act === "cancel") props.onAbort?.();
			}}
		>
			<row role="omp.loader" justify="between">
				<row align="baseline" gap="sm">
					<spinner style="braille" />
					<text key="message" spans={() => [{ s: "muted", t: message() }]} />
				</row>
			</row>
			{props.onAbort && <Hints hints={[{ keys: cancelKbd(), label: "cancel" }]} />}
		</card>
	);
}
