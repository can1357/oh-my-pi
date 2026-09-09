//! `/mcp` operates over the Environment's MCP authorities — the persisted
//! config stores (`~/.o2/mcp.json`,
//! `.omp/mcp.json`, `.mcp.json`) for `add`/`remove`/`enable`/`disable`,
//! the live manager for `list`/`test`/`reconnect`/`reload`/`resources`/
//! `prompts`/`notifications`, the OAuth authority for `reauth`/`unauth`, and
//! the authenticated Smithery registry/device-flow authority for search,
//! login, logout, and connect. Every operation settles a report line on a
//! pending receiver so the host's loader panel never blocks.

use std::{fmt::Write as _, path::Path, time::Duration};

use omp_chat::overlays::services::{
	McpAdd, McpOp, McpRun, McpScope, ServiceError, ServiceResult, SmitheryConnect, SmitherySearch,
};
use omp_core::{Str, dirs::DataDirError, sf};
use omp_envd::mcp::{
	McpConfigPaths,
	config::{McpServerConfig, TransportKind, validate_server_name},
	config_store::{McpConfigStore, set_server_enabled},
	manager::{McpInspectorHealth, McpInspectorSnapshot},
	smithery::{
		SmitheryClient, SmitheryError, SmitheryInputKind, SmitherySearchMode, SmitherySearchResult,
		SmitheryTransport, smithery_config_name,
	},
};
use tokio_util::sync::CancellationToken;

use super::ServiceState;

/// Maximum time `/mcp test` waits for a server.
const TEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Poll cadence while a reconnecting server settles.
const TEST_POLL: Duration = Duration::from_millis(200);
/// Maximum number of tool names shown in a test report.
const LISTED_TOOLS: usize = 10;

fn failed(error: impl std::fmt::Display) -> ServiceError {
	ServiceError::failed(error)
}

/// The three MCP config files `/mcp` reads and mutates: the same
/// [`McpConfigPaths`] the Environment and `omp config mcp` address, rooted at
/// the user configuration root (`~/.o2`, profile-aware) — never the data
/// directory.
///
/// # Errors
///
/// Returns [`DataDirError::HomeUnset`] when no home directory is set.
pub fn mcp_config_paths(project: &Path) -> Result<McpConfigPaths, DataDirError> {
	Ok(McpConfigPaths::new(&omp_core::dirs::user_config_root()?, project))
}

pub(super) fn stores(
	state: &ServiceState,
) -> ServiceResult<(McpConfigStore, McpConfigStore, McpConfigStore)> {
	let paths = mcp_config_paths(&state.project).map_err(failed)?;
	Ok((
		McpConfigStore::new(paths.user),
		McpConfigStore::new(paths.project),
		McpConfigStore::new(paths.root),
	))
}

fn store_for(state: &ServiceState, scope: McpScope) -> ServiceResult<McpConfigStore> {
	let paths = mcp_config_paths(&state.project).map_err(failed)?;
	Ok(McpConfigStore::new(match scope {
		McpScope::User => paths.user,
		McpScope::Project => paths.project,
	}))
}

