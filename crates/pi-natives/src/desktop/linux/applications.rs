//! XDG application inventory and direct desktop-entry launching.
//!
//! Discovery needs neither an X connection nor capture/input permissions.
//! Running state uses exact /proc executable matches or the D-Bus application's
//! unique owner PID; wrappers, sandbox brokers and inaccessible processes may
//! obscure it. Background launches remove inherited activation tokens and use
//! the startup notification timestamp zero (the GTK/X11 no-focus hint).
//! Applications and WMs can ignore that hint; Wayland provides no universal
//! no-activation launch API.

use std::{
	collections::{HashMap, HashSet},
	env, fs,
	os::unix::fs::PermissionsExt,
	path::{Path, PathBuf},
	process::{Command, Stdio},
	thread,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use x11rb::{
	connection::Connection,
	protocol::xproto::{Atom, AtomEnum, ClientMessageEvent, ConnectionExt as _, EventMask, Window},
	rust_connection::RustConnection,
};
use zbus::blocking::Connection as BusConnection;

use super::{
	super::error::{CoreResult, DesktopError},
	Application,
};

struct Entry {
	id:                String,
	path:              PathBuf,
	name:              String,
	icon:              Option<String>,
	exec:              Option<String>,
	working_directory: Option<PathBuf>,
	terminal:          bool,
	dbus:              bool,
}

fn invalid(message: impl Into<String>) -> DesktopError {
	DesktopError::invalid_target(message)
}

fn data_roots() -> Vec<PathBuf> {
	let mut roots = Vec::new();
	if let Some(home) = env::var_os("XDG_DATA_HOME")
		.filter(|value| !value.is_empty())
		.map(PathBuf::from)
		.filter(|path| path.is_absolute())
		.or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
		&& home.is_absolute()
	{
		roots.push(home.join("applications"));
	}
	let directories = env::var_os("XDG_DATA_DIRS")
		.filter(|value| !value.is_empty())
		.unwrap_or_else(|| "/usr/local/share:/usr/share".into());
	roots.extend(
		env::split_paths(&directories)
			.filter(|path| path.is_absolute())
			.map(|path| path.join("applications")),
	);
	roots
}

fn desktop_files(directory: &Path, files: &mut Vec<PathBuf>) {
	let Ok(entries) = fs::read_dir(directory) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		let Ok(kind) = entry.file_type() else {
			continue;
		};
		// Do not follow directory symlinks: they can form cycles. File symlinks
		// are ordinary desktop entries, and retain their installed desktop ID.
		if kind.is_dir() {
			desktop_files(&path, files);
		} else if path
			.extension()
			.is_some_and(|extension| extension == "desktop")
			&& path.is_file()
		{
			files.push(path);
		}
	}
}

fn desktop_id(root: &Path, path: &Path) -> String {
	path
		.strip_prefix(root)
		.unwrap_or(path)
		.to_string_lossy()
		.replace('/', "-")
}

fn locale_names() -> Vec<String> {
	let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
		.into_iter()
		.find_map(|key| env::var(key).ok().filter(|value| !value.is_empty()))
		.unwrap_or_default();
	let (base, modifier) = locale
		.split_once('@')
		.map_or((locale.as_str(), None), |(base, modifier)| (base, Some(modifier)));
	let base = base.split('.').next().unwrap_or(base);
	if base.is_empty() || base == "C" || base == "POSIX" {
		return Vec::new();
	}
	let language = base.split('_').next().unwrap_or(base);
	let mut names = Vec::new();
	if let Some(modifier) = modifier {
		names.push(format!("{base}@{modifier}"));
	}
	names.push(base.to_owned());
	if language != base {
		if let Some(modifier) = modifier {
			names.push(format!("{language}@{modifier}"));
		}
		names.push(language.to_owned());
	}
	names
}

