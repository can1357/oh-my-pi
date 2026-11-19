//! Linux: `open` as `xdg-open` and `gio open` do it.
//!
//! A target goes to its default application, found through [`xdg`] and
//! started here: over D-Bus when its desktop entry asks for that, else as the
//! entry's `Exec` command, detached from the shell. Inside a Flatpak or Snap
//! sandbox, or when no application is registered, the desktop portal opens
//! it; a URL nothing else takes goes to `$BROWSER`. `-R` asks the file manager
//! to show the files (`org.freedesktop.FileManager1`).
//!
//! Without a display there is no desktop to ask: only `$BROWSER` (a remote
//! session's URL forwarder) can open anything, and only URLs.

use std::{
	collections::HashMap,
	fs::{File, OpenOptions},
	os::{
		fd::AsFd as _,
		unix::{fs::PermissionsExt as _, process::CommandExt as _},
	},
	path::{Path, PathBuf},
	process::{Child, Command, Stdio},
	time::Duration,
};

use zbus::{
	blocking::{Connection, connection::Builder},
	names::WellKnownName,
	zvariant::{Fd, Value},
};

use super::{
	CANCELLED_STATUS, MISSING_STATUS, Opener, Request, Target,
	xdg::{self, Dirs, Entry},
};
use crate::host::Host;

/// `xdg-open`'s exit status when nothing is there to open the target with.
const NO_HANDLER: i32 = 3;
/// `xdg-open`'s exit status when opening failed.
const FAILED: i32 = 4;

/// How often `-W` looks for the shell's cancellation.
const POLL: Duration = Duration::from_millis(50);

/// How long a D-Bus service gets to answer.
const BUS_TIMEOUT: Duration = Duration::from_secs(5);

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const PORTAL_OPEN_URI: &str = "org.freedesktop.portal.OpenURI";
const FILE_MANAGER: &str = "org.freedesktop.FileManager1";
const FILE_MANAGER_PATH: &str = "/org/freedesktop/FileManager1";

/// Carries out `request`, reporting failures on the command's stderr, and
/// returns the exit status.
pub(super) fn run(request: &Request, host: &mut Host) -> i32 {
	if request.header.is_some() {
		return super::fail(host, "-h: SDK header search is only available on macOS", 1);
	}
	if request.arch.is_some() {
		return super::fail(host, "--arch: only available on macOS", 1);
	}
	let mut desktop = Desktop::new(request, host);
	if let Err(failure) = desktop.open() {
		desktop.detach();
		return super::fail(host, failure.message, failure.status);
	}
	if request.wait {
		desktop.wait(host)
	} else {
		desktop.detach();
		0
	}
}

#[cfg(test)]
mod tests {
	use std::{fs, path::Path};

	use super::super::run_open;

	/// A script that waits, then writes its last argument and `$EXTRA` to
	/// `$OUT`; returned as the `sh` command line that runs it.
	fn recorder(dir: &Path) -> String {
		let script = dir.join("record.sh");
		fs::write(&script, "sleep 0.3\nfor last; do :; done\nprintf '%s|%s\\n' \"$last\" \"$EXTRA\" > \"$OUT\"\n")
			.expect("script");
		format!("sh {}", script.display())
	}

	/// Failure mode: the registered default application is not the one
	/// started, it gets no file, `--env` does not reach it, or `-W` returns
	/// before it exits.
	#[test]
	fn the_default_application_is_started_on_the_file_and_waited_for() {
		let dir = tempfile::tempdir().expect("tempdir");
		let dir = dir.path().canonicalize().expect("canonical tempdir");
		let config = dir.join("config");
		let data = dir.join("data");
		fs::create_dir_all(data.join("applications")).expect("applications");
		fs::create_dir_all(&config).expect("config");
		fs::write(
			data.join("applications/recorder.desktop"),
			format!("[Desktop Entry]\nType=Application\nName=Recorder\nExec={} --file %f\n", recorder(&dir)),
		)
		.expect("desktop entry");
		fs::write(config.join("mimeapps.list"), "[Default Applications]\ntext/plain=recorder.desktop\n")
			.expect("mimeapps.list");
		fs::write(dir.join("note"), "plain text\n").expect("note");
		let out = dir.join("out.txt");
		let (code, err) = run_open(
			&["-W", "--env", &format!("OUT={}", out.display()), "--env", "EXTRA=from --env", "note"],
			&[
				("DISPLAY", ":0"),
				("PATH", "/usr/bin:/bin"),
				("XDG_CONFIG_HOME", config.to_str().expect("utf-8 path")),
				("XDG_CONFIG_DIRS", "/nonexistent/etc"),
				("XDG_DATA_HOME", data.to_str().expect("utf-8 path")),
				("XDG_DATA_DIRS", "/nonexistent/share"),
			],
			&dir,
		);
		assert_eq!((code, err.as_str()), (0, ""));
		assert_eq!(
			fs::read_to_string(&out).expect("recorder output"),
			format!("{}|from --env\n", dir.join("note").display())
		);
	}