/// Runs one operation; synchronous config edits settle immediately, live
/// manager operations run on the app runtime.
pub(super) fn run(state: &ServiceState, op: McpOp) -> ServiceResult<McpRun> {
	let (tx, rx) = flume::bounded(1);
	match op {
		McpOp::List => {
			let _ = tx.send(list(state));
		},
		McpOp::Add(add) => {
			let _ = tx.send(add_server(state, &add));
		},
		McpOp::Remove(name, scope) => {
			let _ = tx.send(remove_server(state, &name, scope));
		},
		McpOp::SetEnabled(name, enabled) => {
			let _ = tx.send(set_enabled(state, &name, enabled));
		},
		McpOp::Resources => {
			let _ = tx.send(Ok(resources(state)));
		},
		McpOp::Prompts => {
			let _ = tx.send(Ok(prompts(state)));
		},
		McpOp::Notifications => {
			let _ = tx.send(Ok(notifications(state)));
		},
		McpOp::Test(name) => {
			let (cancel_tx, cancel_rx) = flume::bounded::<()>(1);
			let mcp = state.mcp.clone();
			let declared = declared_config(state, &name)?;
			state.runtime.spawn(async move {
				let test = test_server(&mcp, &name, declared);
				let cancelled = cancel_rx.recv_async();
				let result = tokio::select! {
					result = test => result,
					_ = cancelled => Err(ServiceError::Failed(sf!("Cancelled MCP test for \"{name}\""))),
				};
				let _ = tx.send(result);
			});
			return Ok(McpRun { done: rx, cancel: Some(cancel_tx) });
		},
		McpOp::Reconnect(name) => {
			let mcp = state.mcp.clone();
			state.runtime.spawn(async move {
				let result = match mcp.reconnect(&name).await {
					Ok(()) => Ok(sf!("Reconnected to \"{name}\".")),
					Err(error) => Err(ServiceError::Failed(sf!(
						"Failed to reconnect to \"{name}\": {error}. Check server status and logs."
					))),
				};
				let _ = tx.send(result);
			});
		},
		McpOp::Reload => {
			let mcp = state.mcp.clone();
			state.runtime.spawn(async move {
				let result = match mcp.reload().await {
					Ok(snapshot) => {
						let connected = mcp
							.snapshots()
							.iter()
							.filter(|server| server.health == McpInspectorHealth::Connected)
							.count();
						let _ = snapshot;
						Ok(sf!("MCP reload complete\n  Connected servers: {connected}"))
					},
					Err(error) => Err(ServiceError::Failed(sf!("Failed to reload MCP: {error}"))),
				};
				let _ = tx.send(result);
			});
		},
		McpOp::Reauth(name) => {
			let (cancel_tx, cancel_rx) = flume::bounded::<()>(1);
			let mcp = state.mcp.clone();
			let con = std::sync::Arc::clone(&state.con);
			let declared = declared_config(state, &name)?;
			state.runtime.spawn(async move {
				let cancel = CancellationToken::new();
				let cancellation = cancel.clone();
				let cancel_task = tokio::spawn(async move {
					let _ = cancel_rx.recv_async().await;
					cancellation.cancel();
				});
				let result = match declared {
					None => Err(ServiceError::Failed(sf!("Server \"{name}\" not found."))),
					Some(config) if !config.enabled => Err(ServiceError::Failed(sf!(
						"Server \"{name}\" is disabled. Run /mcp enable {name} first."
					))),
					Some(_) => match mcp
						.reauthorize(
							&name,
							|presentation| {
								// The URL and optional RFC 8628 code reach the actor
								// while the grant waits for browser or device approval.
								let message = presentation.user_code.map_or_else(
									|| format!("Authorize \"{name}\" in your browser: {}", presentation.url),
									|code| {
										format!(
											"Authorize \"{name}\" at {} with code {code}",
											presentation.url
										)
									},
								);
								con.reply(omp_con::Severity::Info, &message);
							},
							cancel,
						)
						.await
					{
						Ok(true) => Ok(sf!("Reauthorized \"{name}\".")),
						Ok(false) => Ok(sf!("Server \"{name}\" does not use OAuth.")),
						Err(error) => {
							Err(ServiceError::Failed(sf!("Failed to reauthorize server: {error}")))
						},
					},
				};
				cancel_task.abort();
				let _ = tx.send(result);
			});
			return Ok(McpRun { done: rx, cancel: Some(cancel_tx) });
		},
		McpOp::Unauth(name) => {
			let mcp = state.mcp.clone();
			let declared = declared_config(state, &name)?;
			state.runtime.spawn(async move {
				let result = match declared {
					None => Err(ServiceError::Failed(sf!("Server \"{name}\" not found."))),
					Some(_) => match mcp.clear_authorization(&name).await {
						Ok(true) => Ok(sf!("Cleared auth for \"{name}\".")),
						Ok(false) => Ok(sf!("No stored auth for \"{name}\".")),
						Err(error) => Err(ServiceError::Failed(sf!("Failed to clear auth: {error}"))),
					},
				};
				let _ = tx.send(result);
			});
		},
		McpOp::SmitherySearch(search) => {
			let client = smithery_client()?;
			let (cancel_tx, cancel_rx) = flume::bounded::<()>(1);
			state.runtime.spawn(async move {
				let cancel = CancellationToken::new();
				let cancellation = cancel.clone();
				let cancel_task = tokio::spawn(async move {
					let _ = cancel_rx.recv_async().await;
					cancellation.cancel();
				});
				let result = client
					.search(
						&search.keyword,
						search.limit,
						if search.semantic {
							SmitherySearchMode::Semantic
						} else {
							SmitherySearchMode::Identity
						},
						&cancel,
					)
					.await
					.map(|results| smithery_report(&search, &results))
					.map_err(smithery_failure);
				cancel_task.abort();
				let _ = tx.send(result);
			});
			return Ok(McpRun { done: rx, cancel: Some(cancel_tx) });
		},
		McpOp::SmitheryLogin => {
			let client = smithery_client()?;
			let con = std::sync::Arc::clone(&state.con);
			let environment_active = smithery_environment_key_active();
			let (cancel_tx, cancel_rx) = flume::bounded::<()>(1);
			state.runtime.spawn(async move {
				let cancel = CancellationToken::new();
				let cancellation = cancel.clone();
				let cancel_task = tokio::spawn(async move {
					let _ = cancel_rx.recv_async().await;
					cancellation.cancel();
				});
				let result = client
					.login(&cancel, |url| {
						con.reply(
							omp_con::Severity::Info,
							&format!(
								"Complete Smithery authorization in your browser. If it did not open, \
								 visit: {url}"
							),
						);
					})
					.await
					.map(|()| {
						if environment_active {
							Str::new_static(
								"Smithery API key saved. An environment key still takes precedence.",
							)
						} else {
							Str::new_static("Smithery API key saved.")
						}
					})
					.map_err(smithery_failure);
				cancel_task.abort();
				let _ = tx.send(result);
			});
			return Ok(McpRun { done: rx, cancel: Some(cancel_tx) });
		},
		McpOp::SmitheryLogout => {
			let client = smithery_client()?;
			let file_removed = client.credentials().clear().map_err(smithery_failure)?;
			let environment_active = smithery_environment_key_active();
			let report = match (file_removed, environment_active) {
				(true, true) => Str::new_static(
					"Saved Smithery API key removed. An environment key remains active for this \
					 process.",
				),
				(true, false) => Str::new_static("Smithery API key removed."),
				(false, true) => Str::new_static(
					"No saved Smithery API key found. An environment key remains active.",
				),
				(false, false) => Str::new_static("No saved Smithery API key found."),
			};
			let _ = tx.send(Ok(report));
		},
		McpOp::SmitheryConnect(connect) => {
			let client = smithery_client()?;
			let store = store_for(state, connect.scope)?;
			let mcp = state.mcp.clone();
			let con = std::sync::Arc::clone(&state.con);
			let (cancel_tx, cancel_rx) = flume::bounded::<()>(1);
			state.runtime.spawn(async move {
				let cancel = CancellationToken::new();
				let cancellation = cancel.clone();
				let cancel_task = tokio::spawn(async move {
					let _ = cancel_rx.recv_async().await;
					cancellation.cancel();
				});
				let result = connect_smithery(&client, &store, &mcp, &con, &connect, &cancel).await;
				cancel_task.abort();
				let _ = tx.send(result);
			});
			return Ok(McpRun { done: rx, cancel: Some(cancel_tx) });
		},
	}
	Ok(McpRun { done: rx, cancel: None })
}

