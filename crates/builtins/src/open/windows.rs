//! Windows: `open` and `start` through `ShellExecuteExW`.
//!
//! The shell opens a target as a double click in Explorer would; `-a` names
//! the program to run instead (found as `ShellExecuteExW` finds one: a path,
//! an App Paths registration, or `PATH`), `-b` an application user model ID,
//! and `-R` selects the files in an Explorer window. A program started this
//! way inherits pi's environment and standard handles, which is why `--env`
//! and the stream options are refused.
//!
//! [`Start`] is `cmd.exe`'s `START`, which no program on `PATH` provides.

use std::{
	ffi::{OsStr, OsString, c_void},
	io,
	os::windows::ffi::{OsStrExt as _, OsStringExt as _},
	path::{Path, PathBuf},
	ptr,
};

use clap::Parser;
use windows_sys::Win32::{
	Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
	System::{
		Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize},
		StationsAndDesktops::{
			GetProcessWindowStation, GetUserObjectInformationW, UOI_FLAGS, USEROBJECTFLAGS,
		},
		Threading::{
			ABOVE_NORMAL_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS, GetExitCodeProcess,
			HIGH_PRIORITY_CLASS, IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, REALTIME_PRIORITY_CLASS,
			SetPriorityClass, WaitForSingleObject,
		},
	},
	UI::{
		Shell::{
			ASSOCF_NONE, ASSOCSTR_EXECUTABLE, AssocQueryStringW, ILCreateFromPathW, ILFree,
			SEE_MASK_FLAG_NO_UI, SEE_MASK_NO_CONSOLE, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
			SHELLEXECUTEINFOW, SHOpenFolderAndSelectItems, ShellExecuteExW,
		},
		WindowsAndMessaging::{
			SW_SHOWMAXIMIZED, SW_SHOWMINIMIZED, SW_SHOWMINNOACTIVE, SW_SHOWNOACTIVATE, SW_SHOWNORMAL,
			WSF_VISIBLE,
		},
	},
};

use super::{CANCELLED_STATUS, Opener, Request, Target, Unopenable};
use crate::host::{Host, Utility};

/// How long one wait on a process lasts before the shell's cancellation is
/// looked for, in milliseconds.
const POLL_MS: u32 = 50;

/// `text` as a NUL-terminated UTF-16 string.
fn wide(text: &OsStr) -> Vec<u16> {
	text.encode_wide().chain(std::iter::once(0)).collect()
}

/// Whether this process has a desktop a user can see: a service, or a session
/// started without one (OpenSSH), has a window station nothing is shown on.
fn interactive() -> bool {
	let mut flags = USEROBJECTFLAGS::default();
	let mut needed = 0u32;
	// SAFETY: the station handle belongs to the process and is not closed;
	// `flags` is a writable `USEROBJECTFLAGS` of the size passed.
	unsafe {
		let station = GetProcessWindowStation();
		!station.is_null()
			&& GetUserObjectInformationW(
				station,
				UOI_FLAGS,
				(&raw mut flags).cast::<c_void>(),
				size_of::<USEROBJECTFLAGS>() as u32,
				&raw mut needed,
			) != 0
			&& flags.dwFlags & WSF_VISIBLE as u32 != 0
	}
}

/// The single-threaded COM apartment the shell's verbs run in, left on drop.
struct Apartment {
	entered: bool,
}

impl Apartment {
	fn enter() -> Self {
		// SAFETY: plain initialization of this thread; a thread already in
		// another apartment keeps it and reports failure.
		let status = unsafe {
			CoInitializeEx(ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32)
		};
		Self { entered: status >= 0 }
	}
}

impl Drop for Apartment {
	fn drop(&mut self) {
		if self.entered {
			// SAFETY: balances the successful `CoInitializeEx` of `enter`.
			unsafe { CoUninitialize() };
		}
	}
}

/// A process handle `ShellExecuteExW` returned, closed on drop.
struct Process(HANDLE);

impl Drop for Process {
	fn drop(&mut self) {
		// SAFETY: the handle is owned and still open.
		unsafe { CloseHandle(self.0) };
	}
}

