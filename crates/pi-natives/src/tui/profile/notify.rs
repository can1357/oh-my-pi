//! Terminal notifications: the in-band forms (BEL, OSC 9, OSC 99 with its
//! rich Kitty metadata), when delivery is suppressed, the multiplexer
//! notifiers that address a pane or surface through its CLI or rewrite the
//! terminal's sequence, and the Linux D-Bus toast that accompanies a BEL.

use std::{
	collections::hash_map::RandomState,
	hash::{BuildHasher, Hasher},
	path::{Path, PathBuf},
	process::{Command, Stdio},
	sync::{
		LazyLock, OnceLock,
		atomic::{AtomicU32, Ordering},
	},
	thread,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};

use super::{
	Env, NotifyProtocol, Platform,
	multiplexer::{self, Multiplexer},
	tmux,
};

/// Title for out-of-band notifications that carry none of their own (cmux,
/// Herdr, D-Bus), and the OSC 99 application name.
const APP_NAME: &str = "omp";
const OSC99_MAX_PAYLOAD_BYTES: usize = 2048;

/// A notification: a bare message line, or structured fields whose rich parts
/// are honored only by OSC 99 (Kitty) once support is confirmed; other
/// protocols and the unconfirmed Kitty path collapse it to one `title: body`
/// line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notification {
	Text(String),
	Rich(Rich),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Rich {
	pub title:      Option<String>,
	pub body:       Option<String>,
	pub id:         Option<String>,
	pub types:      Vec<String>,
	/// `low` | `normal` | `critical`.
	pub urgency:    Option<String>,
	pub icon_name:  Option<String>,
	/// `silent` | `system` | `info` | `warning` | `error` | `question`.
	pub sound:      Option<String>,
	/// `focus` | `report` | `focus-report` | `none`.
	pub actions:    Option<String>,
	pub expires_ms: Option<i64>,
}

/// Delivery suppressed by `PI_NOTIFICATIONS=off|0|false`.
pub fn suppressed(env: &Env) -> bool {
	matches!(env.get("PI_NOTIFICATIONS"), Some("off" | "0" | "false"))
}

/// The terminal's in-band form of `message` under `protocol`.
pub fn format(message: &Notification, protocol: NotifyProtocol, osc99_confirmed: bool) -> String {
	let prefix = match protocol {
		NotifyProtocol::Bell => return "\x07".to_owned(),
		NotifyProtocol::Osc99 => "\x1b]99;;",
		NotifyProtocol::Osc9 => "\x1b]9;",
	};
	let line = match message {
		Notification::Text(text) => text.as_str(),
		// Structured notifications use OSC 99's rich metadata only once the
		// terminal confirms support; otherwise collapse to a single message
		// line (basic OSC 99 / OSC 9 still work).
		Notification::Rich(rich) if protocol == NotifyProtocol::Osc99 && osc99_confirmed => {
			return format_osc99(rich);
		},
		Notification::Rich(rich) => &notification_line(rich),
	};
	format!("{prefix}{line}\x1b\\")
}

/// Collapse a structured notification to a single line for non-OSC-99 sinks.
fn notification_line(rich: &Rich) -> String {
	match (rich.title.as_deref(), rich.body.as_deref()) {
		(Some(title), Some(body)) if !title.is_empty() && !body.is_empty() => {
			format!("{title}: {body}")
		},
		(Some(title), _) => title.to_owned(),
		(None, body) => body.unwrap_or_default().to_owned(),
	}
}

/// Kitty matches notification ids across its whole process, not per window,
/// so a bare counter would collide between omp sessions sharing one kitty
/// instance and turn a new notification into a silent replacement of another
/// session's.
static OSC99_ID_PREFIX: LazyLock<String> = LazyLock::new(|| {
	let mut hasher = RandomState::new().build_hasher();
	hasher.write_u32(std::process::id());
	format!("omp-{:08x}", hasher.finish() & 0xffff_ffff)
});
static NEXT_OSC99_ID: AtomicU32 = AtomicU32::new(1);

fn osc99_id(id: Option<&str>) -> String {
	let safe: String = id
		.unwrap_or_default()
		.chars()
		.filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '+' | '-' | '.'))
		.collect();
	if safe.is_empty() || safe == "0" {
		format!("{}-{}", *OSC99_ID_PREFIX, NEXT_OSC99_ID.fetch_add(1, Ordering::Relaxed))
	} else {
		safe
	}
}

fn base64_utf8(value: &str) -> String {
	STANDARD.encode(value)
}

/// Split `payload` into runs of at most [`OSC99_MAX_PAYLOAD_BYTES`] UTF-8
/// bytes on character boundaries (an oversized character stands alone).
fn chunk_utf8(payload: &str) -> Vec<&str> {
	let mut chunks = Vec::new();
	let mut start = 0;
	for (index, ch) in payload.char_indices() {
		if index > start && index + ch.len_utf8() - start > OSC99_MAX_PAYLOAD_BYTES {
			chunks.push(&payload[start..index]);
			start = index;
		}
	}
	chunks.push(&payload[start..]);
	chunks
}

