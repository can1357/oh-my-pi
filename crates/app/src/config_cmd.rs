//! Reflected, typed settings command handlers.

use std::{
	env,
	fs::{self, OpenOptions},
	io,
	path::{Path, PathBuf},
};

use miette::IntoDiagnostic as _;
use omp_con::{Ctx, DumpOptions, Origin, Source, Span, TypeSpec, Value, ValueKind, VarFlags};
use omp_core::Str;
use omp_envd::mcp::{
	McpConfigPaths,
	config::McpServerConfig,
	config_store::{McpConfigStore, set_server_enabled},
	json_rpc,
};
use serde::Serialize;

use crate::cli::{ConfigCommand, ConfigScope, McpConfigCommand, McpConfigScope};

/// Runs a typed command-stream configuration operation.
pub fn run(data_dir: &Path, command: &ConfigCommand) -> miette::Result<()> {
	let project = env::current_dir().into_diagnostic()?;
	if let ConfigCommand::InitXdg { json } = command {
		return init_xdg(data_dir, *json);
	}
	if let ConfigCommand::Mcp { command } = command {
		let user_root = omp_core::dirs::user_config_root().into_diagnostic()?;
		return run_mcp(&user_root, &project, command);
	}
	match command {
		ConfigCommand::Migrate => {
			let destination = migrate_settings(data_dir, &project)?;
			println!("{}", destination.display());
			Ok(())
		},
		ConfigCommand::Dump => {
			print!("{}", crate::process_ctx(&project)?.dump());
			Ok(())
		},
		ConfigCommand::List { json } => list(&crate::process_ctx(&project)?, *json),
		ConfigCommand::Get { key } => get(&crate::process_ctx(&project)?, key),
		ConfigCommand::Set { key, value, scope } => set_persisted(&project, *scope, key, value),
		ConfigCommand::Unset { key, scope } => {
			let destination = path(&project, *scope)?;
			update_cfg(&destination, |ctx| {
				let omp_con::RegItem::Var(spec) = ctx
					.find(key)
					.ok_or_else(|| miette::miette!("unknown convar `{key}`; run `omp config list`"))?
				else {
					return Err(miette::miette!("`{key}` is not a convar"));
				};
				ctx.set(spec.name, (spec.default)(), Origin::Default)
					.into_diagnostic()?;
				Ok(())
			})
		},
		ConfigCommand::Path { scope } => {
			println!("{}", path(&project, *scope)?.display());
			Ok(())
		},
		ConfigCommand::InitXdg { .. } => unreachable!("XDG initialization returns before config"),
		ConfigCommand::Mcp { .. } => unreachable!("MCP commands return before config composition"),
	}
}

#[derive(Serialize)]
struct XdgMigrationReport {
	data:    PathBuf,
	state:   PathBuf,
	cache:   PathBuf,
	moved:   Vec<PathBuf>,
	skipped: Vec<PathBuf>,
}

fn init_xdg(data_dir: &Path, json: bool) -> miette::Result<()> {
	let home = env::var_os("HOME")
		.filter(|value| !value.is_empty())
		.map(PathBuf::from)
		.ok_or_else(|| miette::miette!("HOME must be set for config init-xdg"))?;
	let mut roots = omp_core::dirs::native_directories(&home);
	roots.data = data_dir.to_path_buf();
	for root in [&roots.data, &roots.state, &roots.cache] {
		fs::create_dir_all(root).into_diagnostic()?;
	}
	let legacy = home.join(".omp");
	let mut report = XdgMigrationReport {
		data:    roots.data.clone(),
		state:   roots.state.clone(),
		cache:   roots.cache.clone(),
		moved:   Vec::new(),
		skipped: Vec::new(),
	};
	let legacy_mcp = legacy.join("mcp.json");
	if legacy_mcp.exists() {
		let destination = omp_core::dirs::config_dir(&home).join("mcp.json");
		if McpConfigStore::new(destination)
			.migrate_from(&legacy_mcp)
			.into_diagnostic()?
		{
			report.moved.push(legacy_mcp);
		} else {
			report.skipped.push(legacy_mcp);
		}
	}
	for (source, destination) in [
		(legacy.join("data"), roots.data.clone()),
		(legacy.join("state"), roots.state.clone()),
		(legacy.join("cache"), roots.cache.clone()),
		(legacy.join("sessions"), roots.state.join("sessions")),
		(legacy.join("projects"), roots.state.join("projects")),
	] {
		if source.exists() {
			migrate_without_overwrite(&source, &destination, &mut report)?;
		}
	}
	if json {
		println!("{}", serde_json::to_string_pretty(&report).into_diagnostic()?);
	} else {
		println!("data\t{}", report.data.display());
		println!("state\t{}", report.state.display());
		println!("cache\t{}", report.cache.display());
		println!("migrated\t{}", report.moved.len());
		println!("preserved-conflicts\t{}", report.skipped.len());
	}
	Ok(())
}

