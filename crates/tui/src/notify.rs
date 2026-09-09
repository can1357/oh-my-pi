//! Structured desktop notifications for terminal and native platform sinks.

use std::{
	env,
	ffi::{OsStr, OsString},
	fmt::Write as _,
	fs,
	io::{self, Write},
	path::{Path, PathBuf},
	process::{Command, Stdio},
	sync::atomic::{AtomicU64, Ordering},
};

use omp_core::{IntoStr, Str, encoding::base64};
use smallvec::SmallVec;

use crate::{NotifyProtocol, TerminalCaps, escape::esc, kitty::append_tmux_passthrough};

const OSC99_MAX_PAYLOAD_BYTES: usize = 2048;
const OSC99_APP_NAME: &str = "omp";
const DBUS_APP_NAME: &str = "omp";
const DEFAULT_TITLE: &str = "omp";
static NEXT_OSC99_ID: AtomicU64 = AtomicU64::new(1);

/// The importance assigned to a desktop notification.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Urgency {
	/// A low-priority notification.
	Low,
	/// A normal-priority notification.
	#[default]
	Normal,
	/// A critical notification.
	Critical,
}

impl Urgency {
	const fn name(self) -> &'static str {
		match self {
			Self::Low => "low",
			Self::Normal => "normal",
			Self::Critical => "critical",
		}
	}

	const fn osc99(self) -> char {
		match self {
			Self::Low => '0',
			Self::Normal => '1',
			Self::Critical => '2',
		}
	}

	const fn dbus_byte(self) -> u8 {
		match self {
			Self::Low => 0,
			Self::Normal => 1,
			Self::Critical => 2,
		}
	}
}

/// Terminal actions advertised by a structured notification.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotificationAction {
	/// Ask the terminal to focus the originating window when activated.
	Focus,
	/// Ask the terminal to report activation to the application.
	Report,
	/// Focus the window and report activation.
	FocusReport,
	/// Explicitly disable the default focus action.
	None,
}

impl NotificationAction {
	const fn osc99(self) -> &'static str {
		match self {
			Self::Focus => "focus",
			Self::Report => "report",
			Self::FocusReport => "focus,report",
			Self::None => "-focus",
		}
	}
}

/// Sound requested for a structured notification.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotificationSound {
	/// Do not play a sound.
	Silent,
	/// Use the terminal's system notification sound.
	System,
	/// Use an informational sound.
	Info,
	/// Use a warning sound.
	Warning,
	/// Use an error sound.
	Error,
	/// Use a question sound.
	Question,
}

impl NotificationSound {
	/// Returns the OSC 99 sound identifier.
	pub const fn into_str(&self) -> &'static str {
		match self {
			Self::Silent => "silent",
			Self::System => "system",
			Self::Info => "info",
			Self::Warning => "warning",
			Self::Error => "error",
			Self::Question => "question",
		}
	}

	const fn name(self) -> &'static str {
		self.into_str()
	}
}

impl From<NotificationSound> for &'static str {
	fn from(sound: NotificationSound) -> Self {
		sound.into_str()
	}
}

impl From<&NotificationSound> for &'static str {
	fn from(sound: &NotificationSound) -> Self {
		sound.into_str()
	}
}

/// A structured desktop notification.
///
/// OSC 99 carries every field. OSC 9 and unconfirmed OSC 99 collapse the title
/// and body to one line, while the bell protocol can additionally fan out to a
/// native desktop notification center.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Notification {
	/// Optional notification title.
	pub title:      Option<Str>,
	/// Optional notification body.
	pub body:       Option<Str>,
	/// Optional stable OSC 99 notification identifier.
	pub id:         Option<Str>,
	/// Notification categories encoded as OSC 99 `t=` metadata.
	pub types:      SmallVec<Str, 1>,
	/// Optional urgency metadata.
	pub urgency:    Option<Urgency>,
	/// Optional icon name.
	pub icon_name:  Option<Str>,
	/// Optional sound request.
	pub sound:      Option<NotificationSound>,
	/// Optional terminal action request.
	pub actions:    Option<NotificationAction>,
	/// Optional expiry timeout in milliseconds; values below `-1` become `-1`.
	pub expires_ms: Option<i64>,
}

