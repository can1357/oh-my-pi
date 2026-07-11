import { Radio, ShieldCheck, TerminalSquare } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { ThemeToggle } from "./ThemeToggle";

export interface ConnectScreenProps {
	defaultName: string;
	error: string | null;
	onConnect(link: string, name: string): void;
}

export function ConnectScreen({ defaultName, error, onConnect }: ConnectScreenProps): ReactNode {
	const [link, setLink] = useState("");
	const [name, setName] = useState(defaultName);
	const [localError, setLocalError] = useState<string | null>(null);

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const trimmed = link.trim();
		if (!trimmed) {
			setLocalError("paste a join link first");
			return;
		}
		setLocalError(null);
		onConnect(trimmed, name.trim() || "guest");
	};

	const shown = localError ?? error;

	return (
		<div className="sh-connect">
			<section className="sh-connect-intro" aria-label="oh-my-pk collaboration">
				<div className="sh-connect-brand">
					<span className="sh-lockup-mark" aria-hidden="true" />
					<span>oh-my-pk</span>
				</div>
				<div className="sh-connect-copy">
					<span className="sh-connect-kicker">Live workspace</span>
					<h1>Stay with the work, wherever the agent runs.</h1>
					<p>
						Follow the transcript, inspect tool calls and guide the host session from a focused browser workspace.
					</p>
				</div>
				<div className="sh-connect-features">
					<span>
						<Radio size={15} /> Streaming transcript
					</span>
					<span>
						<TerminalSquare size={15} /> Tool and subagent detail
					</span>
					<span>
						<ShieldCheck size={15} /> End-to-end encrypted
					</span>
				</div>
			</section>
			<form className="sh-connect-card" onSubmit={submit}>
				<div className="sh-connect-head">
					<div>
						<h2>Join a session</h2>
						<p>
							Use the link printed by <code>/collab</code>.
						</p>
					</div>
					<ThemeToggle />
				</div>
				<label className="sh-field">
					<span className="sh-field-label">Join link</span>
					<input
						className="sh-input sh-input-mono"
						type="text"
						value={link}
						onChange={e => setLink(e.target.value)}
						placeholder="ws://host:port/r/room.key"
						spellCheck={false}
						autoComplete="off"
						autoFocus
					/>
					<span className="sh-field-hint">The room key stays in your browser.</span>
				</label>
				<label className="sh-field">
					<span className="sh-field-label">Display name</span>
					<input
						className="sh-input"
						type="text"
						value={name}
						onChange={e => setName(e.target.value)}
						placeholder="guest"
						spellCheck={false}
						autoComplete="off"
						maxLength={32}
					/>
				</label>
				{shown && (
					<div className="sh-connect-error" role="alert">
						{shown}
					</div>
				)}
				<button className="sh-btn sh-btn-primary sh-connect-submit" type="submit">
					Connect to workspace
				</button>
			</form>
		</div>
	);
}