fn migrate_without_overwrite(
	source: &Path,
	destination: &Path,
	report: &mut XdgMigrationReport,
) -> miette::Result<()> {
	let metadata = fs::symlink_metadata(source).into_diagnostic()?;
	if metadata.file_type().is_symlink() {
		report.skipped.push(source.to_path_buf());
		return Ok(());
	}
	if metadata.is_file() {
		if destination.exists() {
			report.skipped.push(source.to_path_buf());
			return Ok(());
		}
		if let Some(parent) = destination.parent() {
			fs::create_dir_all(parent).into_diagnostic()?;
		}
		let mut input = fs::File::open(source).into_diagnostic()?;
		let mut output = OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(destination)
			.into_diagnostic()?;
		if let Err(error) = io::copy(&mut input, &mut output)
			.and_then(|_| output.sync_all())
			.and_then(|()| fs::set_permissions(destination, metadata.permissions()))
		{
			drop(output);
			let _ = fs::remove_file(destination);
			return Err(error).into_diagnostic();
		}
		fs::remove_file(source).into_diagnostic()?;
		report.moved.push(source.to_path_buf());
		return Ok(());
	}
	if !metadata.is_dir() {
		report.skipped.push(source.to_path_buf());
		return Ok(());
	}
	if destination.exists() && !destination.is_dir() {
		report.skipped.push(source.to_path_buf());
		return Ok(());
	}
	fs::create_dir_all(destination).into_diagnostic()?;
	let mut entries = fs::read_dir(source)
		.into_diagnostic()?
		.collect::<Result<Vec<_>, _>>()
		.into_diagnostic()?;
	entries.sort_by_key(fs::DirEntry::file_name);
	for entry in entries {
		migrate_without_overwrite(&entry.path(), &destination.join(entry.file_name()), report)?;
	}
	if fs::read_dir(source).into_diagnostic()?.next().is_none() {
		fs::remove_dir(source).into_diagnostic()?;
	}
	Ok(())
}

fn run_mcp(user_root: &Path, project: &Path, command: &McpConfigCommand) -> miette::Result<()> {
	// The same three files `omp-envd` binds for `/mcp` mutations: the user
	// file lives in the `~/.o2` configuration root, never the data directory.
	let paths = McpConfigPaths::new(user_root, project);
	let user = McpConfigStore::new(paths.user);
	let project_store = McpConfigStore::new(paths.project);
	let root = McpConfigStore::new(paths.root);
	match command {
		McpConfigCommand::List { scope, json } => {
			let stores: Vec<(McpConfigScope, &McpConfigStore)> = match scope {
				Some(McpConfigScope::Global) => vec![(McpConfigScope::Global, &user)],
				Some(McpConfigScope::Project) => vec![(McpConfigScope::Project, &project_store)],
				Some(McpConfigScope::Root) => vec![(McpConfigScope::Root, &root)],
				None => vec![
					(McpConfigScope::Project, &project_store),
					(McpConfigScope::Global, &user),
					(McpConfigScope::Root, &root),
				],
			};
			if *json {
				let mut output = serde_json::Map::new();
				for (scope, store) in stores {
					for name in store.list().into_diagnostic()? {
						output
							.insert(name.to_string(), serde_json::json!({"scope": mcp_scope_name(scope)}));
					}
				}
				println!("{}", serde_json::to_string_pretty(&output).into_diagnostic()?);
			} else {
				for (scope, store) in stores {
					for name in store.list().into_diagnostic()? {
						println!("{}\t{name}", mcp_scope_name(scope));
					}
				}
			}
			Ok(())
		},
		McpConfigCommand::Get { name } => {
			for (scope, store) in [
				(McpConfigScope::Project, &project_store),
				(McpConfigScope::Global, &user),
				(McpConfigScope::Root, &root),
			] {
				if let Some(server) = store.get(name).into_diagnostic()? {
					println!(
						"{}",
						serde_json::to_string_pretty(&serde_json::json!({
							"name": name,
							"scope": mcp_scope_name(scope),
							"config": redacted_server(&server),
						}))
						.into_diagnostic()?
					);
					return Ok(());
				}
			}
			Err(miette::miette!("MCP server `{name}` was not found in native configuration"))
		},
		McpConfigCommand::Add { name, config, scope } => {
			let server: McpServerConfig = serde_json::from_str(config).into_diagnostic()?;
			mcp_store(*scope, &user, &project_store, &root)
				.add(name, server)
				.into_diagnostic()
		},
		McpConfigCommand::Update { name, config, scope } => {
			let server: McpServerConfig = serde_json::from_str(config).into_diagnostic()?;
			mcp_store(*scope, &user, &project_store, &root)
				.update(name, server)
				.into_diagnostic()
		},
		McpConfigCommand::Remove { name, scope } => mcp_store(*scope, &user, &project_store, &root)
			.remove(name)
			.into_diagnostic(),
		McpConfigCommand::Enable { name } | McpConfigCommand::Disable { name } => set_server_enabled(
			&user,
			&project_store,
			Some(&root),
			name,
			matches!(command, McpConfigCommand::Enable { .. }),
		)
		.into_diagnostic(),
	}
}