fn unescape(value: &str) -> CoreResult<String> {
	let mut output = String::with_capacity(value.len());
	let mut chars = value.chars();
	while let Some(character) = chars.next() {
		if character != '\\' {
			output.push(character);
			continue;
		}
		output.push(match chars.next() {
			Some('s') => ' ',
			Some('n') => '\n',
			Some('t') => '\t',
			Some('r') => '\r',
			Some('\\') => '\\',
			_ => return Err(invalid("invalid desktop-entry escape sequence")),
		});
	}
	Ok(output)
}

fn boolean(values: &HashMap<String, String>, key: &str) -> CoreResult<bool> {
	match values.get(key).map(String::as_str) {
		None | Some("false") => Ok(false),
		Some("true") => Ok(true),
		Some(_) => Err(invalid(format!("desktop-entry {key} must be true or false"))),
	}
}

fn read_entry(path: &Path, id: String) -> CoreResult<Entry> {
	if !path.is_absolute()
		|| path
			.extension()
			.is_none_or(|extension| extension != "desktop")
		|| !path.is_file()
	{
		return Err(invalid("Linux application paths must be absolute .desktop files"));
	}
	let text = fs::read_to_string(path)
		.map_err(|error| invalid(format!("cannot read {}: {error}", path.display())))?;
	let mut values = HashMap::new();
	let mut in_entry = false;
	let mut found_entry = false;
	for line in text.lines() {
		let line = line.trim();
		if line.is_empty() || line.starts_with('#') {
			continue;
		}
		if line.starts_with('[') && line.ends_with(']') {
			in_entry = line == "[Desktop Entry]";
			if in_entry && found_entry {
				return Err(invalid("duplicate Desktop Entry group"));
			}
			found_entry |= in_entry;
			continue;
		}
		if in_entry && let Some((key, value)) = line.split_once('=') {
			let key = key.trim().to_owned();
			if values.insert(key, value.trim().to_owned()).is_some() {
				return Err(invalid("duplicate desktop-entry key"));
			}
		}
	}
	if boolean(&values, "Hidden")? {
		return Err(invalid("desktop entry is hidden"));
	}
	if values.get("Type").map(String::as_str) != Some("Application") {
		return Err(invalid("desktop entry is not Type=Application"));
	}
	let base_name = values
		.get("Name")
		.ok_or_else(|| invalid("desktop entry has no Name"))?;
	let name = locale_names()
		.iter()
		.find_map(|locale| values.get(&format!("Name[{locale}]")))
		.unwrap_or(base_name);
	let name = unescape(name)?;
	if name.is_empty() {
		return Err(invalid("desktop entry has an empty Name"));
	}
	let working_directory = values
		.get("Path")
		.map(|value| unescape(value))
		.transpose()?
		.filter(|value| !value.is_empty())
		.map(PathBuf::from);
	if working_directory
		.as_ref()
		.is_some_and(|path| !path.is_absolute())
	{
		return Err(invalid("desktop-entry Path must be absolute"));
	}
	if let Some(value) = values.get("TryExec") {
		let executable = unescape(value)?;
		resolve_executable(&executable, working_directory.as_deref()).ok_or_else(|| {
			invalid(format!("desktop-entry TryExec is not executable: {executable}"))
		})?;
	}
	Ok(Entry {
		id,
		path: path.to_owned(),
		name,
		icon: values
			.get("Icon")
			.map(|value| unescape(value))
			.transpose()?,
		exec: values.get("Exec").cloned(),
		working_directory,
		terminal: boolean(&values, "Terminal")?,
		dbus: boolean(&values, "DBusActivatable")?,
	})
}

fn resolve_executable(executable: &str, working_directory: Option<&Path>) -> Option<PathBuf> {
	fs::canonicalize(executable_path(executable, working_directory)?).ok()
}

