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
			<form className="sh-connect-card" onSubmit={submit}>
				<div className="sh-connect-head">
					<div className="sh-lockup">
						<span className="sh-lockup-mark" aria-hidden="true" />
						<span className="sh-lockup-pi">π</span> omp collab
					</div>
					<ThemeToggle />
				</div>
				<div className="sh-connect-sub">live agent session, in your browser</div>
				<label className="sh-field">
					<span className="sh-field-label">join link</span>
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
					<span className="sh-field-hint">paste a /collab link from any omp session</span>
				</label>
				<label className="sh-field">
					<span className="sh-field-label">display name</span>
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
				{shown && <div className="sh-connect-error">{shown}</div>}
				<button className="sh-btn sh-btn-primary sh-connect-submit" type="submit">
					Connect
				</button>
			</form>
		</div>
	);
}