fn smithery_environment_key_active() -> bool {
	["OMP_SMITHERY_API_KEY", "SMITHERY_API_KEY"]
		.into_iter()
		.any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
}

fn smithery_client() -> ServiceResult<SmitheryClient> {
	let root = omp_core::dirs::user_config_root().map_err(failed)?;
	SmitheryClient::production(&root).map_err(smithery_failure)
}

fn smithery_failure(error: SmitheryError) -> ServiceError {
	if matches!(error, SmitheryError::Cancelled) {
		return ServiceError::Failed(Str::new_static("Smithery operation cancelled."));
	}
	if error.needs_login() {
		return ServiceError::Failed(Str::new_static(
			"Smithery authentication is required or expired. Run /mcp smithery-login.",
		));
	}
	if error.is_rate_limited() {
		return ServiceError::Failed(Str::new_static(
			"Smithery rate limit reached. Wait before retrying.",
		));
	}
	ServiceError::Failed(Str::new(error.to_string()))
}

fn smithery_report(search: &SmitherySearch, results: &[SmitherySearchResult]) -> Str {
	if results.is_empty() {
		return sf!("No Smithery results found for \"{}\".", markdown_text(&search.keyword));
	}
	let query = markdown_text(&search.keyword);
	let mut out = format!(
		"# Smithery registry\n\n{} result{} for **{}**\n",
		results.len(),
		if results.len() == 1 { "" } else { "s" },
		query
	);
	for result in results {
		let transport = match &result.transport {
			SmitheryTransport::Http { .. } => "HTTP",
			SmitheryTransport::Stdio { .. } => "stdio",
		};
		let verified = if result.verified { " · verified" } else { "" };
		let deployed = if result.deployed { " · deployed" } else { "" };
		let display_name = markdown_text(&result.display_name);
		let description = markdown_text(&result.description);
		let _ = write!(
			out,
			"\n## {display_name}\n\n`@{}` · {transport} · {} \
			 uses{verified}{deployed}\n\n{description}\n",
			result.name, result.use_count
		);
		if !result.tools.is_empty() {
			out.push_str("\nTools: ");
			for (index, tool) in result.tools.iter().take(8).enumerate() {
				if index > 0 {
					out.push_str(", ");
				}
				let _ = write!(out, "`{}`", code_text(&tool.name));
			}
			if result.tools.len() > 8 {
				let _ = write!(out, " and {} more", result.tools.len() - 8);
			}
			out.push('\n');
		}
		if !result.required_inputs.is_empty() {
			let names = result
				.required_inputs
				.iter()
				.filter(|input| input.required)
				.map(|input| code_text(&input.key))
				.collect::<Vec<_>>()
				.join(", ");
			if !names.is_empty() {
				let _ = writeln!(out, "\nRequired configuration: `{names}`");
			}
		}
		let _ = writeln!(
			out,
			"\nConnect: `/mcp smithery-connect @{} --scope {}`",
			result.name, search.scope
		);
	}
	Str::new(out)
}