fn mcp_store<'a>(
	scope: McpConfigScope,
	user: &'a McpConfigStore,
	project: &'a McpConfigStore,
	root: &'a McpConfigStore,
) -> &'a McpConfigStore {
	match scope {
		McpConfigScope::Global => user,
		McpConfigScope::Project => project,
		McpConfigScope::Root => root,
	}
}

fn mcp_scope_name(scope: McpConfigScope) -> &'static str {
	scope.into()
}

fn redacted_server(server: &McpServerConfig) -> serde_json::Value {
	let mut value = serde_json::to_value(server).unwrap_or(serde_json::Value::Null);
	if let Some(url) = value.get_mut("url")
		&& let Some(raw) = url.as_str()
	{
		*url = serde_json::Value::String(json_rpc::redact_url_for_log(raw).to_string());
	}
	for map_name in ["env", "headers"] {
		if let Some(values) = value
			.get_mut(map_name)
			.and_then(serde_json::Value::as_object_mut)
		{
			for (name, value) in values {
				let name = name.to_ascii_lowercase();
				if ["key", "token", "secret", "authorization", "cookie"]
					.iter()
					.any(|needle| name.contains(needle))
				{
					*value = serde_json::Value::String("[REDACTED]".to_owned());
				}
			}
		}
	}
	value
}

/// Returns the selected command-stream configuration path.
pub fn path(project: &Path, scope: ConfigScope) -> miette::Result<PathBuf> {
	Ok(match scope {
		ConfigScope::Global => crate::config_path().into_diagnostic()?,
		ConfigScope::Project => project.join(".omp/config.cfg"),
	})
}

/// Loads an existing cfg leniently: lines this build no longer understands are
/// reported and dropped, so an edit never fails on a stale variable and the
/// re-dumped file no longer carries it.
pub(crate) fn load_cfg(path: &Path) -> miette::Result<Ctx> {
	let script = omp_driver::cfg::read_config(path).into_diagnostic()?;
	load_cfg_text(path, script.as_deref())
}

fn load_cfg_text(path: &Path, script: Option<&str>) -> miette::Result<Ctx> {
	let ctx = Ctx::new();
	// The default bind cfg is the baseline the persisted script diffs
	// against; without it a dump would `unbindall` the defaults away.
	ctx.exec(
		crate::keybindings::DEFAULT_BINDS,
		Source::Config(Str::new_static(crate::keybindings::DEFAULT_BINDS_NAME)),
	)
	.into_diagnostic()?;
	ctx.seal_bind_defaults();
	if let Some(script) = script {
		let outcome = ctx
			.exec_configs(&|name: &str| Ok((name == "config.cfg").then(|| Str::new(script))), None)
			.into_diagnostic()?;
		if outcome.failed > 0 {
			eprintln!(
				"warning: {} skipped {} statement(s) this build does not understand",
				path.display(),
				outcome.failed
			);
		}
	}
	Ok(ctx)
}

