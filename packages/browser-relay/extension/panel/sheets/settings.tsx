/** The Settings sheet: connection, session defaults, appearance, suggestions, shortcuts, keyboard and installs. */
import { Pencil, Play, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type {
	PanelInstall,
	PanelSettings,
	RelayStatus,
	Shortcut,
	TabContext,
} from "../../messages";
import { scheduleCaption } from "../schedule";
import type { PanelWorker } from "../session";
import { DEFAULT_SUGGESTIONS, type Stored, sortShortcuts } from "../storage";
import { hostOf } from "../tab-context";
import { Sheet, Toggle } from "../ui";

const TOGGLE_COMMAND = "toggle-side-panel";

/** An install folder that fits a row: home as `~`, and the middle elided so the telling tail stays. */
function shortDir(dir: string): string {
	const home = dir.replace(/^\/(?:Users|home)\/[^/]+/, "~");
	if (home.length <= 40) return home;
	const segments = home.split("/");
	return `${segments[0]}/…/${segments.slice(-3).join("/")}`;
}

function Section(props: { title: string; children: ReactNode }): ReactNode {
	return (
		<section className="pn-set-card">
			<h3 className="pn-set-title">{props.title}</h3>
			{props.children}
		</section>
	);
}

function Segmented<T extends string>(props: {
	value: T;
	options: readonly { value: T; label: string }[];
	label: string;
	onChange(value: T): void;
}): ReactNode {
	return (
		<div className="pn-segmented" role="radiogroup" aria-label={props.label}>
			{props.options.map((option) => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={option.value === props.value}
					className="pn-segment"
					onClick={() => props.onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

function ToggleRow(props: {
	label: string;
	hint?: string;
	checked: boolean;
	disabled?: boolean;
	onChange(next: boolean): void;
}): ReactNode {
	return (
		<div className={`pn-set-row${props.disabled ? " pn-set-row--off" : ""}`}>
			<span className="pn-set-row-copy">
				<span>{props.label}</span>
				{props.hint !== undefined && (
					<span className="pn-set-hint">{props.hint}</span>
				)}
			</span>
			<Toggle
				checked={props.checked}
				label={props.label}
				onChange={props.disabled ? () => undefined : props.onChange}
			/>
		</div>
	);
}

function Connection({ relay }: { relay: RelayStatus | null }): ReactNode {
	const version =
		relay?.extensionVersion ?? chrome.runtime.getManifest().version;
	return (
		<Section title="Connection">
			<div className="pn-set-status">
				<span
					className={`pn-status-dot${relay?.connected ? " pn-status-dot--ok" : ""}`}
				/>
				<span>
					extension {version} ·{" "}
					{relay?.connected ? "connected" : "connecting…"}
				</span>
			</div>
			{relay !== null && !relay.connected && (
				<p className="pn-set-note">
					Still connecting? The omp native host may be missing: run{" "}
					<code>omp browser-relay install</code>.
				</p>
			)}
		</Section>
	);
}

function Suggestions(props: {
	suggestions: Stored<Record<string, string[]>>;
	activeTab: TabContext | null;
}): ReactNode {
	const { value, set } = props.suggestions;
	const hosts = Object.keys(value).sort();
	const current = props.activeTab === null ? "" : hostOf(props.activeTab.url);
	const [host, setHost] = useState("");
	const add = (name: string): void => {
		const key = name.trim().toLowerCase();
		if (key === "" || key in value) return;
		set({ ...value, [key]: [...DEFAULT_SUGGESTIONS] });
		setHost("");
	};
	return (
		<Section title="Suggestions">
			<p className="pn-set-note">
				Starter prompts on a new chat, per site. One per line; the first three
				show.
			</p>
			{hosts.map((name) => (
				<div key={name} className="pn-suggest">
					<div className="pn-suggest-head">
						<span className="pn-mono">{name}</span>
						<button
							type="button"
							className="pn-icon-btn"
							aria-label={`Remove suggestions for ${name}`}
							onClick={() => {
								const next = { ...value };
								delete next[name];
								set(next);
							}}
						>
							<Trash2 size={13} />
						</button>
					</div>
					<textarea
						className="pn-field"
						rows={3}
						defaultValue={value[name].join("\n")}
						aria-label={`Suggestions for ${name}`}
						onBlur={(event) => {
							const prompts = event.target.value
								.split("\n")
								.map((line) => line.trim())
								.filter((line) => line !== "");
							// An emptied list would be dropped on the next read; keep the host until it is removed explicitly.
							set({
								...value,
								[name]:
									prompts.length === 0 ? [...DEFAULT_SUGGESTIONS] : prompts,
							});
						}}
					/>
				</div>
			))}
			<div className="pn-suggest-add">
				<input
					className="pn-field pn-field--mono"
					value={host}
					placeholder={current === "" ? "example.com" : current}
					aria-label="Site"
					spellCheck={false}
					onChange={(event) => setHost(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							add(host || current);
						}
					}}
				/>
				<button
					type="button"
					className="sh-btn pn-btn"
					disabled={(host || current) === ""}
					onClick={() => add(host || current)}
				>
					<Plus size={13} /> Add site
				</button>
			</div>
		</Section>
	);
}

function KeyboardSection(): ReactNode {
	const [binding, setBinding] = useState<string | null>(null);
	const refresh = useCallback((): void => {
		void chrome.commands.getAll().then((commands) => {
			setBinding(
				commands.find((command) => command.name === TOGGLE_COMMAND)?.shortcut ??
					"",
			);
		});
	}, []);
	// The binding is changed on another page (chrome://extensions/shortcuts); re-read when the panel is seen again.
	useEffect(() => {
		refresh();
		document.addEventListener("visibilitychange", refresh);
		window.addEventListener("focus", refresh);
		return () => {
			document.removeEventListener("visibilitychange", refresh);
			window.removeEventListener("focus", refresh);
		};
	}, [refresh]);
	return (
		<Section title="Keyboard">
			<div className="pn-set-row">
				<span>Open omp</span>
				<span className="pn-set-row-end">
					{binding === null ? null : binding === "" ? (
						<span className="pn-set-hint">Not set</span>
					) : (
						<kbd className="pn-kbd">{binding}</kbd>
					)}
					<button
						type="button"
						className="sh-btn pn-btn"
						onClick={() =>
							void chrome.tabs.create({ url: "chrome://extensions/shortcuts" })
						}
					>
						Change…
					</button>
				</span>
			</div>
		</Section>
	);
}

function Installs({
	worker,
	relay,
}: {
	worker: PanelWorker;
	relay: RelayStatus | null;
}): ReactNode {
	const [installs, setInstalls] = useState<PanelInstall[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const connected = relay?.connected ?? false;
	useEffect(() => {
		if (!connected) return;
		let alive = true;
		worker.request("installs", {}).then(
			(list) => {
				if (alive) {
					setInstalls(list);
					setError(null);
				}
			},
			(reason) => {
				if (alive)
					setError(reason instanceof Error ? reason.message : String(reason));
			},
		);
		return () => {
			alive = false;
		};
	}, [worker, connected]);
	const running = relay?.extensionVersion;
	return (
		<Section title="Installs">
			<div className="pn-set-row">
				<span className="pn-set-row-copy">
					<span>This browser</span>
					<span className="pn-set-hint pn-mono">{chrome.runtime.id}</span>
				</span>
				<span className="pn-mono pn-set-version">{running ?? "dev build"}</span>
			</div>
			{installs?.map((install) => (
				<div key={install.dir} className="pn-set-row">
					<span className="pn-set-row-copy">
						<span className="pn-mono pn-install-dir" title={install.dir}>
							{shortDir(install.dir)}
						</span>
						{install.missing && (
							<span className="pn-set-hint pn-set-hint--err">
								Folder is missing
							</span>
						)}
						{!install.missing &&
							running !== undefined &&
							install.version !== null &&
							install.version !== running && (
								<span className="pn-set-hint">Reloads when omp is idle</span>
							)}
					</span>
					<span className="pn-mono pn-set-version">
						{install.version ?? "unknown"}
					</span>
				</div>
			))}
			{installs !== null && installs.length === 0 && (
				<p className="pn-set-note">
					No folders registered. Run <code>omp browser-relay install</code> to
					register this one.
				</p>
			)}
			{installs === null && (
				<p className="pn-set-note">
					{error ??
						(connected
							? "Loading…"
							: "Connect to the relay to list registered folders.")}
				</p>
			)}
		</Section>
	);
}

/** The full-height sheet. */
export function SettingsSheet(props: {
	worker: PanelWorker;
	settings: Stored<PanelSettings>;
	suggestions: Stored<Record<string, string[]>>;
	shortcuts: readonly Shortcut[];
	relay: RelayStatus | null;
	activeTab: TabContext | null;
	onEditShortcut(shortcut: Shortcut | null): void;
	onRunShortcut(shortcut: Shortcut): void;
	onClose(): void;
}): ReactNode {
	const settings = props.settings.value;
	const update = (patch: Partial<PanelSettings>): void =>
		props.settings.set({ ...settings, ...patch });
	const overlay = (patch: Partial<PanelSettings["overlay"]>): void =>
		update({ overlay: { ...settings.overlay, ...patch } });
	return (
		<Sheet title="Settings" full onClose={props.onClose}>
			<Connection relay={props.relay} />
			<Section title="Sessions">
				<div className="pn-set-row pn-set-row--stack">
					<span>New chats</span>
					<Segmented
						label="New chats"
						value={settings.newChat}
						options={[
							{ value: "attach", label: "Attach to newest omp" },
							{ value: "panel", label: "New panel session" },
						]}
						onChange={(newChat) => update({ newChat })}
					/>
				</div>
				<label className="pn-form-row">
					<span className="pn-form-label">Panel sessions start in</span>
					<input
						className="pn-field pn-field--mono"
						defaultValue={settings.defaultCwd}
						key={settings.defaultCwd}
						spellCheck={false}
						onBlur={(event) =>
							update({ defaultCwd: event.target.value.trim() || "~" })
						}
					/>
				</label>
			</Section>
			<Section title="Appearance">
				<div className="pn-set-row pn-set-row--stack">
					<span>Theme</span>
					<Segmented
						label="Theme"
						value={settings.theme}
						options={[
							{ value: "system", label: "System" },
							{ value: "light", label: "Light" },
							{ value: "dark", label: "Dark" },
						]}
						onChange={(theme) => update({ theme })}
					/>
				</div>
				<ToggleRow
					label="Page overlay"
					hint="Working tag, Stop and Open omp on the page"
					checked={settings.overlay.enabled}
					onChange={(enabled) => overlay({ enabled })}
				/>
				<ToggleRow
					label="Arrow and action chip"
					checked={settings.overlay.arrow}
					disabled={!settings.overlay.enabled}
					onChange={(arrow) => overlay({ arrow })}
				/>
				<ToggleRow
					label="Edge glow"
					checked={settings.overlay.edge}
					disabled={!settings.overlay.enabled}
					onChange={(edge) => overlay({ edge })}
				/>
				<p className="pn-set-note">
					Reduced motion follows your system setting.
				</p>
			</Section>
			<Suggestions
				suggestions={props.suggestions}
				activeTab={props.activeTab}
			/>
			<Section title="Shortcuts">
				{props.shortcuts.length === 0 && (
					<p className="pn-set-note">
						Save a prompt as a shortcut, then run it with /name or on a
						schedule.
					</p>
				)}
				{sortShortcuts(props.shortcuts).map((shortcut) => (
					<div key={shortcut.id} className="pn-shortcut-row">
						<span className="pn-set-row-copy">
							<span className="pn-mono">/{shortcut.name}</span>
							<span className="pn-set-hint pn-clip">
								{shortcut.prompt.replace(/\s+/g, " ")}
							</span>
							{shortcut.schedule !== undefined && (
								<span className="pn-set-hint">
									{scheduleCaption(shortcut.schedule)}
									{shortcut.lastRunError !== undefined && (
										<span className="pn-set-hint--err">
											{" "}
											· last run failed: {shortcut.lastRunError}
										</span>
									)}
								</span>
							)}
						</span>
						<button
							type="button"
							className="pn-icon-btn"
							aria-label={`Run /${shortcut.name} now`}
							data-tip="Run now"
							data-tip-side="above"
							onClick={() => props.onRunShortcut(shortcut)}
						>
							<Play size={14} />
						</button>
						<button
							type="button"
							className="pn-icon-btn"
							aria-label={`Edit /${shortcut.name}`}
							data-tip="Edit"
							data-tip-side="above"
							onClick={() => props.onEditShortcut(shortcut)}
						>
							<Pencil size={14} />
						</button>
					</div>
				))}
				<div className="pn-set-actions">
					<button
						type="button"
						className="sh-btn pn-btn"
						onClick={() => props.onEditShortcut(null)}
					>
						<Plus size={13} /> New shortcut
					</button>
				</div>
			</Section>
			<KeyboardSection />
			<Installs worker={props.worker} relay={props.relay} />
		</Sheet>
	);
}