fn markdown_text(value: &str) -> String {
	let mut out = String::with_capacity(value.len());
	for character in value.chars() {
		if matches!(
			character,
			'\\' | '`' | '*' | '_' | '{' | '}' | '[' | ']' | '<' | '>' | '#' | '|' | '~'
		) {
			out.push('\\');
		}
		out.push(character);
	}
	out
}

fn code_text(value: &str) -> String {
	value.replace('`', "'")
}

async fn connect_smithery(
	client: &SmitheryClient,
	store: &McpConfigStore,
	mcp: &omp_envd::McpInspectorHandle,
	con: &omp_con::Ctx,
	request: &SmitheryConnect,
	cancel: &CancellationToken,
) -> ServiceResult<Str> {
	let query = request.target.trim_start_matches('@');
	let results = client
		.search(query, 100, SmitherySearchMode::Identity, cancel)
		.await
		.map_err(smithery_failure)?;
	let result = results
		.into_iter()
		.find(|result| result.name.eq_ignore_ascii_case(query))
		.ok_or_else(|| {
			ServiceError::Failed(sf!(
				"Smithery server \"{}\" was not found. Run /mcp smithery-search first.",
				request.target
			))
		})?;
	if result
		.required_inputs
		.iter()
		.any(|input| input.required && registry_default_value(input).is_none())
	{
		return Err(smithery_failure(SmitheryError::ConfigurationRequired));
	}
	let transport = apply_registry_defaults(result.transport, &result.required_inputs)?;
	let base_name = request
		.name
		.clone()
		.unwrap_or_else(|| smithery_config_name(&result.name));
	let server_name = available_name(store, &base_name, request.name.is_some())?;
	validate_server_name(&server_name)
		.map_err(|error| ServiceError::Failed(sf!("Invalid MCP server name: {error}")))?;
	let transport = match transport {
		SmitheryTransport::Http { url } => {
			let connected = client
				.connect(&url, Some(&server_name), cancel, |authorization_url| {
					con.reply(
						omp_con::Severity::Info,
						&format!(
							"Authorize Smithery connection \"{server_name}\" in your browser: \
							 {authorization_url}"
						),
					);
				})
				.await
				.map_err(smithery_failure)?;
			SmitheryTransport::Http { url: connected.mcp_url }
		},
		transport => transport,
	};
	let mut config = empty_server_config();
	match transport {
		SmitheryTransport::Http { url } => config.url = Some(url),
		SmitheryTransport::Stdio { command, args } => {
			config.command = Some(command);
			config.args = args;
		},
	}
	store
		.add(&server_name, config)
		.map_err(|error| ServiceError::Failed(sf!("Failed to save Smithery server: {error}")))?;
	mcp.reload().await.map_err(|error| {
		ServiceError::Failed(sf!("Smithery server saved, but MCP refresh failed: {error}"))
	})?;
	mcp.reconnect(&server_name).await.map_err(|error| {
		ServiceError::Failed(sf!("Smithery server saved, but its first connection failed: {error}"))
	})?;
	let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
	loop {
		match mcp
			.snapshots()
			.into_iter()
			.find(|server| server.server.as_str() == server_name.as_str())
			.map(|server| server.health)
		{
			Some(McpInspectorHealth::Connected) => break,
			Some(McpInspectorHealth::Failed) => {
				return Err(ServiceError::Failed(Str::new_static(
					"Smithery server was saved, but its first MCP connection failed.",
				)));
			},
			_ if tokio::time::Instant::now() >= deadline => {
				return Err(ServiceError::Failed(Str::new_static(
					"Smithery server was saved, but its MCP catalog refresh timed out.",
				)));
			},
			_ => tokio::time::sleep(TEST_POLL).await,
		}
	}
	Ok(sf!(
		"Connected Smithery server \"{server_name}\" in {} config and refreshed MCP tools.",
		request.scope
	))
}

