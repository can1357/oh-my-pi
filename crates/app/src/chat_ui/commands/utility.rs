//! Structural utility, capability-inspection, and device-mode routes.

use std::{collections::BTreeSet, fmt::Write as _};

use futures::StreamExt as _;
use miette::IntoDiagnostic as _;
use omp_core::{Str, sf};
use omp_tool::{CallOutcome, ErasedEv, ErasedOutcome, Presentation, Registry};
use omp_tools::computer::{Action, Fault, Params, Payload};

use super::{ChangelogRequest, ComputerRequest, UtilityRequest, VisionRequest, command};

command!(changelog, 130, "changelog", icon: RolledNewspaperFontAwesome, [], "Show recent version history", [], true, typed("[recent|full]", ["recent", "full"], parse_changelog) => |host, request| host.utility(UtilityRequest::Changelog(request)));
command!(tools, 131, "tools", icon: ToolExtension, [], "List active and disabled tools", [Execution], false, none => |host| host.utility(UtilityRequest::Tools));
command!(computer, 580, "computer", icon: Desktop, [], "Control desktop automation for this session", [Execution, Owner], false, typed("[on|off|auto|status|diagnose]", ["on", "off", "auto", "status", "diagnose"], parse_computer) => |host, request| host.utility(UtilityRequest::Computer(request)));
command!(vision, 590, "vision", icon: Eye, [], "Control image-tool delegation", [Execution], false, typed("[on|off|auto|status]", ["on", "off", "auto", "status"], parse_vision) => |host, request| host.utility(UtilityRequest::Vision(request)));

fn parse_changelog(raw: &str) -> miette::Result<ChangelogRequest> {
	match raw.trim() {
		"" | "recent" => Ok(ChangelogRequest::Recent),
		"full" => Ok(ChangelogRequest::Full),
		_ => Err(miette::miette!("usage: /changelog [recent|full]")),
	}
}

fn parse_computer(raw: &str) -> miette::Result<ComputerRequest> {
	match raw.trim() {
		"" | "status" => Ok(ComputerRequest::Status),
		"on" => Ok(ComputerRequest::On),
		"off" => Ok(ComputerRequest::Off),
		"auto" => Ok(ComputerRequest::Auto),
		"diagnose" => Ok(ComputerRequest::Diagnose),
		_ => Err(miette::miette!("usage: /computer [on|off|auto|status|diagnose]")),
	}
}

fn parse_vision(raw: &str) -> miette::Result<VisionRequest> {
	match raw.trim() {
		"" | "status" => Ok(VisionRequest::Status),
		"on" => Ok(VisionRequest::On),
		"off" => Ok(VisionRequest::Off),
		"auto" => Ok(VisionRequest::Auto),
		_ => Err(miette::miette!("usage: /vision [on|off|auto|status]")),
	}
}
const CHANGELOG: &str = include_str!(concat!(env!("OUT_DIR"), "/changelog.md"));

pub(crate) fn render_changelog(request: ChangelogRequest) -> Str {
	let limit = match request {
		ChangelogRequest::Recent => 3,
		ChangelogRequest::Full => usize::MAX,
	};
	let mut rendered = String::new();
	for (index, entry) in CHANGELOG.split("\n## ").take(limit).enumerate() {
		let entry = entry.trim();
		if entry.is_empty() {
			continue;
		}
		if !rendered.is_empty() {
			rendered.push_str("\n\n");
		}
		if index > 0 {
			rendered.push_str("## ");
		}
		rendered.push_str(entry);
	}
	if rendered.is_empty() {
		sf!("No changelog entries found.")
	} else {
		Str::from(rendered)
	}
}

pub(crate) fn render_tools(
	registry: &Registry,
	live_tools: &[omp_chat_ui::LiveToolView],
	enabled_tools: &[Str],
	settings: &omp_envd::tool_settings::ToolSettings,
	declarations: &[omp_driver::discovery::manifest::DiscoveredCapability],
) -> Str {
	let mut active = BTreeSet::new();
	active.extend(enabled_tools.iter().map(Str::as_str));
	active.extend(live_tools.iter().map(|tool| tool.name.as_str()));

	let mut all = BTreeSet::new();
	all.extend(
		registry
			.roster()
			.filter(|(_, presentation)| *presentation != Presentation::Hidden)
			.map(|(name, _)| name.as_str()),
	);
	all.extend(active.iter().copied());
	all.extend(settings.enabled.keys().map(Str::as_str));
	all.extend(declarations.iter().filter_map(|declaration| {
		if let omp_driver::discovery::manifest::CapabilityPayload::Tools(tool) = &declaration.payload
		{
			Some(tool.name.as_str())
		} else {
			None
		}
	}));
	if all.is_empty() {
		return sf!("No tools are available.");
	}

	let mut rendered = String::new();
	for name in all {
		let marker = if active.contains(name) { '*' } else { '-' };
		let _ = writeln!(rendered, "{marker} {name}");
	}
	rendered.pop();
	Str::from(rendered)
}