fn executable_path(executable: &str, working_directory: Option<&Path>) -> Option<PathBuf> {
	if executable.is_empty() || executable.contains('\0') {
		return None;
	}
	let executable = Path::new(executable);
	let usable = |path: PathBuf| {
		let metadata = fs::metadata(&path).ok()?;
		(metadata.is_file() && metadata.permissions().mode() & 0o111 != 0).then_some(path)
	};
	if executable.is_absolute() {
		return usable(executable.to_owned());
	}
	if executable.components().count() != 1 {
		return None;
	}
	let cwd = working_directory
		.map(Path::to_owned)
		.or_else(|| env::current_dir().ok())?;
	env::split_paths(&env::var_os("PATH")?).find_map(|directory| {
		usable(if directory.is_absolute() {
			directory.join(executable)
		} else {
			cwd.join(directory).join(executable)
		})
	})
}

/// Parse the two escaping layers specified by the Desktop Entry specification,
/// not shell syntax. No environment expansion, globbing or command
/// substitution.
fn exec_argv(raw: &str, name: &str, icon: Option<&str>, path: &Path) -> CoreResult<Vec<String>> {
	let value = unescape(raw)?;
	let mut words: Vec<String> = Vec::new();
	let mut word = String::new();
	let mut quoted = false;
	let mut started = false;
	let mut chars = value.chars();
	while let Some(character) = chars.next() {
		match character {
			'"' => {
				quoted = !quoted;
				started = true;
			},
			'\\' => {
				let next = chars
					.next()
					.ok_or_else(|| invalid("trailing backslash in desktop Exec"))?;
				if quoted && !matches!(next, '"' | '`' | '$' | '\\') {
					return Err(invalid("invalid quoted escape in desktop Exec"));
				}
				word.push(next);
				started = true;
			},
			'%' if quoted => {
				return Err(invalid("desktop Exec field codes cannot appear inside quotes"));
			},
			character if !quoted && character.is_ascii_whitespace() => {
				if started {
					words.push(std::mem::take(&mut word));
					started = false;
				}
			},
			character
				if !quoted
					&& matches!(
						character,
						'\''
							| '>' | '<' | '~'
							| '|' | '&' | ';'
							| '$' | '*' | '?'
							| '#' | '(' | ')'
							| '`'
					) =>
			{
				return Err(invalid("reserved desktop Exec character must be double-quoted"));
			},
			'\0' => return Err(invalid("NUL in desktop Exec")),
			character => {
				word.push(character);
				started = true;
			},
		}
	}
	if quoted {
		return Err(invalid("unterminated quote in desktop Exec"));
	}
	if started {
		words.push(word);
	}
	let mut argv = Vec::with_capacity(words.len());
	let mut file_codes = 0;
	for (index, word) in words.into_iter().enumerate() {
		let mut expanded = String::with_capacity(word.len());
		let mut chars = word.chars();
		let mut removed = false;
		let mut icon_arguments = false;
		while let Some(character) = chars.next() {
			if character != '%' {
				expanded.push(character);
				continue;
			}
			let code = chars
				.next()
				.ok_or_else(|| invalid("incomplete desktop Exec field code"))?;
			if index == 0 && code != '%' {
				return Err(invalid("desktop Exec executable cannot contain field codes"));
			}
			match code {
				'%' => expanded.push('%'),
				'c' => expanded.push_str(name),
				'k' => expanded.push_str(&path.to_string_lossy()),
				'i' if word == "%i" => {
					icon_arguments = true;
				},
				'f' | 'u' => {
					file_codes += 1;
					removed = true;
				},
				'F' | 'U' if word.len() == 2 => {
					file_codes += 1;
					removed = true;
				},
				'd' | 'D' | 'n' | 'N' | 'v' | 'm' => {
					removed = true;
				},
				_ => {
					return Err(invalid(format!(
						"unsupported or misplaced desktop Exec field code %{code}"
					)));
				},
			}
		}
		if icon_arguments {
			if let Some(icon) = icon.filter(|icon| !icon.is_empty()) {
				argv.push("--icon".to_owned());
				argv.push(icon.to_owned());
			}
		} else if !removed || !expanded.is_empty() {
			argv.push(expanded);
		}
	}
	if file_codes > 1 {
		return Err(invalid("desktop Exec has more than one file/URL field code"));
	}
	if argv.first().is_none_or(String::is_empty) {
		return Err(invalid("desktop entry has no executable"));
	}
	Ok(argv)
}