fn apply_registry_defaults(
	transport: SmitheryTransport,
	inputs: &[omp_envd::mcp::smithery::SmitheryInput],
) -> ServiceResult<SmitheryTransport> {
	let SmitheryTransport::Stdio { command, mut args } = transport else {
		return Ok(transport);
	};
	let values = inputs
		.iter()
		.filter_map(|input| Some((input.key.to_string(), registry_default_value(input)?)))
		.collect::<serde_json::Map<_, _>>();
	if values.is_empty() {
		return Ok(SmitheryTransport::Stdio { command, args });
	}
	let encoded = serde_json::to_string(&values).map_err(|error| {
		ServiceError::Failed(sf!("Smithery defaults could not be encoded: {error}"))
	})?;
	if let Some(index) = args.iter().position(|arg| arg.as_str() == "--config") {
		if let Some(value) = args.get_mut(index + 1) {
			*value = Str::new(encoded);
		} else {
			args.push(Str::new(encoded));
		}
	} else {
		args.push(Str::new_static("--config"));
		args.push(Str::new(encoded));
	}
	Ok(SmitheryTransport::Stdio { command, args })
}

fn registry_default_value(
	input: &omp_envd::mcp::smithery::SmitheryInput,
) -> Option<serde_json::Value> {
	let default = input.default_value.as_deref()?;
	match input.kind {
		SmitheryInputKind::String => Some(serde_json::Value::String(default.to_owned())),
		SmitheryInputKind::Number => default
			.parse::<serde_json::Number>()
			.ok()
			.map(serde_json::Value::Number),
		SmitheryInputKind::Boolean => default.parse::<bool>().ok().map(serde_json::Value::Bool),
	}
}