	/// Failure mode: with no display, `open` hangs or reports success for
	/// something nobody will see; and a remote session's `$BROWSER` forwarder
	/// must still get URLs.
	#[test]
	fn without_a_display_only_browser_opens_urls() {
		let dir = tempfile::tempdir().expect("tempdir");
		let dir = dir.path().canonicalize().expect("canonical tempdir");
		let (code, err) = run_open(&["/"], &[("PATH", "/usr/bin:/bin")], &dir);
		assert_eq!(
			(code, err.as_str()),
			(3, "open: no graphical session (DISPLAY and WAYLAND_DISPLAY are unset)\n")
		);
		let out = dir.join("out.txt");
		let (code, err) = run_open(&["-W", "https://example.com/a?b=c"], &[
			("PATH", "/usr/bin:/bin"),
			("BROWSER", &recorder(&dir)),
			("OUT", out.to_str().expect("utf-8 path")),
		], &dir);
		assert_eq!((code, err.as_str()), (0, ""));
		assert_eq!(fs::read_to_string(&out).expect("recorder output"), "https://example.com/a?b=c|\n");
		// A file is nothing a URL forwarder can show.
		assert_eq!(run_open(&["/"], &[("PATH", "/usr/bin:/bin"), ("BROWSER", "true")], &dir).0, 3);
	}
}

/// Why a request could not be carried out.
struct Failure {
	status:  i32,
	message: String,
}

fn no_handler(message: impl Into<String>) -> Failure {
	Failure { status: NO_HANDLER, message: message.into() }
}

fn failed(message: impl Into<String>) -> Failure {
	Failure { status: FAILED, message: message.into() }
}

/// One request against the desktop session of the shell's environment.
struct Desktop<'a> {
	request:     &'a Request,
	dirs:        Dirs,
	/// The shell's exported environment, then `--env`'s additions.
	env:         Vec<(String, String)>,
	/// The shell's working directory, when it is a host directory.
	cwd:         Option<PathBuf>,
	/// The shell's `PATH`.
	path:        Option<String>,
	browser:     Option<String>,
	terminal:    Option<String>,
	/// The shell's `DBUS_SESSION_BUS_ADDRESS`.
	bus_address: Option<String>,
	/// A display to open windows on.
	graphical:   bool,
	/// Inside a Flatpak or Snap sandbox, where only the portal reaches the
	/// desktop's applications.
	sandboxed:   bool,
	/// The programs started so far.
	children:    Vec<Child>,
}

impl<'a> Desktop<'a> {
	fn new(request: &'a Request, host: &Host) -> Self {
		let var = |name: &str| host.var(name).filter(|value| !value.is_empty());
		let owned = |name: &str| var(name).map(str::to_owned);
		let mut env: Vec<(String, String)> = host
			.env()
			.map(|(name, value)| (name.to_owned(), value.to_owned()))
			.collect();
		env.extend(request.env.iter().cloned());
		Self {
			request,
			dirs: Dirs::from_env(&var),
			env,
			cwd: host
				.fs()
				.is_native_local(host.cwd())
				.then(|| host.cwd().to_path_buf()),
			path: owned("PATH"),
			browser: owned("BROWSER"),
			terminal: owned("TERMINAL"),
			bus_address: owned("DBUS_SESSION_BUS_ADDRESS"),
			graphical: var("DISPLAY").is_some() || var("WAYLAND_DISPLAY").is_some(),
			sandboxed: var("SNAP").is_some() || Path::new("/.flatpak-info").exists(),
			children: Vec::new(),
		}
	}