fn computer_status(
	registry: &Registry,
	settings: &omp_envd::tool_settings::ToolSettings,
	model: &str,
) -> Str {
	let mounted = registry
		.devices()
		.any(|device| device.name.as_str() == "computer");
	let configured = settings.enabled("computer");
	sf!(
		"Computer use: {} · tool: {} · exposure: {} · override: unavailable · model: {}",
		if configured { "enabled" } else { "disabled" },
		if mounted { "active" } else { "inactive" },
		if mounted {
			"mounted device"
		} else {
			"not exposed"
		},
		model
	)
}
pub(crate) async fn handle_computer(
	request: ComputerRequest,
	registry: &Registry,
	settings: &omp_envd::tool_settings::ToolSettings,
	model: &str,
) -> miette::Result<Str> {
	match request {
		ComputerRequest::Status => Ok(computer_status(registry, settings, model)),
		ComputerRequest::Diagnose => diagnose_computer(registry).await,
		ComputerRequest::On | ComputerRequest::Off | ComputerRequest::Auto => Err(miette::miette!(
			"session-scoped computer exposure is unavailable: Registry has no per-session device \
			 slate, and apply_availability only irreversibly unmounts devices"
		)),
	}
}

async fn diagnose_computer(registry: &Registry) -> miette::Result<Str> {
	let params = Params {
		action:     Action::Capabilities,
		read_only:  true,
		window:     None,
		reference:  None,
		value:      None,
		x:          None,
		y:          None,
		dx:         None,
		dy:         None,
		points:     None,
		max_width:  None,
		max_height: None,
		max_depth:  None,
		limit:      None,
	};
	let raw = serde_json::to_string(&params).into_diagnostic()?;
	let (feed, incoming) = omp_tool::IncomingParams::owned_channel(sf!("slash-computer-diagnose"));
	feed.args_committed(Str::from(raw)).into_diagnostic()?;
	drop(feed);
	let mut stream = registry.invoke("computer", incoming).into_diagnostic()?;
	while let Some(event) = stream.next().await {
		match event.into_diagnostic()? {
			ErasedEv::Update(_) => {},
			ErasedEv::Done(ErasedOutcome::Detached(_)) => {
				return Err(miette::miette!("computer diagnostics detached unexpectedly"));
			},
			ErasedEv::Done(ErasedOutcome::Done { verdict, .. }) => {
				let outcome =
					serde_json::from_slice::<CallOutcome<Payload, Fault>>(&verdict).into_diagnostic()?;
				return match outcome {
					CallOutcome::Ok(payload) => Ok(render_capabilities(&payload)),
					CallOutcome::Faulted(fault) => Err(miette::miette!("{fault}")),
					CallOutcome::ArgsRejected(_) => {
						Err(miette::miette!("computer diagnostics arguments were rejected"))
					},
					CallOutcome::Aborted { .. } => {
						Err(miette::miette!("computer diagnostics were aborted"))
					},
				};
			},
		}
	}
	Err(miette::miette!("computer diagnostics ended without a verdict"))
}

fn render_capabilities(payload: &Payload) -> Str {
	let result = &payload.result;
	let backend = result
		.get("backend")
		.and_then(serde_json::Value::as_str)
		.unwrap_or("unavailable");
	let display = result
		.get("display_server")
		.and_then(serde_json::Value::as_str);
	let capture = capability(result, "capture", "capture_permission");
	let input = capability(result, "input", "input_permission");
	let ax = capability(result, "ax", "ax_permission");
	let background = result
		.get("background_window_input")
		.and_then(serde_json::Value::as_bool)
		.unwrap_or(false);
	let delivery = result
		.get("delivery_modes")
		.and_then(serde_json::Value::as_array)
		.map(|modes| {
			modes
				.iter()
				.filter_map(serde_json::Value::as_str)
				.collect::<Vec<_>>()
				.join(",")
		})
		.filter(|modes| !modes.is_empty())
		.unwrap_or_else(|| "none".to_owned());
	let displays = result
		.get("display_count")
		.and_then(serde_json::Value::as_u64)
		.unwrap_or(0);
	sf!(
		"Computer permissions · backend={}{} · capture={} · input={} · ax={} · \
		 backgroundWindowInput={} · deliveryModes={} · displays={}",
		backend,
		display.map_or_else(String::new, |display| format!("/{display}")),
		capture,
		input,
		ax,
		background,
		delivery,
		displays
	)
}

