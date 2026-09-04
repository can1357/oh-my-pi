//! Collaboration, lifecycle, and capability-toggle slash commands: `/export`,
//! `/share`, `/cleanse`, `/security`,
//! `/memory`, `/ssh`, `/browser`, `/computer`, `/vision`, `/prewalk`,
//! `/extended-context`, `/advisor`, `/collab`, `/join`, `/leave`, `/live`.
//!
//! Every command here either flips a convar (ADR 0012: the convar *is* the
//! live setting), asks the application through the [`Services`] seam, opens
//! an observer-local panel, or sends a typed controller request. `/advisor`
//! controls the journal-backed advisor Director; `/vision` sets the journaled
//! `ai_vision` convar the kernel's request projection consumes.
//!
//! [`Services`]: crate::overlays::services::Services

use std::{fmt::Write as _, path::PathBuf};

use omp_con::{ConError, Value};
use omp_core::{Str, StrMut, sf};
use omp_tui::Icon;

use super::{PaletteEntry, rest, run::director_active};
use crate::{
	actions::{HostAction, post},
	host::HostCommand,
	overlays::{
		PanelAnchor, PanelCall, PanelCx, PanelEvent, PanelOpener,
		report::ReportPanel,
		services::{CleanseRequest, CollabOp, MemoryOp, ServiceError, SshHostSpec},
		tasks::{PendingPanel, Settle},
	},
	project::{BlockKind, block_views},
};

/// Palette icons for this module's commands.
pub const PALETTE: &[PaletteEntry] = &[
	PaletteEntry { name: "export", icon: Icon::Export },
	PaletteEntry { name: "share", icon: Icon::Share },
	PaletteEntry { name: "cleanse", icon: Icon::Broom },
	PaletteEntry { name: "security", icon: Icon::Shield },
	PaletteEntry { name: "memory", icon: Icon::Memory },
	PaletteEntry { name: "ssh", icon: Icon::Ssh },
	PaletteEntry { name: "browser", icon: Icon::Browser },
	PaletteEntry { name: "computer", icon: Icon::Desktop },
	PaletteEntry { name: "vision", icon: Icon::Eye },
	PaletteEntry { name: "prewalk", icon: Icon::Prewalk },
	PaletteEntry { name: "skillful", icon: Icon::Compass },
	PaletteEntry { name: "extended-context", icon: Icon::Context },
	PaletteEntry { name: "advisor", icon: Icon::Advisor },
	PaletteEntry { name: "collab", icon: Icon::Link },
	PaletteEntry { name: "join", icon: Icon::Link },
	PaletteEntry { name: "leave", icon: Icon::Link },
	PaletteEntry { name: "live", icon: Icon::Mic },
];

/// Snapshot schema revision written by `/share`.
const SHARE_SNAPSHOT_VERSION: u8 = 1;
/// `/share` copies the viewer link; the same line is the panel row.
const SHARE_MESSAGE: &str = "Sharing session…";
const CLEANSE_MESSAGE: &str = "Cleansing workspace…";
/// Legacy `security review` child brief (`chat_ui/commands/security.rs`).
const SECURITY_REVIEW_BRIEF: &str =
	"Launch exactly one ordinary local child agent to review `{target}` for security defects: \
	 injection, secrets in source, unsafe deserialization, path traversal, missing authorization \
	 checks, and unsafe shell or SQL construction. Report findings first, each with file:line, \
	 severity, and a concrete fix; never edit files.";
omp_con::var! {
	/// Use premium long-context windows on models that bill extra past a
	/// threshold; when disabled, cap them at the standard-pricing window.
	pub static AI_EXTENDED_CONTEXT = ai_extended_context: bool {
		default: false,
		flags: archive | session,
		meta: {
			"ui.tab": "context",
			"ui.group": "General",
			"ui.label": "Extended Context",
			"legacy.path": "extendedContext",
		},
	};
}

fn usage(message: &'static str) -> ConError {
	ConError::Usage(Str::new_static(message))
}

