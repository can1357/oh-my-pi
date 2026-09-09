//! Command-stream configuration migration and persistence contracts.

use std::fs;

use omp_app::{
	cli::ConfigScope,
	config_cmd::{migrate_settings, set_persisted},
};

#[test]
fn config_migrate_is_idempotent_and_uses_declaration_metadata() {
	let registry = omp_con::Ctx::new();
	let mut saw_retry_enabled = false;
	let mut saw_steering_mode = false;
	for var in registry.vars() {
		for path in var.meta_all("legacy.path") {
			assert!(!path.is_empty(), "legacy path for {} is empty", var.name);
			saw_retry_enabled |= path == "retry.enabled" && var.name == "ai_retry_enabled";
			saw_steering_mode |= path == "steeringMode" && var.name == "ai_steering_mode";
		}
	}
	assert!(saw_retry_enabled, "retry.enabled metadata is missing");
	assert!(saw_steering_mode, "steeringMode metadata is missing");

	let data = tempfile::tempdir().expect("data directory");
	let config = tempfile::tempdir().expect("config directory");
	// SAFETY: nextest runs each test in its own process; nothing else reads the
	// variable concurrently.
	unsafe { std::env::set_var("OMP_CONFIG_DIR", config.path()) };
	let project = tempfile::tempdir().expect("project directory");
	fs::write(
		data.path().join("config.toml"),
		"steeringMode = \"all\"\nhideThinkingBlock = true\n[display]\nhideToolActivity = \
		 true\n[retry]\nenabled = false\n[stt]\nenabled = true\nmodelName = \"turbo\"\n",
	)
	.expect("legacy TOML");

	let path = migrate_settings(data.path(), project.path()).expect("first migration");
	let first = fs::read(&path).expect("first config.cfg");
	migrate_settings(data.path(), project.path()).expect("second migration");
	let second = fs::read(&path).expect("second config.cfg");

	assert_eq!(second, first);
	let script = String::from_utf8(first).expect("UTF-8 cfg");
	assert!(script.contains("ai_retry_enabled false"));
	assert!(script.contains("ai_steering_mode all"));
	assert!(script.contains("cl_showthinking false"));
	assert!(script.contains("cl_showtools false"));
	assert!(script.contains("cl_voice_stt_enabled true"));
	assert!(script.contains("cl_stt_model turbo"));
}