	fn open(&mut self) -> Result<(), Failure> {
		let request = self.request;
		// A `file://` URL is the file it names.
		let mut targets = Vec::with_capacity(request.targets.len());
		for target in &request.targets {
			match target {
				Target::Url(url) => match xdg::file_url_path(url) {
					Some(path) if path.symlink_metadata().is_ok() => targets.push(Target::File(path)),
					Some(path) => {
						return Err(Failure {
							status:  MISSING_STATUS,
							message: format!("The file {} does not exist.", path.display()),
						});
					},
					None => targets.push(target.clone()),
				},
				Target::File(_) => targets.push(target.clone()),
			}
		}
		if !self.graphical {
			return self.open_headless(&targets);
		}
		if request.reveal {
			return self.reveal(&targets);
		}
		match &request.opener {
			Opener::Default => targets.iter().try_for_each(|target| self.open_default(target)),
			Opener::Named(name) => self.open_named(name, &targets),
			Opener::Bundle(id) => {
				let entry = self
					.dirs
					.desktop_file(id)
					.ok_or_else(|| no_handler(format!("Unable to find application with identifier '{id}'")))?;
				self.launch(&entry, &targets)
			},
			Opener::TextEdit | Opener::TextEditor => {
				let entry = self
					.dirs
					.handler("text/plain")
					.ok_or_else(|| no_handler("no application is registered for text/plain"))?;
				self.launch(&entry, &targets)
			},
		}
	}

	/// No display: the URLs go to `$BROWSER`, and nothing else can open.
	fn open_headless(&mut self, targets: &[Target]) -> Result<(), Failure> {
		let request = self.request;
		if let Some(browser) = self.browser.clone()
			&& request.opener == Opener::Default
			&& !request.reveal
			&& targets.iter().all(|target| matches!(target, Target::Url(_)))
		{
			return targets.iter().try_for_each(|target| self.browse(&browser, &target.to_url()));
		}
		Err(no_handler("no graphical session (DISPLAY and WAYLAND_DISPLAY are unset)"))
	}

	/// Opens `target` with its default application.
	fn open_default(&mut self, target: &Target) -> Result<(), Failure> {
		let mime = match target {
			Target::File(path) => self.dirs.mime_type(path),
			Target::Url(url) => {
				let scheme = url.split_once(':').map_or(url.as_str(), |(scheme, _)| scheme);
				format!("x-scheme-handler/{}", scheme.to_ascii_lowercase())
			},
		};
		if !self.sandboxed
			&& let Some(entry) = self.dirs.handler(&mime)
		{
			return self.launch(&entry, std::slice::from_ref(target));
		}
		if self.portal(target).is_ok() {
			return Ok(());
		}
		if let Target::Url(url) = target
			&& let Some(browser) = self.browser.clone()
		{
			return self.browse(&browser, url);
		}
		Err(no_handler(format!("no application is registered to open {target} ({mime})")))
	}

	/// `-a`: a desktop entry by path, ID or name, else a program.
	fn open_named(&mut self, name: &str, targets: &[Target]) -> Result<(), Failure> {
		if name.ends_with(".desktop")
			&& let Some(entry) = self.absolute(name).filter(|entry| entry.is_file())
		{
			return self.launch(&entry, targets);
		}
		if let Some(entry) = self.dirs.application(name) {
			return self.launch(&entry, targets);
		}
		if self.executable(name).is_none() {
			return Err(no_handler(format!("Unable to find application named '{name}'")));
		}
		let mut argv = Vec::with_capacity(1 + targets.len() + self.request.args.len());
		argv.push(name.to_owned());
		argv.extend(targets.iter().map(|target| match target {
			Target::File(path) => path.to_string_lossy().into_owned(),
			Target::Url(url) => url.clone(),
		}));
		argv.extend(self.request.args.iter().cloned());
		self.spawn(&argv, None)
	}

