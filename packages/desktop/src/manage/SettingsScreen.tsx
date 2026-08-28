import { useCallback, useEffect, useState } from "react";
import { type ConfigMap, readConfig, resetConfig, writeConfig } from "./cli";
import { SETTING_GROUPS, type SettingField } from "./settings-schema";

export function SettingsScreen() {
	const [config, setConfig] = useState<ConfigMap | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setConfig(await readConfig());
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const update = useCallback(
		async (key: string, value: string) => {
			setPending(key);
			try {
				await writeConfig(key, value);
				// Re-read rather than patching locally: omp normalizes values and a
				// key can be rejected or coerced.
				await load();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setPending(null);
			}
		},
		[load],
	);

	const clear = useCallback(
		async (key: string) => {
			setPending(key);
			try {
				await resetConfig(key);
				await load();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setPending(null);
			}
		},
		[load],
	);

	return (
		<div className="omp-screen">
			<header className="omp-screen__head">
				<h1 className="omp-screen__title">Settings</h1>
				<p className="omp-screen__lede">
					A curated slice. omp exposes {config ? Object.keys(config).length : "hundreds of"} keys in total — the
					rest live in <code>settings.json</code>.
				</p>
			</header>

			{error ? <div className="omp-banner omp-banner--error">{error}</div> : null}
			{!config && !error ? <div className="omp-empty">Reading configuration…</div> : null}

			{config
				? SETTING_GROUPS.map(group => (
						<section className="omp-settings__group" key={group.title}>
							<h2 className="omp-settings__group-title">{group.title}</h2>
							{group.description ? <p className="omp-settings__group-desc">{group.description}</p> : null}

							{group.fields.map(field => {
								const entry = config[field.key];
								if (!entry) return null;
								return (
									<SettingRow
										key={field.key}
										field={field}
										entry={entry}
										busy={pending === field.key}
										onChange={value => void update(field.key, value)}
										onReset={() => void clear(field.key)}
									/>
								);
							})}
						</section>
					))
				: null}
		</div>
	);
}

function SettingRow({
	field,
	entry,
	busy,
	onChange,
	onReset,
}: {
	field: SettingField;
	entry: { value?: unknown; type: string; description: string };
	busy: boolean;
	onChange(value: string): void;
	onReset(): void;
}) {
	const [draft, setDraft] = useState(String(entry.value ?? ""));

	// A refresh after saving must win over a stale local draft.
	useEffect(() => setDraft(String(entry.value ?? "")), [entry.value]);

	return (
		<div className="omp-setting" data-busy={busy || undefined}>
			<div className="omp-setting__label">
				<span>{field.label}</span>
				<code className="omp-setting__key">{field.key}</code>
				{entry.description ? <p className="omp-setting__desc">{entry.description}</p> : null}
			</div>

			<div className="omp-setting__control">
				{entry.type === "boolean" ? (
					<input
						type="checkbox"
						checked={entry.value === true}
						disabled={busy}
						onChange={event => onChange(String(event.target.checked))}
					/>
				) : field.options ? (
					<select
						value={String(entry.value ?? "")}
						disabled={busy}
						onChange={event => onChange(event.target.value)}
					>
						{field.options.map(option => (
							<option key={option.value} value={option.value}>
								{option.label}
								{option.hint ? ` — ${option.hint}` : ""}
							</option>
						))}
					</select>
				) : (
					<input
						className="omp-input"
						type={entry.type === "number" ? "number" : "text"}
						value={draft}
						disabled={busy}
						onChange={event => setDraft(event.target.value)}
						onBlur={() => draft !== String(entry.value ?? "") && onChange(draft)}
						onKeyDown={event => {
							if (event.key === "Enter") onChange(draft);
						}}
					/>
				)}

				<button
					type="button"
					data-component="button"
					data-variant="ghost"
					data-size="normal"
					disabled={busy}
					onClick={onReset}
					title="Reset to the default"
				>
					Reset
				</button>
			</div>
		</div>
	);
}
