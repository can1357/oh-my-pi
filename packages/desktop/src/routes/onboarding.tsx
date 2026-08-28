import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { LoginProvider } from "../rpc/protocol";
import { useBridge } from "../rpc/useBridge";

/**
 * First-run provider login, without leaving the app.
 *
 * `login(providerId)` makes the server emit an `open_url` UI request carrying
 * the auth URL and a short loopback `launchUrl`. The bridge routes that to the
 * host, which opens the system browser. Some providers then send an `input`
 * request for a pasted code, which surfaces through the normal approval dialog.
 * The call can sit for up to 600 s, so the button stays in a pending state
 * rather than timing out on its own.
 */
export function OnboardingRoute() {
	const navigate = useNavigate();
	const [providers, setProviders] = useState<LoginProvider[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [opened, setOpened] = useState<string | null>(null);

	const { bridge, snapshot } = useBridge("scratch", {
		onOpenUrl: async (url, _instructions, launchUrl) => {
			setOpened(launchUrl ?? url);
			await openUrl(url).catch(() => {});
		},
	});

	const load = useCallback(async () => {
		try {
			setProviders(await bridge.getLoginProviders());
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, [bridge]);

	useEffect(() => {
		if (snapshot.status === "ready") void load();
	}, [load, snapshot.status]);

	const signIn = useCallback(
		async (id: string) => {
			setPending(id);
			setError(null);
			try {
				await bridge.login(id);
				await load();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setPending(null);
				setOpened(null);
			}
		},
		[bridge, load],
	);

	const authenticated = providers?.filter(provider => provider.authenticated) ?? [];
	const available = providers?.filter(provider => provider.available && !provider.authenticated) ?? [];

	return (
		<main className="omp-main omp-main--manage">
			<div className="omp-screen__scroll">
				<div className="omp-screen">
					<header className="omp-screen__head">
						<h1 className="omp-screen__title">Connect a provider</h1>
						<p className="omp-screen__lede">
							omp needs credentials for at least one model provider. Signing in opens your browser and comes back
							here.
						</p>
					</header>

					{snapshot.status === "starting" ? (
						<div className="omp-banner omp-banner--info">Starting the agent…</div>
					) : null}
					{error ? <div className="omp-banner omp-banner--error">{error}</div> : null}
					{opened ? (
						<div className="omp-banner omp-banner--info">
							Waiting for the browser. If it did not open: <code>{opened}</code>
						</div>
					) : null}

					{authenticated.length > 0 ? (
						<section className="omp-settings__group">
							<h2 className="omp-settings__group-title">
								Connected <span className="omp-project__count">{authenticated.length}</span>
							</h2>
							{authenticated.map(provider => (
								<div className="omp-setting" key={provider.id}>
									<div className="omp-setting__label">
										<span>{provider.name}</span>
										<code className="omp-setting__key">{provider.id}</code>
									</div>
									<div className="omp-setting__control">
										{/* Same class the sidebar uses; the old one was deleted by the restyle. */}
										<span className="omp-dot omp-dot--done" aria-label="connected" />
									</div>
								</div>
							))}
							<div className="omp-screen__row" style={{ marginTop: 16 }}>
								<button
									type="button"
									data-component="button"
									data-variant="primary"
									data-size="normal"
									onClick={() => void navigate("/")}
								>
									Start working
								</button>
							</div>
						</section>
					) : null}

					<section className="omp-settings__group">
						<h2 className="omp-settings__group-title">
							Available <span className="omp-project__count">{available.length}</span>
						</h2>
						{providers === null ? <div className="omp-empty">Reading providers…</div> : null}
						{available.map(provider => (
							<div className="omp-setting" key={provider.id}>
								<div className="omp-setting__label">
									<span>{provider.name}</span>
									<code className="omp-setting__key">{provider.id}</code>
								</div>
								<div className="omp-setting__control">
									<button
										type="button"
										data-component="button"
										data-variant="ghost"
										data-size="normal"
										disabled={pending !== null}
										onClick={() => void signIn(provider.id)}
									>
										{pending === provider.id ? "Waiting…" : "Sign in"}
									</button>
								</div>
							</div>
						))}
					</section>
				</div>
			</div>
		</main>
	);
}
