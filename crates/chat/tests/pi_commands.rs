//! pi builtin slash-command parity: every top-level command pi registers is
//! an `omp_con` command here, and the sixteen that landed last (`/settings`,
//! `/model`, `/switch`, `/fast`, `/retry`, `/clear`, `/exit`, `/quit`,
//! `/restart`, `/dump`, `/mcp`, `/add-dir`, `/remove-dir`, `/dirs`,
//! `/move`, `/wt`) are driven through a real `Session` + console `Ctx`
//! fixture to the effect pi specifies.

use std::{path::PathBuf, sync::Arc};

use omp_chat::{
	HostCommand, HostOptions, NativeEffect, NativeHost,
	overlays::services::{
		AccountRow, McpOp, McpRun, ServiceError, ServiceResult, Services, WorktreeInfo,
	},
};
use omp_con::Value;
use omp_core::Str;
use omp_session::{ComponentRegistry, Session};
use omp_tui::{Key, Size, UiContext, frame_text, slots::ResizePolicy};
use tempfile::tempdir;

/// Top-level `name:` of every entry in pi's builtin registry —
/// `/work/pi/packages/coding-agent/src/slash-commands/builtin-*.ts`
/// (`BUILTIN_*_SLASH_COMMANDS` arrays; subcommand and alias names
/// excluded), 80 commands in the current pi oracle.
const PI_BUILTIN_COMMANDS: [&str; 80] = [
	"advisor",
	"export",
	"trace",
	"dump",
	"share",
	"collab",
	"join",
	"leave",
	"browser",
	"copy",
	"open",
	"force",
	"live",
	"pause",
	"quit",
	"ssh",
	"new",
	"fresh",
	"clear",
	"drop",
	"compact",
	"shake",
	"handoff",
	"resume",
	"pin",
	"btw",
	"tan",
	"omfg",
	"cleanse",
	"retry",
	"debug",
	"memory",
	"rename",
	"move",
	"wt",
	"add-dir",
	"remove-dir",
	"dirs",
	"exit",
	"restart",
	"marketplace",
	"plugins",
	"reload-plugins",
	"security",
	"settings",
	"setup",
	"plan",
	"plan-review",
	"vibe",
	"goal",
	"guided-goal",
	"loop",
	"queue",
	"model",
	"switch",
	"fast",
	"skillful",
	"extended-context",
	"computer",
	"vision",
	"prewalk",
	"todo",
	"session",
	"jobs",
	"usage",
	"stats",
	"changelog",
	"hotkeys",
	"tools",
	"context",
	"extensions",
	"agents",
	"git",
	"hub",
	"branch",
	"fork",
	"tree",
	"login",
	"logout",
	"mcp",
];

/// Pi aliases (`aliases: [...]`) are registered as first-class console names.
const PI_ALIASES: [(&str, &str); 7] = [
	("force:", "force"),
	("q", "quit"),
	("worktree", "wt"),
	("providers", "setup"),
	("models", "model"),
	("status", "extensions"),
	("rewind", "branch"),
];

#[test]
fn every_pi_builtin_slash_command_is_registered() {
	let con = omp_con::Ctx::new();
	let missing = PI_BUILTIN_COMMANDS
		.iter()
		.copied()
		.filter(|name| !matches!(con.find(name), Some(omp_con::RegItem::Cmd(_))))
		.collect::<Vec<_>>();
	assert!(missing.is_empty(), "pi builtin commands missing from the omp registry: {missing:?}");
	for (alias, target) in PI_ALIASES {
		assert!(
			matches!(con.find(alias), Some(omp_con::RegItem::Cmd(_))),
			"pi alias /{alias} (of /{target}) is not registered"
		);
	}
}

