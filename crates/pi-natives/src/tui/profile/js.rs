//! napi surface of the terminal profile. Every function takes the
//! environment explicitly (`Bun.env` or a test's override object).
#![cfg_attr(test, allow(dead_code, reason = "reached only from JavaScript, through napi"))]

use std::collections::HashMap;

use napi::{
	Either,
	bindgen_prelude::{Error, Result},
};
use napi_derive::napi;

use super::{
	Env, Host, NotifyProtocol, Platform, Profile, multiplexer,
	multiplexer::Multiplexer,
	notify::{self, Notification, Rich},
	tmux,
};
use crate::tui::{js::EngineImageProtocol, types::ImageProtocol};

/// An environment object from JS; unset (`undefined`) values are dropped.
pub type JsEnv = HashMap<String, Option<String>>;

pub fn env_of(env: JsEnv) -> Env {
	Env::new(
		env.into_iter()
			.filter_map(|(key, value)| Some((key, value?)))
			.collect(),
	)
}

/// Process facts JS knows and the environment does not.
#[napi(object)]
pub struct TerminalHostFacts {
	/// Bun is running a test entrypoint (`isBunTestRuntime()`).
	pub test_runtime: bool,
	/// `process.stdout.isTTY`.
	pub stdout_tty:   bool,
	/// `process.platform`; defaults to the compile target.
	pub platform:     Option<String>,
}

/// The resolved terminal profile (`TERMINAL` in pi-tui).
#[napi(object)]
pub struct TerminalProfile {
	#[napi(ts_type = "\"kitty\" | \"ghostty\" | \"wezterm\" | \"iterm2\" | \"vscode\" | \
	                  \"alacritty\" | \"warp\" | \"orca\" | \"otty\" | \"rio\" | \"tern\" | \
	                  \"monstar\" | \"rex\" | \"base\" | \"trueColor\"")]
	pub id: String,
	/// Active image protocol (`PI_FORCE_IMAGE_PROTOCOL` when set); absent: none.
	#[napi(ts_type = "\"kitty\" | \"iterm2\" | \"sixel\"")]
	pub image_protocol: Option<EngineImageProtocol>,
	/// `PI_FORCE_IMAGE_PROTOCOL` pins the protocol (its `off` switch included).
	pub image_protocol_forced: bool,
	pub true_color: bool,
	/// OSC 8 hyperlinks enabled by default.
	pub hyperlinks: bool,
	#[napi(ts_type = "\"bell\" | \"osc99\" | \"osc9\"")]
	pub notify_protocol: String,
	/// DECCARA rectangular-SGR fills (off in the test runtime).
	pub deccara: bool,
	pub supports_screen_to_scrollback: bool,
	/// Renders the Kitty OSC 66 text-sizing protocol.
	pub supports_text_sizing: bool,
	/// Hangul Compatibility Jamo cell width (1 or 2); absent keeps the platform
	/// default.
	pub hangul_jamo_width: Option<u32>,
	/// Colon-form curly underline plus SGR 58/59 underline color.
	pub styled_underlines: bool,
	/// Kitty images display through Unicode placeholders.
	pub kitty_unicode_placeholders: bool,
	pub ssh: bool,
	/// The classified multiplexer, if any.
	#[napi(
		ts_type = "\"herdr\" | \"tmux\" | \"screen\" | \"zellij\" | \"cmux\" | \"wmux\" | \"orca\""
	)]
	pub multiplexer: Option<String>,
	/// The classified multiplexer owns the screen grid.
	pub inside_multiplexer: bool,
	/// Inside a tmux session: sequences for the outer terminal need the
	/// passthrough envelope.
	pub tmux: bool,
}

const fn js_image_protocol(protocol: ImageProtocol) -> EngineImageProtocol {
	match protocol {
		ImageProtocol::Kitty => EngineImageProtocol::Kitty,
		ImageProtocol::Iterm2 => EngineImageProtocol::Iterm2,
		ImageProtocol::Sixel => EngineImageProtocol::Sixel,
	}
}