fn persist_cfg_with_options(path: &Path, ctx: &Ctx, options: DumpOptions) -> miette::Result<()> {
	let transaction =
		omp_driver::cfg::ConfigFileLock::acquire(path.to_path_buf()).into_diagnostic()?;
	transaction
		.replace(ctx.dump_with_options(options).as_str())
		.into_diagnostic()
}

pub(crate) fn update_cfg(
	path: &Path,
	update: impl FnOnce(&Ctx) -> miette::Result<()>,
) -> miette::Result<()> {
	let transaction =
		omp_driver::cfg::ConfigFileLock::acquire(path.to_path_buf()).into_diagnostic()?;
	let current = transaction.read().into_diagnostic()?;
	let migrated = current
		.as_deref()
		.map(|script| omp_driver::cfg::migrate_config_script(path, script))
		.transpose()
		.into_diagnostic()?;
	let ctx = load_cfg_text(path, migrated.as_deref())?;
	update(&ctx)?;
	transaction
		.replace(
			ctx.dump_with_options(DumpOptions {
				include_archived_defaults: true,
				..DumpOptions::default()
			})
			.as_str(),
		)
		.into_diagnostic()
}

fn assignment(ctx: &Ctx, name: &str, input: &str) -> miette::Result<String> {
	let spec = ctx
		.vars()
		.find(|spec| spec.name.eq_ignore_ascii_case(name))
		.ok_or_else(|| miette::miette!("unknown convar `{name}`; run `omp config list`"))?;
	let value = if spec.ty.kind == ValueKind::Str {
		serde_json::to_string(input).into_diagnostic()?
	} else {
		input.to_owned()
	};
	Ok(format!("{name} {value}"))
}

fn list(ctx: &Ctx, json: bool) -> miette::Result<()> {
	let mut vars = ctx.vars().collect::<Vec<_>>();
	vars.sort_unstable_by_key(|spec| spec.name);
	if json {
		let mut output = serde_json::Map::new();
		for spec in vars {
			output.insert(
				spec.name.to_owned(),
				serde_json::json!({
					"value": ctx.value(spec.name).into_diagnostic()?.to_string(),
					"default": spec.default().to_string(),
					"flags": flag_names(spec.flags),
				}),
			);
		}
		println!("{}", serde_json::to_string_pretty(&output).into_diagnostic()?);
		return Ok(());
	}
	for spec in vars {
		println!(
			"{}\t{}\t{}\t{}",
			spec.name,
			ctx.value(spec.name).into_diagnostic()?,
			spec.default(),
			flag_names(spec.flags).join("|"),
		);
	}
	Ok(())
}

fn get(ctx: &Ctx, name: &str) -> miette::Result<()> {
	let value = ctx
		.value(name)
		.map_err(|_| miette::miette!("unknown convar `{name}`; run `omp config list`"))?;
	println!("{value}");
	Ok(())
}

fn flag_names(flags: VarFlags) -> Vec<&'static str> {
	[
		(VarFlags::ARCHIVE, "ARCHIVE"),
		(VarFlags::SESSION, "SESSION"),
		(VarFlags::REPLICATED, "REPLICATED"),
		(VarFlags::READONLY, "READONLY"),
		(VarFlags::NOTIFY, "NOTIFY"),
		(VarFlags::UNSAFE, "UNSAFE"),
	]
	.into_iter()
	.filter_map(|(flag, name)| flags.contains(flag).then_some(name))
	.collect()
}

fn value_at<'a>(document: &'a toml::Table, path: &str) -> Option<&'a toml::Value> {
	let mut segments = path.split('.');
	let mut value = document.get(segments.next()?)?;
	for segment in segments {
		value = value.as_table()?.get(segment)?;
	}
	Some(value)
}