impl Entry {
	fn argv(&self) -> CoreResult<Vec<String>> {
		let exec = self.exec.as_deref().ok_or_else(|| {
			if self.dbus {
				DesktopError::unsupported(
					"this D-Bus-only entry has no Exec command for direct or terminal launching",
				)
			} else {
				invalid("desktop entry has no Exec")
			}
		})?;
		exec_argv(exec, &self.name, self.icon.as_deref(), &self.path)
	}

	fn executable(&self) -> Option<PathBuf> {
		let argv = self.argv().ok()?;
		resolve_executable(&argv[0], self.working_directory.as_deref())
	}

	fn dbus_address(&self) -> CoreResult<(&str, String)> {
		let name = self
			.path
			.file_stem()
			.and_then(|name| name.to_str())
			.ok_or_else(|| invalid("D-Bus desktop filename must be UTF-8"))?;
		zbus::names::WellKnownName::try_from(name)
			.map_err(|error| invalid(format!("invalid D-Bus desktop application name: {error}")))?;
		let path = format!("/{}", name.replace('.', "/").replace('-', "_"));
		zbus::zvariant::ObjectPath::try_from(path.as_str()).map_err(|error| {
			invalid(format!("invalid D-Bus desktop application object path: {error}"))
		})?;
		Ok((name, path))
	}

	fn bus_pid(&self, connection: &BusConnection) -> Option<u32> {
		if !self.dbus {
			return None;
		}
		let (name, _) = self.dbus_address().ok()?;
		// Resolve a unique owner first: neither query activates the application,
		// and a replacement well-known owner cannot redirect the PID query.
		let owner: String = connection
			.call_method(
				Some("org.freedesktop.DBus"),
				"/org/freedesktop/DBus",
				Some("org.freedesktop.DBus"),
				"GetNameOwner",
				&(name,),
			)
			.ok()?
			.body()
			.deserialize()
			.ok()?;
		let pid: u32 = connection
			.call_method(
				Some("org.freedesktop.DBus"),
				"/org/freedesktop/DBus",
				Some("org.freedesktop.DBus"),
				"GetConnectionUnixProcessID",
				&(owner,),
			)
			.ok()?
			.body()
			.deserialize()
			.ok()?;
		(pid != 0).then_some(pid)
	}

	fn activate_dbus(&self, connection: &BusConnection, activate: bool) -> CoreResult<bool> {
		let (name, path) = self.dbus_address()?;
		let startup = background_startup_id();
		let mut platform: HashMap<&str, zbus::zvariant::Value<'_>> = HashMap::new();
		if !activate {
			platform.insert("desktop-startup-id", zbus::zvariant::Value::from(startup.as_str()));
		}
		// Never forward an unrelated inherited Wayland activation token. The
		// timestamp-zero hint is advisory, including for D-Bus Activate.
		match connection.call_method(
			Some(name),
			path.as_str(),
			Some("org.freedesktop.Application"),
			"Activate",
			&(platform,),
		) {
			Ok(_) => Ok(true),
			Err(zbus::Error::MethodError(error, ..))
				if self.exec.is_some()
					&& matches!(
						error.as_str(),
						"org.freedesktop.DBus.Error.ServiceUnknown"
							| "org.freedesktop.DBus.Error.Spawn.ServiceNotFound"
							| "org.freedesktop.DBus.Error.UnknownMethod"
							| "org.freedesktop.DBus.Error.UnknownObject"
							| "org.freedesktop.DBus.Error.UnknownInterface"
					) =>
			{
				Ok(false)
			},
			// Do not double-launch on ambiguous timeouts or transport failures:
			// the application might already have processed Activate.
			Err(error) => {
				Err(DesktopError::unsupported(format!("D-Bus activation of {name} failed: {error}")))
			},
		}
	}

