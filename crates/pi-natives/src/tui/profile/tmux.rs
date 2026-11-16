//! tmux queries and side effects: the attached client's terminal names and
//! SIXEL support, the pane's passthrough allowance, the `@tern-tsp` session
//! option, and the pane's APC titles. Each runs the `tmux` client found on the
//! environment's `PATH` against the session that environment names.

use std::{
	ffi::OsString,
	io::Read,
	path::PathBuf,
	process::{Command, Stdio},
	sync::{Mutex, OnceLock},
	thread,
	time::{Duration, Instant},
};

use super::{Env, multiplexer::Multiplexer};

/// One `tmux display-message` round trip over the server socket, which
/// answers in single-digit milliseconds when healthy. 500ms kept losing the
/// race on a loaded machine (fork/exec of the tmux client alone can exceed it
/// on a saturated box), and a lost race is indistinguishable from "not tmux":
/// the process then falls back to the true-color profile for the whole
/// session. 2s bounds the startup stall only when tmux is genuinely wedged.
const CLIENT_TERMINAL_TIMEOUT: Duration = Duration::from_secs(2);
const COMMAND_TIMEOUT: Duration = Duration::from_millis(500);

/// Wrap a control sequence in tmux's DCS passthrough envelope.
pub fn wrap_passthrough(payload: &str) -> String {
	let mut out = String::with_capacity(payload.len() + 16);
	out.push_str("\x1bPtmux;");
	for ch in payload.chars() {
		if ch == '\x1b' {
			out.push('\x1b');
		}
		out.push(ch);
	}
	out.push_str("\x1b\\");
	out
}

/// Client `TERM` values that name their emulator; tmux records this on every
/// version.
const CLIENT_TERMNAME_PROGRAMS: [(&str, &str); 4] = [
	("xterm-kitty", "kitty"),
	("xterm-ghostty", "ghostty"),
	("xterm-rex", "rex"),
	("wezterm", "wezterm"),
];

/// Emulator name candidates from a `#{client_termtype}<TAB>#{client_termname}`
/// line, best first: the terminal-type reply (tmux 3.4+, XTVERSION), then the
/// emulator the client's `TERM` names when it ships its own terminfo entry.
/// Both are kept because the reply can name an unrecognized program (a nested
/// tmux answers `tmux 3.4`) while `TERM` still identifies the emulator.
pub fn client_programs_from_report(report: &str) -> Vec<String> {
	// Split before trimming: an empty terminal type leaves the line starting
	// with the tab.
	let mut fields = report.split('\t');
	let termtype = fields.next().unwrap_or_default().trim();
	let termname = fields
		.next()
		.unwrap_or_default()
		.trim()
		.to_ascii_lowercase();
	let mut programs = Vec::new();
	// `^[A-Za-z][A-Za-z0-9._+-]*` followed by whitespace, `(`, or the end.
	let end = termtype
		.find(|ch: char| !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '+' | '-')))
		.unwrap_or(termtype.len());
	let (name, rest) = termtype.split_at(end);
	if name.starts_with(|ch: char| ch.is_ascii_alphabetic())
		&& (rest.is_empty() || rest.starts_with(|ch: char| ch.is_whitespace() || ch == '('))
	{
		programs.push(name.to_owned());
	}
	if let Some(&(_, program)) = CLIENT_TERMNAME_PROGRAMS
		.iter()
		.find(|(term, _)| *term == termname)
	{
		programs.push(program.to_owned());
	}
	programs
}

/// Resolve the terminal emulator names recorded for this tmux client, best
/// first.
///
/// tmux overwrites pane identity variables with its own values, but retains
/// the attached client's terminal-type reply in `#{client_termtype}` and its
/// `TERM` in `#{client_termname}` (see [`client_programs_from_report`]). The
/// local IPC query runs once per process and degrades to nothing when
/// unavailable; the test runtime never runs it.
pub fn client_terminal_names(env: &Env, test_runtime: bool) -> &'static [String] {
	static NAMES: OnceLock<Vec<String>> = OnceLock::new();
	if !Multiplexer::Tmux.is_inside(env) || test_runtime {
		return &[];
	}
	NAMES.get_or_init(|| {
		run(
			env,
			&["display-message", "-p", "#{client_termtype}\t#{client_termname}"],
			CLIENT_TERMINAL_TIMEOUT,
		)
		.map_or_default(|report| client_programs_from_report(&report))
	})
}

