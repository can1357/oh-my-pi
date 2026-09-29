import { LockKeyhole, TriangleAlert } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { INSECURE_CONTEXT_ERROR } from "../../lib/codec";
import { BrandMark } from "./BrandMark";
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
			setLocalError("Paste a join link first.");
			return;
		}
		setLocalError(null);
		onConnect(trimmed, name.trim() || "guest");
	};

	// Room keys need WebCrypto, which browsers expose only on https:// or localhost. Say so before
	// the reader pastes a link, instead of failing on Connect.
	const insecure = !window.isSecureContext;
	const shown = localError ?? (insecure && error === INSECURE_CONTEXT_ERROR ? null : error);

	return (
		<div className="sh-connect">
			<div className="sh-connect-corner">
				<ThemeToggle />
			</div>
			<form className="sh-connect-panel" onSubmit={submit}>
				<div className="sh-connect-brand">
					<BrandMark size={40} tile />
					<span className="sh-connect-wordmark">omp collab</span>
				</div>
				<div className="sh-connect-copy">
					<h1 className="sh-connect-title">Join a live session</h1>
					<p className="sh-connect-sub">Follow an omp agent as it works, and prompt it from your browser.</p>
				</div>
				{insecure && (
					<div className="sh-connect-warning" role="alert">
						<TriangleAlert size={15} aria-hidden="true" />
						<p>
							This page was opened over plain <code>http://{window.location.host}</code>, so the browser blocks
							the encryption collab needs. Open it over <code>https://</code> or from <code>localhost</code> to
							join.
						</p>
					</div>
				)}
				<div className="sh-connect-fields">
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
							aria-invalid={shown !== null}
						/>
						<span className="sh-field-hint">
							Run <code>/collab</code> in any omp session and paste the link it prints.
						</span>
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
				</div>
				{shown && (
					<div className="sh-connect-error" role="alert">
						{shown}
					</div>
				)}
				<button className="sh-btn sh-btn-primary sh-connect-submit" type="submit">
					Connect
				</button>
				<p className="sh-connect-note">
					<LockKeyhole size={13} aria-hidden="true" />
					<span>End-to-end encrypted. The room key stays in the link fragment and never reaches the relay.</span>
				</p>
			</form>
		</div>
	);
}