	/// Starts the application of the desktop entry `file` on `targets`.
	fn launch(&mut self, file: &Path, targets: &[Target]) -> Result<(), Failure> {
		let request = self.request;
		let entry = Entry::read(file).map_err(|err| failed(format!("{}: {err}", file.display())))?;
		// Only a program of our own can be waited for, or given arguments,
		// environment and standard streams.
		let plain = !request.wait
			&& request.args.is_empty()
			&& request.env.is_empty()
			&& request.stdio.iter().all(Option::is_none);
		if entry.dbus_activatable && !entry.terminal && plain {
			match self.activate(&entry, targets) {
				Ok(true) => return Ok(()),
				Ok(false) => {},
				Err(message) => return Err(failed(message)),
			}
		}
		for mut argv in entry.command_lines(targets, &request.args).map_err(failed)? {
			if entry.terminal {
				argv = self.in_terminal(argv)?;
			}
			self.spawn(&argv, entry.working_dir.as_deref())?;
		}
		Ok(())
	}

	/// Asks a D-Bus activatable application to open `targets`
	/// (`org.freedesktop.Application`). `Ok(false)` when it cannot be reached
	/// that way and its `Exec` should run instead.
	fn activate(&self, entry: &Entry, targets: &[Target]) -> Result<bool, String> {
		let id = entry.id();
		if WellKnownName::try_from(id.as_str()).is_err() {
			return Ok(false);
		}
		let Ok(bus) = self.bus() else {
			return if entry.has_exec() {
				Ok(false)
			} else {
				Err(format!("{id} is started over D-Bus, and there is no session bus"))
			};
		};
		let object = format!("/{}", id.replace('.', "/").replace('-', "_"));
		let platform: HashMap<&str, Value<'_>> = HashMap::new();
		let interface = Some("org.freedesktop.Application");
		let reply = if targets.is_empty() {
			bus.call_method(Some(id.as_str()), object.as_str(), interface, "Activate", &(platform,))
		} else {
			let uris: Vec<String> = targets.iter().map(Target::to_url).collect();
			bus.call_method(Some(id.as_str()), object.as_str(), interface, "Open", &(uris, platform))
		};
		match reply {
			Ok(_) => Ok(true),
			Err(zbus::Error::MethodError(error, ..))
				if entry.has_exec()
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
			// A timeout or a broken connection may hide a request that got
			// through: running `Exec` too would open everything twice.
			Err(err) => Err(format!("D-Bus activation of {id} failed: {err}")),
		}
	}

	/// The session bus of the shell's environment.
	fn bus(&self) -> zbus::Result<Connection> {
		let builder = match &self.bus_address {
			Some(address) => Builder::address(address.as_str())?,
			None => Builder::session()?,
		};
		builder.method_timeout(BUS_TIMEOUT).build()
	}

	/// Hands `target` to the desktop portal, which picks the application.
	fn portal(&self, target: &Target) -> Result<(), String> {
		let bus = self.bus().map_err(|err| err.to_string())?;
		let options: HashMap<&str, Value<'_>> = HashMap::new();
		let interface = Some(PORTAL_OPEN_URI);
		let reply = match target {
			Target::Url(url) => {
				bus.call_method(Some(PORTAL), PORTAL_PATH, interface, "OpenURI", &("", url.as_str(), options))
			},
			Target::File(path) => {
				let file = File::open(path).map_err(|err| err.to_string())?;
				bus.call_method(
					Some(PORTAL),
					PORTAL_PATH,
					interface,
					"OpenFile",
					&("", Fd::from(file.as_fd()), options),
				)
			},
		};
		reply.map(drop).map_err(|err| err.to_string())
	}

	/// `-R`: has the file manager show `targets` selected; with none on the
	/// bus, opens their folders.
	fn reveal(&mut self, targets: &[Target]) -> Result<(), Failure> {
		let uris: Vec<String> = targets.iter().map(Target::to_url).collect();
		if let Ok(bus) = self.bus()
			&& bus
				.call_method(
					Some(FILE_MANAGER),
					FILE_MANAGER_PATH,
					Some(FILE_MANAGER),
					"ShowItems",
					&(uris, ""),
				)
				.is_ok()
		{
			return Ok(());
		}
		let mut folders: Vec<&Path> = targets
			.iter()
			.filter_map(|target| match target {
				Target::File(path) => Some(path.parent().unwrap_or(path)),
				Target::Url(_) => None,
			})
			.collect();
		folders.sort_unstable();
		folders.dedup();
		folders
			.into_iter()
			.try_for_each(|folder| self.open_default(&Target::File(folder.to_path_buf())))
	}

