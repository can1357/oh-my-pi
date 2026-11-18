//! `direnv` builtin: load and unload a directory's environment.
//!
//! A port of direnv 2.38.2 that keeps everything inside the shell: `.envrc`
//! files are evaluated by a new shell of the engine itself with direnv's
//! stdlib (`direnv-stdlib.txt`, upstream's `stdlib.sh`), the stdlib's calls
//! back into `direnv` reach this builtin again, and `direnv exec DIR COMMAND`
//! runs the command through the shell's own dispatch
//! ([`Host::run_command`]) with the loaded environment, so builtins stay
//! in-process and `scheme://` paths keep working.
//!
//! State is direnv's own and shared with the real program: the allow and
//! deny lists under `$XDG_DATA_HOME/direnv`, `direnv.toml` under
//! `$XDG_CONFIG_HOME/direnv`, the `fetchurl` store under
//! `$XDG_CACHE_HOME/direnv`, and the `DIRENV_DIFF`, `DIRENV_WATCHES`,
//! `DIRENV_FILE` and `DIRENV_DIR` variables a loaded environment carries.
//!
//! Where direnv prints a map in Go's random order (`export`, `dump`), this
//! prints in name order. An external program asked to hand its environment
//! back (`use nix`, `use flox`, `use guix`) runs the `direnv` found on
//! `PATH`, or `env -0` when there is none; `apply_dump` reads both.

mod dotenv;
mod shells;

use std::{
	collections::{BTreeMap, BTreeSet},
	ffi::OsString,
	fmt::Write as _,
	io::{self, Read as _, Write as _},
	path::Path,
	sync::mpsc,
	time::Duration,
};

use base64::Engine as _;
use omp_vfs::{FileTime as SetTime, OpenOptions};
use regex::Regex;
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use self::shells::{Change, SHELL_NAMES, Shell, bash_escape, json_map, json_string, json_value};
use crate::{
	host::{CommandStatus, Host, ShellCommand, Utility, strip_errno},
	time_zone::shell_time_zone,
};

/// The direnv release this is a port of; `direnv version` prints it.
const VERSION: &str = "2.38.2";
/// direnv's stdlib: upstream's `stdlib.sh` (MIT, © zimbatm and contributors),
/// with the three places that hand `direnv dump` to an external program
/// reading it from `__direnv_dump`.
const STDLIB: &str = include_str!("direnv-stdlib.txt");
/// What the stdlib's `direnv=` line holds until [`Run::stdlib`] names direnv.
const STDLIB_SELF: &str = "\"$(command -v direnv)\"";
/// What the stdlib's `__direnv_dump=` line holds until [`Run::stdlib`] picks
/// the command.
const STDLIB_DUMP: &str = "(\"$direnv\" dump)";
/// The dump command for an external program on a host without direnv.
const ENV_DUMP: &str = "(sh -c 'env -0 >\"$DIRENV_DUMP_FILE_PATH\"')";
/// Shell state a subshell of the caller sheds before it evaluates an
/// `.envrc`, which a new shell would not have.
const SUBSHELL_RESET: &str = "set +o errexit +o nounset +o pipefail +o noglob +o noclobber +o \
                              xtrace +o verbose\nIFS=$' \\t\\n'\n";

const ERROR_COLOR: &str = "\x1b[31m";
const CLEAR_COLOR: &str = "\x1b[0m";

const DIRENV_DIR: &str = "DIRENV_DIR";
const DIRENV_FILE: &str = "DIRENV_FILE";
const DIRENV_WATCHES: &str = "DIRENV_WATCHES";
const DIRENV_DIFF: &str = "DIRENV_DIFF";
const DIRENV_REQUIRED: &str = "DIRENV_REQUIRED";
const DIRENV_DUMP_FILE_PATH: &str = "DIRENV_DUMP_FILE_PATH";

/// An environment, in name order.
type Env = BTreeMap<String, String>;

/// A step that fails with the text direnv prints after `direnv: error `.
type Outcome<T = ()> = Result<T, String>;

/// Parsed `direnv` invocation: everything after the name is direnv's own
/// `COMMAND [...ARGS]`, options of the command to run included.
#[derive(clap::Parser)]
#[command(name = "direnv", disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct Direnv {
	#[arg(value_name = "COMMAND [...ARGS]", num_args = 0..)]
	args: Vec<OsString>,
}

impl Utility for Direnv {
	const NAME: &'static str = "direnv";
	const RUNS_COMMANDS: bool = true;

	/// Ends option parsing at the name: `--help`, `--version` and every word
	/// of `exec`'s command are direnv's to read.
	fn rewrite_argv(mut argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		argv.insert(argv.len().min(1), "--".into());
		Ok(argv)
	}

	fn run(self, host: &mut Host) -> i32 {
		let args: Vec<String> = self
			.args
			.iter()
			.map(|arg| arg.to_string_lossy().into_owned())
			.collect();
		let env = host
			.env()
			.map(|(name, value)| (name.to_owned(), value.to_owned()))
			.collect();
		let work_dir = physical_cwd(host);
		let mut run = Run { host, env, work_dir };
		match run.dispatch(&args) {
			Ok(code) => code,
			Err(message) => {
				let _ = writeln!(run.host.stderr, "{ERROR_COLOR}direnv: error {message}{CLEAR_COLOR}");
				1
			},
		}
	}
}

/// One subcommand, as `direnv help` lists it.
struct Command {
	name:    &'static str,
	args:    &'static str,
	aliases: &'static [&'static str],
	desc:    &'static str,
	/// Listed only by `direnv help SHOW_PRIVATE`.
	private: bool,
}

const fn public(
	name: &'static str,
	args: &'static str,
	aliases: &'static [&'static str],
	desc: &'static str,
) -> Command {
	Command { name, args, aliases, desc, private: false }
}

const fn private(name: &'static str, args: &'static str, desc: &'static str) -> Command {
	Command { name, args, aliases: &[], desc, private: true }
}

/// direnv's subcommands, in its help order.
const COMMANDS: [Command; 24] = [
	public(
		"allow",
		" [PATH_TO_RC]",
		&["permit", "grant"],
		"Grants direnv permission to load the given .envrc or .env file.",
	),
	private(
		"apply_dump",
		" FILE",
		"Accepts a filename containing `direnv dump` output and generates a series of bash export \
		 statements to apply the given env",
	),
	private("show_dump", " DUMP", "Show the data inside of a dump for debugging purposes"),
	private(
		"check-required",
		" SHELL ENVRC_PATH PATH...",
		"Checks if required files have been allowed",
	),
	public(
		"block",
		" [PATH_TO_RC]",
		&["deny", "disallow", "revoke"],
		"Revokes the authorization of a given .envrc or .env file.",
	),
	private(
		"dotenv",
		" [SHELL] [PATH_TO_DOTENV]",
		"Transforms a .env file to evaluatable `export KEY=PAIR` statements",
	),
	private(
		"dump",
		" [SHELL] [FILE]",
		"Used to export the inner bash state at the end of execution",
	),
	public(
		"edit",
		" [PATH_TO_RC]",
		&[],
		"Opens PATH_TO_RC or the current .envrc or .env into an $EDITOR and allow\n  the file to be \
		 loaded afterwards.",
	),
	public(
		"exec",
		" DIR COMMAND [...ARGS]",
		&[],
		"Executes a command after loading the first .envrc or .env found in DIR",
	),
	public(
		"export",
		" SHELL",
		&[],
		"Loads an .envrc or .env and prints the diff in terms of exports.\n  Supported SHELL values \
		 are: ",
	),
	public(
		"fetchurl",
		" <url> [<integrity-hash>]",
		&[],
		"Fetches a given URL into direnv's CAS",
	),
	public("help", " [SHOW_PRIVATE]", &["--help"], "Shows this help"),
	public("hook", " SHELL", &[], "Used to setup the shell hook"),
	public("prune", "", &[], "Removes old allowed and required files"),
	public("reload", "", &[], "Triggers an env reload"),
	public("status", " [--json]", &[], "Prints some debug status information"),
	public(
		"stdlib",
		"",
		&[],
		"Displays the stdlib available in the .envrc execution context",
	),
	public(
		"version",
		" [VERSION_AT_LEAST]",
		&["--version"],
		"prints the version or checks that direnv is no older than VERSION_AT_LEAST.",
	),
	private(
		"watch",
		" SHELL PATH...",
		"Adds a path to the list that direnv watches for changes",
	),
	private(
		"watch-dir",
		" SHELL DIR",
		"Recursively adds a directory to the list that direnv watches for changes",
	),
	private(
		"watch-list",
		" [SHELL]",
		"Pipe pairs of `mtime path` to stdin to build a list of files to watch.",
	),
	private("watch-print", " [--null]", "prints the watched paths"),
	private(
		"current",
		" PATH",
		"Reports whether direnv's view of a file is current (or stale)",
	),
	public("log", " [--status | --error] <message>", &[], "Logs a given message"),
];

/// direnv's configuration: where its state lives and what `direnv.toml`
/// sets.
struct Config {
	conf_dir:         String,
	cache_dir:        String,
	data_dir:         String,
	/// How direnv names itself in hooks and the stdlib: `DIRENV_EXE_PATH`,
	/// else `direnv`, which this shell resolves to the builtin.
	self_path:        String,
	bash_path:        String,
	hide_env_diff:    bool,
	disable_stdin:    bool,
	strict_env:       bool,
	load_dotenv:      bool,
	/// The status line format, `%s` standing for the message; empty logs
	/// nothing.
	log_format:       String,
	log_filter:       Option<Regex>,
	log_color:        bool,
	/// Nanoseconds before a slow `export` says so; none when not positive.
	warn_timeout:     i64,
	whitelist_prefix: Vec<String>,
	whitelist_exact:  BTreeSet<String>,
}

impl Config {
	fn allow_dir(&self) -> String {
		join(&self.data_dir, "allow")
	}

	fn deny_dir(&self) -> String {
		join(&self.data_dir, "deny")
	}

	fn allowed_required_dir(&self) -> String {
		join(&self.data_dir, "allowed-required")
	}
}

/// Whether an `.envrc` may load.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AllowStatus {
	Allowed    = 0,
	NotAllowed = 1,
	Denied     = 2,
}