/// Whether the terminal hosting this tmux session draws TSP programs
/// natively: it sets the session user option `@tern-tsp` while it watches the
/// session.
pub fn session_speaks_tsp(env: &Env) -> bool {
	run(env, &["show-options", "-qv", "@tern-tsp"], COMMAND_TIMEOUT)
		.is_some_and(|value| !value.trim().is_empty())
}

/// Stop (`on` false) or restore (`on` true) tmux turning this pane's APC
/// strings into its title, which would otherwise swallow every TSP message.
pub fn set_pane_apc_titles(on: bool, env: &Env) {
	let Some(pane) = env.get("TMUX_PANE").filter(|pane| !pane.is_empty()) else {
		return;
	};
	let args: &[&str] = if on {
		&["set-option", "-pu", "-t", pane, "allow-set-title"]
	} else {
		&["set-option", "-p", "-t", pane, "allow-set-title", "off"]
	};
	run(env, args, COMMAND_TIMEOUT);
}

/// Whether tmux draws SIXEL to the client attached to this session: its
/// effective terminal description for that client carries `Sxl`.
///
/// A tmux built with SIXEL answers every pane's DA1 with attribute 4 and draws
/// a `SIXEL IMAGE (WxH)` text placeholder for clients without SIXEL, so the
/// pane's DA1 says nothing about the outer terminal. tmux itself renders SIXEL
/// only when the client's terminal has `Sxl`, whether from terminfo,
/// `terminal-overrides`, or the `sixel` feature (DA1 or `terminal-features`),
/// and `show-messages -T` reports that merged description. Queried once per
/// tmux session; `false` outside tmux, with no attached client, or when the
/// query fails. Nested tmux usually reports no `Sxl`: the inner client's
/// terminal is the outer tmux, whose DA1 starts with level 1, which tmux does
/// not parse for features.
pub fn client_renders_sixel(env: &Env) -> bool {
	static CACHE: Mutex<Option<(String, bool)>> = Mutex::new(None);
	let Some(tmux) = env.get("TMUX").filter(|tmux| !tmux.is_empty()) else {
		return false;
	};
	cached(&CACHE, tmux, || {
		let Some(client) = run(env, &["display-message", "-p", "#{client_name}"], COMMAND_TIMEOUT)
		else {
			return false;
		};
		let client = client.trim();
		if client.is_empty() {
			return false;
		}
		run(env, &["show-messages", "-T", "-t", client], COMMAND_TIMEOUT)
			.is_some_and(|messages| messages.lines().any(is_sixel_capability))
	})
}

/// `^\s*\d+: Sxl: \(flag\) true$`.
fn is_sixel_capability(line: &str) -> bool {
	let line = line.trim_start();
	let digits = line.bytes().take_while(u8::is_ascii_digit).count();
	digits > 0 && &line[digits..] == ": Sxl: (flag) true"
}

/// Whether tmux forwards this pane's `\x1bPtmux;…\x1b\\` passthrough
/// envelopes to the attached client. tmux 3.3+ defaults `allow-passthrough`
/// to `off` and then silently drops every wrapped sequence, so Kitty graphics
/// sent through the envelope never reach a Kitty-capable outer terminal.
/// Resolves the effective pane value (pane → window → global). Queried once
/// per pane; `false` outside tmux or when the query fails.
pub fn pane_allows_passthrough(env: &Env) -> bool {
	static CACHE: Mutex<Option<(String, bool)>> = Mutex::new(None);
	let Some(tmux) = env.get("TMUX").filter(|tmux| !tmux.is_empty()) else {
		return false;
	};
	let pane = env.get("TMUX_PANE").unwrap_or_default();
	let key = format!("{tmux}\0{pane}");
	cached(&CACHE, &key, || {
		let mut args = vec!["show-options", "-Apqv"];
		if !pane.is_empty() {
			args.extend(["-t", pane]);
		}
		args.push("allow-passthrough");
		// tmux before 3.3 has no `allow-passthrough` option (`-q` prints
		// nothing) and always forwards DCS passthrough.
		run(env, &args, COMMAND_TIMEOUT)
			.is_some_and(|value| matches!(value.trim(), "" | "on" | "all"))
	})
}