impl Notification {
	/// Starts a structured notification builder.
	pub fn builder() -> NotificationBuilder {
		NotificationBuilder::default()
	}
}

/// Builder for [`Notification`].
#[derive(Clone, Debug, Default)]
pub struct NotificationBuilder {
	notification: Notification,
}

impl NotificationBuilder {
	/// Sets the notification title.
	pub fn title(mut self, title: impl IntoStr) -> Self {
		self.notification.title = Some(title.into_str());
		self
	}

	/// Sets the notification body.
	pub fn body(mut self, body: impl IntoStr) -> Self {
		self.notification.body = Some(body.into_str());
		self
	}

	/// Sets the stable OSC 99 identifier.
	pub fn id(mut self, id: impl IntoStr) -> Self {
		self.notification.id = Some(id.into_str());
		self
	}

	/// Appends one notification category.
	pub fn notification_type(mut self, notification_type: impl IntoStr) -> Self {
		self.notification.types.push(notification_type.into_str());
		self
	}

	/// Appends notification categories in iteration order.
	pub fn notification_types<I, S>(mut self, notification_types: I) -> Self
	where
		I: IntoIterator<Item = S>,
		S: Into<Str>,
	{
		self
			.notification
			.types
			.extend(notification_types.into_iter().map(Into::into));
		self
	}

	/// Sets notification urgency.
	pub const fn urgency(mut self, urgency: Urgency) -> Self {
		self.notification.urgency = Some(urgency);
		self
	}

	/// Sets the icon name.
	pub fn icon_name(mut self, icon_name: impl IntoStr) -> Self {
		self.notification.icon_name = Some(icon_name.into_str());
		self
	}

	/// Sets the requested notification sound.
	pub const fn sound(mut self, sound: NotificationSound) -> Self {
		self.notification.sound = Some(sound);
		self
	}

	/// Sets the terminal action request.
	pub const fn actions(mut self, actions: NotificationAction) -> Self {
		self.notification.actions = Some(actions);
		self
	}

	/// Sets the expiry timeout in milliseconds.
	pub const fn expires_ms(mut self, expires_ms: i64) -> Self {
		self.notification.expires_ms = Some(expires_ms);
		self
	}

	/// Finishes the notification.
	pub fn build(self) -> Notification {
		self.notification
	}
}

/// Delivers a notification through the protocol selected by `caps`.
///
/// Delivery commands are detached and best-effort. Only terminal output errors
/// are returned to the caller.
pub fn notify(
	out: &mut impl Write,
	caps: &TerminalCaps,
	notification: &Notification,
) -> io::Result<()> {
	notify_with_system(out, caps, notification, &RealSystem)
}

/// Delivers a notification through the platform desktop sink alone — the
/// path a host without a terminal (a native window) takes: cmux surface
/// routing when present, else `osascript` on macOS, else `notify-send` /
/// D-Bus on a Linux desktop session. Detached and best-effort.
pub fn notify_desktop(notification: &Notification) {
	notify_desktop_with_system(notification, &RealSystem);
}

fn notify_desktop_with_system(notification: &Notification, system: &impl System) {
	if route_cmux(notification, system) {
		return;
	}
	deliver_desktop_fallback(notification, system);
}

trait System {
	fn var(&self, name: &str) -> Option<OsString>;
	fn is_linux(&self) -> bool;
	fn is_macos(&self) -> bool;
	fn path_exists(&self, path: &Path) -> bool;
	fn find_program(&self, name: &str) -> Option<PathBuf>;
	fn spawn(&self, argv: &[OsString]) -> io::Result<()>;
}