/// An `.envrc` or `.env` file and its place in the allow and deny lists.
struct Rc {
	path:       String,
	allow_path: String,
	deny_path:  String,
	times:      FileTimes,
}

/// What direnv knew about one watched file when it loaded.
#[derive(Clone)]
struct FileTime {
	path:    String,
	modtime: i64,
	exists:  bool,
}

/// The watch list (`DIRENV_WATCHES`): a change to any entry reloads.
#[derive(Clone, Default)]
struct FileTimes(Vec<FileTime>);

impl FileTimes {
	/// Records the absolute `path` with `modtime`, replacing its entry.
	fn set(&mut self, path: String, modtime: i64, exists: bool) {
		match self.0.iter_mut().find(|time| time.path == path) {
			Some(time) => (time.modtime, time.exists) = (modtime, exists),
			None => self.0.push(FileTime { path, modtime, exists }),
		}
	}

	fn marshal(&self) -> String {
		let mut json = String::from("[");
		for (index, time) in self.0.iter().enumerate() {
			if index > 0 {
				json.push(',');
			}
			json.push_str("{\"path\":");
			json_string(&mut json, &time.path);
			let _ = write!(json, ",\"modtime\":{},\"exists\":{}}}", time.modtime, time.exists);
		}
		json.push(']');
		gzenv_encode(&json)
	}

	fn unmarshal(gzenv: &str) -> Outcome<Self> {
		let malformed = || "unmarshal() json parsing: not a list of file times".to_owned();
		let mut times = Vec::new();
		match gzenv_decode(gzenv)? {
			Value::Null => {},
			Value::Array(items) => {
				for item in &items {
					times.push(FileTime {
						path:    item["path"].as_str().unwrap_or_default().to_owned(),
						modtime: item["modtime"].as_i64().unwrap_or_default(),
						exists:  item["exists"].as_bool().unwrap_or_default(),
					});
				}
			},
			_ => return Err(malformed()),
		}
		Ok(Self(times))
	}

	/// The watch list `env` carries; empty when it carries none.
	fn from_env(env: &Env) -> Outcome<Self> {
		env.get(DIRENV_WATCHES).map_or_else(|| Ok(Self::default()), |watches| Self::unmarshal(watches))
	}
}

/// What changed between two environments (`DIRENV_DIFF`): the variables of
/// the first that the second lacks or changes, and the second's values that
/// are new or changed. Variables a shell owns never count.
struct EnvDiff {
	prev: Env,
	next: Env,
}

impl EnvDiff {
	fn between(from: &Env, to: &Env) -> Self {
		let changed = |a: &Env, b: &Env| -> Env {
			a.iter()
				.filter(|&(key, value)| !ignored_env(key) && b.get(key) != Some(value))
				.map(|(key, value)| (key.clone(), value.clone()))
				.collect()
		};
		Self { prev: changed(from, to), next: changed(to, from) }
	}

	fn load(gzenv: &str) -> Outcome<Self> {
		let value = gzenv_decode(gzenv)?;
		Ok(Self { prev: string_map(value.get("p"))?, next: string_map(value.get("n"))? })
	}

	fn serialize(&self) -> String {
		fn entries(env: &Env) -> Vec<Change<'_>> {
			env.iter().map(|(key, value)| (key.as_str(), Some(value.as_str()))).collect()
		}
		let mut json = String::from("{\"p\":");
		json_map(&mut json, &entries(&self.prev), false);
		json.push_str(",\"n\":");
		json_map(&mut json, &entries(&self.next), false);
		json.push('}');
		gzenv_encode(&json)
	}

	/// The sets and removals that apply the diff, in name order.
	fn changes(&self) -> Vec<Change<'_>> {
		let mut changes: BTreeMap<&str, Option<&str>> =
			self.prev.keys().map(|key| (key.as_str(), None)).collect();
		changes.extend(self.next.iter().map(|(key, value)| (key.as_str(), Some(value.as_str()))));
		changes.into_iter().collect()
	}

	/// `env` as it was before the diff applied.
	fn revert(&self, env: &Env) -> Env {
		let mut reverted: Env = env
			.iter()
			.filter(|&(key, _)| !self.next.contains_key(key))
			.map(|(key, value)| (key.clone(), value.clone()))
			.collect();
		reverted.extend(self.prev.iter().map(|(key, value)| (key.clone(), value.clone())));
		reverted
	}

	/// The `+NEW ~CHANGED -GONE` summary of the diff, direnv's own
	/// variables left out; empty when nothing else changed.
	fn status(&self) -> String {
		let own = |key: &str| key.starts_with("DIRENV_");
		let mut marks: Vec<String> = Vec::new();
		for key in self.prev.keys().filter(|key| !own(key) && !self.next.contains_key(*key)) {
			marks.push(format!("-{key}"));
		}
		for key in self.next.keys().filter(|key| !own(key)) {
			let mark = if self.prev.contains_key(key) { '~' } else { '+' };
			marks.push(format!("{mark}{key}"));
		}
		marks.sort_unstable();
		marks.join(" ")
	}
}

/// Whether `key` is a variable a shell owns, which direnv neither restores
/// nor exports.
fn ignored_env(key: &str) -> bool {
	key.starts_with("__fish")
		|| key.starts_with("BASH_FUNC_")
		|| matches!(
			key,
			"DIRENV_CONFIG"
				| "DIRENV_BASH"
				| "DIRENV_IN_ENVRC"
				| "COMP_WORDBREAKS"
				| "PS1"
				| "OLDPWD"
				| "PWD"
				| "SHELL"
				| "SHELLOPTS"
				| "SHLVL"
				| "_"
		)
}

/// Whether `key` is a variable the shell running a command maintains itself:
/// a loaded environment's copy of it must not replace the shell's.
fn shell_owned(key: &str) -> bool {
	matches!(key, "PWD" | "OLDPWD" | "SHLVL" | "SHELLOPTS" | "BASHOPTS" | "_")
}

/// `command` with the environment changes that take `current` to `target`.
fn with_env(mut command: ShellCommand, current: &Env, target: &Env) -> ShellCommand {
	for name in current.keys() {
		if !target.contains_key(name) && !shell_owned(name) {
			command = command.env_remove(name);
		}
	}
	for (name, value) in target {
		if current.get(name) != Some(value) && !shell_owned(name) && !name.is_empty() {
			command = command.env(name, value);
		}
	}
	command
}

/// `json` in direnv's `gzenv` encoding: zlib, then URL-safe base64.
fn gzenv_encode(json: &str) -> String {
	let mut encoder =
		flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
	// Writes into a `Vec` cannot fail.
	let _ = encoder.write_all(json.as_bytes());
	let compressed = encoder.finish().unwrap_or_default();
	base64::engine::general_purpose::URL_SAFE.encode(compressed)
}

/// The JSON document a `gzenv` string holds.
fn gzenv_decode(gzenv: &str) -> Outcome<Value> {
	let compressed = base64::engine::general_purpose::URL_SAFE
		.decode(gzenv.trim())
		.map_err(|err| format!("unmarshal() base64 decoding: {err}"))?;
	let mut json = Vec::new();
	flate2::read::ZlibDecoder::new(compressed.as_slice())
		.read_to_end(&mut json)
		.map_err(|err| format!("unmarshal() zlib decoding: {err}"))?;
	serde_json::from_slice(&json).map_err(|err| format!("unmarshal() json parsing: {err}"))
}

/// The JSON object `value` as an environment; a missing or `null` object is
/// empty, a `null` value an empty string.
fn string_map(value: Option<&Value>) -> Outcome<Env> {
	let wrong = || "unmarshal() json parsing: not a map of strings".to_owned();
	let mut env = Env::new();
	match value {
		None | Some(Value::Null) => {},
		Some(Value::Object(map)) => {
			for (key, value) in map {
				let value = match value {
					Value::String(value) => value.clone(),
					Value::Null => String::new(),
					_ => return Err(wrong()),
				};
				env.insert(key.clone(), value);
			}
		},
		Some(_) => return Err(wrong()),
	}
	Ok(env)
}

/// `path` as text; direnv's state names paths as strings.
fn lossy(path: &Path) -> String {
	path.to_string_lossy().into_owned()
}

/// `base/name`, lexically cleaned.
fn join(base: &str, name: &str) -> String {
	lossy(&omp_vfs::normalize_lexically(&Path::new(base).join(name)))
}

/// The directory of `path`: `.` for a bare name, the root for the root.
fn dirname(path: &str) -> String {
	match Path::new(path).parent() {
		Some(parent) if parent.as_os_str().is_empty() => ".".to_owned(),
		Some(parent) => lossy(parent),
		None => path.to_owned(),
	}
}

/// The shell's working directory with symlinks resolved, as a process that
/// ignores `PWD` sees it: allow-list entries are keyed on that path.
fn physical_cwd(host: &Host) -> String {
	#[cfg(unix)]
	if let Ok(real) = host.fs().canonicalize(host.cwd()) {
		return lossy(&real);
	}
	lossy(host.cwd())
}

/// `err` in the words Go's `os` package uses.
fn os_error(err: &io::Error) -> String {
	match err.kind() {
		io::ErrorKind::NotFound => "no such file or directory".to_owned(),
		io::ErrorKind::PermissionDenied => "permission denied".to_owned(),
		_ => {
			let text = strip_errno(err);
			let mut chars = text.chars();
			chars.next().map_or_else(String::new, |first| first.to_lowercase().chain(chars).collect())
		},
	}
}

/// `op path: why`, Go's `*PathError` text.
fn path_error(op: &str, path: &str, err: &io::Error) -> String {
	format!("{op} {path}: {}", os_error(err))
}

/// The hex SHA-256 of `path` and a newline: a file's deny-list name.
fn path_hash(path: &str) -> String {
	hex(&Sha256::new().chain_update(path).chain_update("\n").finalize())
}

/// `path` relative to the directory `base` (both absolute and clean).
fn relative_to(base: &str, path: &str) -> String {
	let (base, path) = (Path::new(base), Path::new(path));
	let shared = base.components().zip(path.components()).take_while(|(a, b)| a == b).count();
	let mut relative = std::path::PathBuf::new();
	for _ in base.components().skip(shared) {
		relative.push("..");
	}
	relative.extend(path.components().skip(shared));
	if relative.as_os_str().is_empty() { ".".to_owned() } else { lossy(&relative) }
}