impl Process {
	/// Blocks until the process exits and returns its exit code; `None` once
	/// the shell cancels the command.
	fn wait(&self, host: &Host) -> Option<u32> {
		loop {
			// SAFETY: the handle is open for the life of `self`.
			match unsafe { WaitForSingleObject(self.0, POLL_MS) } {
				WAIT_OBJECT_0 => {
					let mut code = 0u32;
					// SAFETY: as above; `code` is writable.
					unsafe { GetExitCodeProcess(self.0, &raw mut code) };
					return Some(code);
				},
				WAIT_TIMEOUT if host.is_cancelled() => return None,
				WAIT_TIMEOUT => {},
				_ => return Some(1),
			}
		}
	}
}

/// One `ShellExecuteExW` call.
struct Launch<'a> {
	/// The file, folder, URL or program.
	file:         &'a OsStr,
	/// The program's command line after its name; empty for none.
	parameters:   &'a str,
	directory:    Option<&'a Path>,
	/// The `SW_*` state of the first window.
	show:         i32,
	/// `start /B`: no console window of its own.
	same_console: bool,
	/// Keep the process, to wait for it or set its priority.
	keep:         bool,
}

impl Launch<'_> {
	/// Asks the shell to open the file; the process is returned when
	/// [`Launch::keep`] asked for it and the shell started one.
	fn execute(&self) -> io::Result<Option<Process>> {
		let file = wide(self.file);
		let parameters = wide(OsStr::new(self.parameters));
		let directory = self.directory.map(|directory| wide(directory.as_os_str()));
		let mut mask = SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
		if self.keep {
			mask |= SEE_MASK_NOCLOSEPROCESS;
		}
		if self.same_console {
			mask |= SEE_MASK_NO_CONSOLE;
		}
		let mut info = SHELLEXECUTEINFOW {
			cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
			fMask: mask,
			lpFile: file.as_ptr(),
			lpParameters: if self.parameters.is_empty() { ptr::null() } else { parameters.as_ptr() },
			lpDirectory: directory.as_ref().map_or(ptr::null(), |directory| directory.as_ptr()),
			nShow: self.show,
			..Default::default()
		};
		// SAFETY: every string is NUL-terminated UTF-16 that outlives the call,
		// and `info` is fully initialized with its own size.
		if unsafe { ShellExecuteExW(&raw mut info) } == 0 {
			return Err(io::Error::last_os_error());
		}
		Ok((!info.hProcess.is_null()).then(|| Process(info.hProcess)))
	}
}

/// Appends `argument` to the command line `line`, quoted so the C runtime's
/// argument parser reads it back as one argument.
fn push_argument(line: &mut String, argument: &str) {
	if !line.is_empty() {
		line.push(' ');
	}
	if !argument.is_empty() && !argument.contains([' ', '\t', '"']) {
		line.push_str(argument);
		return;
	}
	line.push('"');
	let mut backslashes = 0;
	for c in argument.chars() {
		if c == '\\' {
			backslashes += 1;
			continue;
		}
		// Backslashes are literal unless a quote follows them.
		if c == '"' {
			line.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
		} else {
			line.extend(std::iter::repeat_n('\\', backslashes));
		}
		line.push(c);
		backslashes = 0;
	}
	line.extend(std::iter::repeat_n('\\', backslashes * 2));
	line.push('"');
}

/// `-t`: the program registered for `.txt`, else Notepad.
fn text_editor() -> OsString {
	let extension = wide(OsStr::new(".txt"));
	let mut program = [0u16; 1024];
	let mut length = program.len() as u32;
	// SAFETY: the extension is NUL-terminated; `program` is writable for
	// `length` characters.
	let status = unsafe {
		AssocQueryStringW(
			ASSOCF_NONE,
			ASSOCSTR_EXECUTABLE,
			extension.as_ptr(),
			ptr::null(),
			program.as_mut_ptr(),
			&raw mut length,
		)
	};
	// On success the length counts the terminating NUL.
	if status == 0 && length > 1 {
		OsString::from_wide(&program[..length as usize - 1])
	} else {
		OsString::from("notepad.exe")
	}
}