fn session() -> Session {
	let directory = tempdir().expect("temp directory");
	let path = directory.keep().join("commands.oms");
	let mut session = Session::create(path, ComponentRegistry::standard()).expect("create session");
	session.begin_turn().expect("begin turn");
	session.user("hello", Vec::new()).expect("user");
	session
		.assistant_start("test/model", "test", "test/model")
		.expect("assistant start");
	let turn = *session
		.dom()
		.children(session.dom().body())
		.last()
		.expect("turn");
	let assistant = *session.dom().children(turn).last().expect("assistant");
	let text = session
		.stream_open(assistant, omp_dom::PropId::Text.into())
		.expect("text stream");
	session.stream_append(text, "answer").expect("delta");
	session.stream_close(text).expect("close");
	session.assistant_end("stop").expect("assistant end");
	session
		.receipt(omp_journal::data::TurnReceipt::tokens(1, 1, 0))
		.expect("receipt");
	session
}

struct Feed {
	project:  PathBuf,
	restarts: parking_lot::Mutex<usize>,
	mcp_ops:  parking_lot::Mutex<Vec<McpOp>>,
}

impl Services for Feed {
	fn project_dir(&self) -> ServiceResult<PathBuf> {
		Ok(self.project.clone())
	}

	fn create_worktree(&self, branch: &str) -> ServiceResult<WorktreeInfo> {
		if branch == "taken" {
			return Err(ServiceError::Failed(Str::new_static(
				"Branch 'taken' already exists; pick another name.",
			)));
		}
		Ok(WorktreeInfo { path: self.project.join("wt").join(branch), branch: Str::new(branch) })
	}

	fn dump_request(&self, _dom: &omp_dom::Dom) -> ServiceResult<PathBuf> {
		Ok(PathBuf::from("/tmp/omp-request-commands.json"))
	}

	fn request_restart(&self) -> ServiceResult<()> {
		*self.restarts.lock() += 1;
		Ok(())
	}

	fn mcp(&self, op: McpOp) -> ServiceResult<McpRun> {
		self.mcp_ops.lock().push(op.clone());
		let (tx, rx) = flume::bounded(1);
		let _ = tx.send(Ok(Str::new(format!("ran {op:?}"))));
		Ok(McpRun { done: rx, cancel: None })
	}

	/// One stored OAuth account on the `sub` provider and an API key on
	/// `test`: only `sub/*` routes bill to a subscription.
	fn accounts(&self) -> ServiceResult<Vec<AccountRow>> {
		let row = |provider: &'static str, kind: &'static str| AccountRow {
			id:            Str::new(format!("{provider}:acct")),
			provider:      Str::new_static(provider),
			provider_name: Str::new_static(provider),
			label:         Str::new_static("owner@example.com"),
			detail:        Str::new(format!("stored {kind}")),
			kind:          Str::new_static(kind),
			active:        true,
		};
		Ok(vec![row("sub", "oauth"), row("test", "api-key")])
	}
}

struct Harness {
	host:     NativeHost,
	commands: flume::Receiver<HostCommand>,
	con:      Arc<omp_con::Ctx>,
	feed:     Arc<Feed>,
	project:  PathBuf,
}

fn harness(models: Vec<omp_chat::ModelRow>) -> Harness {
	let mut session = session();
	let project = tempdir().expect("project").keep();
	std::fs::create_dir_all(project.join("wt")).expect("wt");
	let feed = Arc::new(Feed {
		project:  project.clone(),
		restarts: parking_lot::Mutex::new(0),
		mcp_ops:  parking_lot::Mutex::new(Vec::new()),
	});
	let (snapshot, dom_events) = session.subscribe();
	let (_, kernel_events) = flume::unbounded();
	let (commands, command_rx) = flume::unbounded();
	let (up, _) = flume::unbounded();
	let con = Arc::new(
		omp_chat::HostMailbox::new()
			.attach(omp_con::Ctx::builder())
			.build(),
	);
	let host = NativeHost::new(
		HostOptions {
			model: omp_chat::ModelBadge::from_identifier("test/model"),
			snapshot,
			dom_events,
			kernel_events,
			commands,
			up,
			con: Arc::clone(&con),
			models,
			cycle: Vec::new(),
			resize_policy: ResizePolicy::Rebuild,
			project: project.clone(),
			welcome: omp_chat::welcome::WelcomeFacts::default(),
			ui: UiContext::default(),
			services: Arc::clone(&feed) as Arc<dyn Services>,
			speech: None,
			resuming: false,
			initial_panel: None,
		},
		Size::new(120, 40),
	);
	std::mem::forget(session);
	Harness { host, commands: command_rx, con, feed, project }
}