/// A Go duration (`5s`, `1m30s`, `250ms`) in nanoseconds.
fn parse_duration(text: &str) -> Outcome<i64> {
	let invalid = || format!("time: invalid duration {text:?}");
	let (negative, mut rest) = match text.strip_prefix(['-', '+']) {
		Some(rest) => (text.starts_with('-'), rest),
		None => (false, text),
	};
	if rest == "0" {
		return Ok(0);
	}
	if rest.is_empty() {
		return Err(invalid());
	}
	let mut total: i128 = 0;
	while !rest.is_empty() {
		let digits = |text: &str| text.bytes().take_while(u8::is_ascii_digit).count();
		let whole = &rest[..digits(rest)];
		rest = &rest[whole.len()..];
		let fraction = match rest.strip_prefix('.') {
			Some(after) => {
				let fraction = &after[..digits(after)];
				rest = &after[fraction.len()..];
				fraction
			},
			None => "",
		};
		if whole.is_empty() && fraction.is_empty() {
			return Err(invalid());
		}
		let unit_len = rest.find(|c: char| c == '.' || c.is_ascii_digit()).unwrap_or(rest.len());
		let unit = &rest[..unit_len];
		rest = &rest[unit_len..];
		let scale: i128 = match unit {
			"ns" => 1,
			"us" | "µs" | "μs" => 1_000,
			"ms" => 1_000_000,
			"s" => 1_000_000_000,
			"m" => 60_000_000_000,
			"h" => 3_600_000_000_000,
			"" => return Err(format!("time: missing unit in duration {text:?}")),
			_ => return Err(format!("time: unknown unit {unit:?} in duration {text:?}")),
		};
		let whole: i128 = if whole.is_empty() { 0 } else { whole.parse().map_err(|_| invalid())? };
		total = total.saturating_add(whole.saturating_mul(scale));
		let mut place = scale;
		for digit in fraction.bytes() {
			place /= 10;
			total = total.saturating_add(i128::from(digit - b'0') * place);
		}
	}
	i64::try_from(if negative { -total } else { total }).map_err(|_| invalid())
}

/// `nanos` as Go prints a duration: `5s`, `1m30s`, `1h0m0s`, `1.5ms`.
fn format_duration(nanos: i64) -> String {
	// `digits` fractional digits of `value`, trailing zeros dropped.
	let fraction = |value: u64, digits: u32| {
		let scale = 10u64.pow(digits);
		let fraction = format!("{:0width$}", value % scale, width = digits as usize);
		let fraction = fraction.trim_end_matches('0');
		let point = if fraction.is_empty() { "" } else { "." };
		format!("{}{point}{fraction}", value / scale)
	};
	let total = nanos.unsigned_abs();
	let text = match total {
		0 => return "0s".to_owned(),
		1..1_000 => format!("{total}ns"),
		1_000..1_000_000 => format!("{}µs", fraction(total, 3)),
		1_000_000..1_000_000_000 => format!("{}ms", fraction(total, 6)),
		_ => {
			let seconds = total / 1_000_000_000;
			let (hours, minutes) = (seconds / 3600, seconds / 60 % 60);
			let seconds = fraction(total % 60_000_000_000, 9);
			match (hours, minutes) {
				(0, 0) => format!("{seconds}s"),
				(0, _) => format!("{minutes}m{seconds}s"),
				_ => format!("{hours}h{minutes}m{seconds}s"),
			}
		},
	};
	if nanos < 0 { format!("-{text}") } else { text }
}

/// The numeric parts of the semantic version `version` (`vMAJOR[.MINOR[.PATCH]]`,
/// a pre-release and build allowed after the patch); `None` when it is not a
/// valid version.
fn parse_semver(version: &str) -> Option<[&str; 3]> {
	fn number(text: &str) -> Option<(&str, &str)> {
		let digits = text.bytes().take_while(u8::is_ascii_digit).count();
		(digits > 0 && (digits == 1 || !text.starts_with('0'))).then(|| text.split_at(digits))
	}
	// Dot-separated identifiers of letters, digits and `-`; a pre-release's
	// numeric ones carry no leading zero.
	fn identifiers(text: &str, numeric_rule: bool) -> bool {
		text.split('.').all(|part| {
			!part.is_empty()
				&& part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
				&& !(numeric_rule
					&& part.len() > 1
					&& part.starts_with('0')
					&& part.bytes().all(|c| c.is_ascii_digit()))
		})
	}
	let (major, rest) = number(version.strip_prefix('v')?)?;
	let mut parts = [major, "0", "0"];
	let Some(rest) = rest.strip_prefix('.') else {
		return rest.is_empty().then_some(parts);
	};
	let (minor, rest) = number(rest)?;
	parts[1] = minor;
	let Some(rest) = rest.strip_prefix('.') else {
		return rest.is_empty().then_some(parts);
	};
	let (patch, rest) = number(rest)?;
	parts[2] = patch;
	let (rest, build) = match rest.split_once('+') {
		Some((rest, build)) => (rest, Some(build)),
		None => (rest, None),
	};
	if build.is_some_and(|build| !identifiers(build, false)) {
		return None;
	}
	match rest.strip_prefix('-') {
		Some(prerelease) => identifiers(prerelease, true).then_some(parts),
		None => rest.is_empty().then_some(parts),
	}
}

/// `algo-base64` as a subresource-integrity hash: its digest bytes.
fn parse_sri(hash: &str) -> Outcome<Vec<u8>> {
	let Some((algo, digest)) = hash.split_once('-') else {
		return Err(format!("sri: not a hash {hash}"));
	};
	if !matches!(algo, "sha256" | "sha384" | "sha512") {
		return Err(format!("sri: unsupported algo {algo}"));
	}
	base64::engine::general_purpose::STANDARD
		.decode(digest)
		.map_err(|err| err.to_string())
}

/// The status of the last response in curl's `-D` header dump; 200 when the
/// transfer had no HTTP response (`file://`).
fn last_http_status(headers: &str) -> u16 {
	headers
		.lines()
		.rev()
		.find_map(|line| line.strip_prefix("HTTP/")?.split_ascii_whitespace().nth(1)?.parse().ok())
		.unwrap_or(200)
}

/// Says that a slow command is still running once `warn_timeout` passed,
/// until dropped.
struct SlowWarning {
	done:   Option<mpsc::Sender<()>>,
	thread: Option<std::thread::JoinHandle<()>>,
}

impl SlowWarning {
	fn start(host: &Host, cfg: &Config, what: &str) -> Self {
		let Ok(wait) = u64::try_from(cfg.warn_timeout).map(Duration::from_nanos) else {
			return Self { done: None, thread: None };
		};
		if wait.is_zero() {
			return Self { done: None, thread: None };
		}
		let (done, finished) = mpsc::channel();
		let mut stderr = host.stderr.dup_file();
		let (open, close) = if cfg.log_color { (ERROR_COLOR, CLEAR_COLOR) } else { ("", "") };
		let message = format!(
			"{open}direnv: ([direnv {what}]) is taking a while to execute. Use CTRL-C to give \
			 up.{close}\n"
		);
		let thread = std::thread::spawn(move || {
			if finished.recv_timeout(wait) == Err(mpsc::RecvTimeoutError::Timeout) {
				let _ = stderr.write_all(message.as_bytes());
			}
		});
		Self { done: Some(done), thread: Some(thread) }
	}
}

impl Drop for SlowWarning {
	fn drop(&mut self) {
		self.done = None;
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

/// One `direnv` invocation in progress.
struct Run<'h> {
	host:     &'h mut Host,
	/// The exported environment direnv was started with.
	env:      Env,
	/// The physical working directory ([`physical_cwd`]).
	work_dir: String,
}

impl Run<'_> {
	fn dispatch(&mut self, args: &[String]) -> Outcome<i32> {
		let Some((name, args)) = args.split_first() else {
			self.help(false);
			return Ok(0);
		};
		let Some(command) = COMMANDS
			.iter()
			.find(|command| command.name == name || command.aliases.contains(&name.as_str()))
		else {
			return Err(format!("command \"direnv {name}\" not found"));
		};
		match command.name {
			"allow" => self.allow(args),
			"apply_dump" => self.apply_dump(args),
			"show_dump" => self.show_dump(args),
			"check-required" => self.check_required(args),
			"block" => self.deny(args),
			"dotenv" => self.dotenv(args),
			"dump" => self.dump(args),
			"edit" => self.edit(args),
			"exec" => return self.exec(args),
			"export" => self.export(args),
			"fetchurl" => self.fetchurl(args),
			"help" => {
				self.help(!args.is_empty());
				Ok(())
			},
			"hook" => self.hook(args),
			"prune" => self.prune(),
			"reload" => self.reload(),
			"status" => self.status(args),
			"stdlib" => {
				let cfg = self.config()?;
				let stdlib = self.stdlib(&cfg);
				self.print(&stdlib);
				self.print("\n");
				Ok(())
			},
			"version" => self.version(args),
			"watch" => self.watch(args),
			"watch-dir" => self.watch_dir(args),
			"watch-list" => self.watch_list(args),
			"watch-print" => self.watch_print(args),
			"current" => self.current(args),
			_ => self.log(args),
		}
		.map(|()| 0)
	}

	// ── output ───────────────────────────────────────────────────────────

	fn print(&mut self, text: &str) {
		let _ = self.host.stdout.write_all(text.as_bytes());
	}

	fn log_status(&mut self, cfg: &Config, message: &str) {
		if cfg.log_format.is_empty()
			|| cfg.log_filter.as_ref().is_some_and(|filter| !filter.is_match(message))
		{
			return;
		}
		let line = cfg.log_format.replacen("%s", message, 1);
		let clear = if cfg.log_color { CLEAR_COLOR } else { "" };
		let _ = writeln!(self.host.stderr, "{clear}{line}");
	}

	fn log_error(&mut self, cfg: &Config, message: &str) {
		let (open, close) = if cfg.log_color { (ERROR_COLOR, CLEAR_COLOR) } else { ("", "") };
		let _ = writeln!(self.host.stderr, "{open}direnv: {message}{close}");
	}