struct RealSystem;

impl System for RealSystem {
	fn var(&self, name: &str) -> Option<OsString> {
		env::var_os(name)
	}

	fn is_linux(&self) -> bool {
		cfg!(target_os = "linux")
	}

	fn is_macos(&self) -> bool {
		cfg!(target_os = "macos")
	}

	fn path_exists(&self, path: &Path) -> bool {
		path.exists()
	}

	fn find_program(&self, name: &str) -> Option<PathBuf> {
		let path = self.var("PATH")?;
		env::split_paths(&path)
			.map(|directory| directory.join(name))
			.find(|candidate| fs::metadata(candidate).is_ok_and(|metadata| metadata.is_file()))
	}

	fn spawn(&self, argv: &[OsString]) -> io::Result<()> {
		let Some((program, arguments)) = argv.split_first() else {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty notification command"));
		};
		Command::new(program)
			.args(arguments)
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.spawn()
			.map(drop)
	}
}

fn notify_with_system(
	out: &mut impl Write,
	caps: &TerminalCaps,
	notification: &Notification,
	system: &impl System,
) -> io::Result<()> {
	if route_cmux(notification, system) {
		return Ok(());
	}

	let sequence = format_notification(caps, notification);
	if caps.notify != NotifyProtocol::Bell && caps.inside_tmux {
		let mut wrapped = String::with_capacity(sequence.len() + 16);
		append_tmux_passthrough(&mut wrapped, &sequence);
		wrapped.push('\x07');
		out.write_all(wrapped.as_bytes())?;
	} else {
		out.write_all(sequence.as_bytes())?;
		if caps.notify != NotifyProtocol::Bell && env_present(system, "ZELLIJ") {
			out.write_all(esc!(bel).as_bytes())?;
		}
	}

	if caps.notify == NotifyProtocol::Bell {
		deliver_desktop_fallback(notification, system);
	}
	Ok(())
}

fn route_cmux(notification: &Notification, system: &impl System) -> bool {
	let Some(surface) = system.var("CMUX_SURFACE_ID") else {
		return false;
	};
	let surface = surface.to_string_lossy();
	let surface = surface.trim();
	if !valid_surface_id(surface.as_bytes()) {
		return false;
	}
	let title = notification
		.title
		.as_deref()
		.map(str::trim)
		.filter(|title| !title.is_empty())
		.unwrap_or(DEFAULT_TITLE);
	let body = notification.body.as_deref().unwrap_or("");
	let argv = [
		OsString::from("cmux"),
		OsString::from("notify"),
		OsString::from("--surface"),
		OsString::from(surface),
		OsString::from("--title"),
		OsString::from(title),
		OsString::from("--body"),
		OsString::from(body),
	];
	system.spawn(&argv).is_ok()
}

fn valid_surface_id(id: &[u8]) -> bool {
	if id.len() != 36 {
		return false;
	}
	for (index, byte) in id.iter().copied().enumerate() {
		if matches!(index, 8 | 13 | 18 | 23) {
			if byte != b'-' {
				return false;
			}
		} else if !byte.is_ascii_hexdigit() {
			return false;
		}
	}
	true
}

fn format_notification(caps: &TerminalCaps, notification: &Notification) -> String {
	match caps.notify {
		NotifyProtocol::Bell => String::from(esc!(bel)),
		NotifyProtocol::Osc9 => {
			format!(esc!(osc, "9;{}", st), notification_line(notification))
		},
		NotifyProtocol::Osc99 if caps.osc99_confirmed => format_osc99(notification),
		NotifyProtocol::Osc99 => {
			format!(esc!(osc, "99;;{}", st), notification_line(notification))
		},
	}
}

fn notification_line(notification: &Notification) -> String {
	match (notification.title.as_deref(), notification.body.as_deref()) {
		(Some(title), Some(body)) => format!("{title}: {body}"),
		(Some(title), None) => title.to_owned(),
		(None, Some(body)) => body.to_owned(),
		(None, None) => String::new(),
	}
}