fn available_name(store: &McpConfigStore, base: &str, explicit: bool) -> ServiceResult<Str> {
	let existing = store.list().map_err(failed)?;
	if !existing.iter().any(|name| name.as_str() == base) {
		return Ok(Str::new(base));
	}
	if explicit {
		return Err(ServiceError::Failed(sf!("MCP server \"{base}\" already exists in this scope.")));
	}
	for suffix in 2..=999 {
		let candidate = sf!("{base}-{suffix}");
		if !existing.iter().any(|name| name == &candidate) {
			return Ok(candidate);
		}
	}
	Err(ServiceError::Failed(sf!("No available MCP server name derived from \"{base}\".")))
}

fn empty_server_config() -> McpServerConfig {
	McpServerConfig {
		transport:         None,
		enabled:           true,
		command:           None,
		args:              Vec::new(),
		env:               Default::default(),
		env_policy:        None,
		env_literal_keys:  Default::default(),
		cwd:               None,
		url:               None,
		headers:           Default::default(),
		header_policy:     None,
		timeout:           None,
		request_id_format: None,
		auth:              None,
		oauth:             None,
		protocol_versions: Vec::new(),
	}
}

/// The declaration for `name` from the highest-precedence writable store.
fn declared_config(state: &ServiceState, name: &str) -> ServiceResult<Option<McpServerConfig>> {
	let (user, project, root) = stores(state)?;
	for store in [project, user, root] {
		if let Some(config) = store.get(name).map_err(failed)? {
			return Ok(Some(config));
		}
	}
	Ok(None)
}

/// Lists user-level, project-level, then discovered servers,
/// each with its connection state.
fn list(state: &ServiceState) -> ServiceResult<Str> {
	let (user, project, root) = stores(state)?;
	let live = state.mcp.snapshots();
	let health = |name: &str| {
		live
			.iter()
			.find(|server| server.server == name)
			.map(|server| server.health)
	};
	let mut out = String::new();
	let mut declared = std::collections::BTreeSet::new();
	for (label, store) in
		[("User level", &user), ("Project level", &project), ("Project root", &root)]
	{
		let file = store.read().map_err(failed)?;
		if file.mcp_servers.is_empty() {
			continue;
		}
		let _ = writeln!(out, "{label} ({}):", shorten(store.path(), &state.project));
		for (name, config) in &file.mcp_servers {
			declared.insert(name.clone());
			let kind = match config.resolved_transport() {
				TransportKind::Stdio => "stdio",
				_ => "http",
			};
			let status = if !config.enabled {
				"◌ inactive"
			} else {
				status_label(health(name))
			};
			let _ = writeln!(out, "  {name} {status} [{kind}]");
		}
		out.push('\n');
	}
	let discovered = live
		.iter()
		.filter(|server| !declared.contains(&server.server))
		.collect::<Vec<_>>();
	if !discovered.is_empty() {
		out.push_str("Discovered (extension-mounted):\n");
		for server in discovered {
			let _ = writeln!(out, "  {} {}", server.server, status_label(Some(server.health)));
		}
		out.push('\n');
	}
	if out.is_empty() {
		return Ok(Str::new_static(
			"No MCP servers configured. Add one with /mcp add <name> -- <command>.",
		));
	}
	Ok(Str::new(out.trim_end()))
}