/// `-R`: an Explorer window on the folder of `path`, with it selected.
fn reveal(path: &Path) -> io::Result<()> {
	let path = wide(path.as_os_str());
	// SAFETY: the path is NUL-terminated; the item list is freed below, after
	// the call that borrows it.
	unsafe {
		let item = ILCreateFromPathW(path.as_ptr());
		if item.is_null() {
			return Err(io::ErrorKind::NotFound.into());
		}
		let status = SHOpenFolderAndSelectItems(item, 0, ptr::null(), 0);
		ILFree(item);
		if status < 0 { Err(io::Error::from_raw_os_error(status)) } else { Ok(()) }
	}
}

/// The shell's working directory, when it is a host directory.
fn working_directory(host: &Host) -> Option<PathBuf> {
	host
		.fs()
		.is_native_local(host.cwd())
		.then(|| host.cwd().to_path_buf())
}

/// Carries out `request`, reporting failures on the command's stderr, and
/// returns the exit status.
pub(super) fn run(request: &Request, host: &mut Host) -> i32 {
	let refused = [
		(request.header.is_some(), "-h: SDK header search is only available on macOS"),
		(request.arch.is_some(), "--arch: only available on macOS"),
		(!request.env.is_empty(), "--env: not available on Windows"),
		(
			request.stdio.iter().any(Option::is_some),
			"--stdin, --stdout and --stderr: not available on Windows",
		),
	];
	if let Some((_, message)) = refused.iter().find(|(asked, _)| *asked) {
		return super::fail(host, message, 1);
	}
	if !interactive() {
		return super::fail(host, "no interactive desktop session", 1);
	}
	let _apartment = Apartment::enter();
	if request.reveal {
		for target in &request.targets {
			if let Target::File(path) = target
				&& let Err(err) = reveal(path)
			{
				return super::fail(host, format!("Unable to reveal {}: {err}", path.display()), 1);
			}
		}
		return 0;
	}
	let directory = working_directory(host);
	let show = if request.hide {
		SW_SHOWMINNOACTIVE
	} else if request.background {
		SW_SHOWNOACTIVATE
	} else {
		SW_SHOWNORMAL
	};
	let application: Option<OsString> = match &request.opener {
		Opener::Default => None,
		Opener::Named(name) => {
			let path = host.resolve(name);
			Some(if name.contains(['/', '\\']) && path.exists() {
				path.into_os_string()
			} else {
				OsString::from(name)
			})
		},
		Opener::Bundle(id) => Some(OsString::from(format!("shell:AppsFolder\\{id}"))),
		Opener::TextEdit => Some(OsString::from("notepad.exe")),
		Opener::TextEditor => Some(text_editor()),
	};
	let mut parameters = String::new();
	let mut files: Vec<OsString> = Vec::new();
	match application {
		Some(application) => {
			for target in &request.targets {
				push_argument(&mut parameters, &target.to_string());
			}
			files.push(application);
		},
		None => files.extend(request.targets.iter().map(|target| match target {
			Target::File(path) => path.clone().into_os_string(),
			Target::Url(url) => OsString::from(url),
		})),
	}
	for argument in &request.args {
		push_argument(&mut parameters, argument);
	}
	let mut processes = Vec::new();
	let mut status = 0;
	for file in &files {
		let launch = Launch {
			file,
			parameters: &parameters,
			directory: directory.as_deref(),
			show,
			same_console: false,
			keep: request.wait,
		};
		match launch.execute() {
			Ok(process) => processes.extend(process),
			Err(err) => {
				host.error(format!("{}: {err}", file.display()), 1);
				status = 1;
			},
		}
	}
	for process in &processes {
		if process.wait(host).is_none() {
			return CANCELLED_STATUS;
		}
	}
	status
}