fn format_osc99(notification: &Notification) -> String {
	let id = osc99_id(notification.id.as_deref());
	let mut metadata = format!("i={id}:f={}", base64_utf8(OSC99_APP_NAME));
	if let Some(actions) = notification.actions {
		let _ = write!(metadata, ":a={}", actions.osc99());
	}
	if let Some(urgency) = notification.urgency {
		let _ = write!(metadata, ":u={}", urgency.osc99());
	}
	for notification_type in &notification.types {
		let _ = write!(metadata, ":t={}", base64_utf8(notification_type));
	}
	if let Some(icon_name) = &notification.icon_name {
		let _ = write!(metadata, ":n={}", base64_utf8(icon_name));
	}
	if let Some(sound) = notification.sound {
		let _ = write!(metadata, ":s={}", base64_utf8(sound.name()));
	}
	if let Some(expires_ms) = notification.expires_ms {
		let _ = write!(metadata, ":w={}", expires_ms.max(-1));
	}

	let title = notification
		.title
		.as_deref()
		.or(notification.body.as_deref())
		.unwrap_or("");
	let body = notification
		.title
		.as_ref()
		.and(notification.body.as_deref())
		.filter(|body| !body.is_empty());
	let mut output = String::new();
	append_osc99_payload(&mut output, &metadata, title, body.is_some());
	if let Some(body) = body {
		let body_metadata = format!("i={id}:p=body");
		append_osc99_payload(&mut output, &body_metadata, body, false);
	}
	output
}

fn osc99_id(id: Option<&str>) -> String {
	if let Some(id) = id {
		let sanitized: String = id
			.chars()
			.filter(|character| {
				character.is_ascii_alphanumeric() || matches!(character, '_' | '+' | '-' | '.')
			})
			.collect();
		if !sanitized.is_empty() && sanitized != "0" {
			return sanitized;
		}
	}
	format!("omp-{}", NEXT_OSC99_ID.fetch_add(1, Ordering::Relaxed))
}

fn append_osc99_payload(output: &mut String, metadata: &str, payload: &str, hold: bool) {
	if payload.is_empty() {
		append_osc99_chunk(output, metadata, "", hold);
		return;
	}
	let mut start = 0;
	while start < payload.len() {
		let mut end = (start + OSC99_MAX_PAYLOAD_BYTES).min(payload.len());
		while !payload.is_char_boundary(end) {
			end -= 1;
		}
		let more = end < payload.len();
		append_osc99_chunk(output, metadata, &payload[start..end], hold || more);
		start = end;
	}
}

fn append_osc99_chunk(output: &mut String, metadata: &str, payload: &str, hold: bool) {
	output.push_str(esc!(osc, "99;"));
	output.push_str(metadata);
	if hold {
		output.push_str(":d=0");
	}
	if osc99_unsafe(payload) {
		output.push_str(":e=1");
	}
	output.push(';');
	if osc99_unsafe(payload) {
		output.push_str(&base64_utf8(payload));
	} else {
		output.push_str(payload);
	}
	output.push_str(esc!(st));
}

fn osc99_unsafe(payload: &str) -> bool {
	payload.chars().any(|character| {
		let code = character as u32;
		code <= 0x1f || code == 0x7f || (0x80..=0x9f).contains(&code)
	})
}

fn base64_utf8(value: &str) -> String {
	base64::encode(value.as_bytes()).into_string()
}