	// ── paths and files ──────────────────────────────────────────────────

	fn var(&self, name: &str) -> &str {
		self.env.get(name).map_or("", String::as_str)
	}

	/// `path` made absolute against the physical working directory and
	/// lexically cleaned.
	fn abs(&self, path: &str) -> String {
		let given = Path::new(path);
		let absolute = if given.is_relative() && !omp_vfs::is_virtual_path(given) {
			Path::new(&self.work_dir).join(given)
		} else {
			self.host.resolve(given)
		};
		lossy(&omp_vfs::normalize_lexically(&absolute))
	}

	fn is_regular(&self, path: &str) -> bool {
		self.host.fs().metadata(path).is_ok_and(|meta| meta.is_file())
	}

	/// The program `name` on the environment's `PATH`.
	fn look_path(&self, name: &str) -> Option<String> {
		std::env::split_paths(self.var("PATH")).find_map(|dir| {
			let dir = if dir.as_os_str().is_empty() { Path::new(".") } else { dir.as_path() };
			let candidate = self.abs(&lossy(&dir.join(name)));
			let runs = |path: &str| {
				self.host.fs().metadata(path).is_ok_and(|meta| {
					meta.is_file() && (cfg!(not(unix)) || meta.mode() & 0o111 != 0)
				})
			};
			if runs(&candidate) {
				return Some(candidate);
			}
			let exe = format!("{candidate}.exe");
			(cfg!(windows) && runs(&exe)).then_some(exe)
		})
	}

	/// The newer of the modification times of `path` and, for a symlink, the
	/// link itself, in seconds.
	fn latest_mtime(&self, path: &str) -> io::Result<i64> {
		let link = self.host.fs().symlink_metadata(path)?;
		let target = self.host.fs().metadata(path)?;
		Ok(link.mtime().unwrap_or(0).max(target.mtime().unwrap_or(0)))
	}

	/// Records the current state of `path` in `times`.
	fn watch_path(&self, times: &mut FileTimes, path: &str) -> Outcome {
		let path = self.abs(path);
		let (modtime, exists) = match self.latest_mtime(&path) {
			Ok(modtime) => (modtime, true),
			Err(err) if err.kind() == io::ErrorKind::NotFound => (0, false),
			Err(err) => return Err(path_error("stat", &path, &err)),
		};
		times.set(path, modtime, exists);
		Ok(())
	}

	/// Fails with what changed when `time` no longer describes its file.
	fn check_time(&self, time: &FileTime) -> Outcome {
		match self.latest_mtime(&time.path) {
			Err(err) if err.kind() == io::ErrorKind::NotFound => {
				if time.exists {
					return Err(format!("File {:?} is missing (Stat)", time.path));
				}
			},
			Err(err) => return Err(path_error("stat", &time.path, &err)),
			Ok(_) if !time.exists => return Err(format!("File {:?} newly created", time.path)),
			Ok(modtime) if modtime != time.modtime => {
				return Err(format!("File {:?} has changed", time.path));
			},
			Ok(_) => {},
		}
		Ok(())
	}

	/// Fails when `times` is empty or any of its files changed.
	fn check_times(&self, times: &FileTimes) -> Outcome {
		if times.0.is_empty() {
			return Err("Times list is empty".to_owned());
		}
		times.0.iter().try_for_each(|time| self.check_time(time))
	}

	/// The hex SHA-256 of the absolute `path`, a newline and the file's
	/// content: its allow-list name.
	fn file_hash(&self, path: &str) -> Outcome<String> {
		let path = self.abs(path);
		let content = self.host.fs().read(&path).map_err(|err| path_error("open", &path, &err))?;
		let hash = Sha256::new().chain_update(&path).chain_update("\n").chain_update(content);
		Ok(format!("{:x}", hash.finalize()))
	}

	/// The first of `names` found in `dir` or the nearest directory above it.
	fn find_up(&self, dir: &str, names: &[&str]) -> Option<String> {
		if dir.is_empty() {
			return None;
		}
		let start = self.abs(dir);
		Path::new(&start).ancestors().find_map(|dir| {
			names
				.iter()
				.map(|name| lossy(&dir.join(name)))
				.find(|candidate| self.is_regular(candidate))
		})
	}

	/// The `.envrc` (or, with `load_dotenv`, `.env`) that governs `dir`.
	fn find_env_up(&self, dir: &str, cfg: &Config) -> Option<String> {
		let names: &[&str] = if cfg.load_dotenv { &[".envrc", ".env"] } else { &[".envrc"] };
		self.find_up(dir, names)
	}

	// ── configuration ────────────────────────────────────────────────────

	/// direnv's XDG directory of `kind` (`config`, `cache`, `data`).
	fn xdg_dir(&self, variable: &str, home_relative: &str, kind: &str) -> Outcome<String> {
		if !self.var(variable).is_empty() {
			return Ok(join(self.var(variable), "direnv"));
		}
		if !self.var("HOME").is_empty() {
			return Ok(join(&join(self.var("HOME"), home_relative), "direnv"));
		}
		Err(format!("couldn't find a {kind} directory for direnv"))
	}

	/// `~/x` under the user's home.
	fn expand_tilde(&self, path: &str) -> String {
		match path.strip_prefix("~/") {
			Some(rest) if !self.var("HOME").is_empty() => join(self.var("HOME"), rest),
			_ => path.to_owned(),
		}
	}

	fn config(&mut self) -> Outcome<Config> {
		let conf_dir = if self.var("DIRENV_CONFIG").is_empty() {
			self.xdg_dir("XDG_CONFIG_HOME", ".config", "configuration")?
		} else {
			self.var("DIRENV_CONFIG").to_owned()
		};
		let mut cfg = Config {
			cache_dir: self.xdg_dir("XDG_CACHE_HOME", ".cache", "cache")?,
			data_dir: self.xdg_dir("XDG_DATA_HOME", ".local/share", "data")?,
			self_path: match self.var("DIRENV_EXE_PATH") {
				"" => "direnv".to_owned(),
				path => path.replace('\\', "/"),
			},
			bash_path: String::new(),
			hide_env_diff: false,
			disable_stdin: false,
			strict_env: false,
			load_dotenv: false,
			log_format: self
				.env
				.get("DIRENV_LOG_FORMAT")
				.map_or_else(|| "direnv: %s".to_owned(), Clone::clone),
			log_filter: None,
			log_color: self.var("TERM") != "dumb",
			warn_timeout: 5_000_000_000,
			whitelist_prefix: Vec::new(),
			whitelist_exact: BTreeSet::new(),
			conf_dir,
		};
		let toml_path = ["direnv.toml", "config.toml"]
			.iter()
			.map(|name| join(&cfg.conf_dir, name))
			.find(|path| self.host.fs().metadata(path).is_ok());
		let mut inverted_setting = false;
		if let Some(toml_path) = toml_path {
			let failed = |why: &dyn std::fmt::Display| {
				format!("LoadConfig() failed to parse {toml_path}: {why}")
			};
			let text = self.host.fs().read_to_string(&toml_path).map_err(|err| failed(&os_error(&err)))?;
			let table: toml::Table = text.parse().map_err(|err: toml::de::Error| failed(&err))?;
			// A setting may sit under `[global]` or, as it once did, at the top.
			let global = table.get("global").and_then(toml::Value::as_table);
			let setting = |key: &str| global.and_then(|global| global.get(key)).or_else(|| table.get(key));
			let wrong_type = |key: &str| failed(&format_args!("incompatible types for key {key:?}"));
			let flag = |key: &str| {
				setting(key).map_or(Ok(false), |value| value.as_bool().ok_or_else(|| wrong_type(key)))
			};
			let text = |key: &str| {
				setting(key).map_or(Ok(""), |value| value.as_str().ok_or_else(|| wrong_type(key)))
			};
			let list = |key: &str| -> Outcome<Vec<&str>> {
				let Some(value) = table.get("whitelist").and_then(|whitelist| whitelist.get(key)) else {
					return Ok(Vec::new());
				};
				let items = value.as_array().ok_or_else(|| wrong_type(key))?;
				items.iter().map(|item| item.as_str().ok_or_else(|| wrong_type(key))).collect()
			};
			if !self.env.contains_key("DIRENV_LOG_FORMAT") {
				match text("log_format")? {
					"" => {},
					"-" => cfg.log_format.clear(),
					format => format.clone_into(&mut cfg.log_format),
				}
			}
			let filter = text("log_filter")?;
			if !filter.is_empty() {
				cfg.log_filter =
					Some(Regex::new(filter).map_err(|err| format!("error in log filter: {err}"))?);
			}
			cfg.hide_env_diff = flag("hide_env_diff")?;
			for prefix in list("prefix")? {
				cfg.whitelist_prefix.push(self.expand_tilde(prefix));
			}
			for exact in list("exact")? {
				let exact = if exact.ends_with("/.envrc") || exact.ends_with("/.env") {
					exact.to_owned()
				} else {
					join(exact, ".envrc")
				};
				cfg.whitelist_exact.insert(self.expand_tilde(&exact));
			}
			inverted_setting = flag("skip_dotenv")?;
			text("bash_path")?.clone_into(&mut cfg.bash_path);
			cfg.disable_stdin = flag("disable_stdin")?;
			cfg.load_dotenv = flag("load_dotenv")?;
			cfg.strict_env = flag("strict_env")?;
			let timeout = text("warn_timeout")?;
			if !timeout.is_empty() {
				cfg.warn_timeout = parse_duration(timeout).map_err(|err| failed(&err))?;
			}
		}
		if inverted_setting {
			self.log_error(&cfg, "skip_dotenv has been inverted to load_dotenv.");
		}
		if !self.var("DIRENV_WARN_TIMEOUT").is_empty() {
			match parse_duration(self.var("DIRENV_WARN_TIMEOUT")) {
				Ok(timeout) => cfg.warn_timeout = timeout,
				Err(err) => self.log_error(&cfg, &format!("invalid DIRENV_WARN_TIMEOUT: {err}")),
			}
		}
		if cfg.bash_path.is_empty() {
			cfg.bash_path = match self.var("DIRENV_BASH") {
				"" => self.look_path("bash").unwrap_or_else(|| "bash".to_owned()),
				bash => bash.to_owned(),
			};
		}
		Ok(cfg)
	}