/// Parsed `start` invocation: `cmd.exe`'s `START`.
#[derive(Parser, Debug)]
#[command(
	name = "start",
	about = "Start a program, or open a file, folder or URL.",
	override_usage = "start [\"title\"] [/D path] [/MIN] [/MAX] [/WAIT] [/B] [/LOW | /NORMAL | /HIGH | \
	                  /REALTIME | /ABOVENORMAL | /BELOWNORMAL] [command] [parameters]",
	disable_help_flag = true,
	disable_version_flag = true
)]
pub(crate) struct Start {
	/// Print help.
	#[allow(dead_code, reason = "clap consumes help before options are inspected")]
	#[arg(long = "help", action = clap::ArgAction::Help)]
	help: Option<bool>,

	/// The switches, title, command and parameters, as `START` takes them.
	#[arg(value_name = "word", trailing_var_arg = true, allow_hyphen_values = true)]
	words: Vec<String>,
}

/// A `START` command line, taken apart.
#[derive(Debug, PartialEq, Eq)]
struct StartLine {
	/// `/D`: the directory to start in.
	directory:    Option<String>,
	/// `/MIN`, `/MAX`: the `SW_*` state of the first window.
	show:         i32,
	/// `/WAIT`.
	wait:         bool,
	/// `/B`.
	same_console: bool,
	/// The priority class a priority switch names.
	priority:     Option<u32>,
	/// What to start; `None` starts a command prompt.
	command:      Option<String>,
	parameters:   Vec<String>,
}

/// Takes `words` apart as `START` does. `cmd.exe` knows the window title by
/// its quotes, which the shell has already removed: here the first word is the
/// title when it is empty, or when more words follow and `opens` says it
/// names nothing to start. Switches end at the command; everything after it
/// is the command's.
fn start_line(words: Vec<String>, opens: impl Fn(&str) -> bool) -> StartLine {
	let mut line = StartLine {
		directory:    None,
		show:         SW_SHOWNORMAL,
		wait:         false,
		same_console: false,
		priority:     None,
		command:      None,
		parameters:   Vec::new(),
	};
	let mut title_taken = false;
	let mut words = words.into_iter().peekable();
	while let Some(word) = words.next() {
		if let Some(switch) = word.strip_prefix('/') {
			match switch.to_ascii_uppercase().as_str() {
				"MIN" => line.show = SW_SHOWMINIMIZED,
				"MAX" => line.show = SW_SHOWMAXIMIZED,
				"WAIT" | "W" => line.wait = true,
				"B" => line.same_console = true,
				"I" | "SEPARATE" | "SHARED" => {},
				"LOW" => line.priority = Some(IDLE_PRIORITY_CLASS),
				"NORMAL" => line.priority = Some(NORMAL_PRIORITY_CLASS),
				"HIGH" => line.priority = Some(HIGH_PRIORITY_CLASS),
				"REALTIME" => line.priority = Some(REALTIME_PRIORITY_CLASS),
				"ABOVENORMAL" => line.priority = Some(ABOVE_NORMAL_PRIORITY_CLASS),
				"BELOWNORMAL" => line.priority = Some(BELOW_NORMAL_PRIORITY_CLASS),
				"D" => line.directory = words.next(),
				"NODE" | "AFFINITY" | "MACHINE" => {
					words.next();
				},
				// Not a switch: a path the shell spells with a leading slash.
				_ => {
					line.command = Some(word);
					line.parameters = words.collect();
					break;
				},
			}
			continue;
		}
		if !title_taken && (word.is_empty() || (words.peek().is_some() && !opens(&word))) {
			title_taken = true;
			continue;
		}
		line.command = Some(word);
		line.parameters = words.collect();
		break;
	}
	line
}

/// Whether `word` names something `START` can start: a file or folder, a URL,
/// or a program on `PATH`.
fn opens(host: &Host, word: &str) -> bool {
	const EXTENSIONS: [&str; 5] = ["", ".exe", ".cmd", ".bat", ".com"];
	let path = host.resolve(word);
	if omp_vfs::is_virtual_path(&path) || path.exists() || super::reads_as_url(word) {
		return true;
	}
	host.var("PATH").is_some_and(|path| {
		std::env::split_paths(path).any(|dir| {
			EXTENSIONS
				.iter()
				.any(|extension| dir.join(format!("{word}{extension}")).is_file())
		})
	})
}

