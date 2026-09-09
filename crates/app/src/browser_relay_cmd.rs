//! Native `omp browser-relay` serve and extension-install commands.

use std::time::Duration;

use miette::{IntoDiagnostic as _, miette};
use omp_envd::browser_relay::{RelayOptions, RelayServer, install_extension, probe_relay_server};
use tokio::io::AsyncReadExt as _;

use crate::cli::{BrowserRelayAction, BrowserRelayArgs};

/// Runs the native relay service or installs its bundled Chrome extension.
pub(crate) async fn run(args: BrowserRelayArgs) -> miette::Result<()> {
	match args.action {
		BrowserRelayAction::Install => install(args),
		BrowserRelayAction::Serve => serve(args).await,
	}
}

fn install(args: BrowserRelayArgs) -> miette::Result<()> {
	let directory = install_extension(args.dir.as_deref()).into_diagnostic()?;
	println!("Installed the OMP Browser Relay extension to {}", directory.display());
	println!();
	println!("Finish setup in Chrome:");
	println!("  1. Open chrome://extensions and enable Developer mode.");
	println!("  2. Click \"Load unpacked\" and select: {}", directory.display());
	println!("  3. Enable the mode:  omp config set browser.relay true");
	println!();
	println!("omp starts the relay automatically when the browser prelude needs it;");
	println!("run `omp browser-relay` yourself only for --token or --no-group.");
	println!("The extension badge shows 'on' once it reaches a relay.");
	Ok(())
}

async fn serve(args: BrowserRelayArgs) -> miette::Result<()> {
	let requested_endpoint = format!("http://{}", std::net::SocketAddr::new(args.bind, args.port));
	let token_required = args.token.is_some();
	let relay = match RelayServer::start(RelayOptions {
		bind:    args.bind,
		port:    args.port,
		token:   args.token,
		group:   !args.no_group,
		verbose: args.verbose,
		managed: args.managed,
	}) {
		Ok(relay) => relay,
		Err(error) if error.is_addr_in_use() && probe_relay_server(&requested_endpoint) => {
			println!("omp browser relay already running on {requested_endpoint}; nothing to do.");
			return Ok(());
		},
		Err(error) if error.is_addr_in_use() => {
			return Err(miette!(
				"Port {} is in use by something that is not an omp browser relay.",
				args.port
			));
		},
		Err(error) => return Err(error).into_diagnostic(),
	};
	let endpoint = format!(
		"http://{}",
		std::net::SocketAddr::new(args.bind, relay.port())
	);

	println!("omp browser relay listening on {endpoint}");
	println!(
		"  extension endpoint  ws://{}/ext{}",
		std::net::SocketAddr::new(args.bind, relay.port()),
		if token_required { "?token=***" } else { "" }
	);
	if args.port == 9224 {
		println!("  enable with         omp config set browser.relay true");
	} else {
		println!(
			"  enable with         omp config set browser.relay true && omp config set \
			 browser.relayUrl {endpoint}"
		);
	}
	println!(
		"Waiting for the OMP Browser Relay extension to connect (omp browser-relay install)..."
	);

	let mut announced = false;
	let mut readiness = tokio::time::interval(Duration::from_millis(500));
	{
		let termination = async {
			if args.managed {
				relay.wait_for_managed_shutdown().await;
			} else {
				termination_signal().await;
			}
		};
		let bootstrap_closed = async {
			if args.managed {
				let mut stdin = tokio::io::stdin();
				let mut byte = [0_u8; 1];
				let _ = stdin.read(&mut byte).await;
				if relay.has_consumer_lease() {
					std::future::pending::<()>().await;
				}
			} else {
				std::future::pending::<()>().await;
			}
		};
		tokio::pin!(termination);
		tokio::pin!(bootstrap_closed);
		loop {
			tokio::select! {
				_ = &mut termination => break,
				_ = &mut bootstrap_closed => break,
				_ = readiness.tick() => {
					if relay.ready() && !announced {
						announced = true;
						println!("Extension connected. The omp browser prelude can now drive your tabs.");
					} else if !relay.ready() && announced {
						announced = false;
						println!("Extension disconnected; waiting for it to reconnect...");
					}
				},
			}
		}
	}
	relay.stop();
	Ok(())
}

#[cfg(unix)]
async fn termination_signal() {
	let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
		.expect("SIGTERM handler");
	tokio::select! {
		_ = tokio::signal::ctrl_c() => {},
		_ = terminate.recv() => {},
	}
}

#[cfg(not(unix))]
async fn termination_signal() {
	let _ = tokio::signal::ctrl_c().await;
}