	// ── .envrc files ─────────────────────────────────────────────────────

	fn rc_from_path(&self, path: &str, cfg: &Config) -> Outcome<Rc> {
		let allow_path = join(&cfg.allow_dir(), &self.file_hash(path)?);
		let deny_path = join(&cfg.deny_dir(), &path_hash(&self.abs(path)));
		let mut times = FileTimes::default();
		self.watch_path(&mut times, path)?;
		self.watch_path(&mut times, &allow_path)?;
		self.watch_path(&mut times, &deny_path)?;
		Ok(Rc { path: path.to_owned(), allow_path, deny_path, times })
	}

	/// The file the environment says is loaded, with the watch list it was
	/// loaded with; `None` when nothing is loaded or the file is gone.
	fn loaded_rc(&self, cfg: &Config) -> Option<Rc> {
		let path = self.var(DIRENV_FILE);
		if path.is_empty() {
			return None;
		}
		let allow_path = join(&cfg.allow_dir(), &self.file_hash(path).ok()?);
		let times = FileTimes::unmarshal(self.var(DIRENV_WATCHES)).ok()?;
		let deny_path = join(&cfg.deny_dir(), &path_hash(&self.abs(path)));
		Some(Rc { path: path.to_owned(), allow_path, deny_path, times })
	}

	fn find_rc(&self, dir: &str, cfg: &Config) -> Outcome<Option<Rc>> {
		self.find_env_up(dir, cfg).map(|path| self.rc_from_path(&path, cfg)).transpose()
	}

	fn allowed(&self, rc: &Rc, cfg: &Config) -> AllowStatus {
		let exists = |path: &str| self.host.fs().metadata(path).is_ok();
		if exists(&rc.deny_path) {
			return AllowStatus::Denied;
		}
		let path = self.abs(&rc.path);
		if exists(&rc.allow_path)
			|| cfg.whitelist_exact.contains(&path)
			|| cfg.whitelist_prefix.iter().any(|prefix| path.starts_with(prefix.as_str()))
		{
			AllowStatus::Allowed
		} else {
			AllowStatus::NotAllowed
		}
	}

	/// Writes the one-line list entry `file` naming `rc_path`.
	fn write_entry(&self, file: &str, rc_path: &str) -> Outcome {
		let dir = dirname(file);
		self.host.fs().create_dir_all(&dir).map_err(|err| path_error("mkdir", &dir, &err))?;
		self.host
			.fs()
			.write(file, format!("{rc_path}\n"))
			.map_err(|err| path_error("open", file, &err))
	}

	/// Removes `path` if it exists.
	fn remove_entry(&self, path: &str) -> Outcome {
		match self.host.fs().remove_file(path) {
			Err(err) if err.kind() != io::ErrorKind::NotFound => Err(path_error("remove", path, &err)),
			_ => Ok(()),
		}
	}

	/// The `.envrc` an `allow` or `deny` argument names: the file governing
	/// the given path (symlinks resolved), or the working directory.
	fn rc_for(&self, args: &[String], cfg: &Config) -> Outcome<Rc> {
		let start = match args.first() {
			Some(path) => {
				let path = self.abs(path);
				lossy(&self.host.fs().canonicalize(&path).map_err(|err| path_error("lstat", &path, &err))?)
			},
			None => self.work_dir.clone(),
		};
		self.find_rc(&start, cfg)?.ok_or_else(|| {
			let names = if cfg.load_dotenv { ".envrc or .env" } else { ".envrc" };
			format!("{names} file not found")
		})
	}

	/// The stdlib an `.envrc` runs with, naming direnv and the command an
	/// external program dumps its environment with.
	fn stdlib(&self, cfg: &Config) -> String {
		let (head, rest) = STDLIB.split_once(STDLIB_SELF).unwrap_or((STDLIB, ""));
		let (middle, tail) = rest.split_once(STDLIB_DUMP).unwrap_or((rest, ""));
		let mut stdlib = String::with_capacity(STDLIB.len() + 256);
		stdlib.push_str(head);
		stdlib.push_str(&bash_escape(&cfg.self_path));
		stdlib.push_str(middle);
		if cfg.self_path.contains('/') {
			stdlib.push_str(STDLIB_DUMP);
		} else if let Some(program) = self.look_path("direnv") {
			let _ = write!(stdlib, "({} dump)", bash_escape(&program));
		} else {
			stdlib.push_str(ENV_DUMP);
		}
		stdlib.push_str(tail);
		stdlib
	}

	/// Evaluates `rc` on top of `previous` and returns the environment it
	/// leaves, direnv's bookkeeping variables set, with whether the load
	/// succeeded. A file that may not load, or fails, leaves `previous` plus
	/// the bookkeeping, so it is not retried until it changes.
	fn load(&mut self, rc: &Rc, cfg: &Config, previous: &Env) -> (Env, Outcome) {
		let mut env = previous.clone();
		env.insert(DIRENV_WATCHES.to_owned(), rc.times.marshal());
		let outcome = match self.allowed(rc, cfg) {
			AllowStatus::NotAllowed => {
				Err(format!("{} is blocked. Run `direnv allow` to approve its content", rc.path))
			},
			AllowStatus::Denied => Ok(()),
			AllowStatus::Allowed => self.evaluate(rc, cfg, &env).map(|loaded| {
				if let Some(loaded) = loaded {
					env = loaded;
				}
			}),
		};
		env.insert(DIRENV_DIR.to_owned(), format!("-{}", dirname(&rc.path)));
		env.insert(DIRENV_FILE.to_owned(), rc.path.clone());
		env.insert(DIRENV_DIFF.to_owned(), EnvDiff::between(previous, &env).serialize());
		(env, outcome)
	}

	/// Runs `rc` in a new shell started with `env` and returns the exported
	/// environment the shell ended with; `None` when it dumped nothing.
	fn evaluate(&mut self, rc: &Rc, cfg: &Config, env: &Env) -> Outcome<Option<Env>> {
		let scratch = tempfile::Builder::new()
			.prefix("direnv-")
			.tempdir()
			.map_err(|err| os_error(&err))?;
		let dump = scratch.path().join("dump");
		let loader = if rc.path.ends_with("/.env") { "dotenv" } else { "source_env" };
		// stdout is the dump's: the stdlib sends everything an `.envrc`
		// prints to stderr and writes the final environment last.
		// An `sh` or zsh caller starts the file as `sh`: bash's posix mode,
		// which the stdlib is not written for.
		let mut script = format!(
			"exec >{}\nset +o posix 2>/dev/null\n",
			bash_escape(&lossy(&dump).replace('\\', "/"))
		);
		if cfg.strict_env {
			script.push_str("set -euo pipefail\n");
		}
		script.push_str(&self.stdlib(cfg));
		// The explicit `exit` is what fires the stdlib's dump-at-exit trap.
		let _ = writeln!(
			script,
			"\n__main__ {loader} {}\nexit",
			bash_escape(&rc.path.replace('\\', "/"))
		);
		let mut command = with_env(script_command(scratch.path(), script).map_err(|err| os_error(&err))?, &self.env, env);
		if !cfg.disable_stdin
			&& let Ok(stdin) = self.host.stdin.file().to_fd()
		{
			command = command.stdin(stdin);
		}
		let status = self.host.run_command(command).map_err(|err| os_error(&err))?;
		match status {
			CommandStatus::Exited(0) => {},
			CommandStatus::Exited(code) => return Err(format!("exit status {code}")),
			CommandStatus::Signaled(signal) => return Err(format!("signal: {signal}")),
		}
		let dumped = std::fs::read(&dump).unwrap_or_default();
		if dumped.is_empty() {
			return Ok(None);
		}
		let value: Value = serde_json::from_slice(&dumped).map_err(|err| err.to_string())?;
		string_map(Some(&value)).map(Some)
	}

	/// The environment before the loaded `.envrc` applied.
	fn revert(&self) -> Outcome<Env> {
		match self.var(DIRENV_DIFF) {
			"" => Ok(self.env.clone()),
			diff => Ok(EnvDiff::load(diff)?.revert(&self.env)),
		}
	}

	// ── commands ─────────────────────────────────────────────────────────

	fn help(&mut self, show_private: bool) {
		let mut text = format!(
			"direnv v{VERSION}\nUsage: direnv COMMAND [...ARGS]\n\nAvailable \
			 commands\n------------------\n"
		);
		for command in &COMMANDS {
			let Command { name, args, desc, .. } = command;
			let shells = if *name == "export" { SHELL_NAMES } else { "" };
			if command.private {
				if show_private {
					let _ = writeln!(text, "*{name}{args}:\n  {desc}");
				}
				continue;
			}
			let _ = writeln!(text, "{name}{args}:");
			let aliases: Vec<&str> = command
				.aliases
				.iter()
				.copied()
				.filter(|alias| !alias.starts_with('-'))
				.collect();
			if !aliases.is_empty() {
				let _ = writeln!(text, "  aliases: {}", aliases.join(", "));
			}
			let _ = writeln!(text, "  {desc}{shells}");
		}
		if show_private {
			text.push_str("* = private commands\n");
		}
		self.print(&text);
	}