impl Utility for Start {
	const NAME: &'static str = "start";

	/// `start /?` is `START`'s own spelling of `--help`.
	fn rewrite_argv(mut argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		if let Some(first) = argv.get_mut(1)
			&& first.as_os_str() == "/?"
		{
			*first = OsString::from("--help");
		}
		Ok(argv)
	}

	fn run(self, host: &mut Host) -> i32 {
		let line = start_line(self.words, |word| opens(host, word));
		if !interactive() {
			return super::fail(host, "no interactive desktop session", 1);
		}
		let file = match &line.command {
			None => OsString::from("cmd.exe"),
			Some(command) => match super::target(host.fs(), command, host.resolve(command)) {
				Ok(Target::File(path)) => path.into_os_string(),
				Err(Unopenable::Other(message)) => return super::fail(host, message, 1),
				// A program for the shell to find, or a URL.
				Ok(Target::Url(_)) | Err(Unopenable::Missing(_)) => OsString::from(command),
			},
		};
		let directory = match &line.directory {
			Some(directory) => Some(host.resolve(directory)),
			None => working_directory(host),
		};
		let mut parameters = String::new();
		for parameter in &line.parameters {
			push_argument(&mut parameters, parameter);
		}
		let _apartment = Apartment::enter();
		let launch = Launch {
			file:         &file,
			parameters:   &parameters,
			directory:    directory.as_deref(),
			show:         line.show,
			same_console: line.same_console,
			keep:         line.wait || line.priority.is_some(),
		};
		let process = match launch.execute() {
			Ok(process) => process,
			Err(err) => return super::fail(host, format!("{}: {err}", file.display()), 1),
		};
		let Some(process) = process else {
			return 0;
		};
		if let Some(priority) = line.priority {
			// SAFETY: the handle is open for the life of `process`.
			unsafe { SetPriorityClass(process.0, priority) };
		}
		if !line.wait {
			return 0;
		}
		match process.wait(host) {
			Some(code) => code as i32,
			None => CANCELLED_STATUS,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn words(words: &[&str]) -> Vec<String> {
		words.iter().map(ToString::to_string).collect()
	}

	/// Failure mode: `start "" page.html` tries to run the empty title, a
	/// title is run as the program, or a program's own `/switch` is consumed.
	#[test]
	fn start_separates_title_switches_and_command() {
		let known = |word: &str| matches!(word, "notepad" | "page.html");
		let line = start_line(words(&["", "/d", "C:\\work", "/MIN", "/wait", "notepad", "/A", "x y"]), known);
		assert_eq!(line, StartLine {
			directory:    Some("C:\\work".into()),
			show:         SW_SHOWMINIMIZED,
			wait:         true,
			same_console: false,
			priority:     None,
			command:      Some("notepad".into()),
			parameters:   words(&["/A", "x y"]),
		});
		let titled = start_line(words(&["My Title", "/B", "/high", "page.html"]), known);
		assert_eq!(titled.command.as_deref(), Some("page.html"));
		assert!(titled.same_console);
		assert_eq!(titled.priority, Some(HIGH_PRIORITY_CLASS));
		// Something to start is never taken for a title, nor is a lone word.
		assert_eq!(start_line(words(&["notepad", "page.html"]), known).command.as_deref(), Some("notepad"));
		assert_eq!(start_line(words(&["unknown"]), known).command.as_deref(), Some("unknown"));
		assert_eq!(start_line(words(&["/c/Users/me/page.html"]), known).command.as_deref(), Some("/c/Users/me/page.html"));
		assert_eq!(start_line(Vec::new(), known).command, None);
	}

	/// Failure mode: a file name with spaces or quotes reaches the program
	/// split into several arguments.
	#[test]
	fn arguments_are_quoted_for_the_c_runtime() {
		let mut line = String::new();
		for argument in ["plain", "two words", "", r#"say "hi""#, r"C:\dir with space\", r"a\b"] {
			push_argument(&mut line, argument);
		}
		assert_eq!(line, r#"plain "two words" "" "say \"hi\"" "C:\dir with space\\" a\b"#);
	}
}