/// Detect the terminal hosting the process and resolve its capabilities.
/// Inside tmux this may query the tmux client (once per process).
#[napi]
pub fn detect_terminal_profile(
	#[napi(ts_arg_type = "Record<string, string | undefined>")] env: JsEnv,
	host: TerminalHostFacts,
) -> TerminalProfile {
	let host = Host {
		platform:     Platform::from_node(host.platform.as_deref()),
		test_runtime: host.test_runtime,
		stdout_tty:   host.stdout_tty,
	};
	let profile = Profile::detect(&env_of(env), host);
	TerminalProfile {
		id: profile.id.as_str().to_owned(),
		image_protocol: profile.image_protocol.map(js_image_protocol),
		image_protocol_forced: profile.image_protocol_forced,
		true_color: profile.info.true_color,
		hyperlinks: profile.hyperlinks,
		notify_protocol: profile.info.notify.as_str().to_owned(),
		deccara: profile.deccara,
		supports_screen_to_scrollback: profile.info.screen_to_scrollback,
		supports_text_sizing: profile.info.text_sizing,
		hangul_jamo_width: profile.info.hangul_jamo_width.map(u32::from),
		styled_underlines: profile.styled_underlines,
		kitty_unicode_placeholders: profile.kitty_unicode_placeholders,
		ssh: profile.ssh,
		multiplexer: profile.multiplexer.map(|id| id.as_str().to_owned()),
		inside_multiplexer: profile.inside_multiplexer,
		tmux: profile.tmux,
	}
}

/// Whether the detected terminal renders 24-bit color (Windows Terminal
/// always does).
#[napi]
pub fn detect_true_color(
	#[napi(ts_arg_type = "Record<string, string | undefined>")] env: JsEnv,
	test_runtime: bool,
	platform: Option<String>,
) -> bool {
	let env = env_of(env);
	env.set("WT_SESSION") || {
		let id = super::detect_terminal_id(&env, test_runtime);
		super::terminal_info(id, Platform::from_node(platform.as_deref()), &env).true_color
	}
}

/// Every environment variable multiplexer classification reads, including
/// the TERM fallback.
#[napi]
pub fn terminal_multiplexer_env_keys() -> Vec<String> {
	multiplexer::env_keys().map(str::to_owned).collect()
}

/// The multiplexer hosting the process, or `null` for a direct terminal.
#[napi(ts_return_type = "\"herdr\" | \"tmux\" | \"screen\" | \"zellij\" | \"cmux\" | \"wmux\" | \
                         \"orca\" | null")]
pub fn classify_terminal_multiplexer(
	#[napi(ts_arg_type = "Record<string, string | undefined>")] env: JsEnv,
) -> Option<String> {
	multiplexer::classify(&env_of(env)).map(|module| module.id.as_str().to_owned())
}

/// Whether an explicit session marker of `multiplexer` is present (TERM is
/// not consulted).
#[napi]
pub fn has_terminal_multiplexer_session(
	#[napi(ts_arg_type = "\"herdr\" | \"tmux\" | \"screen\" | \"zellij\" | \"cmux\" | \"wmux\" | \
	                      \"orca\"")]
	multiplexer: String,
	#[napi(ts_arg_type = "Record<string, string | undefined>")] env: JsEnv,
) -> Result<bool> {
	let id = Multiplexer::parse(&multiplexer)
		.ok_or_else(|| Error::from_reason(format!("unknown terminal multiplexer: {multiplexer}")))?;
	Ok(id.is_inside(&env_of(env)))
}

/// True when the classified multiplexer owns the screen grid.
#[napi]
pub fn is_inside_terminal_multiplexer(
	#[napi(ts_arg_type = "Record<string, string | undefined>")] env: JsEnv,
) -> bool {
	multiplexer::is_inside_any(&env_of(env))
}

/// Whether OSC 11 background replies are trusted on this platform.
#[napi]
pub fn is_terminal_background_query_trusted(
	#[napi(ts_arg_type = "Record<string, string | undefined>")] env: JsEnv,
	platform: Option<String>,
) -> bool {
	multiplexer::background_query_trusted(&env_of(env), Platform::from_node(platform.as_deref()))
}

/// Whether the process runs in an SSH session.
#[napi]
pub fn is_ssh_session(
	#[napi(ts_arg_type = "Record<string, string | undefined>")] env: JsEnv,
) -> bool {
	super::is_ssh(&env_of(env))
}