	fn application(
		&self,
		processes: &HashMap<PathBuf, Vec<u32>>,
		bus: Option<&BusConnection>,
	) -> Application {
		let pid = bus.and_then(|bus| self.bus_pid(bus)).or_else(|| {
			self
				.executable()
				.and_then(|exe| processes.get(&exe).and_then(|pids| pids.first()).copied())
		});
		Application {
			id: self.id.clone(),
			name: self.name.clone(),
			path: self.path.to_string_lossy().into_owned(),
			running: pid.is_some(),
			pid,
		}
	}
}

fn processes() -> HashMap<PathBuf, Vec<u32>> {
	let mut processes: HashMap<PathBuf, Vec<u32>> = HashMap::new();
	if let Ok(entries) = fs::read_dir("/proc") {
		for entry in entries.flatten() {
			let Some(pid) = entry
				.file_name()
				.to_str()
				.and_then(|name| name.parse::<u32>().ok())
			else {
				continue;
			};
			if let Ok(exe) = fs::read_link(entry.path().join("exe")) {
				processes.entry(exe).or_default().push(pid);
			}
		}
	}
	for pids in processes.values_mut() {
		pids.sort_unstable();
	}
	processes
}

#[allow(
	clippy::unnecessary_wraps,
	reason = "uniform CoreResult signature shared with the macOS/Windows backends"
)]
pub(super) fn list() -> CoreResult<Vec<Application>> {
	let processes = processes();
	let bus = BusConnection::session().ok();
	let mut seen = HashSet::new();
	let mut applications = Vec::new();
	for root in data_roots() {
		let mut files = Vec::new();
		desktop_files(&root, &mut files);
		files.sort();
		for path in files {
			let id = desktop_id(&root, &path);
			// Reserve IDs before parsing: Hidden=true is a tombstone, not a
			// reason to rediscover the lower-precedence system entry.
			if !seen.insert(id.clone()) {
				continue;
			}
			if let Ok(entry) = read_entry(&path, id) {
				applications.push(entry.application(&processes, bus.as_ref()));
			}
		}
	}
	applications.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
	Ok(applications)
}

pub(super) fn from_path(path: &Path) -> CoreResult<Application> {
	let id = data_roots()
		.iter()
		.find(|root| path.starts_with(root))
		.map_or_else(|| path.to_string_lossy().into_owned(), |root| desktop_id(root, path));
	let bus = BusConnection::session().ok();
	Ok(read_entry(path, id)?.application(&processes(), bus.as_ref()))
}