#[test]
fn config_migrate_moves_legacy_data_mcp_without_overwriting() {
	let data = tempfile::tempdir().expect("data directory");
	let config = tempfile::tempdir().expect("config directory");
	// SAFETY: nextest runs each test in its own process.
	unsafe { std::env::set_var("OMP_CONFIG_DIR", config.path()) };
	let project = tempfile::tempdir().expect("project directory");
	let legacy = data.path().join("mcp.json");
	fs::write(&legacy, br#"{"mcpServers":{"legacy":{"type":"stdio","command":"legacy"}}}"#)
		.expect("legacy MCP config");

	migrate_settings(data.path(), project.path()).expect("migration");
	let destination = config.path().join("mcp.json");
	assert!(!legacy.exists());
	let migrated = fs::read_to_string(&destination).expect("migrated MCP config");
	assert!(migrated.contains("\"legacy\""));

	fs::write(
		&legacy,
		br#"{"mcpServers":{"replacement":{"type":"stdio","command":"replacement"}}}"#,
	)
	.expect("replacement MCP config");
	migrate_settings(data.path(), project.path()).expect("repeat migration");
	assert!(legacy.exists());
	assert_eq!(fs::read_to_string(destination).expect("preserved MCP config"), migrated);
}

#[test]
fn config_migrate_preserves_output_limit_kibibyte_values() {
	let data = tempfile::tempdir().expect("data directory");
	let config = tempfile::tempdir().expect("config directory");
	// SAFETY: nextest runs each test in its own process.
	unsafe { std::env::set_var("OMP_CONFIG_DIR", config.path()) };
	let project = tempfile::tempdir().expect("project directory");
	fs::write(
		data.path().join("config.toml"),
		r#"
[tools]
artifactSpillThreshold = 50
artifactTailBytes = 2.5
artifactHeadBytes = 20
outputMaxColumns = 768
artifactTailLines = 500
"#,
	)
	.expect("legacy TOML");

	let path = migrate_settings(data.path(), project.path()).expect("migration");
	let script = fs::read_to_string(path).expect("config.cfg");
	assert!(script.contains("sv_tools_output_spill_bytes 51200"));
	assert!(script.contains("sv_tools_artifact_tail_bytes 2560"));
	assert!(script.contains("sv_tools_artifact_head_bytes 20480"));
	assert!(script.contains("sv_tools_output_max_columns 768"));
	assert!(script.contains("sv_tools_artifact_tail_lines 500"));
}

#[test]
fn config_migrate_converts_legacy_value_encodings() {
	let data = tempfile::tempdir().expect("data directory");
	let config = tempfile::tempdir().expect("config directory");
	// SAFETY: nextest runs each test in its own process.
	unsafe { std::env::set_var("OMP_CONFIG_DIR", config.path()) };
	let project = tempfile::tempdir().expect("project directory");
	fs::write(
		data.path().join("config.toml"),
		r#"
doubleEscapeAction = "rewind"

[completion]
notify = "off"

[error]
notify = "on"

[ask]
notify = "off"

[compaction]
thresholdPercent = 80
thresholdTokens = "default"

[task]
maxRuntimeMs = 0

[task.isolation]
enabled = true

[irc]
timeoutMs = 30000

[tools]
maxTimeout = 60

[edit]
mode = "hashline"

[providers]
tinyModel = "online"
memoryModel = "online"
autoThinkingModel = "online"
unexpectedStopModel = "online"
fireworksTier = "standard"

[share]
store = "blob"
"#,
	)
	.expect("legacy TOML");

	let path = migrate_settings(data.path(), project.path()).expect("migration");
	let script = fs::read_to_string(path).expect("config.cfg");
	assert!(script.contains("cl_double_escape branch"));
	assert!(script.contains("cl_notify_completion false"));
	assert!(script.contains("cl_notify_error true"));
	assert!(script.contains("cl_notify_ask false"));
	assert!(script.contains("ai_compact_threshold 0.8"));
	assert!(script.contains("ai_compaction_threshold_tokens -1"));
	assert!(script.contains("sv_task_isolation_mode auto"));
	assert!(script.contains("sv_task_max_runtime never"));
	assert!(script.contains("sv_irc_timeout 30000ms"));
	assert!(script.contains("sv_tools_max_timeout 60s"));
	assert!(script.contains("sv_tools_edit_dialect hl.1"));
	assert!(script.contains("ai_tiny_selector @tiny"));
	assert!(script.contains("ai_memory_selector @tiny"));
	assert!(script.contains("ai_auto_thinking_selector @tiny"));
	assert!(script.contains("ai_unexpected_stop_selector @tiny"));
	assert!(script.contains("ai_tier_fireworks none"));
	assert!(script.contains("sv_share_store http"));
}

#[test]
fn keybinding_migration_replaces_action_defaults_without_erasing_unrelated_binds() {
	let data = tempfile::tempdir().expect("data directory");
	let config = tempfile::tempdir().expect("config directory");
	// SAFETY: nextest runs each test in its own process.
	unsafe { std::env::set_var("OMP_CONFIG_DIR", config.path()) };
	let project = tempfile::tempdir().expect("project directory");
	fs::write(
		data.path().join("keybindings.toml"),
		r#"
active = "custom"

[profiles.custom.bindings]
"app.retry" = ["alt+shift+r"]
"app.message.dequeue" = ["alt+up"]
"#,
	)
	.expect("legacy keybindings");

	let path = migrate_settings(data.path(), project.path()).expect("migration");
	let script = fs::read_to_string(path).expect("config.cfg");
	assert!(!script.contains("unbindall"), "a remap must not erase unrelated defaults");
	assert!(script.contains("unbind f5"));
	assert!(script.contains("unbind alt+r"));
	assert!(script.contains("unbind shift+up"));
	assert!(script.contains("bind alt+shift+r cl_retry"));

	let ctx = omp_app::process_ctx(project.path()).expect("reload");
	assert_eq!(ctx.bound("alt+r"), None);
	assert_eq!(ctx.bound("f5"), None);
	assert_eq!(ctx.bound("alt+shift+r").as_deref(), Some("cl_retry"));
	assert_eq!(ctx.bound("shift+up"), None);
	assert_eq!(ctx.bound("alt+up").as_deref(), Some("cl_dequeue"));
	assert_eq!(ctx.bound("enter").as_deref(), Some("ed_enter"));
}

#[test]
fn config_migrate_keeps_project_values_out_of_the_user_cfg() {
	let data = tempfile::tempdir().expect("data directory");
	let config = tempfile::tempdir().expect("config directory");
	// SAFETY: see above.
	unsafe { std::env::set_var("OMP_CONFIG_DIR", config.path()) };
	let project = tempfile::tempdir().expect("project directory");
	fs::create_dir_all(project.path().join(".omp")).expect(".omp");
	fs::write(data.path().join("config.toml"), "[stt]\nenabled = true\n").expect("user TOML");
	fs::write(project.path().join(".omp/config.toml"), "[stt]\nmodelName = \"turbo\"\n")
		.expect("project TOML");

	let user = migrate_settings(data.path(), project.path()).expect("migration");
	let user_script = fs::read_to_string(&user).expect("user config.cfg");
	assert!(user_script.contains("cl_voice_stt_enabled true"));
	assert!(!user_script.contains("cl_stt_model"), "project value leaked into the user scope");
	let project_script =
		fs::read_to_string(project.path().join(".omp/config.cfg")).expect("project config.cfg");
	assert!(
		!project_script.contains("unbindall"),
		"a settings migration must preserve default binds"
	);
	assert!(project_script.contains("cl_stt_model turbo"));
	assert!(!project_script.contains("cl_voice_stt_enabled"));
	let ctx = omp_app::process_ctx(project.path()).expect("reload context");
	assert_eq!(
		ctx.get_typed::<omp_app::voice::settings::SttModel>("cl_stt_model")
			.expect("convar"),
		omp_app::voice::settings::SttModel::Turbo
	);
	assert!(
		ctx.get_typed::<bool>("cl_voice_stt_enabled")
			.expect("convar")
	);
}

#[test]
fn profile_selects_its_own_config_cfg() {
	let config = tempfile::tempdir().expect("config directory");
	// SAFETY: see above.
	unsafe {
		std::env::set_var("OMP_CONFIG_DIR", config.path());
		std::env::set_var("OMP_PROFILE", "work");
	}
	let project = tempfile::tempdir().expect("project directory");
	set_persisted(project.path(), ConfigScope::Global, "cl_showthinking", "false")
		.expect("set archived convar");
	set_persisted(project.path(), ConfigScope::Global, "sv_worktree_base", "/tmp/omp-worktrees")
		.expect("set worktree root");
	assert!(config.path().join("profiles/work/config.cfg").is_file());
	assert!(!config.path().join("config.cfg").exists());
	let ctx = omp_app::process_ctx(project.path()).expect("reload context");
	assert!(!ctx.get_typed::<bool>("cl_showthinking").expect("convar"));
	assert_eq!(
		omp_driver::settings::current()
			.expect("driver settings")
			.worktree
			.base
			.as_deref(),
		Some(std::path::Path::new("/tmp/omp-worktrees"))
	);
}

#[test]
fn exec_and_writecfg_use_the_installed_cfg_files() {
	let config = tempfile::tempdir().expect("config directory");
	// SAFETY: see above.
	unsafe { std::env::set_var("OMP_CONFIG_DIR", config.path()) };
	let project = tempfile::tempdir().expect("project directory");
	fs::create_dir_all(project.path().join(".omp")).expect(".omp");
	fs::write(config.path().join("focus.cfg"), "cl_showthinking false\n").expect("user profile");
	fs::write(project.path().join(".omp/focus.cfg"), "ai_fastmode true\n").expect("project overlay");
	let ctx = omp_app::process_ctx(project.path()).expect("context");
	ctx.run("exec focus")
		.expect("exec resolves through the installed loader");
	assert!(!ctx.get_typed::<bool>("cl_showthinking").expect("convar"));
	assert!(ctx.get_typed::<bool>("ai_fastmode").expect("convar"));
	ctx.run("writecfg")
		.expect("writecfg resolves through the installed saver");
	let script = fs::read_to_string(config.path().join("config.cfg")).expect("config.cfg");
	assert!(script.contains("cl_showthinking false"));
	assert!(script.contains("ai_fastmode true"));
}

#[test]
fn chat_services_address_user_configuration_under_the_config_root() {
	let config = tempfile::tempdir().expect("config directory");
	let data = tempfile::tempdir().expect("data directory");
	// SAFETY: see above.
	unsafe {
		std::env::set_var("OMP_CONFIG_DIR", config.path());
		std::env::set_var("OMP_DATA_DIR", data.path());
	}
	let project = tempfile::tempdir().expect("project directory");

	// `/mcp` in chat and `omp config mcp` on the CLI must address one file.
	let chat = omp_app::chat_services::mcp_config_paths(project.path()).expect("mcp paths");
	let cli = omp_envd::mcp::McpConfigPaths::new(
		&omp_core::dirs::user_config_root().expect("config root"),
		project.path(),
	);
	assert_eq!(chat, cli);
	assert_eq!(chat.user, config.path().join("mcp.json"));
	assert_eq!(chat.project, project.path().join(".omp/mcp.json"));
	assert!(!chat.user.starts_with(data.path()), "user mcp.json must not live in the data dir");

	// `/share` redacts with the user `secrets.yml` under the same root.
	let [user, project_secrets] =
		omp_app::chat_services::secrets_files(project.path()).expect("secrets files");
	assert_eq!(user, config.path().join("secrets.yml"));
	assert_eq!(project_secrets, project.path().join(".omp/secrets.yml"));
}

#[test]
fn config_set_persists_and_get_reads_back() {
	let config = tempfile::tempdir().expect("config directory");
	// SAFETY: see above.
	unsafe { std::env::set_var("OMP_CONFIG_DIR", config.path()) };
	let project = tempfile::tempdir().expect("project directory");
	set_persisted(project.path(), ConfigScope::Global, "cl_showthinking", "false")
		.expect("set archived convar");

	let script = fs::read_to_string(config.path().join("config.cfg")).expect("config.cfg");
	assert!(script.contains("cl_showthinking false"));
	let ctx = omp_app::process_ctx(project.path()).expect("reload context");
	assert_eq!(ctx.get_typed::<bool>("cl_showthinking").expect("convar"), false);
}

#[test]
fn explicit_default_survives_schema_default_changes() {
	let config = tempfile::tempdir().expect("config directory");
	// SAFETY: nextest runs each test in its own process.
	unsafe { std::env::set_var("OMP_CONFIG_DIR", config.path()) };
	let project = tempfile::tempdir().expect("project directory");
	set_persisted(project.path(), ConfigScope::Global, "cl_showthinking", "true")
		.expect("persist explicit current default");
	let script = fs::read_to_string(config.path().join("config.cfg")).expect("config.cfg");
	assert!(
		script.contains("cl_showthinking true"),
		"an explicit value must not disappear merely because it equals this build's default"
	);
}

#[test]
fn concurrent_config_updates_preserve_distinct_assignments() {
	let config = tempfile::tempdir().expect("config directory");
	// SAFETY: nextest runs each test in its own process.
	unsafe { std::env::set_var("OMP_CONFIG_DIR", config.path()) };
	let project = tempfile::tempdir().expect("project directory");
	let project_path = project.path().to_path_buf();
	let first = std::thread::spawn({
		let project = project_path.clone();
		move || {
			set_persisted(&project, ConfigScope::Global, "cl_showthinking", "false")
				.expect("first update")
		}
	});
	let second = std::thread::spawn(move || {
		set_persisted(
			&project_path,
			ConfigScope::Global,
			"sv_worktree_base",
			"/tmp/concurrent-worktrees",
		)
		.expect("second update")
	});
	first.join().expect("first updater");
	second.join().expect("second updater");

	let script = fs::read_to_string(config.path().join("config.cfg")).expect("config.cfg");
	assert!(script.contains("cl_showthinking false"), "{script}");
	assert!(script.contains("sv_worktree_base /tmp/concurrent-worktrees"), "{script}");
}