	fn allow(&mut self, args: &[String]) -> Outcome {
		let cfg = self.config()?;
		let fs = self.host.fs();
		let allow_dir = cfg.allow_dir();
		let old_allow_dir = join(&cfg.conf_dir, "allow");
		// The lists once lived beside the configuration.
		if matches!(fs.metadata(&allow_dir), Err(err) if err.kind() == io::ErrorKind::NotFound)
			&& fs.metadata(&old_allow_dir).is_ok()
		{
			let moved = (|| -> io::Result<()> {
				fs.create_dir_all(dirname(&allow_dir))?;
				fs.rename(&old_allow_dir, &allow_dir)?;
				fs.symlink(&allow_dir, &old_allow_dir)
			})();
			let mut text = format!(
				"\nMigrating the allow data to the new location\n\nThe allowed .envrc or .env \
				 permissions used to be stored in the XDG_CONFIG_HOME. It's\nbetter to keep that \
				 folder for user-editable configuration so the data is\nbeing moved to \
				 XDG_DATA_HOME.\n\nmoving {old_allow_dir} to {allow_dir}\n"
			);
			if moved.is_ok() {
				let _ = write!(
					text,
					"creating a symlink back from {allow_dir} to {old_allow_dir} for \
					 back-compat.\n\nAll done, have a nice day!\n"
				);
			}
			self.print(&text);
			moved.map_err(|err| os_error(&err))?;
		}
		let mut rc = self.rc_for(args, &cfg)?;
		if rc.allow_path.is_empty() {
			return Err("cannot allow empty path".to_owned());
		}
		self.write_entry(&rc.allow_path, &rc.path)?;
		self.watch_path(&mut rc.times, &rc.allow_path)?;
		self.remove_entry(&rc.deny_path)?;
		let required = self.var(DIRENV_REQUIRED).to_owned();
		if required.is_empty() {
			return Ok(());
		}
		// The files `require_allowed` found unapproved are approved with it.
		let rc_dir = dirname(&rc.path);
		let approved_dir = join(&cfg.allowed_required_dir(), &path_hash(&self.abs(&rc.path)));
		for relative in required.split(':') {
			let hash = self.file_hash(&join(&rc_dir, relative)).map_err(|err| {
				if err.ends_with("no such file or directory") {
					format!("required file does not exist: {relative}")
				} else {
					format!("failed to hash required file {relative}: {err}")
				}
			})?;
			self.write_entry(&join(&approved_dir, &hash), relative)
				.map_err(|err| format!("failed to write allowed-required file entry: {err}"))?;
			self.print(&format!("direnv: allowing {relative}\n"));
		}
		Ok(())
	}

	fn deny(&mut self, args: &[String]) -> Outcome {
		let cfg = self.config()?;
		let rc = self.rc_for(args, &cfg)?;
		let approved_dir = join(&cfg.allowed_required_dir(), &path_hash(&self.abs(&rc.path)));
		match self.host.fs().remove_dir_all(&approved_dir) {
			Err(err) if err.kind() != io::ErrorKind::NotFound => {
				return Err(format!("failed to remove allowed-required files: {}", os_error(&err)));
			},
			_ => {},
		}
		self.write_entry(&rc.deny_path, &rc.path)?;
		self.remove_entry(&rc.allow_path)
	}

	fn exec(&mut self, args: &[String]) -> Outcome<i32> {
		let cfg = self.config()?;
		let Some(first) = args.first() else {
			return Err("missing DIR and COMMAND arguments".to_owned());
		};
		let given = lossy(&omp_vfs::normalize_lexically(Path::new(first)));
		let target = self.abs(&given);
		let meta = self.host.fs().metadata(&target).map_err(|err| path_error("stat", &given, &err))?;
		// A file in place of DIR is the command itself, loaded from its own
		// directory.
		let (dir, argv) = if meta.is_dir() {
			if args.len() < 2 {
				return Err("missing COMMAND argument".to_owned());
			}
			(target, &args[1..])
		} else {
			(dirname(&target), args)
		};
		// The directory as a shell that entered it would name it.
		let dir = self.host.fs().canonicalize(&dir).map_or(dir, |real| lossy(&real));
		let mut previous = self.revert()?;
		for name in [DIRENV_DIFF, DIRENV_DIR, DIRENV_FILE, DIRENV_DUMP_FILE_PATH, DIRENV_WATCHES] {
			previous.remove(name);
		}
		let env = match self.find_env_up(&dir, &cfg) {
			Some(path) => {
				let rc = self.rc_from_path(&path, &cfg)?;
				let (env, outcome) = self.load(&rc, &cfg, &previous);
				outcome?;
				env
			},
			None => previous,
		};
		let mut command = with_env(ShellCommand::new(argv.iter().map(OsString::from).collect()), &self.env, &env);
		if let Ok(stdin) = self.host.stdin.file().to_fd() {
			command = command.stdin(stdin);
		}
		match self.host.run_command(command) {
			Ok(status) => Ok(status.code()),
			Err(err) if matches!(err.kind(), io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied) => {
				let path = env.get("PATH").map_or("", String::as_str);
				Err(format!("command '{}' not found on PATH '{path}'", argv[0]))
			},
			Err(err) => Err(os_error(&err)),
		}
	}

	fn export(&mut self, args: &[String]) -> Outcome {
		let cfg = self.config()?;
		let target = args.first().map_or("", String::as_str);
		let _slow = SlowWarning::start(self.host, &cfg, &format!("export {target}"));
		let disabled = self.var("DIRENV_DISABLE");
		if disabled == "1" || disabled.eq_ignore_ascii_case("true") {
			return Ok(());
		}
		let shell =
			Shell::detect(target).ok_or_else(|| format!("unknown target shell '{target}'"))?;
		let loaded = self.loaded_rc(&cfg);
		let to_load = self.find_env_up(&self.work_dir, &cfg);
		let current = match (&to_load, &loaded) {
			(None, None) if self.var(DIRENV_DIFF).is_empty() => return Ok(()),
			(Some(path), Some(loaded)) => {
				loaded.path == *path
					&& self.check_times(&loaded.times).is_ok()
					&& self.var(DIRENV_REQUIRED).is_empty()
			},
			_ => false,
		};
		if current {
			return Ok(());
		}
		let previous = self.revert().map_err(|err| format!("Revert() failed: {err}"))?;
		let (env, outcome) = match to_load {
			None => {
				if !EnvDiff::between(&self.env, &previous).status().is_empty() {
					self.log_status(&cfg, "unloading");
				}
				let mut env = previous.clone();
				for name in [DIRENV_DIFF, DIRENV_DIR, DIRENV_FILE, DIRENV_DUMP_FILE_PATH, DIRENV_WATCHES] {
					env.remove(name);
				}
				(env, Ok(()))
			},
			Some(path) => {
				let rc = self.rc_from_path(&path, &cfg)?;
				self.load(&rc, &cfg, &previous)
			},
		};
		let summary = EnvDiff::between(&previous, &env).status();
		if !summary.is_empty() && !cfg.hide_env_diff {
			self.log_status(&cfg, &format!("export {summary}"));
		}
		let diff = EnvDiff::between(&self.env, &env);
		let text = shell.export(&diff.changes()).map_err(|err| format!("ToShell() failed: {err}"))?;
		self.print(&text);
		// The diff is delivered even when the load failed, so a broken
		// `.envrc` is not retried at every prompt.
		outcome
	}

	fn hook(&mut self, args: &[String]) -> Outcome {
		let cfg = self.config()?;
		let target = args.first().map_or("", String::as_str);
		let shell =
			Shell::detect(target).ok_or_else(|| format!("unknown target shell '{target}'"))?;
		let hook = shell.hook(&cfg.self_path)?;
		self.print(&hook);
		Ok(())
	}

	fn reload(&mut self) -> Outcome {
		let cfg = self.config()?;
		let Some(rc) = self.find_rc(&self.work_dir, &cfg)? else {
			return Err(".envrc not found".to_owned());
		};
		if self.allowed(&rc, &cfg) == AllowStatus::Denied {
			return Err(format!("{} is blocked. Run `direnv allow` to approve its content", rc.path));
		}
		self.host
			.fs()
			.set_times(&rc.path, SetTime::Now, SetTime::Now, true)
			.map_err(|err| path_error("chtimes", &rc.path, &err))
	}

	/// The lines `direnv status` prints for `rc`.
	fn describe_rc(&self, text: &mut String, label: &str, rc: &Rc, cfg: &Config) {
		let dir = dirname(&rc.path);
		let zone = shell_time_zone(self.host);
		let _ = writeln!(text, "{label} RC path {}", rc.path);
		for time in &rc.times.0 {
			let stamp = jiff::Timestamp::from_second(time.modtime)
				.ok()
				.map(|stamp| stamp.to_zoned(zone.clone()))
				.filter(|stamp| (0..=9999).contains(&stamp.year()))
				.map_or_else(
					|| "<<???>>".to_owned(),
					|stamp| {
						let format = if stamp.offset().seconds() == 0 {
							"%Y-%m-%dT%H:%M:%SZ"
						} else {
							"%Y-%m-%dT%H:%M:%S%:z"
						};
						stamp.strftime(format).to_string()
					},
				);
			let _ = writeln!(text, "{label} watch: {:?} - {stamp}", relative_to(&dir, &time.path));
		}
		let _ = writeln!(text, "{label} RC allowed {}", self.allowed(rc, cfg) as u8);
		let _ = writeln!(text, "{label} RC allowPath {}", rc.allow_path);
	}

	fn status(&mut self, args: &[String]) -> Outcome {
		let cfg = self.config()?;
		let loaded = self.loaded_rc(&cfg);
		let found = self.find_rc(&self.work_dir, &cfg)?;
		let mut text = String::new();
		if matches!(args.first().map(String::as_str), Some("-json" | "--json")) {
			let rc = |rc: &Option<Rc>| {
				rc.as_ref().map_or(Value::Null, |rc| {
					serde_json::json!({ "allowed": self.allowed(rc, &cfg) as u8, "path": rc.path })
				})
			};
			let status = serde_json::json!({
				"config": { "ConfigDir": cfg.conf_dir, "SelfPath": cfg.self_path },
				"state": { "foundRC": rc(&found), "loadedRC": rc(&loaded) },
			});
			json_value(&mut text, &status, 0);
			text.push('\n');
		} else {
			let exact: Vec<String> =
				cfg.whitelist_exact.iter().map(|path| format!("{path}:true")).collect();
			let _ = write!(
				text,
				"direnv exec path {}\nDIRENV_CONFIG {}\nbash_path {}\ndisable_stdin \
				 {}\nwarn_timeout {}\nwhitelist.prefix [{}]\nwhitelist.exact map[{}]\n",
				cfg.self_path,
				cfg.conf_dir,
				cfg.bash_path,
				cfg.disable_stdin,
				format_duration(cfg.warn_timeout),
				cfg.whitelist_prefix.join(" "),
				exact.join(" "),
			);
			match &loaded {
				Some(rc) => self.describe_rc(&mut text, "Loaded", rc, &cfg),
				None => text.push_str("No .envrc or .env loaded\n"),
			}
			match &found {
				Some(rc) => self.describe_rc(&mut text, "Found", rc, &cfg),
				None => text.push_str("No .envrc or .env found\n"),
			}
		}
		self.print(&text);
		Ok(())
	}