pub(super) fn open(app: Application, activate: bool) -> CoreResult<Application> {
	let entry = read_entry(Path::new(&app.path), app.id)?;
	// Preflight before launching: XWayland cannot activate arbitrary native
	// Wayland windows, and Wayland tokens require an originating user gesture.
	let activation = activate.then(Activation::connect).transpose()?;
	let bus = BusConnection::session();
	let current = entry.application(&processes(), bus.as_ref().ok());
	let executable = entry.executable();
	if current.running {
		if let Some(activation) = activation {
			activation.activate(executable.as_deref(), current.pid, entry.terminal)?;
		}
		return Ok(current);
	}
	if entry.dbus && !entry.terminal {
		match bus.as_ref() {
			Ok(bus) => {
				if entry.activate_dbus(bus, activate)? {
					let application = entry.application(&processes(), Some(bus));
					if let Some(activation) = activation {
						activation.activate(executable.as_deref(), application.pid, false)?;
					}
					return Ok(application);
				}
			},
			Err(error) if entry.exec.is_none() => {
				return Err(DesktopError::unsupported(format!(
					"D-Bus-only application requires a session bus: {error}"
				)));
			},
			Err(_) => {}, // The entry's own Exec is its non-D-Bus fallback.
		}
	}
	let argv = entry.argv()?;
	let executable = executable
		.ok_or_else(|| invalid(format!("desktop Exec executable is unavailable: {}", argv[0])))?;
	// Preserve the entry's actual executable spelling and argv[0]. Launching
	// the canonical /proc identity would change symlink/multicall semantics.
	let mut command = if entry.terminal {
		terminal_command(&entry, &argv)?
	} else {
		let mut command = Command::new(&argv[0]);
		command.args(&argv[1..]);
		command
	};
	command
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null());
	if let Some(directory) = &entry.working_directory {
		command.current_dir(directory);
	}
	command
		.env_remove("XDG_ACTIVATION_TOKEN")
		.env_remove("DESKTOP_STARTUP_ID");
	if !activate {
		command.env("DESKTOP_STARTUP_ID", background_startup_id());
	}
	let mut child = command
		.spawn()
		.map_err(|error| invalid(format!("cannot launch {}: {error}", entry.path.display())))?;
	// Reap even daemonizing launchers without blocking the caller or inventing
	// a long-lived PID for their eventual application process.
	thread::spawn(move || {
		let _ = child.wait();
	});
	if let Some(activation) = activation {
		activation.activate(Some(&executable), None, entry.terminal)?;
	}
	Ok(entry.application(&processes(), bus.as_ref().ok()))
}

fn background_startup_id() -> String {
	let nonce = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_nanos();
	format!("pi-{}-{nonce}_TIME0", std::process::id())
}

/// Delegate selection to the installed standard helper, not a guessed emulator.
/// Debian's configured system alternative has the documented execvp-style -e
/// contract; it is used only when the XDG selector is absent.
fn terminal_command(entry: &Entry, argv: &[String]) -> CoreResult<Command> {
	let executable = executable_path(&argv[0], entry.working_directory.as_deref())
		.ok_or_else(|| invalid("terminal application executable is unavailable"))?;
	if let Some(helper) = resolve_executable("xdg-terminal-exec", None) {
		let selected = Command::new(&helper)
			.arg("--print-id")
			.env_remove("XDG_ACTIVATION_TOKEN")
			.env_remove("DESKTOP_STARTUP_ID")
			.stdin(Stdio::null())
			.output()
			.map_err(|error| {
				DesktopError::unsupported(format!("cannot query configured XDG terminal: {error}"))
			})?;
		if !selected.status.success() || selected.stdout.iter().all(u8::is_ascii_whitespace) {
			return Err(DesktopError::unsupported(format!(
				"no usable terminal configured for xdg-terminal-exec: {}",
				String::from_utf8_lossy(&selected.stderr).trim(),
			)));
		}
		let mut command = Command::new(helper);
		if let Some(directory) = &entry.working_directory {
			command.arg(format!("--dir={}", directory.display()));
		}
		command.arg("--").arg(&executable).args(&argv[1..]);
		return Ok(command);
	}
	let alternative = Path::new("/usr/bin/x-terminal-emulator");
	if alternative.is_file()
		&& fs::metadata(alternative).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
	{
		let mut command = Command::new(alternative);
		command.arg("-e").arg(&executable).args(&argv[1..]);
		return Ok(command);
	}
	Err(DesktopError::unsupported(
		"Terminal=true requires an installed/configured xdg-terminal-exec or \
		 /usr/bin/x-terminal-emulator system alternative",
	))
}

struct Activation {
	connection: RustConnection,
	root:       Window,
	active:     Atom,
	clients:    Atom,
	pid:        Atom,
}

fn x11_error(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::unsupported(format!("X11 application activation unavailable: {error}"))
}

