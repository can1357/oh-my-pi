import { useCallback, useEffect, useState } from "react";
import { type PluginList, type PluginRecord, pluginAction, readPlugins } from "./cli";

export function PluginsScreen() {
	const [plugins, setPlugins] = useState<PluginList | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [log, setLog] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [target, setTarget] = useState("");

	const load = useCallback(async () => {
		try {
			setPlugins(await readPlugins());
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const act = useCallback(
		async (action: "install" | "uninstall" | "enable" | "disable" | "upgrade" | "doctor", id?: string) => {
			setBusy(id ?? action);
			setError(null);
			try {
				// Output is kept verbatim: plugin installs report resolution details
				// worth reading, and a doctor run is entirely its output.
				setLog(await pluginAction(action, id));
				await load();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setBusy(null);
			}
		},
		[load],
	);

	const groups: Array<[string, PluginRecord[]]> = plugins
		? [
				["Marketplace", plugins.marketplace],
				["npm", plugins.npm],
			]
		: [];

	return (
		<div className="omp-screen">
			<header className="omp-screen__head">
				<h1 className="omp-screen__title">Plugins</h1>
				<p className="omp-screen__lede">
					Extensions, skills and MCP servers installed through omp's plugin system.
				</p>
			</header>

			<div className="omp-screen__row">
				<input
					className="omp-input"
					placeholder="package, path or marketplace id…"
					value={target}
					onChange={event => setTarget(event.target.value)}
					onKeyDown={event => {
						if (event.key === "Enter" && target.trim()) void act("install", target.trim());
					}}
				/>
				<button
					type="button"
					data-component="button"
					data-variant="primary"
					data-size="normal"
					disabled={!target.trim() || busy !== null}
					onClick={() => void act("install", target.trim())}
				>
					Install
				</button>
				<button
					type="button"
					data-component="button"
					data-variant="ghost"
					data-size="normal"
					disabled={busy !== null}
					onClick={() => void act("doctor")}
				>
					Doctor
				</button>
			</div>

			{error ? <div className="omp-banner omp-banner--error">{error}</div> : null}

			{groups.map(([title, records]) => (
				<section className="omp-settings__group" key={title}>
					<h2 className="omp-settings__group-title">
						{title} <span className="omp-project__count">{records.length}</span>
					</h2>

					{records.length === 0 ? (
						<div className="omp-empty" style={{ height: "auto", padding: 12 }}>
							Nothing installed.
						</div>
					) : null}

					{records.map(record => {
						const entry = record.entries[0];
						const enabled = record.entries.some(candidate => candidate.enabled);
						return (
							<div className="omp-setting" key={record.id}>
								<div className="omp-setting__label">
									<span>{record.id}</span>
									<code className="omp-setting__key">
										{entry?.version ? `v${entry.version} · ` : ""}
										{record.scope}
									</code>
									{entry?.installPath ? <p className="omp-setting__desc">{entry.installPath}</p> : null}
								</div>

								<div className="omp-setting__control">
									<button
										type="button"
										data-component="button"
										data-variant="ghost"
										data-size="normal"
										disabled={busy !== null}
										onClick={() => void act(enabled ? "disable" : "enable", record.id)}
									>
										{enabled ? "Disable" : "Enable"}
									</button>
									<button
										type="button"
										data-component="button"
										data-variant="ghost"
										data-size="normal"
										disabled={busy !== null}
										onClick={() => void act("uninstall", record.id)}
									>
										Uninstall
									</button>
								</div>
							</div>
						);
					})}
				</section>
			))}

			{log ? (
				<section className="omp-settings__group">
					<h2 className="omp-settings__group-title">Output</h2>
					<pre className="omp-screen__log">{log}</pre>
				</section>
			) : null}
		</div>
	);
}