const fn status_label(health: Option<McpInspectorHealth>) -> &'static str {
	match health {
		Some(McpInspectorHealth::Connected) => "● connected",
		Some(McpInspectorHealth::Connecting) => "◌ connecting",
		Some(McpInspectorHealth::Failed) => "○ failed",
		Some(McpInspectorHealth::Disconnected) | None => "○ not connected",
	}
}

fn shorten(path: &Path, project: &Path) -> String {
	path
		.strip_prefix(project)
		.map_or_else(|_| path.display().to_string(), |rest| rest.display().to_string())
}

/// Validates, writes, and reports a non-interactive server addition.
fn add_server(state: &ServiceState, add: &McpAdd) -> ServiceResult<Str> {
	let store = store_for(state, add.scope)?;
	let mut config = empty_server_config();
	if let Some(url) = &add.url {
		config.url = Some(url.clone());
	} else if let Some((command, args)) = add.command.split_first() {
		config.command = Some(command.clone());
		config.args = args.to_vec();
	}
	store
		.add(&add.name, config)
		.map_err(|error| ServiceError::Failed(sf!("Failed to add server: {error}")))?;
	schedule_reload(state);
	Ok(sf!(
		"Added MCP server \"{}\" to {} config ({}).",
		add.name,
		add.scope,
		shorten(store.path(), &state.project)
	))
}

/// Removes a configured server and schedules a reload.
fn remove_server(state: &ServiceState, name: &str, scope: McpScope) -> ServiceResult<Str> {
	let store = store_for(state, scope)?;
	if store.get(name).map_err(failed)?.is_none() {
		return Err(ServiceError::Failed(sf!("Server \"{name}\" not found in {scope} config.")));
	}
	store
		.remove(name)
		.map_err(|error| ServiceError::Failed(sf!("Failed to remove server: {error}")))?;
	schedule_reload(state);
	Ok(sf!("Removed MCP server \"{name}\" from {scope} config."))
}

/// Changes a server's enabled state and schedules a reload.
fn set_enabled(state: &ServiceState, name: &str, enabled: bool) -> ServiceResult<Str> {
	let known = declared_config(state, name)?.is_some()
		|| state
			.mcp
			.snapshots()
			.iter()
			.any(|server| server.server == name);
	if !known {
		return Err(ServiceError::Failed(sf!("Server \"{name}\" not found.")));
	}
	let (user, project, root) = stores(state)?;
	set_server_enabled(&user, &project, Some(&root), name, enabled).map_err(|error| {
		ServiceError::Failed(sf!(
			"Failed to {} server: {error}",
			if enabled { "enable" } else { "disable" }
		))
	})?;
	schedule_reload(state);
	Ok(sf!("{} MCP server \"{name}\".", if enabled { "Enabled" } else { "Disabled" }))
}

/// Config edits become live through a background reload.
fn schedule_reload(state: &ServiceState) {
	let mcp = state.mcp.clone();
	state.runtime.spawn(async move {
		if let Err(error) = mcp.reload().await {
			tracing::warn!(%error, "MCP reload after config edit failed");
		}
	});
}

/// Reconnects, waits for the catalog, then reports the
/// server and its tools.
async fn test_server(
	mcp: &omp_envd::McpInspectorHandle,
	name: &str,
	declared: Option<McpServerConfig>,
) -> ServiceResult<Str> {
	if let Some(config) = &declared
		&& !config.enabled
	{
		return Err(ServiceError::Failed(sf!(
			"Server \"{name}\" is disabled. Run /mcp enable {name} first."
		)));
	}
	let mounted = mcp.snapshots().iter().any(|server| server.server == name);
	if declared.is_none() && !mounted {
		return Err(ServiceError::Failed(sf!(
			"Server \"{name}\" not found.\n\nTip: Run /mcp list to see available servers."
		)));
	}
	if let Err(error) = mcp.reconnect(name).await {
		return Err(ServiceError::Failed(sf!(
			"Failed to connect to \"{name}\": {error}{}",
			tip(&error.to_string())
		)));
	}
	let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
	loop {
		let snapshot = mcp
			.snapshots()
			.into_iter()
			.find(|server| server.server == name);
		match snapshot {
			Some(server) if server.health == McpInspectorHealth::Connected => {
				return Ok(test_report(name, &server));
			},
			Some(server) if server.health == McpInspectorHealth::Failed => {
				return Err(ServiceError::Failed(sf!(
					"Failed to connect to \"{name}\": the server reported a failure. Check its logs."
				)));
			},
			_ if tokio::time::Instant::now() >= deadline => {
				return Err(ServiceError::Failed(sf!(
					"Failed to connect to \"{name}\": timeout\n\nTip: The server may be slow or \
					 unresponsive. Try increasing the timeout."
				)));
			},
			_ => tokio::time::sleep(TEST_POLL).await,
		}
	}
}