fn deliver_linux_fallback(notification: &Notification, system: &impl System) {
	if system.is_macos() {
		deliver_macos_fallback(notification, system);
		return;
	}
	if !system.is_linux()
		|| system.var("OMP_NO_DESKTOP_NOTIFY").as_deref() == Some(OsStr::new("1"))
		|| !has_desktop_session(system)
	{
		return;
	}
	let (title, body, urgency) = resolved_fields(notification);
	if let Some(program) = system.find_program("notify-send") {
		let argv = [
			program.into_os_string(),
			OsString::from("--app-name"),
			OsString::from(DBUS_APP_NAME),
			OsString::from(format!("--urgency={}", urgency.name())),
			OsString::from("--expire-time=5000"),
			OsString::from(title),
			OsString::from(body),
		];
		let _ = system.spawn(&argv);
		return;
	}
	let Some(program) = system.find_program("gdbus") else {
		return;
	};
	let argv = [
		program.into_os_string(),
		OsString::from("call"),
		OsString::from("--session"),
		OsString::from("--dest"),
		OsString::from("org.freedesktop.Notifications"),
		OsString::from("--object-path"),
		OsString::from("/org/freedesktop/Notifications"),
		OsString::from("--method"),
		OsString::from("org.freedesktop.Notifications.Notify"),
		OsString::from(DBUS_APP_NAME),
		OsString::from("0"),
		OsString::new(),
		OsString::from(title),
		OsString::from(body),
		OsString::from("[]"),
		OsString::from(format!("{{\"urgency\": <byte {}>}}", urgency.dbus_byte())),
		OsString::from("5000"),
	];
	let _ = system.spawn(&argv);
}

fn deliver_desktop_fallback(notification: &Notification, system: &impl System) {
	deliver_linux_fallback(notification, system);
}

fn deliver_macos_fallback(notification: &Notification, system: &impl System) {
	if system.var("OMP_NO_DESKTOP_NOTIFY").as_deref() == Some(OsStr::new("1")) {
		return;
	}
	let Some(program) = system.find_program("osascript") else {
		return;
	};
	let (title, body, _) = resolved_fields(notification);
	let argv = [
		program.into_os_string(),
		OsString::from("-e"),
		OsString::from(
			"on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run",
		),
		OsString::from("--"),
		OsString::from(title),
		OsString::from(body),
	];
	let _ = system.spawn(&argv);
}

fn has_desktop_session(system: &impl System) -> bool {
	if env_present(system, "DBUS_SESSION_BUS_ADDRESS") {
		return true;
	}
	let Some(runtime_dir) = system.var("XDG_RUNTIME_DIR") else {
		return false;
	};
	system.path_exists(&PathBuf::from(runtime_dir).join("bus"))
}

fn env_present(system: &impl System, name: &str) -> bool {
	system.var(name).is_some_and(|value| !value.is_empty())
}

fn resolved_fields(notification: &Notification) -> (&str, &str, Urgency) {
	let title = notification
		.title
		.as_deref()
		.map(str::trim)
		.filter(|title| !title.is_empty())
		.unwrap_or(DEFAULT_TITLE);
	let body = notification.body.as_deref().unwrap_or("");
	let urgency = notification.urgency.unwrap_or_default();
	(title, body, urgency)
}

#[cfg(test)]
mod tests {
	use std::{
		cell::RefCell,
		collections::{HashMap, HashSet},
	};

	use super::*;
	use crate::{TerminalPlatform, detect_from};

	#[derive(Default)]
	struct MockSystem {
		env:      HashMap<String, OsString>,
		linux:    bool,
		macos:    bool,
		existing: HashSet<PathBuf>,
		programs: HashMap<String, PathBuf>,
		spawns:   RefCell<Vec<Vec<OsString>>>,
	}

	impl System for MockSystem {
		fn var(&self, name: &str) -> Option<OsString> {
			self.env.get(name).cloned()
		}

		fn is_linux(&self) -> bool {
			self.linux
		}

		fn is_macos(&self) -> bool {
			self.macos
		}

		fn path_exists(&self, path: &Path) -> bool {
			self.existing.contains(path)
		}

		fn find_program(&self, name: &str) -> Option<PathBuf> {
			self.programs.get(name).cloned()
		}