fn open(ctx: &omp_con::Ctx, opener: PanelOpener) -> omp_con::ConResult<()> {
	post(ctx, HostAction::Open(opener))
}

fn call(ctx: &omp_con::Ctx, call: PanelCall) -> omp_con::ConResult<()> {
	post(ctx, HostAction::Call(call))
}

fn notice(text: impl Into<Str>) -> PanelEvent {
	PanelEvent::Notice(text.into())
}

/// Parses an `on|off|status` word (`None` is `status`).
fn switch(word: Option<&Str>, usage_line: &'static str) -> Result<Option<bool>, ConError> {
	match word.map(|word| word.trim().to_ascii_lowercase()).as_deref() {
		None | Some("status") => Ok(None),
		Some("on" | "true" | "1" | "enable" | "enabled") => Ok(Some(true)),
		Some("off" | "false" | "0" | "disable" | "disabled") => Ok(Some(false)),
		Some(_) => Err(usage(usage_line)),
	}
}

/// Sets a convar from a host effect, reporting the console's own error.
fn set_var(cx: &PanelCx<'_>, name: &str, value: Value) -> Result<(), Str> {
	cx.con
		.exec(&format!("{name} {value}"), omp_con::Source::Console)
		.map(|_| ())
		.map_err(|error| Str::new(error.to_string()))
}

fn var_text(cx: &PanelCx<'_>, name: &str) -> Str {
	cx.con
		.get(name)
		.map_or_else(|| Str::new_static("unset"), |value| Str::new(value.to_string()))
}

/// How `ai_vision` reads in a notice.
fn vision_flow(mode: &str) -> &'static str {
	match mode {
		"on" => "always sent",
		"off" => "never sent",
		_ => "sent when the route accepts image input",
	}
}

fn var_bool(cx: &PanelCx<'_>, name: &str) -> Option<bool> {
	match cx.con.get(name)? {
		Value::Bool(value) => Some(value),
		other => other.to_string().parse().ok(),
	}
}

/// `/share`: the transcript as a schema-agnostic JSON snapshot for the
/// zero-knowledge viewer (`SHARE_LOADER_HTML` pretty-prints whatever it
/// decrypts).
pub(crate) fn share_snapshot(dom: &omp_dom::Dom) -> serde_json::Value {
	let blocks = block_views(dom, true)
		.into_iter()
		.filter(|block| block.kind != BlockKind::Welcome)
		.map(|block| {
			let role = match block.kind {
				BlockKind::User => "user",
				BlockKind::Assistant => "assistant",
				BlockKind::Thinking => "thinking",
				BlockKind::Tool => "tool",
				BlockKind::Local => "local",
				BlockKind::Notice => "notice",
				BlockKind::Usage => "usage",
				BlockKind::Divider => "divider",
				BlockKind::Welcome => "welcome",
			};
			serde_json::json!({ "role": role, "text": block.text.as_str() })
		})
		.collect::<Vec<_>>();
	serde_json::json!({
		"version": SHARE_SNAPSHOT_VERSION,
		"exported_at_ms": std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map_or(0, |elapsed| elapsed.as_millis() as u64),
		"blocks": blocks,
	})
}