/// C0/C1 control characters are unsafe inside an OSC payload (must base64).
fn osc99_unsafe(payload: &str) -> bool {
	payload
		.chars()
		.any(|ch| matches!(ch, '\x00'..='\x1f' | '\x7f'..='\u{9f}'))
}

fn osc99_chunk(out: &mut String, meta: &[String], payload: &str) {
	out.push_str("\x1b]99;");
	out.push_str(&meta.join(":"));
	if osc99_unsafe(payload) {
		out.push_str(if meta.is_empty() { "e=1;" } else { ":e=1;" });
		out.push_str(&base64_utf8(payload));
	} else {
		out.push(';');
		out.push_str(payload);
	}
	out.push_str("\x1b\\");
}

fn osc99_payload(out: &mut String, meta: &[String], payload: &str, hold_until_later_payload: bool) {
	let chunks = chunk_utf8(payload);
	let last = chunks.len() - 1;
	for (index, chunk) in chunks.into_iter().enumerate() {
		let mut chunk_meta = meta.to_vec();
		if hold_until_later_payload || index < last {
			chunk_meta.push("d=0".to_owned());
		}
		osc99_chunk(out, &chunk_meta, chunk);
	}
}

/// Format a structured notification as OSC 99 title/body payloads. Title and
/// body chunks share one id. Every non-final chunk carries `d=0`; the final
/// title or body chunk displays the notification. Metadata values that
/// require it (application name, type, icon name, sound) are base64-encoded.
fn format_osc99(rich: &Rich) -> String {
	let id = osc99_id(rich.id.as_deref());
	let mut meta = vec![format!("i={id}"), format!("f={}", base64_utf8(APP_NAME))];
	let actions = match rich.actions.as_deref() {
		Some("focus") => Some("focus"),
		Some("report") => Some("report"),
		Some("focus-report") => Some("focus,report"),
		Some("none") => Some("-focus"),
		_ => None,
	};
	if let Some(actions) = actions {
		meta.push(format!("a={actions}"));
	}
	let urgency = match rich.urgency.as_deref() {
		Some("low") => Some('0'),
		Some("normal") => Some('1'),
		Some("critical") => Some('2'),
		_ => None,
	};
	if let Some(urgency) = urgency {
		meta.push(format!("u={urgency}"));
	}
	for kind in &rich.types {
		meta.push(format!("t={}", base64_utf8(kind)));
	}
	if let Some(icon) = rich.icon_name.as_deref().filter(|icon| !icon.is_empty()) {
		meta.push(format!("n={}", base64_utf8(icon)));
	}
	if let Some(sound) = rich.sound.as_deref().filter(|sound| !sound.is_empty()) {
		meta.push(format!("s={}", base64_utf8(sound)));
	}
	if let Some(expires) = rich.expires_ms {
		meta.push(format!("w={}", expires.max(-1)));
	}

	let title = rich
		.title
		.as_deref()
		.or(rich.body.as_deref())
		.unwrap_or_default();
	let body = rich
		.title
		.as_deref()
		.filter(|title| !title.is_empty())
		.and(rich.body.as_deref());

	let mut out = String::new();
	match body {
		Some(body) if !body.is_empty() => {
			osc99_payload(&mut out, &meta, title, true);
			osc99_payload(&mut out, &[format!("i={id}"), "p=body".to_owned()], body, false);
		},
		_ => osc99_payload(&mut out, &meta, title, false),
	}
	out
}

/// Process side effects of delivery, injectable for tests.
pub trait Effects {
	/// Start a notifier CLI without waiting for or pinning it. False when the
	/// binary cannot be spawned, which leaves delivery to the next notifier
	/// and then the terminal fallback.
	fn spawn(&mut self, argv: &[String]) -> bool;
	/// The resolved D-Bus notifier, if any is installed.
	fn desktop_notifier(&mut self) -> Option<DesktopNotifier>;
	fn file_exists(&mut self, path: &Path) -> bool;
}

/// The real process: detached children, `PATH` lookups, the filesystem.
#[cfg_attr(test, allow(dead_code, reason = "reached only from JavaScript, through napi"))]
pub struct System;

impl Effects for System {
	fn spawn(&mut self, argv: &[String]) -> bool {
		let Some((program, args)) = argv.split_first() else {
			return false;
		};
		let Ok(mut child) = Command::new(program)
			.args(args)
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.spawn()
		else {
			return false;
		};
		// Reap off-thread: the notifier must never delay the renderer or pin
		// process exit (a detached thread does not keep the process alive).
		thread::spawn(move || {
			let _ = child.wait();
		});
		true
	}