/// Helpful error suffixes for common connection failures.
fn tip(message: &str) -> &'static str {
	if message.contains("ENOENT") || message.contains("not found") {
		"\n\nTip: Check that the command or URL is correct."
	} else if message.contains("EACCES") {
		"\n\nTip: Check file/command permissions."
	} else if message.contains("ECONNREFUSED") {
		"\n\nTip: Check that the server is running and the URL/port is correct."
	} else if message.contains("timeout") {
		"\n\nTip: The server may be slow or unresponsive. Try increasing the timeout."
	} else if message.contains("401") || message.contains("403") {
		"\n\nTip: Check your authentication credentials."
	} else {
		""
	}
}

fn test_report(name: &str, server: &McpInspectorSnapshot) -> Str {
	let mut out = format!(
		"✓ Successfully connected to \"{name}\"\n\n  Server: {} v{}\n  Tools: {}",
		server.implementation.as_deref().unwrap_or(name),
		server.version.as_deref().unwrap_or("?"),
		server.tools.len()
	);
	if !server.tools.is_empty() && server.tools.len() <= LISTED_TOOLS {
		out.push_str("\n\n  Available tools:");
		for tool in server.tools.iter() {
			if let Some(tool) = tool.get("name").and_then(|name| name.as_str()) {
				let _ = write!(out, "\n    • {tool}");
			}
		}
	}
	Str::new(out)
}

/// Renders resources from connected servers.
fn resources(state: &ServiceState) -> Str {
	let mut out = String::new();
	for server in state.mcp.snapshots() {
		if server.resources.is_empty() {
			continue;
		}
		let _ = writeln!(out, "{}:", server.server);
		for resource in server.resources.iter() {
			let _ = writeln!(out, "  {} — {}", resource.uri, resource.name);
		}
	}
	if out.is_empty() {
		return Str::new_static("No resources available from connected servers.");
	}
	Str::new(out.trim_end())
}

/// Renders prompts from connected servers.
fn prompts(state: &ServiceState) -> Str {
	let mut out = String::new();
	for server in state.mcp.snapshots() {
		if server.prompts.is_empty() {
			continue;
		}
		let _ = writeln!(out, "{}:", server.server);
		for prompt in server.prompts.iter() {
			match &prompt.description {
				Some(description) => {
					let _ = writeln!(out, "  {} — {description}", prompt.name);
				},
				None => {
					let _ = writeln!(out, "  {}", prompt.name);
				},
			}
		}
	}
	if out.is_empty() {
		return Str::new_static("No prompts available from connected servers.");
	}
	Str::new(out.trim_end())
}

/// Renders a per-server capability summary.
fn notifications(state: &ServiceState) -> Str {
	let mut out = String::new();
	for server in state.mcp.snapshots() {
		let _ = writeln!(
			out,
			"{} — {} · {} tools · {} resources · {} prompts",
			server.server,
			status_label(Some(server.health)),
			server.tools.len(),
			server.resources.len(),
			server.prompts.len()
		);
	}
	if out.is_empty() {
		return Str::new_static("No connected MCP servers.");
	}
	Str::new(out.trim_end())
}