/// Migrates legacy TOML settings and keybindings to the archived command
/// stream, scope for scope (ADR 0012): the user `config.toml` (plus
/// `OMP_CONFIG_FILES` overlays) and legacy keybindings become the user
/// `config.cfg`; `<project>/.omp/config.toml` becomes
/// `<project>/.omp/config.cfg`, never a global setting. A legacy data-root
/// `mcp.json` moves into the selected user/profile configuration root without
/// overwriting an existing destination. Returns the user cfg path.
///
/// Re-running migration over unchanged inputs writes identical bytes.
pub fn migrate_settings(data_dir: &Path, project: &Path) -> miette::Result<PathBuf> {
	let mut user_sources = vec![data_dir.join("config.toml")];
	if let Some(overlays) = env::var_os("OMP_CONFIG_FILES") {
		user_sources.extend(env::split_paths(&overlays));
	}
	let user = migrate_toml_sources(&user_sources)?;
	user
		.exec(
			crate::keybindings::DEFAULT_BINDS,
			Source::Config(Str::new_static(crate::keybindings::DEFAULT_BINDS_NAME)),
		)
		.into_diagnostic()?;
	user.seal_bind_defaults();
	migrate_keybindings(data_dir, &user)?;
	let migration_dump = DumpOptions { include_archived_defaults: true, ..DumpOptions::default() };
	let destination = crate::config_path().into_diagnostic()?;
	persist_cfg_with_options(&destination, &user, migration_dump)?;
	let user_root = destination
		.parent()
		.ok_or_else(|| miette::miette!("user configuration path has no parent directory"))?;
	McpConfigStore::new(user_root.join("mcp.json"))
		.migrate_from(&data_dir.join("mcp.json"))
		.into_diagnostic()?;

	let project_source = project.join(".omp/config.toml");
	if project_source.is_file() {
		let scoped = migrate_toml_sources(std::slice::from_ref(&project_source))?;
		scoped.seal_bind_defaults();
		persist_cfg_with_options(&project.join(".omp/config.cfg"), &scoped, migration_dump)?;
	}
	Ok(destination)
}

/// Folds legacy TOML documents (later sources override earlier) into one
/// archive-layer context through legacy paths owned by each declaration.
fn migrate_toml_sources(sources: &[PathBuf]) -> miette::Result<Ctx> {
	let mut document = toml::Table::new();
	for source in sources {
		if !source.is_file() {
			continue;
		}
		let text = fs::read_to_string(source).into_diagnostic()?;
		let incoming = text.parse::<toml::Table>().into_diagnostic()?;
		merge_toml(&mut document, incoming);
	}
	let ctx = Ctx::new();
	for var in ctx.vars() {
		for path in var.meta_all("legacy.path") {
			let Some(value) = value_at(&document, path) else {
				continue;
			};
			ctx.set(var.name, legacy_toml_value(path, value, var.ty)?, Origin::Archive)
				.into_diagnostic()?;
		}
	}
	Ok(ctx)
}

fn merge_toml(target: &mut toml::Table, incoming: toml::Table) {
	for (key, value) in incoming {
		match (target.get_mut(&key), value) {
			(Some(toml::Value::Table(target)), toml::Value::Table(incoming)) => {
				merge_toml(target, incoming);
			},
			(_, value) => {
				target.insert(key, value);
			},
		}
	}
}

/// Sets and persists one convar in the selected cfg scope.
pub fn set_persisted(
	project: &Path,
	scope: ConfigScope,
	name: &str,
	value: &str,
) -> miette::Result<()> {
	let destination = path(project, scope)?;
	update_cfg(&destination, |ctx| {
		let assignment = assignment(ctx, name, value)?;
		ctx.exec(&assignment, Source::Config(Str::new_static("config.cfg")))
			.into_diagnostic()?;
		Ok(())
	})
}

fn migrate_keybindings(data_dir: &Path, ctx: &Ctx) -> miette::Result<()> {
	let path = data_dir.join("keybindings.toml");
	if !path.is_file() {
		return Ok(());
	}
	let text = fs::read_to_string(path).into_diagnostic()?;
	let document = text.parse::<toml::Table>().into_diagnostic()?;
	let active = document
		.get("active")
		.and_then(toml::Value::as_str)
		.unwrap_or("default");
	let Some(bindings) = document
		.get("profiles")
		.and_then(toml::Value::as_table)
		.and_then(|profiles| profiles.get(active))
		.and_then(toml::Value::as_table)
		.and_then(|profile| profile.get("bindings"))
		.and_then(toml::Value::as_table)
	else {
		return Ok(());
	};
	for (action, chords) in bindings {
		let Some(command) = legacy_action_command(action) else {
			continue;
		};
		let Some(chords) = chords.as_array() else {
			continue;
		};
		remove_bound_command(ctx, command)?;
		for chord in chords.iter().filter_map(toml::Value::as_str) {
			ctx.bind(Str::new(chord), Str::new_static(command))
				.into_diagnostic()?;
		}
	}
	Ok(())
}