	fn desktop_notifier(&mut self) -> Option<DesktopNotifier> {
		static NOTIFIER: OnceLock<Option<DesktopNotifier>> = OnceLock::new();
		NOTIFIER
			.get_or_init(|| resolve_desktop_notifier(|name| tmux::which(name, &Env::default())))
			.clone()
	}

	fn file_exists(&mut self, path: &Path) -> bool {
		path.exists()
	}
}

/// Deliver `message`, returning the sequence the host must write through the
/// active terminal, if any. Suppressed delivery (`PI_NOTIFICATIONS`, a
/// headless terminal) writes and spawns nothing.
///
/// Multiplexers that swallow or rewrite the terminal's notification get it
/// first, innermost target first; the terminal sequence is the fallback.
pub fn deliver(
	message: &Notification,
	protocol: NotifyProtocol,
	osc99_confirmed: bool,
	headless: bool,
	env: &Env,
	platform: Platform,
	effects: &mut dyn Effects,
) -> Option<String> {
	if suppressed(env) || headless {
		return None;
	}
	let formatted = format(message, protocol, osc99_confirmed);
	let sequence = (protocol != NotifyProtocol::Bell).then_some(formatted.as_str());
	for (multiplexer, tier) in multiplexer::notifiers(env) {
		debug_assert_eq!(multiplexer.module().notifier, Some(tier));
		match notify_multiplexer(multiplexer, message, env, sequence, effects) {
			Routed::Spawned => return None,
			Routed::Write(write) => return Some(write),
			Routed::Declined => {},
		}
	}
	// VTE-family terminals (Ptyxis, GNOME Terminal, Tilix, …) plus Alacritty
	// and bare xterm-on-Wayland have no in-band escape that surfaces an
	// arbitrary desktop toast (#3685). When the chosen protocol is BEL on a
	// Linux session bus, also fan the notification out via libnotify so users
	// see the toast and the BEL still fires for tmux `monitor-bell` / X11
	// urgency hints / audible bell.
	if protocol == NotifyProtocol::Bell
		&& should_deliver_desktop(env, platform, effects)
		&& let Some(notifier) = effects.desktop_notifier()
	{
		effects.spawn(&desktop_command(&notifier, message));
	}
	Some(formatted)
}

enum Routed {
	/// A CLI took the notification; nothing is written.
	Spawned,
	/// Write this instead of the terminal's own sequence.
	Write(String),
	/// Leave it to the next notifier and then the terminal fallback.
	Declined,
}

/// Title and body for an out-of-band multiplexer notification (cmux, Herdr).
fn title_and_body(message: &Notification) -> (String, String) {
	match message {
		Notification::Text(text) => (APP_NAME.to_owned(), text.clone()),
		Notification::Rich(rich) => {
			let title = rich
				.title
				.as_deref()
				.map(str::trim)
				.filter(|title| !title.is_empty());
			(title.unwrap_or(APP_NAME).to_owned(), rich.body.clone().unwrap_or_default())
		},
	}
}

fn notify_multiplexer(
	multiplexer: Multiplexer,
	message: &Notification,
	env: &Env,
	sequence: Option<&str>,
	effects: &mut dyn Effects,
) -> Routed {
	let spawned = |effects: &mut dyn Effects, argv: Vec<String>| {
		if effects.spawn(&argv) {
			Routed::Spawned
		} else {
			Routed::Declined
		}
	};
	match multiplexer {
		// The exact pane ID addresses the CLI call; without a valid one, or
		// without the binary, delivery falls through.
		Multiplexer::Herdr => {
			// The CLI reads the pane from the inherited `HERDR_PANE_ID`.
			if !env
				.get("HERDR_PANE_ID")
				.map(str::trim)
				.is_some_and(valid_herdr_pane)
			{
				return Routed::Declined;
			}
			let (title, body) = title_and_body(message);
			// `herdr notification show` takes the title as its first positional
			// and reads exactly these three values there as a help request; it
			// has no `--` terminator. Any other text, including one starting
			// with `-`, is a title.
			let title = if matches!(title.as_str(), "help" | "--help" | "-h") {
				APP_NAME.to_owned()
			} else {
				title
			};
			// A question waiting on the user and a turn that stopped with an
			// error both need the human and ring `request`, a settled turn rings
			// `done`, anything else stays silent.
			let kinds: &[String] = match message {
				Notification::Text(_) => &[],
				Notification::Rich(rich) => &rich.types,
			};
			let has = |kind: &str| kinds.iter().any(|k| k == kind);
			let sound = if has("ask") || has("error") {
				"request"
			} else if has("completion") {
				"done"
			} else {
				"none"
			};
			let argv = [
				"herdr",
				"notification",
				"show",
				title.as_str(),
				"--body",
				body.as_str(),
				"--sound",
				sound,
			];
			spawned(effects, argv.map(str::to_owned).to_vec())
		},
		// Workspace/socket state alone is not enough: only the injected surface
		// UUID identifies the pane that should receive the notification.
		Multiplexer::Cmux => {
			let Some(surface) = env
				.get("CMUX_SURFACE_ID")
				.map(str::trim)
				.filter(|id| is_uuid(id))
			else {
				return Routed::Declined;
			};
			let (title, body) = title_and_body(message);
			let argv = [
				"cmux",
				"notify",
				"--surface",
				surface,
				"--title",
				title.as_str(),
				"--body",
				body.as_str(),
			];
			spawned(effects, argv.map(str::to_owned).to_vec())
		},
		// tmux swallows bare OSCs; passthrough preserves the toast and BEL
		// flags the pane. Bell notifications already provide that signal. One
		// write keeps a concurrent renderer from interleaving between the two.
		Multiplexer::Tmux => sequence.map_or(Routed::Declined, |sequence| {
			Routed::Write(format!("{}\x07", tmux::wrap_passthrough(sequence)))
		}),
		// Zellij drops OSCs and has no DCS passthrough; a bare BEL raises its
		// bell flag. Bell notifications already provide that signal.
		Multiplexer::Zellij => {
			sequence.map_or(Routed::Declined, |sequence| Routed::Write(format!("{sequence}\x07")))
		},
		Multiplexer::Screen | Multiplexer::Wmux | Multiplexer::Orca => Routed::Declined,
	}
}