fn model_row(key: &'static str, name: &'static str) -> omp_chat::ModelRow {
	omp_chat::ModelRow {
		key:         key.into(),
		name:        name.into(),
		provider_id: "test".into(),
		provider:    "Test".into(),
		context:     Some(200_000),
		input_mtok:  None,
		output_mtok: None,
		efforts:     Vec::new(),
	}
}

// ------------------------------------------------------------------ /settings

#[test]
fn settings_command_opens_curated_rows_and_applies_a_human_label_toggle() {
	let mut h = harness(Vec::new());
	assert_eq!(h.host.console("settings").expect("console"), NativeEffect::Consumed);
	assert_eq!(h.host.overlay_id(), Some("settings"));
	let frame = h.host.picker_frame().expect("panel frame");
	let text = frame_text(&frame);
	assert!(text.contains("Settings"), "{text}");
	assert!(text.contains("Appearance"), "{text}");
	assert!(text.contains("Model"), "{text}");
	assert!(!text.contains("ai_") && !text.contains("cl_") && !text.contains("sv_"), "{text}");
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::Overlay { open: true, .. })));

	for character in "show thinking".chars() {
		h.host.key(Key::Char(character)).expect("type");
	}
	let frame = h.host.picker_frame().expect("search frame");
	let text = frame_text(&frame);
	assert!(text.contains("Show Thinking Blocks"), "{text}");
	assert!(!text.contains("cl_showthinking"), "{text}");
	assert_eq!(h.con.get("cl_showthinking"), Some(Value::Bool(true)));
	h.host.key(Key::Enter).expect("toggle");
	assert_eq!(h.con.get("cl_showthinking"), Some(Value::Bool(false)));
	assert_eq!(h.host.overlay_id(), Some("settings"), "the panel stays open");
	h.host.key(Key::Esc).expect("end search");
	h.host.key(Key::Esc).expect("close");
	assert_eq!(h.host.overlay_id(), None);
}

// -------------------------------------------------------------------- /model

#[test]
fn model_opens_the_picker_and_model_with_a_selector_sets_ai_model() {
	let mut h =
		harness(vec![model_row("test/model", "Test Model"), model_row("test/other", "Other Model")]);
	h.host.console("model").expect("console");
	assert_eq!(h.host.overlay_id(), Some("models"));
	h.host.key(Key::Esc).expect("close");
	h.host.console("models").expect("alias");
	assert_eq!(h.host.overlay_id(), Some("models"));
	h.host.key(Key::Esc).expect("close");
	h.host.console("model test/other").expect("direct");
	assert_eq!(h.con.get("ai_model"), Some(Value::Str("test/other".into())));
	assert!(
		h.host
			.notice()
			.is_some_and(|text| text.starts_with("test/other set for this session only")),
		"{:?}",
		h.host.notice()
	);
	h.host.console("model \"Test Model\"").expect("by name");
	assert_eq!(h.con.get("ai_model"), Some(Value::Str("test/model".into())));
	h.host.console("model other").expect("bare id");
	assert_eq!(h.con.get("ai_model"), Some(Value::Str("test/other".into())));
	h.host.console("model nope/none").expect("unknown");
	assert_eq!(h.con.get("ai_model"), Some(Value::Str("test/other".into())));
	assert!(
		h.host
			.notice()
			.is_some_and(|text| text.starts_with("Unknown model: nope/none")),
		"{:?}",
		h.host.notice()
	);
}

/// The composer status band row of the native frame.
fn band_row(h: &Harness) -> String {
	frame_text(h.host.frame())
		.lines()
		.find(|row| row.contains("📁 session"))
		.map(|row| row.trim_end().to_owned())
		.unwrap_or_else(|| panic!("band row in:\n{}", frame_text(h.host.frame())))
}