/// `/security` report over the live policy convars (legacy omp printed the
/// same facts as a markdown block).
pub(crate) fn security_report(cx: &PanelCx<'_>) -> Str {
	let mut out = StrMut::new("**Security posture**\n\n");
	let _ =
		writeln!(out, "- Host approval: `sv_approval_mode {}`", var_text(cx, "sv_approval_mode"));
	let _ = writeln!(
		out,
		"- Tool approval tier: `sv_tools_approval_mode {}`",
		var_text(cx, "sv_tools_approval_mode")
	);
	let _ = writeln!(
		out,
		"- Per-tool overrides: `sv_tools_approval {}`",
		var_text(cx, "sv_tools_approval")
	);
	let _ = writeln!(out, "- Tool roster enabled: `sv_tools {}`", var_text(cx, "sv_tools"));
	let _ = writeln!(out, "- Sandbox: `sv_sandbox_mode {}`", var_text(cx, "sv_sandbox_mode"));
	let _ = writeln!(
		out,
		"- Network: `sv_sandbox_network_mode {}`",
		var_text(cx, "sv_sandbox_network_mode")
	);
	let _ = writeln!(
		out,
		"- Writable roots: `sv_sandbox_writable_roots {}`",
		var_text(cx, "sv_sandbox_writable_roots")
	);
	let _ =
		writeln!(out, "- Read mode: `sv_sandbox_read_mode {}`", var_text(cx, "sv_sandbox_read_mode"));
	let _ = writeln!(
		out,
		"- Browser tool: `sv_browser_enabled {}` · headless `{}`",
		var_text(cx, "sv_browser_enabled"),
		var_text(cx, "sv_browser_headless")
	);
	let _ =
		writeln!(out, "- Fetch in read: `sv_fetch_enabled {}`", var_text(cx, "sv_fetch_enabled"));
	let _ = write!(
		out,
		"\n`/security review [path]` drafts a findings-first review brief for a child agent."
	);
	out.freeze()
}

/// `/ssh add` grammar (legacy omp): `<alias> --host <host> --user <user>
/// --host-key <SHA256:…> [--port <n>] [--key <path>] [--scope user|project]`.
fn parse_ssh_add(words: &[&str]) -> Result<SshHostSpec, ConError> {
	const USAGE: &str = "Usage: /ssh add <alias> --host <host> --user <user> --host-key \
	                     <SHA256:fingerprint> [--port <1-65535>] [--key <path>] [--scope \
	                     user|project]";
	let mut words = words.iter().copied();
	let alias = words.next().ok_or_else(|| usage(USAGE))?;
	let mut spec = SshHostSpec {
		alias:    Str::new(alias),
		address:  Str::default(),
		user:     Str::default(),
		port:     22,
		host_key: Str::default(),
		key:      None,
		project:  true,
	};
	while let Some(flag) = words.next() {
		let value = words.next().ok_or_else(|| usage(USAGE))?;
		match flag {
			"--host" => spec.address = Str::new(value),
			"--user" => spec.user = Str::new(value),
			"--host-key" => spec.host_key = Str::new(value),
			"--port" => spec.port = value.parse().map_err(|_| usage(USAGE))?,
			"--key" => spec.key = Some(PathBuf::from(value)),
			"--scope" => {
				spec.project = match value {
					"project" => true,
					"user" => false,
					_ => return Err(usage(USAGE)),
				}
			},
			_ => return Err(usage(USAGE)),
		}
	}
	if spec.address.is_empty() || spec.user.is_empty() || !spec.host_key.starts_with("SHA256:") {
		return Err(usage(USAGE));
	}
	Ok(spec)
}

fn scope_flag(words: &[&str]) -> Result<bool, ConError> {
	match words {
		[] => Ok(true),
		["--scope", "project"] => Ok(true),
		["--scope", "user"] => Ok(false),
		_ => Err(usage("Usage: /ssh remove <alias> [--scope user|project]")),
	}
}

const SSH_HELP: &str = "**SSH host management**\n\n`/ssh list`\n`/ssh add <alias> --host <host> \
                        --user <user> --host-key <SHA256:fingerprint> [--port <1-65535>] [--key \
                        <path>] [--scope user|project]`\n`/ssh remove <alias> [--scope \
                        user|project]`\n`/ssh help`\n\nProject declarations are stored in \
                        `.omp/hosts.toml`; user declarations are stored in the user configuration \
                        root's `hosts.toml` (`~/.o2`). Project aliases take precedence.";