/// `^[0-9A-Za-z:_-]{1,64}$`.
fn valid_herdr_pane(pane: &str) -> bool {
	(1..=64).contains(&pane.len())
		&& pane
			.bytes()
			.all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'))
}

/// `^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$` (case-insensitive).
fn is_uuid(id: &str) -> bool {
	let groups: Vec<_> = id.split('-').collect();
	groups.len() == 5
		&& groups
			.iter()
			.zip([8, 4, 4, 4, 12])
			.all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()))
}

// Linux desktop notification delivery via D-Bus.
//
// Several terminal families — most notably the VTE-based stack (Ptyxis, GNOME
// Terminal, Tilix, Terminator) but also Alacritty and bare xterm — notify with
// a raw BEL, which never surfaces an arbitrary-text toast on those hosts (see
// #3685): Ptyxis hooks BEL to a CSS visual-bell flash, GNOME Terminal rings
// the audible bell. None of OSC 9 (ConEmu progress in VTE), OSC 99
// (unimplemented), or OSC 777 (only `notify;Command completed` → unused
// shell-postexec termprop in current VTE) produce a desktop notification.
//
// The freedesktop `org.freedesktop.Notifications` D-Bus service is the only
// path that consistently delivers toasts on those terminals across Wayland
// and X11. It is invoked out-of-process via `notify-send` (the canonical
// libnotify CLI present on every modern Linux desktop), falling back to
// `gdbus call` when libnotify is absent but GLib is installed. Delivery is
// fire-and-forget: a failed spawn or missing binary is a silent no-op.

/// Resolved notifier binary used to fan a notification out to D-Bus.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DesktopNotifier {
	NotifySend(PathBuf),
	Gdbus(PathBuf),
}

/// `notify-send` (one-shot, no marshalling) when installed, else `gdbus`.
fn resolve_desktop_notifier(which: impl Fn(&str) -> Option<PathBuf>) -> Option<DesktopNotifier> {
	which("notify-send")
		.map(DesktopNotifier::NotifySend)
		.or_else(|| which("gdbus").map(DesktopNotifier::Gdbus))
}

/// Whether the process can reach a freedesktop notification daemon: Linux
/// plus either a session bus address in env or the systemd user-bus socket at
/// `$XDG_RUNTIME_DIR/bus`.
fn has_linux_desktop_session(env: &Env, platform: Platform, effects: &mut dyn Effects) -> bool {
	if platform != Platform::Linux {
		return false;
	}
	if env.set("DBUS_SESSION_BUS_ADDRESS") {
		return true;
	}
	env.get("XDG_RUNTIME_DIR")
		.filter(|dir| !dir.is_empty())
		.is_some_and(|dir| effects.file_exists(&Path::new(dir).join("bus")))
}

/// A BEL notification also dispatches a D-Bus toast on a Linux desktop
/// session unless the user opted out (`PI_NO_DESKTOP_NOTIFY=1`).
fn should_deliver_desktop(env: &Env, platform: Platform, effects: &mut dyn Effects) -> bool {
	has_linux_desktop_session(env, platform, effects) && env.get("PI_NO_DESKTOP_NOTIFY") != Some("1")
}