fn capability(result: &serde_json::Value, available: &str, permission: &str) -> String {
	let available = result
		.get(available)
		.and_then(serde_json::Value::as_bool)
		.unwrap_or(false);
	let permission = result
		.get(permission)
		.and_then(serde_json::Value::as_str)
		.unwrap_or("unavailable");
	format!("{available} ({permission})")
}

#[cfg(test)]
mod tests {
	use bytes::Bytes;
	use omp_tool::{Claims, Constraint, Effects, Precedence, Rev, ToolSpec};

	use super::*;

	fn core_claims() -> Claims {
		Claims { precedence: Precedence::CORE, claimant: sf!("omp/core"), replaces: None }
	}

	fn device_claims() -> Claims {
		Claims { precedence: Precedence::ENHANCEMENT, claimant: sf!("omp/core"), replaces: None }
	}

	fn stub_spec(name: &str) -> ToolSpec {
		ToolSpec {
			name:            Str::new(name),
			rev:             Rev { family: sf!("test"), n: 1 },
			description:     sf!("test tool"),
			schema:          Bytes::from_static(br#"{"type":"object"}"#),
			constraint:      Constraint::None,
			effects:         Effects::empty(),
			projection_code: [0; 32],
		}
	}

	fn roster_registry() -> Registry {
		let mut registry = Registry::new();
		registry
			.register_worker(stub_spec("read"), Presentation::Slot, core_claims())
			.expect("read");
		registry
			.register_worker(stub_spec("computer"), Presentation::Device, device_claims())
			.expect("computer");
		registry
			.register_worker(stub_spec("secret"), Presentation::Hidden, core_claims())
			.expect("secret");
		registry
	}

	#[test]
	fn recent_changelog_is_bounded_to_three_real_releases() {
		let rendered = render_changelog(ChangelogRequest::Recent);
		assert!(!rendered.contains("No changelog entries"));
		assert_eq!(
			rendered
				.lines()
				.filter(|line| line.starts_with("## "))
				.count(),
			3
		);
	}

	#[test]
	fn full_changelog_contains_every_embedded_release() {
		let rendered = render_changelog(ChangelogRequest::Full);
		assert_eq!(
			rendered
				.lines()
				.filter(|line| line.starts_with("## "))
				.count(),
			CHANGELOG
				.lines()
				.filter(|line| line.starts_with("## "))
				.count()
		);
	}
	#[test]
	fn tools_distinguish_active_and_disabled_builtins() {
		let registry = roster_registry();
		let rendered = render_tools(
			&registry,
			&[],
			&[sf!("read")],
			&omp_envd::tool_settings::ToolSettings::default(),
			&[],
		);
		assert!(rendered.lines().any(|line| line == "* read"));
		assert!(rendered.lines().any(|line| line == "- computer"));
		assert!(
			registry
				.roster()
				.any(|(name, presentation)| name.as_str() == "secret"
					&& presentation == Presentation::Hidden)
		);
		assert!(
			!rendered
				.lines()
				.any(|line| line == "* secret" || line == "- secret")
		);
	}

	#[test]
	fn capability_report_preserves_platform_permissions() {
		let payload = Payload {
			action:    Action::Capabilities,
			result:    serde_json::json!({
				"backend": "quartz",
				"display_server": "Quartz WindowServer",
				"capture": true,
				"capture_permission": "granted",
				"input": false,
				"input_permission": "denied",
				"ax": false,
				"ax_permission": "denied",
				"background_window_input": false,
				"delivery_modes": ["foreground"],
				"display_count": 2,
			}),
			artifacts: Vec::new(),
		};
		let rendered = render_capabilities(&payload);
		assert!(rendered.contains("backend=quartz/Quartz WindowServer"));
		assert!(rendered.contains("capture=true (granted)"));
		assert!(rendered.contains("input=false (denied)"));
		assert!(rendered.contains("ax=false (denied)"));
		assert!(rendered.contains("displays=2"));
	}
}