	fn version(&mut self, args: &[String]) -> Outcome {
		let Some(at_least) = args.first() else {
			self.print(&format!("{VERSION}\n"));
			return Ok(());
		};
		let at_least = if at_least.starts_with('v') { at_least.clone() } else { format!("v{at_least}") };
		let Some(wanted) = parse_semver(&at_least) else {
			return Err(format!("{at_least} is not a valid semver version"));
		};
		// Numbers carry no leading zeros, so the longer one is the larger; a
		// release is no older than a pre-release of the same numbers.
		let older = VERSION
			.split('.')
			.zip(wanted)
			.map(|(own, wanted)| own.len().cmp(&wanted.len()).then_with(|| own.cmp(wanted)))
			.find(|order| order.is_ne())
			.is_some_and(std::cmp::Ordering::is_lt);
		if older {
			return Err(format!(
				"current version v{VERSION} is older than the desired version {at_least}"
			));
		}
		Ok(())
	}

	fn prune(&mut self) -> Outcome {
		let cfg = self.config()?;
		let fs = self.host.fs();
		let names = |dir: &str| -> io::Result<Vec<String>> {
			fs.read_dir(dir)?
				.map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
				.collect()
		};
		let allow_dir = cfg.allow_dir();
		// The allowed files that still exist unchanged, by deny-list name.
		let mut valid: BTreeMap<String, String> = BTreeMap::new();
		for hash in names(&allow_dir).map_err(|err| path_error("open", &allow_dir, &err))? {
			let entry = join(&allow_dir, &hash);
			let meta = fs.metadata(&entry).map_err(|err| path_error("stat", &entry, &err))?;
			if meta.is_dir() {
				continue;
			}
			let rc_path = fs.read_to_string(&entry).map_err(|err| path_error("open", &entry, &err))?;
			let rc_path = rc_path.trim();
			// Entries of old releases name no file.
			if rc_path.is_empty() {
				continue;
			}
			if self.is_regular(rc_path) && self.file_hash(rc_path)? == hash {
				valid.insert(path_hash(&self.abs(rc_path)), rc_path.to_owned());
			} else {
				let _ = fs.remove_file(&entry);
			}
		}
		let required_dir = cfg.allowed_required_dir();
		let approved = match names(&required_dir) {
			Ok(approved) => approved,
			Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
			Err(err) => return Err(path_error("open", &required_dir, &err)),
		};
		for rc_hash in approved {
			let dir = join(&required_dir, &rc_hash);
			let Some(rc_path) = valid.get(&rc_hash) else {
				let _ = fs.remove_dir_all(&dir);
				continue;
			};
			let rc_dir = dirname(rc_path);
			for hash in names(&dir).unwrap_or_default() {
				let entry = join(&dir, &hash);
				let Ok(relative) = fs.read_to_string(&entry) else {
					continue;
				};
				let required = join(&rc_dir, relative.trim());
				if !self.is_regular(&required) || self.file_hash(&required).ok().as_ref() != Some(&hash) {
					let _ = fs.remove_file(&entry);
				}
			}
		}
		Ok(())
	}

	fn edit(&mut self, args: &[String]) -> Outcome {
		let cfg = self.config()?;
		let found = self.find_rc(&self.work_dir, &cfg)?;
		let rc_path = match (args.first(), &found) {
			(Some(path), _) if self.host.fs().metadata(self.abs(path)).is_ok_and(|meta| meta.is_dir()) => {
				join(path, ".envrc")
			},
			(Some(path), _) => path.clone(),
			(None, Some(rc)) => rc.path.clone(),
			(None, None) => {
				return Err(".envrc or .env not found. Use `direnv edit .` to create a new .envrc in \
				            the current directory"
					.to_owned());
			},
		};
		let mut editor = self.var("EDITOR").to_owned();
		if editor.is_empty() {
			self.log_error(&cfg, "$EDITOR not found.");
			let editors = ["editor", "subl -w", "mate -w", "open -t -W", "nano", "vim", "emacs"];
			editor = editors
				.iter()
				.find(|editor| {
					let program = editor.split(' ').next().unwrap_or_default();
					self.look_path(program).is_some()
				})
				.ok_or("could not find a default editor in the PATH")?
				.to_string();
		}
		let mut command = ShellCommand::line(format!("{editor} {}", bash_escape(&rc_path)));
		if let Ok(stdin) = self.host.stdin.file().to_fd() {
			command = command.stdin(stdin);
		}
		match self.host.run_command(command).map_err(|err| os_error(&err))? {
			CommandStatus::Exited(0) => {},
			status => return Err(format!("exit status {}", status.code())),
		}
		// An edited file is one its author has read: it loads without `allow`.
		if let Some(mut rc) = self.find_rc(&rc_path, &cfg)?
			&& found.is_none_or(|before| self.check_times(&before.times).is_err())
		{
			self.write_entry(&rc.allow_path, &rc.path)?;
			self.watch_path(&mut rc.times, &rc.allow_path)?;
			self.remove_entry(&rc.deny_path)?;
		}
		Ok(())
	}

