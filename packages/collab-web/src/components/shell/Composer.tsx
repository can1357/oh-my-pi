import { SendHorizontal, Square } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";

export interface ComposerProps {
	client: GuestClient;
	snapshot: GuestSnapshot;
}

/** Textarea metrics: line-height 20px + 18px total vertical padding (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 18;
const MAX_ROWS = 8;

export function Composer({ client, snapshot }: ComposerProps): ReactNode {
	const [text, setText] = useState("");
	const taRef = useRef<HTMLTextAreaElement | null>(null);

	const live = snapshot.phase === "live";
	const readOnly = snapshot.readOnly;
	const canPrompt = live && !readOnly;
	const busy = snapshot.working || (snapshot.state?.isStreaming ?? false);
	const queued = snapshot.state?.queuedMessageCount ?? 0;
	const canSend = canPrompt && text.trim().length > 0;

	useLayoutEffect(() => {
		const el = taRef.current;
		if (!el) return;
		el.style.height = "0px";
		const max = MAX_ROWS * LINE_PX + PAD_Y;
		el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
		el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
	}, [text]);

	const send = useCallback((): void => {
		const trimmed = text.trim();
		if (!trimmed || !live || readOnly) return;
		client.sendPrompt(trimmed);
		setText("");
	}, [client, live, readOnly, text]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	};

	return (
		<div className="sh-composer">
			<div className="sh-composer-inner">
				<textarea
					ref={taRef}
					className="sh-composer-input"
					aria-label="Message the host agent"
					value={text}
					onChange={e => setText(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder={
						readOnly
							? "Read-only session"
							: live
								? "Ask the host agent to change or inspect something…"
								: "Waiting for session…"
					}
					disabled={!canPrompt}
					rows={1}
					spellCheck={false}
				/>
				<div className="sh-composer-footer">
					<span className="sh-composer-hint">
						Enter to send <span aria-hidden="true">·</span> Shift+Enter for newline
					</span>
					<div className="sh-composer-actions">
						{busy && queued > 0 && (
							<span className="sh-queued">
								<span className="sh-queued-label">queued </span>×{queued}
							</span>
						)}
						{busy && !readOnly && (
							<button
								type="button"
								className="sh-btn sh-btn-stop"
								onClick={() => client.sendAbort()}
								disabled={!live}
								title="stop the current turn"
							>
								<Square size={11} /> <span className="sh-btn-label">Stop</span>
							</button>
						)}
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							onClick={send}
							disabled={!canSend}
							title="send (Enter)"
						>
							<SendHorizontal size={12} /> <span className="sh-btn-label">Send</span>
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