/// Whether the environment names a Tern Surface Protocol terminal and the
/// `hello` probe will run.
#[napi]
pub fn is_tsp_expected(
	#[napi(ts_arg_type = "Record<string, string | undefined>")] env: JsEnv,
	headless: bool,
	test_runtime: bool,
) -> bool {
	super::tsp_expected(&env_of(env), headless, test_runtime)
}

/// Wrap a control sequence in tmux's DCS passthrough envelope.
#[napi]
pub fn wrap_tmux_passthrough(payload: String) -> String {
	tmux::wrap_passthrough(&payload)
}

/// Delivery suppressed by `PI_NOTIFICATIONS=off|0|false`.
#[napi]
pub fn is_notification_suppressed(
	#[napi(ts_arg_type = "Record<string, string | undefined>")] env: JsEnv,
) -> bool {
	notify::suppressed(&env_of(env))
}

/// Structured terminal notification. Rich fields are honored only by OSC 99
/// (Kitty) once support is confirmed; other protocols and the unconfirmed
/// Kitty path collapse to a single `title: body` line.
#[napi(object)]
pub struct TerminalNotification {
	pub title:      Option<String>,
	pub body:       Option<String>,
	pub id:         Option<String>,
	#[napi(js_name = "type", ts_type = "string | string[]")]
	pub kind:       Option<Either<String, Vec<String>>>,
	#[napi(ts_type = "\"low\" | \"normal\" | \"critical\"")]
	pub urgency:    Option<String>,
	pub icon_name:  Option<String>,
	#[napi(ts_type = "\"silent\" | \"system\" | \"info\" | \"warning\" | \"error\" | \"question\"")]
	pub sound:      Option<String>,
	#[napi(ts_type = "\"focus\" | \"report\" | \"focus-report\" | \"none\"")]
	pub actions:    Option<String>,
	pub expires_ms: Option<f64>,
}

/// Where a notification goes.
#[napi(object)]
pub struct NotificationTarget {
	#[napi(ts_type = "\"bell\" | \"osc99\" | \"osc9\"")]
	pub protocol:        String,
	/// The terminal confirmed OSC 99 support (rich notifications).
	pub osc99_confirmed: bool,
	/// `isTerminalHeadless()`: delivery is suppressed.
	pub headless:        bool,
	#[napi(ts_type = "Record<string, string | undefined>")]
	pub env:             JsEnv,
	/// `process.platform`; defaults to the compile target.
	pub platform:        Option<String>,
}

/// Deliver a notification: multiplexer notifiers first (a pane or surface CLI
/// is spawned detached, or the sequence is rewritten), then the terminal's
/// own sequence, plus a Linux D-Bus toast beside a BEL. Returns the sequence
/// the host must write through the active terminal, if any.
#[napi]
pub fn send_terminal_notification(
	message: Either<String, TerminalNotification>,
	target: NotificationTarget,
) -> Result<Option<String>> {
	let protocol = NotifyProtocol::parse(&target.protocol)
		.ok_or_else(|| Error::from_reason(format!("unknown notify protocol: {}", target.protocol)))?;
	let message = match message {
		Either::A(text) => Notification::Text(text),
		Either::B(n) => Notification::Rich(Rich {
			title:      n.title,
			body:       n.body,
			id:         n.id,
			types:      match n.kind {
				None => Vec::new(),
				Some(Either::A(kind)) => vec![kind],
				Some(Either::B(kinds)) => kinds,
			},
			urgency:    n.urgency,
			icon_name:  n.icon_name,
			sound:      n.sound,
			actions:    n.actions,
			#[allow(clippy::cast_possible_truncation, reason = "Math.trunc of a finite JS number")]
			expires_ms: n
				.expires_ms
				.filter(|ms| ms.is_finite())
				.map(|ms| ms.trunc() as i64),
		}),
	};
	Ok(notify::deliver(
		&message,
		protocol,
		target.osc99_confirmed,
		target.headless,
		&env_of(target.env),
		Platform::from_node(target.platform.as_deref()),
		&mut notify::System,
	))
}