impl Activation {
	fn connect() -> CoreResult<Self> {
		if env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty())
			|| env::var("XDG_SESSION_TYPE").is_ok_and(|value| value.eq_ignore_ascii_case("wayland"))
		{
			return Err(DesktopError::unsupported(
				"activate=true is unavailable on Wayland without a compositor-issued user-gesture \
				 activation token; application was not launched",
			));
		}
		let (connection, screen) = x11rb::connect(None).map_err(x11_error)?;
		let root = connection.setup().roots[screen].root;
		let atom = |name: &[u8]| -> CoreResult<Atom> {
			Ok(connection
				.intern_atom(false, name)
				.map_err(x11_error)?
				.reply()
				.map_err(x11_error)?
				.atom)
		};
		let active = atom(b"_NET_ACTIVE_WINDOW")?;
		let clients = atom(b"_NET_CLIENT_LIST")?;
		let pid = atom(b"_NET_WM_PID")?;
		let supported = atom(b"_NET_SUPPORTED")?;
		let wm_check = atom(b"_NET_SUPPORTING_WM_CHECK")?;
		let wm = connection
			.get_property(false, root, wm_check, AtomEnum::WINDOW, 0, 1)
			.map_err(x11_error)?
			.reply()
			.map_err(x11_error)?
			.value32()
			.and_then(|mut values| values.next())
			.ok_or_else(|| {
				DesktopError::unsupported(
					"activate=true requires a live EWMH window manager; application was not launched",
				)
			})?;
		let check = connection
			.get_property(false, wm, wm_check, AtomEnum::WINDOW, 0, 1)
			.map_err(x11_error)?
			.reply()
			.map_err(x11_error)?;
		if check.value32().and_then(|mut values| values.next()) != Some(wm) {
			return Err(DesktopError::unsupported(
				"activate=true requires a live EWMH window manager; application was not launched",
			));
		}
		let values = connection
			.get_property(false, root, supported, AtomEnum::ATOM, 0, u32::MAX)
			.map_err(x11_error)?
			.reply()
			.map_err(x11_error)?;
		let supported: Vec<_> = values.value32().into_iter().flatten().collect();
		if !supported.contains(&active) || !supported.contains(&clients) {
			return Err(DesktopError::unsupported(
				"activate=true requires an EWMH window manager supporting _NET_ACTIVE_WINDOW and \
				 _NET_CLIENT_LIST; application was not launched",
			));
		}
		Ok(Self { connection, root, active, clients, pid })
	}

	fn property(&self, window: Window, property: Atom, kind: AtomEnum) -> CoreResult<Vec<u32>> {
		let reply = self
			.connection
			.get_property(false, window, property, kind, 0, u32::MAX)
			.map_err(x11_error)?
			.reply()
			.map_err(x11_error)?;
		Ok(reply.value32().into_iter().flatten().collect())
	}

	fn activate(
		&self,
		executable: Option<&Path>,
		known_pid: Option<u32>,
		terminal: bool,
	) -> CoreResult<()> {
		let deadline = Instant::now() + Duration::from_secs(5);
		let window = loop {
			let mut application_pids = Vec::new();
			if let Some(pid) = known_pid {
				application_pids.push(pid);
			}
			if terminal {
				if let Some(pids) = executable.and_then(|executable| processes().remove(executable)) {
					application_pids.extend(pids);
				}
				// Terminal windows belong to the emulator, not the command it
				// runs. Only verified /proc ancestors are eligible for focus.
				for index in 0..application_pids.len() {
					let mut current = application_pids[index];
					for _ in 0..64 {
						let Ok(stat) = fs::read_to_string(format!("/proc/{current}/stat")) else {
							break;
						};
						let Some((_, fields)) = stat.rsplit_once(')') else {
							break;
						};
						let Some(parent) = fields
							.split_ascii_whitespace()
							.nth(1)
							.and_then(|value| value.parse::<u32>().ok())
						else {
							break;
						};
						if parent <= 1 || parent == current {
							break;
						}
						application_pids.push(parent);
						current = parent;
					}
				}
			}
			let clients = self.property(self.root, self.clients, AtomEnum::WINDOW)?;
			let window = clients.into_iter().find(|&window| {
				let Ok(pids) = self.property(window, self.pid, AtomEnum::CARDINAL) else {
					return false;
				};
				pids.first().is_some_and(|pid| {
					application_pids.contains(pid)
						|| executable.is_some_and(|executable| {
							fs::read_link(format!("/proc/{pid}/exe")).is_ok_and(|path| path == executable)
						})
				})
			});
			if let Some(window) = window {
				break window;
			}
			if Instant::now() >= deadline {
				return Err(DesktopError::timeout(
					"application is launched/running, but no X11 window with a verifiable executable \
					 PID appeared; wrappers and sandboxed applications may not expose one",
				));
			}
			thread::sleep(Duration::from_millis(50));
		};
		let current = self
			.property(self.root, self.active, AtomEnum::WINDOW)?
			.first()
			.copied()
			.unwrap_or(0);
		let event =
			ClientMessageEvent::new(32, window, self.active, [2, x11rb::CURRENT_TIME, current, 0, 0]);
		self
			.connection
			.send_event(
				false,
				self.root,
				EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
				event,
			)
			.map_err(x11_error)?
			.check()
			.map_err(x11_error)?;
		self.connection.flush().map_err(x11_error)?;
		let deadline = Instant::now() + Duration::from_secs(1);
		loop {
			if self
				.property(self.root, self.active, AtomEnum::WINDOW)?
				.first() == Some(&window)
			{
				return Ok(());
			}
			if Instant::now() >= deadline {
				return Err(DesktopError::timeout(
					"application is running, but the X11 window manager did not honor its activation \
					 request",
				));
			}
			thread::sleep(Duration::from_millis(25));
		}
	}
}