		fn spawn(&self, argv: &[OsString]) -> io::Result<()> {
			self.spawns.borrow_mut().push(argv.to_vec());
			Ok(())
		}
	}

	fn caps(protocol: NotifyProtocol) -> TerminalCaps {
		let mut caps = detect_from(&|_| None, TerminalPlatform::Other);
		caps.notify = protocol;
		caps
	}

	fn strings(argv: &[OsString]) -> Vec<String> {
		argv
			.iter()
			.map(|value| value.to_string_lossy().into_owned())
			.collect()
	}

	#[test]
	fn structured_osc99_is_byte_exact_and_chunks_on_utf8_boundaries() {
		let title = format!("{}éZ", "a".repeat(2047));
		let notification = Notification::builder()
			.id("job:7")
			.title(title)
			.body("body\n")
			.actions(NotificationAction::FocusReport)
			.urgency(Urgency::Critical)
			.notification_types(["build", "complete"])
			.icon_name("omp")
			.sound(NotificationSound::Warning)
			.expires_ms(2500)
			.build();
		let mut caps = caps(NotifyProtocol::Osc99);
		caps.osc99_confirmed = true;
		let mut actual = Vec::new();
		notify_with_system(&mut actual, &caps, &notification, &MockSystem::default()).unwrap();

		let metadata =
			"i=job7:f=b21w:a=focus,report:u=2:t=YnVpbGQ=:t=Y29tcGxldGU=:n=b21w:s=d2FybmluZw==:w=2500";
		let expected = format!(
			"\x1b]99;{metadata}:d=0;{}\x1b\\\x1b]99;{metadata}:d=0;éZ\x1b\\\x1b]99;i=job7:p=body:e=1;\
			 Ym9keQo=\x1b\\",
			"a".repeat(2047),
		);
		assert_eq!(actual, expected.as_bytes());
	}

	#[test]
	fn unconfirmed_osc99_collapses_to_one_line() {
		let notification = Notification::builder()
			.title("Done")
			.body("All green")
			.build();
		let mut actual = Vec::new();
		notify_with_system(
			&mut actual,
			&caps(NotifyProtocol::Osc99),
			&notification,
			&MockSystem::default(),
		)
		.unwrap();
		assert_eq!(actual, b"\x1b]99;;Done: All green\x1b\\");
	}

	#[test]
	fn osc9_and_bell_have_exact_wire_forms() {
		let notification = Notification::builder()
			.title("Done")
			.body("All green")
			.build();
		let mut osc9 = Vec::new();
		notify_with_system(
			&mut osc9,
			&caps(NotifyProtocol::Osc9),
			&notification,
			&MockSystem::default(),
		)
		.unwrap();
		assert_eq!(osc9, b"\x1b]9;Done: All green\x1b\\");
		let mut bell = Vec::new();
		notify_with_system(
			&mut bell,
			&caps(NotifyProtocol::Bell),
			&notification,
			&MockSystem::default(),
		)
		.unwrap();
		assert_eq!(bell, b"\x07");
	}

	#[test]
	fn tmux_wraps_non_bell_and_appends_bell() {
		let mut caps = caps(NotifyProtocol::Osc9);
		caps.inside_tmux = true;
		let notification = Notification::builder().body("done").build();
		let mut actual = Vec::new();
		notify_with_system(&mut actual, &caps, &notification, &MockSystem::default()).unwrap();
		assert_eq!(actual, b"\x1bPtmux;\x1b\x1b]9;done\x1b\x1b\\\x1b\\\x07");
	}

	#[test]
	fn zellij_appends_bell_to_non_bell() {
		let mut system = MockSystem::default();
		system.env.insert("ZELLIJ".into(), "1".into());
		let notification = Notification::builder().body("done").build();
		let mut actual = Vec::new();
		notify_with_system(&mut actual, &caps(NotifyProtocol::Osc9), &notification, &system).unwrap();
		assert_eq!(actual, b"\x1b]9;done\x1b\\\x07");
	}