/// Removes one legacy action from every shipped fallback script before its
/// replacement chords are installed. Other contextual actions sharing a
/// chord remain in their original order.
fn remove_bound_command(ctx: &Ctx, command: &str) -> miette::Result<()> {
	for (chord, script) in ctx.binds() {
		let kept = script
			.as_str()
			.split(';')
			.map(str::trim)
			.filter(|statement| *statement != command)
			.collect::<Vec<_>>();
		if kept.len() == script.as_str().split(';').count() {
			continue;
		}
		if kept.is_empty() {
			ctx.unbind(chord.as_str());
		} else {
			ctx.bind(chord, Str::new(kept.join("; ")))
				.into_diagnostic()?;
		}
	}
	Ok(())
}

fn legacy_action_command(action: &str) -> Option<&'static str> {
	crate::keybindings::pi_action_command(action)
}

fn legacy_toml_value(path: &str, value: &toml::Value, ty: &TypeSpec) -> miette::Result<Value> {
	if matches!(path, "display.hideToolActivity" | "hideThinkingBlock") {
		let hidden = value
			.as_bool()
			.ok_or_else(|| miette::miette!("expected boolean migration value"))?;
		return Ok(Value::Bool(!hidden));
	}
	if matches!(path, "completion.notify" | "error.notify" | "ask.notify")
		&& let Some(value) = value.as_str()
	{
		return match value {
			"on" => Ok(Value::Bool(true)),
			"off" => Ok(Value::Bool(false)),
			_ => Err(miette::miette!("expected `on` or `off` migration value")),
		};
	}
	if path == "compaction.thresholdPercent" {
		let percent = value
			.as_float()
			.or_else(|| value.as_integer().map(|value| value as f64))
			.ok_or_else(|| miette::miette!("expected numeric percent migration value"))?;
		return Ok(Value::Float(percent / 100.0));
	}
	if path == "compaction.thresholdTokens" && value.as_str() == Some("default") {
		return Ok(Value::Int(-1));
	}
	if path == "task.isolation.enabled" {
		let enabled = value
			.as_bool()
			.ok_or_else(|| miette::miette!("expected boolean migration value"))?;
		return Ok(Value::Enum(Str::new_static(if enabled { "auto" } else { "none" })));
	}
	if path == "edit.mode"
		&& let Some(revision) = value.as_str().and_then(|value| match value {
			"apply_patch" => Some("apply_patch.1"),
			"hashline" => Some("hl.1"),
			"patch" => Some("patch.2"),
			"replace" => Some("rep.2"),
			"sloppy" => Some("sloppy.1"),
			_ => None,
		}) {
		return Ok(Value::Str(Str::new_static(revision)));
	}
	if matches!(
		path,
		"providers.tinyModel"
			| "providers.memoryModel"
			| "providers.autoThinkingModel"
			| "providers.unexpectedStopModel"
	) && value.as_str() == Some("online")
	{
		return Ok(Value::Str(Str::new_static("@tiny")));
	}
	if path == "providers.fireworksTier" && value.as_str() == Some("standard") {
		return Ok(Value::Enum(Str::new_static("none")));
	}
	if path == "share.store" && value.as_str() == Some("blob") {
		return Ok(Value::Enum(Str::new_static("http")));
	}
	if path == "doubleEscapeAction" && value.as_str() == Some("rewind") {
		return Ok(Value::Str(Str::new_static("branch")));
	}
	if matches!(path, "task.maxRuntimeMs" | "irc.timeoutMs")
		&& let Some(millis) = value.as_integer()
	{
		let millis = u64::try_from(millis)
			.map_err(|_| miette::miette!("expected non-negative millisecond migration value"))?;
		let span = if millis == 0 {
			Span::NEVER
		} else {
			Span::millis(millis)
		};
		return Ok(Value::Duration(span));
	}
	if path == "tools.maxTimeout"
		&& let Some(seconds) = value.as_integer()
	{
		let seconds = u64::try_from(seconds)
			.map_err(|_| miette::miette!("expected non-negative second migration value"))?;
		let span = if seconds == 0 {
			Span::NEVER
		} else {
			Span::secs(seconds)
		};
		return Ok(Value::Duration(span));
	}
	if matches!(
		path,
		"tools.artifactSpillThreshold" | "tools.artifactTailBytes" | "tools.artifactHeadBytes"
	) {
		let kibibytes = value
			.as_float()
			.or_else(|| value.as_integer().map(|value| value as f64))
			.ok_or_else(|| miette::miette!("expected numeric kilobyte migration value"))?;
		let bytes = kibibytes * 1024.0;
		if !bytes.is_finite() || bytes < 0.0 || bytes > i64::MAX as f64 {
			return Err(miette::miette!("kilobyte migration value is out of range"));
		}
		return Ok(Value::Int(bytes.round() as i64));
	}
	toml_to_value(value, ty)
}