#[test]
fn ai_model_write_to_an_unlisted_route_replaces_the_badge() {
	let listed = omp_chat::ModelRow {
		efforts: vec![Str::new_static("low"), Str::new_static("high")],
		..model_row("test/listed", "Listed Model")
	};
	let mut h = harness(vec![listed]);
	h.host.console("ai_model test/listed").expect("listed");
	assert_eq!(h.host.model_badge().context_window, Some(200_000));
	assert!(h.host.model_badge().reasoning);
	let band = band_row(&h);
	assert!(band.contains("Listed Model") && band.contains("200K"), "{band}");
	// A route the picker never listed (custom provider,
	// direct `provider/model` syntax) still becomes the live badge, so the
	// gauge, the thinking gate, and the welcome box stop describing the
	// previous model.
	h.host
		.console("ai_model custom/direct-model")
		.expect("unlisted");
	let badge = h.host.model_badge();
	assert_eq!(badge.identifier.as_str(), "custom/direct-model");
	assert_eq!(badge.provider.as_str(), "custom");
	assert_eq!(badge.context_window, None);
	assert!(!badge.reasoning);
	let band = band_row(&h);
	assert!(band.contains("⬢ direct-model"), "{band}");
	assert!(!band.contains("200K"), "the previous window is gone: {band}");
	assert!(!band.contains("Listed Model"), "{band}");
}

#[test]
fn band_marks_subscription_billing_from_the_stored_oauth_account() {
	let mut h = harness(vec![model_row("test/model", "Test Model"), omp_chat::ModelRow {
		provider_id: "sub".into(),
		..model_row("sub/plan", "Plan Model")
	}]);
	h.host.console("ai_model test/model").expect("metered");
	let band = band_row(&h);
	assert!(!band.contains("(sub)"), "an api-key provider is metered: {band}");
	// A provider served by a stored OAuth credential
	// bills to its subscription; with no spend the `(sub)` marker alone
	// shows in the cost chip.
	h.host.console("ai_model sub/plan").expect("subscribed");
	let band = band_row(&h);
	assert!(band.contains("(sub)"), "{band}");
	h.host.console("ai_model test/model").expect("back");
	let band = band_row(&h);
	assert!(!band.contains("(sub)"), "{band}");
}

#[test]
fn switch_opens_the_session_only_picker() {
	let mut h =
		harness(vec![model_row("test/model", "Test Model"), model_row("test/other", "Other")]);
	h.host.console("switch").expect("console");
	assert_eq!(h.host.overlay_id(), Some("models"));
	h.host.key(Key::Down).expect("down");
	h.host.key(Key::Enter).expect("pick");
	assert_eq!(h.host.notice(), Some("Session model: Other"));
	assert_eq!(h.con.get("ai_model"), Some(Value::Str("test/other".into())));
}

// --------------------------------------------------------------------- /fast

#[test]
fn fast_toggles_on_off_and_reports_status() {
	let mut h = harness(Vec::new());
	h.host.console("fast").expect("toggle");
	assert_eq!(h.con.get("ai_fastmode"), Some(Value::Bool(true)));
	assert_eq!(h.host.notice(), Some("Fast mode enabled."));
	h.host.console("fast status").expect("status");
	assert_eq!(h.host.notice(), Some("Fast mode is on."));
	h.host.console("fast off").expect("off");
	assert_eq!(h.con.get("ai_fastmode"), Some(Value::Bool(false)));
	assert_eq!(h.host.notice(), Some("Fast mode disabled."));
	h.host.console("fast on").expect("on");
	assert_eq!(h.con.get("ai_fastmode"), Some(Value::Bool(true)));
	h.host.console("fast bogus").expect("usage");
	assert_eq!(h.host.notice(), Some("Usage: /fast [on|off|status]"));
	assert_eq!(h.con.get("ai_fastmode"), Some(Value::Bool(true)));
}

// -------------------------------------------------------------------- /retry

#[test]
fn retry_notices_when_the_last_turn_did_not_fail() {
	let mut h = harness(Vec::new());
	h.host.console("retry").expect("retry");
	assert_eq!(h.host.notice(), Some("Last turn did not fail; nothing to retry"));
	assert!(h.commands.try_recv().is_err());
}