	#[test]
	fn cmux_surface_routes_instead_of_writing_terminal_sequence() {
		let mut system = MockSystem::default();
		system
			.env
			.insert("CMUX_SURFACE_ID".into(), "01234567-89AB-cdef-0123-456789abcdef".into());
		let notification = Notification::builder().title("Build").body("done").build();
		let mut actual = Vec::new();
		notify_with_system(&mut actual, &caps(NotifyProtocol::Osc9), &notification, &system).unwrap();
		assert!(actual.is_empty());
		assert_eq!(strings(&system.spawns.borrow()[0]), [
			"cmux",
			"notify",
			"--surface",
			"01234567-89AB-cdef-0123-456789abcdef",
			"--title",
			"Build",
			"--body",
			"done"
		],);
	}

	#[test]
	fn linux_notify_send_fallback_uses_exact_argv() {
		let mut system = MockSystem { linux: true, ..MockSystem::default() };
		system
			.env
			.insert("DBUS_SESSION_BUS_ADDRESS".into(), "unix:path=/run/user/1/bus".into());
		system
			.programs
			.insert("notify-send".into(), "/usr/bin/notify-send".into());
		let notification = Notification::builder()
			.title("Build")
			.body("failed")
			.urgency(Urgency::Critical)
			.build();
		let mut actual = Vec::new();
		notify_with_system(&mut actual, &caps(NotifyProtocol::Bell), &notification, &system).unwrap();
		assert_eq!(actual, b"\x07");
		assert_eq!(strings(&system.spawns.borrow()[0]), [
			"/usr/bin/notify-send",
			"--app-name",
			"omp",
			"--urgency=critical",
			"--expire-time=5000",
			"Build",
			"failed"
		],);
	}

	#[test]
	fn linux_gdbus_fallback_uses_exact_argv() {
		let mut system = MockSystem { linux: true, ..MockSystem::default() };
		system
			.env
			.insert("XDG_RUNTIME_DIR".into(), "/run/user/1".into());
		system.existing.insert(PathBuf::from("/run/user/1/bus"));
		system
			.programs
			.insert("gdbus".into(), "/usr/bin/gdbus".into());
		let notification = Notification::builder()
			.title("Build")
			.body("done")
			.urgency(Urgency::Low)
			.build();
		let mut actual = Vec::new();
		notify_with_system(&mut actual, &caps(NotifyProtocol::Bell), &notification, &system).unwrap();
		assert_eq!(strings(&system.spawns.borrow()[0]), [
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
			"Build",
			"done",
			"[]",
			"{\"urgency\": <byte 0>}",
			"5000",
		],);
	}

	#[test]
	fn desktop_sink_delivers_without_a_terminal_and_prefers_cmux() {
		let mut system = MockSystem { macos: true, ..MockSystem::default() };
		system
			.programs
			.insert("osascript".into(), "/usr/bin/osascript".into());
		let notification = Notification::builder()
			.title("refactor")
			.body("Complete")
			.build();
		notify_desktop_with_system(&notification, &system);
		let argv = strings(&system.spawns.borrow()[0]);
		assert_eq!(argv[0], "/usr/bin/osascript");
		assert_eq!(&argv[argv.len() - 2..], ["refactor", "Complete"]);

		let mut system = MockSystem { macos: true, ..MockSystem::default() };
		system
			.programs
			.insert("osascript".into(), "/usr/bin/osascript".into());
		system
			.env
			.insert("CMUX_SURFACE_ID".into(), "01234567-89AB-cdef-0123-456789abcdef".into());
		notify_desktop_with_system(&notification, &system);
		let spawns = system.spawns.borrow();
		assert_eq!(spawns.len(), 1, "a cmux surface outranks the desktop sink");
		assert_eq!(strings(&spawns[0])[..2], ["cmux", "notify"]);
	}
}