	/// Runs the first `$BROWSER` command that starts, on `url`.
	fn browse(&mut self, browser: &str, url: &str) -> Result<(), Failure> {
		let started = xdg::browser_commands(browser, url)
			.iter()
			.any(|argv| self.spawn(argv, None).is_ok());
		if started {
			Ok(())
		} else {
			Err(no_handler(format!("no application is registered to open {url}")))
		}
	}

	/// `argv` as the command line of a terminal window running it, for a
	/// `Terminal=true` entry.
	fn in_terminal(&self, argv: Vec<String>) -> Result<Vec<String>, Failure> {
		let (terminal, flag) = if self.executable("xdg-terminal-exec").is_some() {
			("xdg-terminal-exec", "--")
		} else if self.executable("x-terminal-emulator").is_some() {
			("x-terminal-emulator", "-e")
		} else if let Some(terminal) = self.terminal.as_deref() {
			(terminal, "-e")
		} else {
			return Err(no_handler(format!("{}: needs a terminal, and none is installed", argv.join(" "))));
		};
		let mut wrapped = Vec::with_capacity(argv.len() + 2);
		wrapped.push(terminal.to_owned());
		wrapped.push(flag.to_owned());
		wrapped.extend(argv);
		Ok(wrapped)
	}

	/// `name` against the shell's working directory.
	fn absolute(&self, name: &str) -> Option<PathBuf> {
		let path = Path::new(name);
		if path.is_absolute() {
			Some(path.to_path_buf())
		} else {
			self.cwd.as_ref().map(|cwd| cwd.join(path))
		}
	}

	/// The program `name` runs: a path, or a name on the shell's `PATH`.
	fn executable(&self, name: &str) -> Option<PathBuf> {
		let runs = |path: &PathBuf| {
			path
				.metadata()
				.is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
		};
		if name.contains('/') {
			return self.absolute(name).filter(runs);
		}
		std::env::split_paths(self.path.as_deref()?)
			.map(|dir| dir.join(name))
			.find(runs)
	}

	/// Starts `argv` in its own session, with the shell's environment and the
	/// request's standard streams (the null device where it names none), in
	/// `directory` or else the shell's working directory.
	fn spawn(&mut self, argv: &[String], directory: Option<&Path>) -> Result<(), Failure> {
		let Some((name, arguments)) = argv.split_first() else {
			return Err(failed("nothing to run"));
		};
		let program = self
			.executable(name)
			.ok_or_else(|| no_handler(format!("{name}: command not found")))?;
		let mut command = Command::new(program);
		command
			.arg0(name)
			.args(arguments)
			.env_clear()
			.envs(self.env.iter().map(|(name, value)| (name, value)))
			.current_dir(directory.or(self.cwd.as_deref()).unwrap_or(Path::new("/")))
			.setsid(true);
		for (slot, path) in self.request.stdio.iter().enumerate() {
			let stream = match path {
				None => Stdio::null(),
				Some(path) => {
					let opened = if slot == 0 {
						File::open(path)
					} else {
						OpenOptions::new().create(true).append(true).open(path)
					};
					Stdio::from(opened.map_err(|err| failed(format!("{}: {err}", path.display())))?)
				},
			};
			match slot {
				0 => command.stdin(stream),
				1 => command.stdout(stream),
				_ => command.stderr(stream),
			};
		}
		let child = command.spawn().map_err(|err| failed(format!("{name}: {err}")))?;
		self.children.push(child);
		Ok(())
	}

	/// `-W`: blocks until every program started has exited; the shell's
	/// cancellation ends the wait, not the programs.
	fn wait(mut self, host: &Host) -> i32 {
		loop {
			self
				.children
				.retain_mut(|child| matches!(child.try_wait(), Ok(None)));
			if self.children.is_empty() {
				return 0;
			}
			if host.is_cancelled() {
				self.detach();
				return CANCELLED_STATUS;
			}
			std::thread::sleep(POLL);
		}
	}

	/// Leaves the programs started running, reaping them as they exit.
	fn detach(&mut self) {
		let mut children = std::mem::take(&mut self.children);
		if children.is_empty() {
			return;
		}
		std::thread::spawn(move || {
			for child in &mut children {
				let _ = child.wait();
			}
		});
	}
}