// -------------------------------------------------------------------- /clear

#[test]
fn clear_asks_the_controller_for_a_context_reset() {
	let mut h = harness(Vec::new());
	h.host.console("clear").expect("clear");
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::ContextReset)));
}

// ---------------------------------------------------------- /exit /quit /q

#[test]
fn exit_quit_and_q_leave_the_host() {
	for command in ["exit", "quit", "q"] {
		let mut h = harness(Vec::new());
		assert_eq!(h.host.console(command).expect(command), NativeEffect::Quit, "/{command}");
	}
}

// ------------------------------------------------------------------ /restart

#[test]
fn restart_marks_the_process_and_leaves_through_exit() {
	let h_feed;
	{
		let mut h = harness(Vec::new());
		h_feed = Arc::clone(&h.feed);
		assert_eq!(h.host.console("restart").expect("restart"), NativeEffect::Quit);
	}
	assert_eq!(*h_feed.restarts.lock(), 1);
}

// --------------------------------------------------------------------- /dump

#[test]
fn dump_copies_the_transcript_with_the_sidecar_path() {
	let mut h = harness(Vec::new());
	h.host.console("dump").expect("dump");
	let copied = h.host.take_clipboard().expect("clipboard");
	assert!(copied.starts_with("User:\nhello\n\nAssistant:\nanswer"), "{copied}");
	assert!(copied.contains("LLM request JSON: /tmp/omp-request-commands.json"), "{copied}");
	assert!(copied.contains("may contain raw context/secrets"), "{copied}");
	assert!(
		h.host
			.notice()
			.is_some_and(|text| text.starts_with("Session copied to clipboard")),
		"{:?}",
		h.host.notice()
	);
}

// ---------------------------------------------------------------------- /mcp

#[test]
fn mcp_help_opens_the_report_and_subcommands_run_through_services() {
	let mut h = harness(Vec::new());
	h.host.console("mcp").expect("help");
	assert_eq!(h.host.overlay_id(), Some("mcp"));
	let text = frame_text(&h.host.picker_frame().expect("frame"));
	assert!(text.contains("MCP Server Management"), "{text}");
	h.host.key(Key::Esc).expect("close");
	h.host.console("mcp list").expect("list");
	assert_eq!(h.host.overlay_id(), Some("mcp"));
	h.host.key(Key::Esc).expect("close");
	h.host.console("mcp test github").expect("test");
	h.host.key(Key::Esc).expect("close");
	h.host.console("mcp reload").expect("reload");
	h.host.key(Key::Esc).expect("close");
	assert_eq!(&*h.feed.mcp_ops.lock(), &[McpOp::List, McpOp::Test("github".into()), McpOp::Reload]);
	h.host.console("mcp test").expect("usage");
	assert_eq!(h.host.notice(), Some("Server name required. Usage: /mcp test <name>"));
	h.host.console("mcp bogus").expect("unknown");
	assert_eq!(h.host.notice(), Some("Unknown subcommand: bogus. Type /mcp help for usage."));
	h.host.console("mcp smithery-login").expect("smithery");
	assert!(
		h.host
			.notice()
			.is_some_and(|text| text.contains("Smithery"))
	);
}

// ---------------------------------------------- /add-dir /remove-dir /dirs

