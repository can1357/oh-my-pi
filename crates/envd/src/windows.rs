//! Owner-scoped Windows named-pipe listener for the environment DATA plane.

use std::{
	fs, future, io,
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use omp_con::Ctx;
use omp_core::Hash32;
use omp_tool::Registry;
use tokio::{
	signal::ctrl_c,
	sync::{watch, watch::Receiver},
	task::JoinSet,
	time,
};
use tokio_util::sync::CancellationToken;

use super::{
	exec::ExecHost,
	host_settings,
	server::{ConnectionPolicy, EnvServer, EnvdError, ExtensionDataBinding},
	workspace::WorkspaceHost,
};
pub use crate::windows::OwnerPipeListener;
use crate::{EnvdConfig, RegistryBridges};

/// Derives the stable pipe identity for one fully scoped extension binding.
pub(crate) fn extension_pipe_endpoint(binding: &ExtensionDataBinding) -> PathBuf {
	scoped_pipe_endpoint(binding.path())
}

fn scoped_pipe_endpoint(identity: &Path) -> PathBuf {
	let mut hasher = Hash32::hasher();
	hasher.update(b"omp/extension-data-pipe/v1");
	let identity = identity.as_os_str().as_encoded_bytes();
	hasher.update(&(identity.len() as u64).to_le_bytes());
	hasher.update(identity);
	let digest = hasher.finalize().to_hex();
	PathBuf::from(format!(r"\\.\pipe\omp-env-{digest}"))
}

/// Serves one extension host's owner-scoped DATA pipe until cancellation.
pub(crate) async fn serve_extension_pipe(
	server: Arc<EnvServer>,
	binding: ExtensionDataBinding,
	shutdown: CancellationToken,
) -> Result<(), EnvdError> {
	let endpoint = extension_pipe_endpoint(&binding);
	let listener = OwnerPipeListener::bind(endpoint)?;
	let policy = binding.policy();
	serve_pipe(server, listener, shutdown, policy, None).await
}

/// Serves a pre-bound, ready project-owner pipe until cancellation.
pub(crate) async fn serve_owner_pipe(
	server: Arc<EnvServer>,
	listener: OwnerPipeListener,
	shutdown: CancellationToken,
	connection_gauge: Option<watch::Sender<usize>>,
) -> Result<(), EnvdError> {
	let retire = CancellationToken::new();
	let policy = ConnectionPolicy::external(Some(retire.clone()));
	serve_pipe(server, listener, shutdown, policy, Some((retire, connection_gauge))).await
}

async fn serve_pipe(
	server: Arc<EnvServer>,
	listener: OwnerPipeListener,
	shutdown: CancellationToken,
	policy: ConnectionPolicy,
	retirement: Option<(CancellationToken, Option<watch::Sender<usize>>)>,
) -> Result<(), EnvdError> {
	let (retire, connection_gauge) = retirement.unwrap_or_else(|| (CancellationToken::new(), None));
	let mut listener = Some(listener);
	let mut connections = JoinSet::new();
	let mut abort_connections = false;
	if let Some(gauge) = &connection_gauge {
		gauge.send_replace(0);
	}
	loop {
		if retire.is_cancelled() && listener.is_some() {
			drop(listener.take());
			if connections.is_empty() {
				break;
			}
		}
		tokio::select! {
			() = shutdown.cancelled() => {
				abort_connections = true;
				break;
			},
			() = retire.cancelled(), if listener.is_some() => {},
			accepted = async {
				listener.as_mut().expect("guarded listener").accept().await
			}, if listener.is_some() => {
				let stream = accepted?;
				let server = Arc::clone(&server);
				let policy = policy.clone();
				connections.spawn(async move {
					server.serve_io_with_policy(stream, policy).await
				});
				if let Some(gauge) = &connection_gauge {
					gauge.send_replace(connections.len());
				}
			},
			completed = connections.join_next(), if !connections.is_empty() => {
				if let Some(gauge) = &connection_gauge {
					gauge.send_replace(connections.len());
				}
				match completed {
					Some(Ok(Ok(()))) | None => {},
					Some(Ok(Err(error))) => return Err(error),
					Some(Err(error)) => return Err(error.into()),
				}
				if listener.is_none() && connections.is_empty() {
					break;
				}
			},
		}
	}
	drop(listener);
	if abort_connections {
		connections.abort_all();
		while let Some(result) = connections.join_next().await {
			if let Err(error) = result
				&& !error.is_cancelled()
			{
				return Err(error.into());
			}
		}
	}
	if let Some(gauge) = connection_gauge {
		gauge.send_replace(0);
	}
	Ok(())
}

/// Assembles and runs the Windows project environment daemon.
pub(crate) async fn run(
	args: EnvdConfig,
	con: Arc<Ctx>,
	bridges: RegistryBridges,
) -> Result<(), EnvdError> {
	use super::worker_config;
	let workspace = WorkspaceHost::open(&args.root)?;
	let root = workspace.root().to_path_buf();
	let data_dir = omp_core::dirs::data_dir(None).map_err(io::Error::other)?;
	let interrupt_grace = host_settings::SV_INTERRUPT_GRACE.get(&con);
	let state_dir = if let Some(path) = args.state_dir {
		path
	} else {
		omp_env::project_state::directory(&data_dir, &root)?
	};
	fs::create_dir_all(&state_dir)?;
	let socket = args
		.socket
		.unwrap_or_else(|| omp_env::project_state::environment_socket(&state_dir));
	let require_document_ownership = args.docserver_socket.is_none();
	let docserver_socket = args
		.docserver_socket
		.unwrap_or_else(|| omp_env::project_state::document_socket(&state_dir));
	let owner_listener = OwnerPipeListener::bind(&socket)?;
	let (worker_config, extension_bindings) =
		worker_config(&state_dir, args.py_eval, &[], &[], interrupt_grace)?;
	let (env_connections, env_connection_rx) = watch::channel(0);
	let (doc_connections, doc_connection_rx) = watch::channel(0);
	let convars = Arc::new(crate::exthost::ConvarControlFactory::new(Arc::clone(&con)));
	let server = Arc::new(
		EnvServer::open_project(
			&root,
			&state_dir,
			&docserver_socket,
			Registry::new(),
			worker_config,
			Some(doc_connections),
			require_document_ownership,
			None,
			&con,
			convars,
			bridges,
		)
		.await?,
	);
	let process_shutdown = CancellationToken::new();
	let signal = process_shutdown.clone();
	let signal_task = tokio::spawn(async move {
		let _ = ctrl_c().await;
		signal.cancel();
	});
	let listener_shutdown = CancellationToken::new();
	let owner_shutdown = listener_shutdown.clone();
	let owner_server = Arc::clone(&server);
	let mut owner_task = tokio::spawn(async move {
		serve_owner_pipe(owner_server, owner_listener, owner_shutdown, Some(env_connections)).await
	});
	let mut extension_tasks = JoinSet::new();
	for binding in extension_bindings {
		let extension_server = Arc::clone(&server);
		let extension_shutdown = listener_shutdown.clone();
		extension_tasks.spawn(async move {
			serve_extension_pipe(extension_server, binding, extension_shutdown).await
		});
	}
	let idle_timeout = Duration::from_secs(args.idle_timeout);
	let idle =
		wait_idle(env_connection_rx, doc_connection_rx, 1, idle_timeout, server.process_host());
	tokio::pin!(idle);
	tokio::select! {
		() = process_shutdown.cancelled() => {
			listener_shutdown.cancel();
			owner_task.await??;
		},
		() = &mut idle => {
			listener_shutdown.cancel();
			owner_task.await??;
		},
		result = &mut owner_task => {
			result??;
			tokio::select! {
				() = process_shutdown.cancelled() => {},
				() = &mut idle => {},
			}
		},
	}
	listener_shutdown.cancel();
	while let Some(result) = extension_tasks.join_next().await {
		result??;
	}
	server.shutdown_managed(interrupt_grace).await;
	signal_task.abort();
	Ok(())
}

async fn wait_idle(
	mut env: Receiver<usize>,
	mut docs: Receiver<usize>,
	reserved_docs: usize,
	timeout: Duration,
	processes: ExecHost,
) {
	if timeout.is_zero() {
		future::pending::<()>().await;
		return;
	}
	let mut env_open = true;
	let mut docs_open = true;
	loop {
		while *env.borrow() != 0
			|| *docs.borrow() > reserved_docs
			|| processes.has_live_persistent_processes()
		{
			tokio::select! {
				result = env.changed(), if env_open => env_open = result.is_ok(),
				result = docs.changed(), if docs_open => docs_open = result.is_ok(),
				() = time::sleep(Duration::from_millis(50)) => {},
			}
		}
		let idle = time::sleep(timeout);
		tokio::pin!(idle);
		loop {
			tokio::select! {
				() = &mut idle => return,
				result = env.changed(), if env_open => {
					env_open = result.is_ok();
					if *env.borrow() != 0 || *docs.borrow() > reserved_docs {
						break;
					}
				},
				result = docs.changed(), if docs_open => {
					docs_open = result.is_ok();
					if *env.borrow() != 0 || *docs.borrow() > reserved_docs {
						break;
					}
				},
				() = time::sleep(Duration::from_millis(50)) => {
					if processes.has_live_persistent_processes() {
						break;
					}
				},
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn extension_endpoints_are_scope_specific_and_stable() {
		let first = Path::new(r"C:\omp\state\ext-env\host-a.sock");
		let same = Path::new(r"C:\omp\state\ext-env\host-a.sock");
		let second = Path::new(r"C:\omp\state\ext-env\host-b.sock");
		assert_eq!(scoped_pipe_endpoint(first), scoped_pipe_endpoint(same));
		assert_ne!(scoped_pipe_endpoint(first), scoped_pipe_endpoint(second));
	}
}