#[cfg(test)]
mod tests {
	use std::path::Path;

	use super::exec_argv;

	fn parse(value: &str) -> super::CoreResult<Vec<String>> {
		exec_argv(
			value,
			"Display Name",
			Some("icon with spaces"),
			Path::new("/apps/test app.desktop"),
		)
	}

	#[test]
	fn expands_desktop_fields_without_splitting_values() {
		assert_eq!(parse("/usr/bin/example %c %i %k %U %%").unwrap(), [
			"/usr/bin/example",
			"Display Name",
			"--icon",
			"icon with spaces",
			"/apps/test app.desktop",
			"%",
		]);
	}

	#[test]
	fn preserves_quoted_arguments_and_empty_arguments() {
		assert_eq!(parse(r#""/opt/App Suite/app" "two words" """#).unwrap(), [
			"/opt/App Suite/app",
			"two words",
			""
		]);
	}

	#[test]
	fn applies_desktop_and_exec_backslash_layers() {
		assert_eq!(parse(r#"app "a\\"b" "c\\\\d" "\\$HOME""#).unwrap(), [
			"app", "a\"b", "c\\d", "$HOME"
		]);
	}

	#[test]
	fn rejects_shell_operators_and_malformed_fields() {
		for value in [
			"app ; touch /tmp/file",
			"app $(command)",
			"app 'single quoted'",
			"app %Z",
			"app %",
			"app prefix%F",
			"app %f %U",
			"app \"%c\"",
			"app \"unterminated",
			r"app \q",
		] {
			assert!(parse(value).is_err(), "{value}");
		}
	}

	#[test]
	fn shell_text_is_only_a_literal_argument() {
		assert_eq!(parse(r#"app "$(touch /tmp/file); * | >""#).unwrap(), [
			"app",
			"$(touch /tmp/file); * | >"
		]);
	}

	#[test]
	fn removes_absent_inputs_and_deprecated_codes() {
		assert_eq!(parse("app %f %d %D %n %N %v %m").unwrap(), ["app"]);
		assert_eq!(exec_argv("app %i", "Name", None, Path::new("/app.desktop")).unwrap(), ["app"]);
	}
}
