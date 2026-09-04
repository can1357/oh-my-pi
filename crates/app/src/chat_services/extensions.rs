//! `/extensions`, `/reload-plugins`: extension and MCP server status joined
//! from the live envd authorities and the persisted enable switches.
//!
//! Row ids use `mcp:<server>`, `ext:<id>`, and `plugin:<name@market>` so
//! the dashboard's toggle routes back to the switch that owns the row: the
//! MCP config stores (`~/.o2/mcp.json`, `.omp/mcp.json`, `.mcp.json`), the
//! extension installation record (`omp ext enable|disable`), or the
//! marketplace plugin registry.

use std::collections::BTreeMap;

use omp_chat::overlays::services::{
	ExtensionKind, ExtensionRow, ExtensionStatus, Pending, ServiceError, ServiceResult,
};
use omp_core::{Str, sf};
use omp_envd::mcp::{
	config::{ConfigSource, ConfigSourceKind, resolve_sources},
	config_store::set_server_enabled,
	manager::{McpInspectorHealth, McpInspectorSnapshot},
};

use super::ServiceState;
use crate::ext_cli::{Scope, StatePaths, service::ExtensionTransactions};

const MCP_PREFIX: &str = "mcp:";
const EXT_PREFIX: &str = "ext:";
const PLUGIN_PREFIX: &str = "plugin:";

/// Every MCP server, installed Python extension, and marketplace plugin.
pub(super) fn rows(state: &ServiceState) -> ServiceResult<Vec<ExtensionRow>> {
	let mut rows = mcp_rows(state)?;
	let paths = StatePaths::new(&state.data_dir, &state.project);
	rows.extend(python_rows(state, &paths)?);
	rows.extend(plugin_rows(state)?);
	Ok(rows)
}

/// Flips the persisted switch behind `id` and, for extensions, respawns
/// the worker generation so the change is live.
pub(super) fn set_enabled(state: &ServiceState, id: &str, enabled: bool) -> ServiceResult<()> {
	if let Some(name) = id.strip_prefix(MCP_PREFIX) {
		let (user, project, root) = super::mcp::stores(state)?;
		return set_server_enabled(&user, &project, Some(&root), name, enabled)
			.map_err(ServiceError::failed);
	}
	if let Some(extension) = id.strip_prefix(EXT_PREFIX) {
		let paths = StatePaths::new(&state.data_dir, &state.project);
		let scope = crate::ext_cli::service::installed_views(&paths)
			.map_err(ServiceError::failed)?
			.into_iter()
			.find(|view| view.id == extension)
			.map(|view| view.scope)
			.ok_or_else(|| ServiceError::Failed(sf!("extension {extension} is not installed")))?;
		crate::ext_cli::enable(&paths.scoped(scope), extension, enabled)
			.map_err(ServiceError::failed)?;
		let reload = state.reload.clone();
		state.runtime.spawn(async move {
			if let Err(error) = reload.reload().await {
				tracing::warn!(%error, "extension reload after toggle failed");
			}
		});
		return Ok(());
	}
	if let Some(spec) = id.strip_prefix(PLUGIN_PREFIX) {
		return super::plugins::set_enabled(state, spec, enabled);
	}
	Err(ServiceError::Failed(sf!("unknown extension id {id}")))
}

/// Respawns every extension worker generation from disk.
pub(super) fn reload(state: &ServiceState) -> ServiceResult<Pending<Str>> {
	let (tx, rx) = flume::bounded(1);
	let reload = state.reload.clone();
	state.runtime.spawn(async move {
		let result = reload
			.reload()
			.await
			.map(|_| Str::new_static("Plugins reloaded."))
			.map_err(ServiceError::failed);
		let _ = tx.send(result);
	});
	Ok(rx)
}

/// Live MCP catalogs joined with the persisted configuration so disabled
/// declarations still appear (as `Disabled`) beside the mounted ones.
fn mcp_rows(state: &ServiceState) -> ServiceResult<Vec<ExtensionRow>> {
	let (user, project, root) = super::mcp::stores(state)?;
	let sources: Vec<ConfigSource> = [
		(ConfigSourceKind::Project, project),
		(ConfigSourceKind::User, user),
		(ConfigSourceKind::Root, root),
	]
	.into_iter()
	.map(|(kind, store)| {
		store
			.read()
			.map(|file| ConfigSource { path: store.path().to_path_buf(), kind, file })
			.map_err(ServiceError::failed)
	})
	.collect::<ServiceResult<Vec<_>>>()?;
	let resolved = resolve_sources(&sources, true);
	let mut declared: BTreeMap<Str, (bool, Str)> = BTreeMap::new();
	for source in &sources {
		for (name, config) in &source.file.mcp_servers {
			let transport = config
				.command
				.as_ref()
				.map_or_else(|| sf!("http"), |command| sf!("stdio · {command}"));
			declared
				.entry(name.clone())
				.or_insert((resolved.servers.contains_key(name), transport));
		}
	}
	let mut rows: BTreeMap<Str, ExtensionRow> = BTreeMap::new();
	for snapshot in state.mcp.snapshots() {
		let enabled = declared
			.get(&snapshot.server)
			.is_none_or(|(enabled, _)| *enabled);
		rows.insert(snapshot.server.clone(), mcp_row(&snapshot, enabled));
	}
	for (name, (enabled, transport)) in declared {
		rows.entry(name.clone()).or_insert_with(|| ExtensionRow {
			id: sf!("{MCP_PREFIX}{name}"),
			name: name.clone(),
			kind: ExtensionKind::Mcp,
			status: if enabled {
				ExtensionStatus::Disconnected
			} else {
				ExtensionStatus::Disabled
			},
			enabled,
			version: None,
			description: Some(transport),
			tools: Vec::new(),
			resources: Vec::new(),
			prompts: Vec::new(),
			error: None,
		});
	}
	Ok(rows.into_values().collect())
}