/// The cached answer for `key`, computing (and caching) it on a miss.
fn cached(
	cache: &Mutex<Option<(String, bool)>>,
	key: &str,
	compute: impl FnOnce() -> bool,
) -> bool {
	if let Some((cached_key, value)) = &*cache.lock().unwrap_or_else(|err| err.into_inner())
		&& cached_key == key
	{
		return *value;
	}
	let value = compute();
	*cache.lock().unwrap_or_else(|err| err.into_inner()) = Some((key.to_owned(), value));
	value
}

/// Run a tmux command against the session `env` names; its stdout, or `None`
/// when tmux is missing, fails, or outlives `timeout` (then it is killed).
fn run(env: &Env, args: &[&str], timeout: Duration) -> Option<String> {
	let tmux = which("tmux", env)?;
	let mut child = Command::new(tmux)
		.args(args)
		.env_clear()
		.envs(env.iter())
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::null())
		.spawn()
		.ok()?;
	let mut stdout = child.stdout.take()?;
	// Drain on a thread so a chatty reply cannot fill the pipe and stall the
	// child past its deadline.
	let reader = thread::spawn(move || {
		let mut out = Vec::new();
		let _ = stdout.read_to_end(&mut out);
		out
	});
	let deadline = Instant::now() + timeout;
	let status = loop {
		match child.try_wait() {
			Ok(Some(status)) => break status,
			Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(1)),
			_ => {
				let _ = child.kill();
				let _ = child.wait();
				return None;
			},
		}
	};
	let out = reader.join().ok()?;
	status
		.success()
		.then(|| String::from_utf8_lossy(&out).into_owned())
}

/// Locate `name` on the environment's `PATH` (the process `PATH` when the
/// environment has none).
pub(super) fn which(name: &str, env: &Env) -> Option<PathBuf> {
	let path = env
		.get("PATH")
		.map_or_else(|| std::env::var_os("PATH"), |path| Some(OsString::from(path)))?;
	std::env::split_paths(&path).find_map(|dir| executable(dir.join(name)))
}

#[cfg(unix)]
fn executable(path: PathBuf) -> Option<PathBuf> {
	use std::os::unix::fs::PermissionsExt;
	let meta = std::fs::metadata(&path).ok()?;
	(meta.is_file() && meta.permissions().mode() & 0o111 != 0).then_some(path)
}

#[cfg(windows)]
fn executable(path: PathBuf) -> Option<PathBuf> {
	if path.extension().is_some() && path.is_file() {
		return Some(path);
	}
	let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned());
	exts
		.split(';')
		.filter(|ext| !ext.is_empty())
		.find_map(|ext| {
			let mut candidate = path.clone().into_os_string();
			candidate.push(ext);
			let candidate = PathBuf::from(candidate);
			candidate.is_file().then_some(candidate)
		})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn wraps_passthrough_with_doubled_escapes() {
		assert_eq!(
			wrap_passthrough("\x1b]99;;Hello\x1b\\"),
			"\x1bPtmux;\x1b\x1b]99;;Hello\x1b\x1b\\\x1b\\"
		);
		assert_eq!(
			wrap_passthrough("\x1b_Gpayload\x1b\\"),
			"\x1bPtmux;\x1b\x1b_Gpayload\x1b\x1b\\\x1b\\"
		);
	}

	#[test]
	fn reads_client_programs_from_the_report() {
		assert_eq!(
			client_programs_from_report("WezTerm 20260905-175422-0f4b5596\ttmux-256color\n"),
			["WezTerm"]
		);
		assert_eq!(client_programs_from_report("tmux 3.4\txterm-kitty\n"), ["tmux", "kitty"]);
		assert_eq!(client_programs_from_report("\txterm-ghostty"), ["ghostty"]);
		assert_eq!(client_programs_from_report("iTerm2(3.5)\tXTERM-REX"), ["iTerm2", "rex"]);
		assert!(client_programs_from_report("3dterm\tscreen").is_empty());
		assert!(client_programs_from_report("bad/name\t").is_empty());
	}

	#[test]
	fn recognizes_the_sixel_capability_line() {
		assert!(is_sixel_capability(" 216: Sxl: (flag) true"));
		assert!(!is_sixel_capability(" 216: Sxl: [missing]"));
		assert!(!is_sixel_capability("Sxl: (flag) true"));
	}

	#[test]
	fn outside_tmux_nothing_runs() {
		let env = Env::of(&[("PATH", "/nonexistent")]);
		assert!(client_terminal_names(&env, false).is_empty());
		assert!(!client_renders_sixel(&env));
		assert!(!pane_allows_passthrough(&env));
	}
}