#[test]
fn workspace_dirs_are_a_session_convar_listed_like_pi() {
	let mut h = harness(Vec::new());
	let project = h.project.clone();
	let extra = project.join("extra");
	std::fs::create_dir_all(&extra).expect("extra");
	h.host.console("dirs").expect("dirs");
	assert_eq!(
		h.host.notice(),
		Some(format!("Workspace directories:\n  {} (working directory)", project.display()).as_str())
	);
	h.host.console("add-dir").expect("usage");
	assert!(
		h.host
			.notice()
			.is_some_and(|text| text.starts_with("Usage: /add-dir <path>\n"))
	);
	h.host.console("add-dir extra").expect("add");
	assert_eq!(
		h.host.notice(),
		Some(
			format!(
				"Added {0}.\nWorkspace directories:\n  {1} (working directory)\n  {0}",
				extra.display(),
				project.display()
			)
			.as_str()
		)
	);
	assert_eq!(
		h.con.get("sv_workspace_dirs"),
		Some(Value::List(vec![Value::Str(Str::new(extra.display().to_string()))]))
	);
	assert!(
		h.con
			.session_writes()
			.any(|(name, _)| name == "sv_workspace_dirs"),
		"workspace dirs live in the session layer"
	);
	h.host.console("add-dir extra").expect("again");
	assert_eq!(
		h.host.notice(),
		Some(format!("Already in the workspace: {}", extra.display()).as_str())
	);
	h.host.console("add-dir missing").expect("missing");
	assert_eq!(
		h.host.notice(),
		Some(format!("Directory does not exist: {}", project.join("missing").display()).as_str())
	);
	h.host.console("remove-dir .").expect("cwd");
	assert_eq!(
		h.host.notice(),
		Some("Cannot remove the working directory; use /move to change it.")
	);
	h.host.console("remove-dir nope").expect("not a dir");
	assert_eq!(
		h.host.notice(),
		Some(format!("Not a workspace directory: {}", project.join("nope").display()).as_str())
	);
	h.host.console("remove-dir extra").expect("remove");
	assert!(
		h.host
			.notice()
			.is_some_and(|text| text.starts_with(&format!("Removed {}.", extra.display())))
	);
	assert_eq!(h.con.get("sv_workspace_dirs"), Some(Value::List(Vec::new())));
}

// ---------------------------------------------------------------- /move /wt

#[test]
fn move_validates_the_directory_then_asks_the_controller() {
	let mut h = harness(Vec::new());
	let target = h.project.clone().join("elsewhere");
	std::fs::create_dir_all(&target).expect("target");
	h.host.console("move").expect("editor");
	assert_eq!(h.host.overlay_id(), Some("move"));
	h.host.key(Key::Esc).expect("cancel editor");
	h.host
		.console("move nowhere")
		.expect("missing confirmation");
	assert_eq!(h.host.overlay_id(), Some("move"));
	h.host.key(Key::Char('y')).expect("confirm create");
	let create = h
		.commands
		.try_iter()
		.find(|command| matches!(command, HostCommand::Move { .. }))
		.expect("create move command");
	assert!(
		matches!(
			&create,
			HostCommand::Move { path, create: true } if path == &h.project.join("nowhere")
		),
		"{create:?}",
	);
	h.host.console("move elsewhere").expect("move");
	let existing = h
		.commands
		.try_iter()
		.find(|command| matches!(command, HostCommand::Move { .. }))
		.expect("existing move command");
	assert!(matches!(
		existing,
		HostCommand::Move { path, create: false } if path == target
	));
}

#[test]
fn wt_creates_a_worktree_through_services_and_moves_there() {
	let mut h = harness(Vec::new());
	h.host.console("wt feature/x").expect("wt");
	let expected = h.project.join("wt").join("feature/x");
	assert!(matches!(
		h.commands.try_recv(),
		Ok(HostCommand::Move { path, create: false }) if path == expected
	));
	assert_eq!(
		h.host.notice(),
		Some(
			format!(
				"Moved to worktree {} on branch feature/x (checked out, uncommitted changes carried \
				 over).",
				expected.display()
			)
			.as_str()
		)
	);
	h.host.console("worktree taken").expect("alias + failure");
	assert_eq!(
		h.host.notice(),
		Some("Worktree creation failed: Branch 'taken' already exists; pick another name.")
	);
	assert!(h.commands.try_recv().is_err());
	h.host.console("wt").expect("default branch");
	match h.commands.try_recv() {
		Ok(HostCommand::Move { path, create: false }) => {
			let branch = path.strip_prefix(h.project.join("wt")).expect("under wt");
			assert!(branch.to_string_lossy().starts_with("wt/"), "{}", branch.display());
		},
		other => panic!("expected a move: {other:?}"),
	}
}