/// The argv that delivers `message` through `notifier`:
/// - `notify-send` takes title + body positionally, a numeric expire timeout
///   and the urgency as flags.
/// - `gdbus call ... Notify` takes the freedesktop signature `s u s s s as
///   a{sv} i`: `app_name`, `replaces_id`, `app_icon`, summary, body, actions,
///   hints, `expire_timeout`; the urgency byte rides in the hints so the daemon
///   classifies the toast identically to `notify-send`.
fn desktop_command(notifier: &DesktopNotifier, message: &Notification) -> Vec<String> {
	let (title, body) = title_and_body(message);
	let urgency = match message {
		Notification::Rich(rich) => rich
			.urgency
			.as_deref()
			.filter(|urgency| matches!(*urgency, "low" | "critical"))
			.unwrap_or("normal"),
		Notification::Text(_) => "normal",
	};
	match notifier {
		DesktopNotifier::NotifySend(path) => vec![
			path.to_string_lossy().into_owned(),
			"--app-name".to_owned(),
			APP_NAME.to_owned(),
			format!("--urgency={urgency}"),
			"--expire-time=5000".to_owned(),
			title,
			body,
		],
		DesktopNotifier::Gdbus(path) => {
			let byte = match urgency {
				"low" => 0,
				"critical" => 2,
				_ => 1,
			};
			let mut argv = vec![path.to_string_lossy().into_owned()];
			argv.extend(
				[
					"call",
					"--session",
					"--dest",
					"org.freedesktop.Notifications",
					"--object-path",
					"/org/freedesktop/Notifications",
					"--method",
					"org.freedesktop.Notifications.Notify",
					APP_NAME,
					"0",
					"",
				]
				.map(str::to_owned),
			);
			argv.extend([
				title,
				body,
				"[]".to_owned(),
				format!("{{\"urgency\": <byte {byte}>}}"),
				"5000".to_owned(),
			]);
			argv
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[derive(Default)]
	struct Fake {
		spawned:     Vec<Vec<String>>,
		spawn_fails: bool,
		notifier:    Option<DesktopNotifier>,
		bus_socket:  bool,
	}

	impl Effects for Fake {
		fn spawn(&mut self, argv: &[String]) -> bool {
			self.spawned.push(argv.to_vec());
			!self.spawn_fails
		}

		fn desktop_notifier(&mut self) -> Option<DesktopNotifier> {
			self.notifier.clone()
		}

		fn file_exists(&mut self, path: &Path) -> bool {
			self.bus_socket && path == Path::new("/run/user/1000/bus")
		}
	}

	fn text(message: &str) -> Notification {
		Notification::Text(message.to_owned())
	}

	fn rich(title: &str, body: &str) -> Rich {
		Rich { title: Some(title.to_owned()), body: Some(body.to_owned()), ..Rich::default() }
	}

	fn kind(title: &str, body: &str, kind: &str) -> Notification {
		Notification::Rich(Rich { types: vec![kind.to_owned()], ..rich(title, body) })
	}

	const UUID: &str = "123e4567-e89b-12d3-a456-426614174000";

	/// Deliver with OSC 99 on Linux; the write and the spawned argvs.
	fn deliver_in(
		pairs: &[(&str, &str)],
		message: &Notification,
		fake: &mut Fake,
	) -> Option<String> {
		deliver(message, NotifyProtocol::Osc99, false, false, &Env::of(pairs), Platform::Linux, fake)
	}

	#[test]
	fn formats_strings_and_unconfirmed_structured_messages_as_one_line() {
		assert_eq!(format(&text("hello"), NotifyProtocol::Osc99, false), "\x1b]99;;hello\x1b\\");
		assert_eq!(format(&text("hello"), NotifyProtocol::Osc9, false), "\x1b]9;hello\x1b\\");
		assert_eq!(format(&text("hello"), NotifyProtocol::Bell, true), "\x07");
		let structured = Notification::Rich(rich("Session", "Complete"));
		assert_eq!(
			format(&structured, NotifyProtocol::Osc99, false),
			"\x1b]99;;Session: Complete\x1b\\"
		);
		assert_eq!(format(&structured, NotifyProtocol::Osc9, true), "\x1b]9;Session: Complete\x1b\\");
	}

	#[test]
	fn formats_structured_osc99_title_and_body_chunks() {
		let message = Notification::Rich(Rich {
			id: Some("complete-1".to_owned()),
			types: vec!["completion".to_owned()],
			urgency: Some("normal".to_owned()),
			icon_name: Some("info".to_owned()),
			sound: Some("info".to_owned()),
			actions: Some("focus".to_owned()),
			expires_ms: Some(5000),
			..rich("Session", "Complete")
		});
		assert_eq!(
			format(&message, NotifyProtocol::Osc99, true),
			"\x1b]99;i=complete-1:f=b21w:a=focus:u=1:t=Y29tcGxldGlvbg==:n=aW5mbw==:s=aW5mbw==:w=5000:\
			 d=0;Session\x1b\\\x1b]99;i=complete-1:p=body;Complete\x1b\\"
		);
	}

	#[test]
	fn base64_encodes_unsafe_payload_controls() {
		let message = Notification::Rich(Rich {
			title: Some("Line 1\nLine 2".to_owned()),
			id: Some("unsafe".to_owned()),
			..Rich::default()
		});
		assert_eq!(
			format(&message, NotifyProtocol::Osc99, true),
			"\x1b]99;i=unsafe:f=b21w:e=1;TGluZSAxCkxpbmUgMg==\x1b\\"
		);
	}

	#[test]
	fn chunks_long_payloads_on_character_boundaries() {
		let body = "é".repeat(1500);
		let out = format(
			&Notification::Rich(Rich { id: Some("x".to_owned()), ..rich("T", &body) }),
			NotifyProtocol::Osc99,
			true,
		);
		assert_eq!(out.matches("p=body").count(), 2);
		assert_eq!(out.matches(":d=0").count(), 2);
		assert!(out.ends_with(&format!("\x1b]99;i=x:p=body;{}\x1b\\", "é".repeat(476))));
	}

	#[test]
	fn generated_ids_differ_between_notifications_and_carry_the_process_prefix() {
		let message = Notification::Rich(rich("omp", "Complete"));
		let id = |out: String| out[7..].split(':').next().unwrap().to_owned();
		let first = id(format(&message, NotifyProtocol::Osc99, true));
		let second = id(format(&message, NotifyProtocol::Osc99, true));
		assert_ne!(first, second);
		assert!(first.starts_with(&format!("{}-", *OSC99_ID_PREFIX)));
		assert_eq!(OSC99_ID_PREFIX.len(), "omp-".len() + 8);
		// Ids are sanitized; `0` would be Kitty's "no id".
		assert_eq!(osc99_id(Some("a b/c")), "abc");
		assert!(osc99_id(Some("0")).starts_with("omp-"));
	}

	#[test]
	fn suppression_and_headless_deliver_nothing() {
		let mut fake = Fake::default();
		for value in ["off", "0", "false"] {
			assert_eq!(deliver_in(&[("PI_NOTIFICATIONS", value)], &text("x"), &mut fake), None);
		}
		let env = Env::default();
		assert_eq!(
			deliver(&text("x"), NotifyProtocol::Osc9, false, true, &env, Platform::Linux, &mut fake),
			None
		);
		assert!(fake.spawned.is_empty());
		assert_eq!(
			deliver_in(&[("PI_NOTIFICATIONS", "on")], &text("x"), &mut fake).as_deref(),
			Some("\x1b]99;;x\x1b\\")
		);
	}

	#[test]
	fn routes_a_cmux_surface_notification_with_explicit_argv() {
		let mut fake = Fake::default();
		let message = Notification::Rich(rich("--title=spoof", "--surface other"));
		assert_eq!(deliver_in(&[("CMUX_SURFACE_ID", UUID)], &message, &mut fake), None);
		assert_eq!(fake.spawned, [[
			"cmux",
			"notify",
			"--surface",
			UUID,
			"--title",
			"--title=spoof",
			"--body",
			"--surface other"
		]]);
	}

	#[test]
	fn routes_a_herdr_pane_notification_through_the_cli() {
		let mut fake = Fake::default();
		let env = [("HERDR_ENV", "1"), ("HERDR_PANE_ID", "w6:p1")];
		assert_eq!(deliver_in(&env, &kind("session", "Waiting for input", "ask"), &mut fake), None);
		assert_eq!(fake.spawned, [[
			"herdr",
			"notification",
			"show",
			"session",
			"--body",
			"Waiting for input",
			"--sound",
			"request"
		]]);
		// A launcher dropped HERDR_ENV but kept the pane id.
		let mut fake = Fake::default();
		assert_eq!(deliver_in(&[("HERDR_PANE_ID", "w6:p1")], &text("x"), &mut fake), None);
		assert_eq!(fake.spawned.len(), 1);
	}

	#[test]
	fn herdr_sounds_follow_the_notification_kind() {
		let mut fake = Fake::default();
		let env = [("HERDR_PANE_ID", "w6:p1")];
		for (body, k) in
			[("Complete", "completion"), ("Stopped with error", "error"), ("Reminder", "info")]
		{
			deliver_in(&env, &kind("session", body, k), &mut fake);
		}
		let sounds: Vec<_> = fake.spawned.iter().map(|argv| argv[7].as_str()).collect();
		assert_eq!(sounds, ["done", "request", "none"]);
	}

	#[test]
	fn herdr_never_gets_a_help_request_title() {
		let mut fake = Fake::default();
		let env = [("HERDR_PANE_ID", "w6:p1")];
		deliver_in(&env, &kind("--help", "Complete", "completion"), &mut fake);
		deliver_in(&env, &kind("-x session", "Complete", "completion"), &mut fake);
		let titles: Vec<_> = fake.spawned.iter().map(|argv| argv[3].as_str()).collect();
		assert_eq!(titles, ["omp", "-x session"]);
	}

	#[test]
	fn falls_back_without_a_herdr_pane_id_or_binary() {
		let mut fake = Fake::default();
		assert_eq!(
			deliver_in(&[("HERDR_ENV", "1")], &text("no pane"), &mut fake).as_deref(),
			Some("\x1b]99;;no pane\x1b\\")
		);
		assert!(fake.spawned.is_empty());

		let mut fake = Fake { spawn_fails: true, ..Fake::default() };
		let env = [("HERDR_ENV", "1"), ("HERDR_PANE_ID", "w6:p1")];
		assert_eq!(
			deliver_in(&env, &text("no binary"), &mut fake).as_deref(),
			Some("\x1b]99;;no binary\x1b\\")
		);
		assert_eq!(fake.spawned.len(), 1);
	}

	#[test]
	fn an_incomplete_herdr_session_falls_through_to_a_cmux_surface() {
		let mut fake = Fake::default();
		assert_eq!(
			deliver_in(&[("HERDR_ENV", "1"), ("CMUX_SURFACE_ID", UUID)], &text("ping"), &mut fake),
			None
		);
		assert_eq!(fake.spawned[0][0], "cmux");
	}

	#[test]
	fn the_herdr_pane_wins_over_the_cmux_surface_it_runs_in() {
		let mut fake = Fake::default();
		let env = [
			("HERDR_ENV", "1"),
			("HERDR_PANE_ID", "w6:p1"),
			("CMUX_SURFACE_ID", UUID),
			("CMUX_SOCKET_PATH", "/tmp/cmux.sock"),
		];
		assert_eq!(deliver_in(&env, &kind("session", "Waiting for input", "ask"), &mut fake), None);
		assert_eq!(fake.spawned.len(), 1);
		assert_eq!(fake.spawned[0][0], "herdr");
	}

	#[test]
	fn routes_to_the_innermost_notifier() {
		const TMUX_PING: &str = "\x1bPtmux;\x1b\x1b]99;;ping\x1b\x1b\\\x1b\\\x07";
		let tmux = ("TMUX", "/tmp/tmux-1000/default,1234,0");
		for (env, binary, write) in [
			(&[("HERDR_PANE_ID", "w6:p1"), tmux][..], Some("herdr"), None),
			(&[("CMUX_SURFACE_ID", UUID), tmux], Some("cmux"), None),
			(&[("CMUX_SURFACE_ID", UUID), ("ZELLIJ", "0")], Some("cmux"), None),
			(&[("HERDR_ENV", "1"), tmux], None, Some(TMUX_PING)),
			(&[tmux, ("ZELLIJ", "0")], None, Some(TMUX_PING)),
			(&[tmux], None, Some(TMUX_PING)),
			(&[("ZELLIJ", "0")], None, Some("\x1b]99;;ping\x1b\\\x07")),
		] {
			let mut fake = Fake::default();
			assert_eq!(deliver_in(env, &text("ping"), &mut fake).as_deref(), write, "{env:?}");
			let binaries: Vec<_> = fake.spawned.iter().map(|argv| argv[0].as_str()).collect();
			assert_eq!(binaries, binary.into_iter().collect::<Vec<_>>(), "{env:?}");
		}
	}

	#[test]
	fn bell_stays_a_plain_bel_under_tmux_and_zellij() {
		for env in [("TMUX", "/tmp/tmux-1000/default,1234,0"), ("ZELLIJ", "0")] {
			let mut fake = Fake::default();
			let out = deliver(
				&text("ping"),
				NotifyProtocol::Bell,
				false,
				false,
				&Env::of(&[env]),
				Platform::Linux,
				&mut fake,
			);
			assert_eq!(out.as_deref(), Some("\x07"));
		}
	}

	#[test]
	fn cmux_without_a_valid_surface_keeps_the_fallback() {
		for env in [
			&[("CMUX_WORKSPACE_ID", "workspace:1")][..],
			&[("CMUX_SOCKET_PATH", "/tmp/cmux.sock")],
			&[("CMUX_SURFACE_ID", "--help")],
		] {
			let mut fake = Fake::default();
			assert_eq!(
				deliver_in(env, &text("ping"), &mut fake).as_deref(),
				Some("\x1b]99;;ping\x1b\\")
			);
			assert!(fake.spawned.is_empty());
		}
		let mut fake = Fake { spawn_fails: true, ..Fake::default() };
		assert_eq!(
			deliver_in(&[("CMUX_SURFACE_ID", UUID)], &text("ping"), &mut fake).as_deref(),
			Some("\x1b]99;;ping\x1b\\")
		);
	}

	#[test]
	fn bell_fans_out_to_dbus_on_a_linux_session() {
		let notifier = DesktopNotifier::NotifySend(PathBuf::from("/usr/bin/notify-send"));
		let bus = ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
		let message = Notification::Rich(rich("Session", "Complete"));
		let bell = |pairs: &[(&str, &str)], platform, fake: &mut Fake| {
			deliver(&message, NotifyProtocol::Bell, false, false, &Env::of(pairs), platform, fake)
		};

		let mut fake = Fake { notifier: Some(notifier.clone()), ..Fake::default() };
		assert_eq!(bell(&[bus], Platform::Linux, &mut fake).as_deref(), Some("\x07"));
		assert_eq!(fake.spawned, [[
			"/usr/bin/notify-send",
			"--app-name",
			"omp",
			"--urgency=normal",
			"--expire-time=5000",
			"Session",
			"Complete"
		]]);

		// The systemd user bus socket stands in for an unexported address.
		let mut fake = Fake { notifier: Some(notifier.clone()), bus_socket: true, ..Fake::default() };
		bell(&[("XDG_RUNTIME_DIR", "/run/user/1000")], Platform::Linux, &mut fake);
		assert_eq!(fake.spawned.len(), 1);

		for (pairs, platform) in [
			(&[bus, ("PI_NO_DESKTOP_NOTIFY", "1")][..], Platform::Linux),
			(&[bus], Platform::Darwin),
			(&[bus], Platform::Win32),
			(&[("XDG_RUNTIME_DIR", "/run/user/1000")], Platform::Linux),
			(&[], Platform::Linux),
		] {
			let mut fake = Fake { notifier: Some(notifier.clone()), ..Fake::default() };
			bell(pairs, platform, &mut fake);
			assert!(fake.spawned.is_empty(), "{pairs:?} {platform:?}");
		}

		// An in-band protocol never reaches D-Bus; neither does a missing
		// notifier.
		let mut fake = Fake { notifier: Some(notifier), ..Fake::default() };
		deliver(
			&message,
			NotifyProtocol::Osc99,
			false,
			false,
			&Env::of(&[bus]),
			Platform::Linux,
			&mut fake,
		);
		let mut missing = Fake::default();
		bell(&[bus], Platform::Linux, &mut missing);
		assert!(fake.spawned.is_empty() && missing.spawned.is_empty());
	}

	#[test]
	fn prefers_notify_send_then_gdbus() {
		let found = |names: &'static [&'static str]| {
			resolve_desktop_notifier(|name| {
				names
					.contains(&name)
					.then(|| PathBuf::from(format!("/usr/bin/{name}")))
			})
		};
		assert_eq!(
			found(&["notify-send", "gdbus"]),
			Some(DesktopNotifier::NotifySend(PathBuf::from("/usr/bin/notify-send")))
		);
		assert_eq!(found(&["gdbus"]), Some(DesktopNotifier::Gdbus(PathBuf::from("/usr/bin/gdbus"))));
		assert_eq!(found(&[]), None);
	}

	#[test]
	fn builds_desktop_commands() {
		let notify_send = DesktopNotifier::NotifySend(PathBuf::from("/usr/bin/notify-send"));
		let gdbus = DesktopNotifier::Gdbus(PathBuf::from("/usr/bin/gdbus"));
		assert_eq!(desktop_command(&notify_send, &text("ping")), [
			"/usr/bin/notify-send",
			"--app-name",
			"omp",
			"--urgency=normal",
			"--expire-time=5000",
			"omp",
			"ping"
		]);
		let critical = Notification::Rich(Rich {
			urgency: Some("critical".to_owned()),
			..rich("Session 12", "Complete")
		});
		assert_eq!(desktop_command(&notify_send, &critical)[3], "--urgency=critical");
		assert_eq!(desktop_command(&notify_send, &critical)[5..], ["Session 12", "Complete"]);
		let blank = Notification::Rich(rich("   ", "Waiting for input"));
		assert_eq!(desktop_command(&notify_send, &blank)[5..], ["omp", "Waiting for input"]);
		let low = Notification::Rich(Rich { urgency: Some("low".to_owned()), ..rich("omp", "ping") });
		assert_eq!(desktop_command(&gdbus, &low), [
			"/usr/bin/gdbus",
			"call",
			"--session",
			"--dest",
			"org.freedesktop.Notifications",
			"--object-path",
			"/org/freedesktop/Notifications",
			"--method",
			"org.freedesktop.Notifications.Notify",
			"omp",
			"0",
			"",
			"omp",
			"ping",
			"[]",
			"{\"urgency\": <byte 0>}",
			"5000"
		]);
	}
}