fn ssh_list(cx: &PanelCx<'_>) -> Result<Box<dyn crate::overlays::Panel>, Str> {
	let hosts = cx.services.ssh_hosts().map_err(|error| sf!("{error}"))?;
	if hosts.is_empty() {
		return Err(Str::new_static("No SSH hosts configured. Use `/ssh add` to add one."));
	}
	let mut body = StrMut::new("**Configured SSH hosts**\n");
	for host in &hosts {
		let _ =
			writeln!(body, "- `{}` ({}) — `{}` · {}", host.name, host.scope, host.target, host.auth);
	}
	Ok(Box::new(ReportPanel::new("ssh", "SSH hosts", body.freeze(), cx.ui)))
}

omp_con::cmd! {
	/// Exports the session transcript: `/export [path]`.
	export(?path: Str) = |ctx, args| {
		let path = args.opt::<Str>(0)?.map(|path| PathBuf::from(path.as_str()));
		call(ctx, PanelCall::new(move |cx| match cx.services.export(cx.dom, path.as_deref()) {
			Ok(written) => notice(sf!("Session exported to: {}", written.display())),
			Err(error) => notice(sf!("Failed to export session: {error}")),
		}))
	};

	/// Shares the session as an encrypted link and copies it.
	share() = |ctx, _args| {
		open(ctx, PanelOpener::new(|cx| {
			let pending = cx
				.services
				.share(share_snapshot(cx.dom))
				.map_err(|error| sf!("Failed to share session: {error}"))?;
			Ok(Box::new(PendingPanel::new(
				"share",
				PanelAnchor::Center,
				"Share",
				SHARE_MESSAGE,
				pending,
				None,
				Settle::Copy,
				cx.ui,
			)))
		}))
	};

	/// Detects and fixes project diagnostics with repair agents: `/cleanse [request] [--all] [--tests]`.
	cleanse(?request: Str) = |ctx, args| {
		let mut request = CleanseRequest::default();
		let mut words = Vec::new();
		let text = rest(args, 0);
		for word in text.iter().flat_map(|text| text.split_whitespace()) {
			match word {
				"--all" => request.all = true,
				"--tests" => request.tests = true,
				other => words.push(other),
			}
		}
		if !words.is_empty() {
			request.request = Some(Str::new(words.join(" ")));
		}
		open(ctx, PanelOpener::new(move |cx| {
			let run = cx
				.services
				.cleanse(request.clone())
				.map_err(|error| sf!("Cleanse failed to start: {error}"))?;
			let (tx, rx) = flume::bounded(1);
			let done = run.done;
			std::thread::spawn(move || {
				let result = done.recv().map_or_else(
					|_| Err(ServiceError::Failed(Str::new_static("cleanse run dropped"))),
					|result| {
						result.map(|outcome| {
							let mut line = StrMut::new(outcome.summary.as_str());
							for group in &outcome.remainder {
								line.push('\n');
								line.push_str(group.as_str());
							}
							line.freeze()
						})
					},
				);
				let _ = tx.send(result);
			});
			Ok(Box::new(PendingPanel::new(
				"cleanse",
				PanelAnchor::Side,
				"Cleanse",
				CLEANSE_MESSAGE,
				rx,
				Some(run.cancel),
				Settle::Show,
				cx.ui,
			)))
		}))
	};

	/// Shows the approval and sandbox posture; `review [path]` drafts a security review brief.
	security(?sub: Str, ?target: Str) = |ctx, args| {
		let words = rest(args, 0);
		let mut words = words.iter().flat_map(|text| text.split_whitespace());
		match words.next() {
			None | Some("status" | "show") => open(ctx, PanelOpener::new(|cx| {
				Ok(Box::new(ReportPanel::new("security", "Security", security_report(cx), cx.ui)))
			})),
			Some("review") => {
				let target = words.next().unwrap_or(".").to_owned();
				call(ctx, PanelCall::new(move |_cx| {
					PanelEvent::Recall(Str::new(SECURITY_REVIEW_BRIEF.replace("{target}", &target)))
				}))
			},
			Some(_) => Err(usage("Usage: /security [status|review [path]]")),
		}
	};

	/// Inspects or maintains the memory bank: `/memory <view|stats|diagnose|clear|enqueue>`.
	memory(op: Str) = |ctx, args| {
		let op = args
			.get::<Str>(0)?
			.trim()
			.parse::<MemoryOp>()
			.map_err(|_| usage("Usage: /memory <view|stats|diagnose|clear|enqueue>"))?;
		open(ctx, PanelOpener::new(move |cx| {
			let text = cx.services.memory(op).map_err(|error| sf!("{error}"))?;
			Ok(Box::new(ReportPanel::new("memory", sf!("Memory · {op}"), text, cx.ui)))
		}))
	};

	/// Manages native SSH hosts: `/ssh <list|add|remove|help>`.
	ssh(?sub: Str, ?args: Str) = |ctx, args| {
		let words = rest(args, 0).unwrap_or_default();
		let words = words.split_whitespace().collect::<Vec<_>>();
		match words.split_first() {
			None | Some((&"list", _)) => open(ctx, PanelOpener::new(ssh_list)),
			Some((&"help", _)) => open(ctx, PanelOpener::new(|cx| {
				Ok(Box::new(ReportPanel::new("ssh", "SSH hosts", SSH_HELP, cx.ui)))
			})),
			Some((&"add", tail)) => {
				let spec = parse_ssh_add(tail)?;
				call(ctx, PanelCall::new(move |cx| match cx.services.ssh_add(&spec) {
					Ok(line) => notice(line),
					Err(error) => notice(sf!("{error}")),
				}))
			},
			Some((&"remove", [alias, tail @ ..])) => {
				let alias = Str::new(*alias);
				let project = scope_flag(tail)?;
				call(ctx, PanelCall::new(move |cx| match cx.services.ssh_remove(&alias, project) {
					Ok(line) => notice(line),
					Err(error) => notice(sf!("{error}")),
				}))
			},
			Some(_) => Err(usage("Usage: /ssh <list|add|remove|help>")),
		}
	};

	/// Runs the browser tool offscreen or in a window: `/browser [headless|visible]`.
	browser(?mode: Str) = |ctx, args| {
		let headless = match args.opt::<Str>(0)?.as_deref().map(str::trim) {
			None | Some("status") => None,
			Some("headless") => Some(true),
			Some("visible") => Some(false),
			Some(_) => return Err(usage("Usage: /browser [headless|visible]")),
		};
		call(ctx, PanelCall::new(move |cx| {
			if var_bool(cx, "sv_browser_enabled") == Some(false) {
				return notice("Browser tool is disabled (sv_browser_enabled 0)");
			}
			if let Some(headless) = headless
				&& let Err(error) = set_var(cx, "sv_browser_headless", Value::Bool(headless))
			{
				return notice(error);
			}
			let headless = var_bool(cx, "sv_browser_headless").unwrap_or(true);
			notice(if headless { "Browser mode: headless" } else { "Browser mode: visible" })
		}))
	};

	/// Enables or disables the native computer-use tool: `/computer [on|off|status]`.
	computer(?mode: Str) = |ctx, args| {
		let enable = switch(args.opt::<Str>(0)?.as_ref(), "Usage: /computer [on|off|status]")?;
		call(ctx, PanelCall::new(move |cx| {
			if let Some(enable) = enable {
				let script = format!("sv_tools_enabled computer={}", if enable { "on" } else { "off" });
				if let Err(error) = cx.con.exec(&script, omp_con::Source::Console) {
					return notice(error.to_string());
				}
			}
			let registered = cx
				.services
				.tools()
				.map(|tools| tools.iter().any(|tool| tool.name == "computer"))
				.unwrap_or(false);
			let overrides = var_text(cx, "sv_tools_enabled");
			let enabled = !overrides.contains("computer=off");
			notice(sf!(
				"Computer use: {} · tool: {} · overrides: {overrides}",
				if enabled { "enabled" } else { "disabled" },
				if registered { "registered" } else { "not registered" },
			))
		}))
	};

	/// Image input policy: `/vision [on|off|auto|status]` sets the
	/// session's `ai_vision` (auto follows the route's image capability).
	vision(?mode: Str) = |ctx, args| {
		let mode = match args.opt::<Str>(0)?.as_deref().map(str::trim) {
			None | Some("status") => None,
			Some(word @ ("on" | "off" | "auto")) => Some(Str::new(word)),
			Some(_) => return Err(usage("Usage: /vision [on|off|auto|status]")),
		};
		call(ctx, PanelCall::new(move |cx| {
			if let Some(mode) = &mode
				&& let Err(error) = set_var(cx, "ai_vision", Value::Str(mode.clone()))
			{
				return notice(error);
			}
			let current = var_text(cx, "ai_vision");
			notice(sf!("Vision mode: {current} · images {}", vision_flow(&current)))
		}))
	};

	/// Arms a one-shot switch to `@smol` at the next edit/write action.
	prewalk() = |ctx, _args| {
		call(ctx, PanelCall::new(|_cx| PanelEvent::Command(HostCommand::Prewalk)))
	};

	/// Lists discovered skills in the system prompt for this session:
	/// `/skillful [on|off|toggle|status]`.
	skillful(?mode: Str) = |ctx, args| {
		let mode = args
			.opt::<Str>(0)?
			.map_or_else(|| Str::new_static("toggle"), |mode| Str::new(mode.trim().to_ascii_lowercase()));
		if !matches!(mode.as_str(), "on" | "off" | "toggle" | "status") {
			return Err(usage("Usage: /skillful [on|off|status]"));
		}
		call(ctx, PanelCall::new(move |cx| {
			let current = var_bool(cx, "ai_skillful").unwrap_or(true);
			if mode == "status" {
				return notice(if current { "Skill listing: on." } else { "Skill listing: off." });
			}
			let enabled = match mode.as_str() {
				"on" => true,
				"off" => false,
				_ => !current,
			};
			if let Err(error) = set_var(cx, "ai_skillful", Value::Bool(enabled)) {
				return notice(error);
			}
			notice(if enabled {
				"Skill listing enabled for this session."
			} else {
				"Skill listing disabled for this session."
			})
		}))
	};

	/// Uses the premium extended-context tier: `/extended-context [on|off|status]`.
	"extended-context"(?mode: Str) = |ctx, args| {
		let enable = switch(args.opt::<Str>(0)?.as_ref(), "Usage: /extended-context [on|off|status]")?;
		call(ctx, PanelCall::new(move |cx| {
			if let Some(enable) = enable
				&& let Err(error) = set_var(cx, "ai_extended_context", Value::Bool(enable))
			{
				return notice(error);
			}
			notice(if AI_EXTENDED_CONTEXT.get(cx.con) {
				"Extended context: on"
			} else {
				"Extended context: off"
			})
		}))
	};

	/// Second-model watchdog: `/advisor [on|off|status|toggle|dump|configure]`.
	advisor(?mode: Str) = |ctx, args| {
		let mode = args
			.opt::<Str>(0)?
			.map_or_else(|| Str::new_static("status"), |mode| Str::new(mode.trim().to_ascii_lowercase()));
		if !matches!(mode.as_str(), "on" | "off" | "status" | "toggle" | "dump" | "configure") {
			return Err(usage("Usage: /advisor [on|off|status|toggle|dump|configure]"));
		}
		call(ctx, PanelCall::new(move |cx| {
			let active = director_active(cx.dom, "advisor");
			match mode.as_str() {
				"status" | "dump" => notice(if active { "Advisor: on" } else { "Advisor: off" }),
				"configure" => notice("Configure ai_advisor_enabled, ai_advisor_sync_backlog, and ai_advisor_immune_turns in /settings."),
				"on" | "off" | "toggle" => {
					let enabled = match mode.as_str() {
						"on" => true,
						"off" => false,
						_ => !active,
					};
					if let Err(error) = set_var(cx, "ai_advisor_enabled", Value::Bool(enabled)) {
						return notice(error);
					}
					PanelEvent::Command(HostCommand::Director {
						id: Str::new_static("advisor"),
						engage: enabled,
						args: Vec::new(),
					})
				},
				_ => unreachable!("advisor command vocabulary checked above"),
			}
		}))
	};

	/// Hosts a live collaboration room: `/collab [start|view|status|stop] [relay]`.
	collab(?sub: Str, ?relay: Str) = |ctx, args| {
		let words = rest(args, 0).unwrap_or_default();
		let words = words.as_str().trim();
		let (verb, tail) = words
			.split_once(char::is_whitespace)
			.map_or((words, ""), |(verb, tail)| (verb, tail.trim()));
		let op = match verb {
			"" | "start" => CollabOp::Start {
				read_only: false,
				relay: (!tail.is_empty()).then(|| Str::new(tail)),
			},
			"view" => CollabOp::Start {
				read_only: true,
				relay: (!tail.is_empty()).then(|| Str::new(tail)),
			},
			"status" if tail.is_empty() => CollabOp::Status,
			"stop" if tail.is_empty() => CollabOp::Leave,
			relay if !relay.is_empty() && tail.is_empty() => CollabOp::Start {
				read_only: false,
				relay: Some(Str::new(relay)),
			},
			_ => return Err(usage("Usage: /collab [start|view|status|stop] [relayUrl]")),
		};
		call(ctx, PanelCall::new(move |_cx| PanelEvent::Command(HostCommand::Collab(op.clone()))))
	};

	/// Joins a shared collaboration room: `/join <link>`.
	join(link: Str) = |ctx, args| {
		let link = rest(args, 0).ok_or_else(|| usage("Usage: /join <link>"))?;
		call(ctx, PanelCall::new(move |_cx| {
			PanelEvent::Command(HostCommand::Collab(CollabOp::Join {
				link: link.clone(),
				name: None,
			}))
		}))
	};

	/// Leaves the collaboration room.
	leave() = |ctx, _args| {
		call(ctx, PanelCall::new(|_cx| {
			PanelEvent::Command(HostCommand::Collab(CollabOp::Leave))
		}))
	};

	/// Starts or stops the duplex live-voice session.
	live() = |ctx, _args| post(ctx, HostAction::LiveToggle);
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn ssh_add_parses_the_legacy_flag_grammar() {
		let spec = parse_ssh_add(&[
			"build",
			"--host",
			"10.0.0.5",
			"--user",
			"ci",
			"--host-key",
			"SHA256:abc",
			"--port",
			"2222",
			"--scope",
			"user",
		])
		.unwrap();
		assert_eq!(spec.alias, "build");
		assert_eq!(spec.address, "10.0.0.5");
		assert_eq!(spec.user, "ci");
		assert_eq!(spec.port, 2222);
		assert!(!spec.project);
		assert!(spec.key.is_none());
		assert!(parse_ssh_add(&["build", "--host", "x"]).is_err(), "user and host key are required");
		assert!(
			parse_ssh_add(&["build", "--host", "x", "--user", "u", "--host-key", "MD5:z"]).is_err()
		);
	}

	#[test]
	fn switch_words_map_to_on_off_status() {
		assert_eq!(switch(None, "u").unwrap(), None);
		assert_eq!(switch(Some(&Str::new_static("on")), "u").unwrap(), Some(true));
		assert_eq!(switch(Some(&Str::new_static("OFF")), "u").unwrap(), Some(false));
		assert!(switch(Some(&Str::new_static("maybe")), "u").is_err());
	}

	#[test]
	fn share_snapshot_carries_roles_and_text() {
		let dom = omp_dom::Dom::new();
		let snapshot = share_snapshot(&dom);
		assert_eq!(snapshot["version"], SHARE_SNAPSHOT_VERSION);
		assert!(snapshot["blocks"].as_array().is_some());
	}

	/// Runs one console line and applies the posted host effect against a
	/// bare panel context (no application feeds).
	fn run_call(line: &str) -> (std::sync::Arc<omp_con::Ctx>, PanelEvent) {
		use std::sync::Arc;

		use crate::actions::HostMailbox;
		let ctx = Arc::new(HostMailbox::new().attach(omp_con::Ctx::builder()).build());
		ctx.run(line).expect("command runs");
		let mailbox = ctx.user::<HostMailbox>().expect("mailbox installed");
		let action = mailbox.drain().next().expect("one action posted");
		let HostAction::Call(call) = action else {
			panic!("expected a host call, got {action:?}");
		};
		let dom = omp_dom::Dom::new();
		let ui = omp_tui::UiContext::default();
		let services: Arc<dyn crate::overlays::Services> =
			Arc::new(crate::overlays::services::NoServices);
		let event = call.call(&PanelCx {
			dom:      &dom,
			con:      &ctx,
			ui:       &ui,
			viewport: omp_tui::Size { width: 80, height: 24 },
			services: &services,
		});
		(ctx, event)
	}

	#[test]
	fn extended_context_flips_its_convar_and_reports() {
		let (ctx, event) = run_call("extended-context on");
		assert_eq!(event, PanelEvent::Notice(Str::new_static("Extended context: on")));
		assert!(AI_EXTENDED_CONTEXT.get(&ctx));
		let (_, event) = run_call("extended-context");
		assert_eq!(event, PanelEvent::Notice(Str::new_static("Extended context: off")));
		let ctx = crate::actions::HostMailbox::new()
			.attach(omp_con::Ctx::builder())
			.build();
		assert!(ctx.run("extended-context sideways").is_err(), "bad words are usage errors");
	}

	#[test]
	fn advisor_command_controls_the_real_director_and_convar() {
		let (ctx, event) = run_call("advisor on");
		assert!(omp_ai::settings::AI_ADVISOR_ENABLED.get(&ctx));
		assert_eq!(
			event,
			PanelEvent::Command(HostCommand::Director {
				id:     Str::new_static("advisor"),
				engage: true,
				args:   Vec::new(),
			})
		);
		let (_, event) = run_call("advisor status");
		assert_eq!(event, PanelEvent::Notice(Str::new_static("Advisor: off")));
		let ctx = crate::actions::HostMailbox::new()
			.attach(omp_con::Ctx::builder())
			.build();
		assert!(ctx.run("advisor sideways").is_err(), "bad words are usage errors");
	}

	#[test]
	fn export_without_feeds_reports_the_missing_service() {
		let (_, event) = run_call("export notes.txt");
		assert_eq!(
			event,
			PanelEvent::Notice(Str::new_static(
				"Failed to export session: export is unavailable in this host"
			))
		);
	}

	#[test]
	fn security_review_recalls_the_brief_into_the_composer() {
		let (_, event) = run_call("security review src/auth");
		let PanelEvent::Recall(text) = event else {
			panic!("expected a composer recall, got {event:?}");
		};
		assert!(text.contains("`src/auth`"), "target substituted:\n{text}");
	}

	#[test]
	fn collaboration_commands_route_to_the_controller() {
		let (_, event) = run_call("join wss://relay.example/room");
		assert!(
			matches!(
				event,
				PanelEvent::Command(HostCommand::Collab(CollabOp::Join { ref link, name: None }))
					if link == "wss://relay.example/room"
			),
			"{event:?}",
		);
		let (_, event) = run_call("collab view wss://relay.example");
		assert!(matches!(
			event,
			PanelEvent::Command(HostCommand::Collab(CollabOp::Start {
				read_only: true,
				relay: Some(relay),
			})) if relay == "wss://relay.example"
		));
	}

	#[test]
	fn vision_sets_the_session_convar_and_reports_the_flow() {
		let (_, event) = run_call("vision off");
		assert!(
			matches!(&event, PanelEvent::Notice(text) if text == "Vision mode: off · images never sent"),
			"{event:?}"
		);
		let (_, event) = run_call("vision status");
		assert!(
			matches!(&event, PanelEvent::Notice(text) if text.starts_with("Vision mode: ")),
			"{event:?}"
		);
	}
}