fn mcp_row(snapshot: &McpInspectorSnapshot, enabled: bool) -> ExtensionRow {
	let status = if !enabled {
		ExtensionStatus::Disabled
	} else {
		match snapshot.health {
			McpInspectorHealth::Connecting => ExtensionStatus::Connecting,
			McpInspectorHealth::Connected => ExtensionStatus::Ready,
			McpInspectorHealth::Disconnected => ExtensionStatus::Disconnected,
			McpInspectorHealth::Failed => ExtensionStatus::Failed,
		}
	};
	let version = snapshot.implementation.as_ref().map(|implementation| {
		snapshot
			.version
			.as_ref()
			.map_or_else(|| implementation.clone(), |version| sf!("{implementation} {version}"))
	});
	ExtensionRow {
		id: sf!("{MCP_PREFIX}{}", snapshot.server),
		name: snapshot.server.clone(),
		kind: ExtensionKind::Mcp,
		status,
		enabled,
		version,
		description: snapshot
			.description
			.clone()
			.or_else(|| snapshot.title.clone()),
		tools: snapshot
			.tools
			.iter()
			.filter_map(|tool| tool.get("name").and_then(serde_json::Value::as_str))
			.map(Str::new)
			.collect(),
		resources: snapshot
			.resources
			.iter()
			.map(|resource| resource.name.clone())
			.collect(),
		prompts: snapshot
			.prompts
			.iter()
			.map(|prompt| prompt.name.clone())
			.collect(),
		error: (snapshot.health == McpInspectorHealth::Failed)
			.then(|| Str::new_static("automatic reconnects stopped after a terminal failure")),
	}
}

/// Installed Python extensions from `installed.toml`, joined with the sealed
/// registries of the generations envd currently runs.
fn python_rows(state: &ServiceState, paths: &StatePaths) -> ServiceResult<Vec<ExtensionRow>> {
	let views = crate::ext_cli::service::installed_views(paths).map_err(ServiceError::failed)?;
	let evidences = state.reload.registry_evidences();
	Ok(views
		.into_iter()
		.map(|view| {
			let live = evidences
				.iter()
				.find(|evidence| evidence.provenance.extension_id() == view.id.as_str());
			let status = if !view.enabled {
				ExtensionStatus::Disabled
			} else if !view.admitted {
				ExtensionStatus::Failed
			} else if live.is_some() {
				ExtensionStatus::Ready
			} else {
				ExtensionStatus::Disconnected
			};
			let tools = live.map_or_else(Vec::new, |evidence| {
				evidence
					.tools
					.iter()
					.filter_map(|tool| {
						tool
							.definition
							.as_ref()
							.map(|definition| Str::new(&definition.name))
					})
					.collect()
			});
			let version = live
				.map(|evidence| Str::new(evidence.provenance.version()))
				.or(view.version);
			let scope = match view.scope {
				Scope::User => "user",
				Scope::Project => "project",
			};
			let mut description = sf!("{scope} · {} · {}", view.tier, view.source);
			if let (Some(publisher), Some(artifact)) = (&view.publisher, &view.artifact) {
				description = sf!("{description} · publisher={publisher} · artifact={artifact}");
			}
			if let Some(capability) = &view.capability {
				description = sf!("{description} · capability={capability}");
			}
			if view.shadowed {
				description = sf!("{description} · shadowed by the project install");
			}
			let error = (!view.admitted).then(|| {
				Str::new_static(
					"E-CONSENT: current publisher, capability digest, tier, or shipping level is \
					 ungranted",
				)
			});
			ExtensionRow {
				id: sf!("{EXT_PREFIX}{}", view.id),
				name: view.id,
				kind: ExtensionKind::Python,
				status,
				enabled: view.enabled,
				version,
				description: Some(description),
				tools,
				resources: Vec::new(),
				prompts: Vec::new(),
				error,
			}
		})
		.collect())
}

/// Installed marketplace plugins from both scope registries.
fn plugin_rows(state: &ServiceState) -> ServiceResult<Vec<ExtensionRow>> {
	let transactions = ExtensionTransactions::new(&state.data_dir, &state.project, Scope::User);
	let installed = transactions.installed().map_err(ServiceError::failed)?;
	Ok(installed
		.into_iter()
		.map(|view| {
			let spec = view
				.marketplace
				.as_ref()
				.map_or_else(|| view.id.clone(), |marketplace| sf!("{}@{marketplace}", view.id));
			let scope = match view.scope {
				Scope::User => "user",
				Scope::Project => "project",
			};
			let mut description = sf!("{scope} · {}", view.source);
			if view.shadowed {
				description = sf!("{description} · shadowed by the project install");
			}
			ExtensionRow {
				id:          sf!("{PLUGIN_PREFIX}{spec}"),
				name:        spec,
				kind:        ExtensionKind::Plugin,
				status:      if view.enabled {
					ExtensionStatus::Ready
				} else {
					ExtensionStatus::Disabled
				},
				enabled:     view.enabled,
				version:     view.version,
				description: Some(description),
				tools:       Vec::new(),
				resources:   Vec::new(),
				prompts:     Vec::new(),
				error:       None,
			}
		})
		.collect())
}