	fn fetchurl(&mut self, args: &[String]) -> Outcome {
		let cfg = self.config()?;
		let Some(url) = args.first() else {
			return Err("missing URL argument".to_owned());
		};
		let cas_dir = self.abs(&join(&cfg.cache_dir, "cas"));
		// Base64 with `_` for `/` is accepted too.
		let integrity = args.get(1).map(|hash| hash.replace('_', "/"));
		if let Some(integrity) = &integrity {
			let stored = join(&cas_dir, &hex(&parse_sri(integrity)?));
			if self.is_regular(&stored) {
				self.print(&format!("{stored}\n"));
				return Ok(());
			}
		}
		let io_failed = |err: io::Error| os_error(&err);
		std::fs::create_dir_all(&cas_dir).map_err(|err| path_error("mkdir", &cas_dir, &err))?;
		let body = tempfile::Builder::new().prefix("tmp").tempfile_in(&cas_dir).map_err(io_failed)?;
		let headers = tempfile::Builder::new().prefix("tmp").tempfile_in(&cas_dir).map_err(io_failed)?;
		let curl: Vec<OsString> = [
			"curl".into(),
			"-sSL".into(),
			"-o".into(),
			body.path().into(),
			"-D".into(),
			headers.path().into(),
			"--".into(),
			url.into(),
		]
		.into();
		match self.host.run_command(ShellCommand::new(curl)) {
			Ok(CommandStatus::Exited(0)) => {},
			Ok(status) => return Err(format!("Get {url:?}: curl: exit status {}", status.code())),
			Err(err) if err.kind() == io::ErrorKind::NotFound => {
				return Err(format!("Get {url:?}: curl: executable file not found in $PATH"));
			},
			Err(err) => return Err(format!("Get {url:?}: {}", os_error(&err))),
		}
		let status = last_http_status(&std::fs::read_to_string(headers.path()).unwrap_or_default());
		if status != 200 {
			return Err(format!("expected status code 200 but got {status}"));
		}
		let mut digest = Sha256::new();
		let mut file = std::fs::File::open(body.path()).map_err(io_failed)?;
		let mut chunk = [0u8; 64 * 1024];
		loop {
			match file.read(&mut chunk).map_err(io_failed)? {
				0 => break,
				read => digest.update(&chunk[..read]),
			}
		}
		let digest = digest.finalize();
		let calculated = format!(
			"sha256-{}",
			base64::engine::general_purpose::STANDARD.encode(digest.as_slice())
		);
		// Read-only and executable, for whatever is fetched to be run.
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt as _;
			std::fs::set_permissions(body.path(), std::fs::Permissions::from_mode(0o500))
				.map_err(io_failed)?;
		}
		if let Some(integrity) = &integrity
			&& calculated != *integrity
		{
			return Err(format!("hash mismatch. Expected '{integrity}' but got '{calculated}'"));
		}
		let stored = join(&cas_dir, &hex(&digest));
		if !self.is_regular(&stored) {
			body.persist(&stored).map_err(|err| os_error(&err.error))?;
		}
		let text = if integrity.is_some() {
			format!("{stored}\n")
		} else if self.host.stdout.is_terminal() {
			format!(
				"Found hash: {calculated}\n\nInvoke fetchurl again with the hash as an argument to \
				 get the disk location:\n\n  direnv fetchurl \"{url}\" \"{calculated}\"\n  #=> \
				 {stored}\n"
			)
		} else {
			format!("{calculated}\n")
		};
		self.print(&text);
		Ok(())
	}

	fn dump(&mut self, args: &[String]) -> Outcome {
		let target = args.first().map_or("gzenv", String::as_str);
		let file = args.get(1).map_or_else(|| self.var(DIRENV_DUMP_FILE_PATH), String::as_str).to_owned();
		let shell =
			Shell::detect(target).ok_or_else(|| format!("unknown target shell '{target}'"))?;
		let changes: Vec<Change<'_>> = self
			.env
			.iter()
			.map(|(name, value)| (name.as_str(), Some(value.as_str())))
			.collect();
		let mut text = shell.export(&changes)?;
		text.push('\n');
		if file.is_empty() {
			self.print(&text);
			return Ok(());
		}
		// A number names one of the shell's descriptors.
		let path = if file.bytes().all(|c| c.is_ascii_digit()) {
			lossy(&self.host.resolve(format!("/dev/fd/{file}")))
		} else {
			self.abs(&file)
		};
		self.host
			.fs()
			.open_with(&path, OpenOptions::new().write(true))
			.and_then(|mut out| out.write_all(text.as_bytes()))
			.map_err(|err| path_error("open", &file, &err))
	}

	fn apply_dump(&mut self, args: &[String]) -> Outcome {
		let [file] = args else {
			let count = if args.is_empty() { "not enough" } else { "too many" };
			return Err(format!("{count} arguments"));
		};
		let path = self.abs(file);
		let dumped = self.host.fs().read(&path).map_err(|err| path_error("open", file, &err))?;
		let env = if dumped.contains(&0) {
			// `env -0`: what a host without direnv dumps.
			dumped
				.split(|&byte| byte == 0)
				.filter_map(|entry| String::from_utf8_lossy(entry).split_once('=').map(|(k, v)| (k.to_owned(), v.to_owned())))
				.collect()
		} else {
			string_map(Some(&gzenv_decode(&String::from_utf8_lossy(&dumped))?))?
		};
		let diff = EnvDiff::between(&self.env, &env);
		let mut text = Shell::Bash.export(&diff.changes())?;
		text.push('\n');
		self.print(&text);
		Ok(())
	}

	fn show_dump(&mut self, args: &[String]) -> Outcome {
		let Some(dump) = args.first() else {
			return Err("missing DUMP argument".to_owned());
		};
		let mut text = String::new();
		json_value(&mut text, &gzenv_decode(dump)?, 0);
		text.push('\n');
		self.print(&text);
		Ok(())
	}

	fn dotenv(&mut self, args: &[String]) -> Outcome {
		let shell = match args.first() {
			Some(target) => {
				Shell::detect(target).ok_or_else(|| format!("unknown target shell '{target}'"))?
			},
			None => Shell::Bash,
		};
		let target = args.get(1).map_or(".env", String::as_str);
		let target = if target.is_empty() { ".env" } else { target };
		let path = self.abs(target);
		let data = self.host.fs().read(&path).map_err(|err| path_error("open", target, &err))?;
		// `$PWD` in a `.env` file is the file's own directory.
		let dir = dirname(&path);
		let lookup = |name: &str| if name == "PWD" { Some(dir.as_str()) } else { self.env.get(name).map(String::as_str) };
		let vars = dotenv::parse(&String::from_utf8_lossy(&data), &lookup)?;
		let changes: Vec<Change<'_>> =
			vars.iter().map(|(name, value)| (name.as_str(), Some(value.as_str()))).collect();
		let mut text = shell.export(&changes)?;
		text.push('\n');
		self.print(&text);
		Ok(())
	}

	/// Prints the export of `times` as the new watch list for `shell`.
	fn print_watches(&mut self, shell: Shell, times: &FileTimes) -> Outcome {
		let watches = times.marshal();
		let text = shell.export(&[(DIRENV_WATCHES, Some(watches.as_str()))])?;
		self.print(&text);
		Ok(())
	}

	fn watch(&mut self, args: &[String]) -> Outcome {
		let Some((target, paths)) = args.split_first() else {
			return Err("a path is required to add to the list of watches".to_owned());
		};
		let shell =
			Shell::detect(target).ok_or_else(|| format!("unknown target shell '{target}'"))?;
		let mut times = FileTimes::from_env(&self.env)?;
		for path in paths {
			self.watch_path(&mut times, path)?;
		}
		self.print_watches(shell, &times)
	}

	/// Records `path` and everything below it in `times`, in name order,
	/// symlinks unfollowed.
	fn watch_tree(&self, times: &mut FileTimes, path: &str) -> io::Result<()> {
		if self.host.is_cancelled() {
			return Err(io::ErrorKind::Interrupted.into());
		}
		let meta = self.host.fs().symlink_metadata(path)?;
		times.set(path.to_owned(), meta.mtime().unwrap_or(0), true);
		if meta.is_dir() {
			let mut names: Vec<OsString> = self
				.host
				.fs()
				.read_dir(path)?
				.map(|entry| entry.map(|entry| entry.file_name()))
				.collect::<io::Result<_>>()?;
			names.sort_unstable();
			for name in names {
				self.watch_tree(times, &lossy(&Path::new(path).join(name)))?;
			}
		}
		Ok(())
	}

	fn watch_dir(&mut self, args: &[String]) -> Outcome {
		let [target, dir, ..] = args else {
			return Err("a directory is required to add to the list of watches".to_owned());
		};
		let shell =
			Shell::detect(target).ok_or_else(|| format!("unknown target shell '{target}'"))?;
		let root = self.abs(dir);
		if matches!(self.host.fs().metadata(&root), Err(err) if err.kind() == io::ErrorKind::NotFound) {
			return Err(format!("dir '{dir}' does not exist"));
		}
		let mut times = FileTimes::from_env(&self.env)?;
		self.watch_tree(&mut times, &root)
			.map_err(|err| format!("failed to recursively watch dir '{dir}': {}", os_error(&err)))?;
		self.print_watches(shell, &times)
	}

	fn watch_list(&mut self, args: &[String]) -> Outcome {
		let target = args.first().map_or("bash", String::as_str);
		let shell =
			Shell::detect(target).ok_or_else(|| format!("unknown target shell '{target}'"))?;
		let mut times = FileTimes::from_env(&self.env)?;
		let mut input = String::new();
		self.host.stdin.read_to_string(&mut input).map_err(|err| os_error(&err))?;
		// `MTIME PATH` lines; an unterminated last line is not one.
		let lines = input.rfind('\n').map(|end| input[..end].split('\n'));
		for (index, line) in lines.into_iter().flatten().enumerate() {
			let number = index + 1;
			let Some((mtime, path)) = line.split_once(' ') else {
				return Err(format!("line {number}: expected to contain two elements"));
			};
			let mtime: i64 = mtime.parse().map_err(|_| {
				format!("line {number}: strconv.Atoi: parsing {mtime:?}: invalid syntax")
			})?;
			times.set(self.abs(path), mtime, true);
		}
		self.print_watches(shell, &times)
	}

	fn watch_print(&mut self, args: &[String]) -> Outcome {
		let separator = if args.first().is_some_and(|arg| arg == "--null") { '\0' } else { '\n' };
		let mut text = String::new();
		for time in FileTimes::from_env(&self.env)?.0 {
			text.push_str(&time.path);
			text.push(separator);
		}
		self.print(&text);
		Ok(())
	}

	fn current(&mut self, args: &[String]) -> Outcome {
		let Some(path) = args.first() else {
			return Err("missing PATH argument".to_owned());
		};
		let path = self.abs(path);
		let times = FileTimes::from_env(&self.env)?;
		match times.0.iter().find(|time| time.path == path) {
			Some(time) => self.check_time(time),
			None => Err(format!("File {path:?} is unknown")),
		}
	}

	fn check_required(&mut self, args: &[String]) -> Outcome {
		let [target, envrc, paths @ ..] = args else {
			return Err(if args.is_empty() { "a shell name is required" } else { "an envrc path is required" }.to_owned());
		};
		if paths.is_empty() {
			return Err("at least one file path is required".to_owned());
		}
		let cfg = self.config()?;
		let shell =
			Shell::detect(target).ok_or_else(|| format!("unknown target shell '{target}'"))?;
		let envrc = self.abs(envrc);
		let envrc_dir = dirname(&envrc);
		let approved_dir = join(&cfg.allowed_required_dir(), &path_hash(&envrc));
		let mut missing: Vec<&str> = Vec::new();
		for relative in paths {
			let refusal = if Path::new(relative).is_absolute() {
				Some("path must be relative")
			} else if relative.contains("..") {
				Some("path must not contain '..'")
			} else {
				None
			};
			if let Some(refusal) = refusal {
				let message = bash_escape(&format!("require_allowed: {refusal}: {relative}"));
				self.print(&format!("log_error {message};\nexit 1;\n"));
				return Ok(());
			}
			let approved = self
				.file_hash(&join(&envrc_dir, relative))
				.is_ok_and(|hash| self.host.fs().metadata(join(&approved_dir, &hash)).is_ok());
			if !approved {
				missing.push(relative);
			}
		}
		if missing.is_empty() {
			return Ok(());
		}
		// The `.envrc` stops here; `direnv allow` approves what is listed.
		let pending = missing.join(":");
		let mut text = shell.export(&[(DIRENV_REQUIRED, Some(pending.as_str()))])?;
		let files = match missing.as_slice() {
			[one] => format!("{one} requires"),
			many => format!("{} require", many.join(" and ")),
		};
		let message = bash_escape(&format!("{files} approval. Run 'direnv allow' to approve."));
		let _ = write!(text, "log_error {message};\nexit 0;\n");
		self.print(&text);
		Ok(())
	}

	fn log(&mut self, args: &[String]) -> Outcome {
		let [kind, message] = args else {
			return Err("invalid arguments".to_owned());
		};
		let cfg = self.config()?;
		match kind.as_str() {
			"--status" | "-status" => self.log_status(&cfg, message),
			"--error" | "-error" => self.log_error(&cfg, message),
			_ => return Err(format!("invalid log-type '{kind}'")),
		}
		Ok(())
	}
}

/// Lowercase hex of `bytes`.
fn hex(bytes: &[u8]) -> String {
	let mut text = String::with_capacity(bytes.len() * 2);
	for byte in bytes {
		let _ = write!(text, "{byte:02x}");
	}
	text
}

/// Whether files under `dir` cannot be executed whatever their mode.
#[cfg(unix)]
fn mounted_noexec(dir: &Path) -> bool {
	#[cfg(any(target_os = "linux", target_os = "android"))]
	{
		rustix::fs::statvfs(dir)
			.is_ok_and(|stat| stat.f_flag.contains(rustix::fs::StatVfsMountFlags::NOEXEC))
	}
	#[cfg(not(any(target_os = "linux", target_os = "android")))]
	{
		let _ = dir;
		false
	}
}

/// The command that runs `script` in a new shell of the engine: an
/// executable text file without `#!`, which the shell runs itself as bash
/// does. Where no such file can run (no execute permission to give, a
/// `noexec` temporary directory), a subshell of the caller reads the script
/// instead, after dropping the options an `.envrc` must not inherit.
fn script_command(dir: &Path, script: String) -> io::Result<ShellCommand> {
	#[cfg(unix)]
	if !mounted_noexec(dir) {
		use std::os::unix::fs::PermissionsExt as _;

		let path = dir.join("envrc");
		std::fs::write(&path, script)?;
		std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
		return Ok(ShellCommand::new(vec![path.into_os_string()]));
	}
	let _ = dir;
	Ok(ShellCommand::line(format!("{SUBSHELL_RESET}{script}")))
}

#[cfg(test)]
mod tests;