fn toml_to_value(value: &toml::Value, ty: &TypeSpec) -> miette::Result<Value> {
	match ty.kind {
		ValueKind::Bool => value
			.as_bool()
			.map(Value::Bool)
			.ok_or_else(|| miette::miette!("expected boolean migration value")),
		ValueKind::Int => value
			.as_integer()
			.map(Value::Int)
			.ok_or_else(|| miette::miette!("expected integer migration value")),
		ValueKind::Float => value
			.as_float()
			.or_else(|| value.as_integer().map(|value| value as f64))
			.map(Value::Float)
			.ok_or_else(|| miette::miette!("expected numeric migration value")),
		ValueKind::Str => Ok(Value::Str(Str::new(
			value
				.as_str()
				.map_or_else(|| value.to_string(), str::to_owned),
		))),
		ValueKind::Enum => value
			.as_str()
			.map(|value| Value::Enum(Str::new(value)))
			.ok_or_else(|| miette::miette!("expected enum migration value")),
		ValueKind::Duration => {
			let span = if let Some(value) = value.as_str() {
				value.parse::<Span>().into_diagnostic()?
			} else {
				let millis = value
					.as_integer()
					.and_then(|value| u64::try_from(value).ok())
					.ok_or_else(|| miette::miette!("expected duration migration value"))?;
				Span::millis(millis)
			};
			Ok(Value::Duration(span))
		},
		ValueKind::List => {
			let values = value
				.as_array()
				.ok_or_else(|| miette::miette!("expected list migration value"))?;
			let elem = ty.elem.unwrap_or(TypeSpec::STR);
			values
				.iter()
				.map(|value| {
					if elem.kind == ValueKind::Kv
						&& let Some(value) = value.as_str()
					{
						return Ok(Value::Kv(omp_con::Kv(vec![(
							Str::new_static("value"),
							Value::Str(Str::new(value)),
						)])));
					}
					toml_to_value(value, elem)
				})
				.collect::<miette::Result<Vec<_>>>()
				.map(Value::List)
		},
		ValueKind::Kv => value
			.as_table()
			.ok_or_else(|| miette::miette!("expected table migration value"))
			.and_then(|table| {
				table
					.iter()
					.map(|(key, value)| Ok((Str::new(key), toml_to_untyped_value(value)?)))
					.collect::<miette::Result<Vec<_>>>()
			})
			.map(|entries| Value::Kv(omp_con::Kv(entries))),
	}
}

fn toml_to_untyped_value(value: &toml::Value) -> miette::Result<Value> {
	match value {
		toml::Value::String(value) => Ok(Value::Str(Str::new(value))),
		toml::Value::Integer(value) => Ok(Value::Int(*value)),
		toml::Value::Float(value) => Ok(Value::Float(*value)),
		toml::Value::Boolean(value) => Ok(Value::Bool(*value)),
		toml::Value::Datetime(value) => Ok(Value::Str(Str::new(value.to_string()))),
		toml::Value::Array(values) => values
			.iter()
			.map(toml_to_untyped_value)
			.collect::<miette::Result<Vec<_>>>()
			.map(Value::List),
		toml::Value::Table(table) => table
			.iter()
			.map(|(key, value)| Ok((Str::new(key), toml_to_untyped_value(value)?)))
			.collect::<miette::Result<Vec<_>>>()
			.map(omp_con::Kv)
			.map(Value::Kv),
	}
}
