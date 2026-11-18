//! `fswatch`'s command line: `getopt_long` scanning, the option table and the
//! messages of fswatch 1.22.

use std::ffi::OsString;

use omp_xfs::watch::Backend;

/// The fswatch release this command line follows; `--version` reports it.
pub(super) const VERSION: &str = "1.22.0";

/// `FSW_EXIT_*`: fswatch's exit statuses.
pub(super) const EXIT_UNKNOWN_OPTION: i32 = 1;
pub(super) const EXIT_LATENCY: i32 = 3;
pub(super) const EXIT_ERROR: i32 = 5;
pub(super) const EXIT_OPTION: i32 = 7;
pub(super) const EXIT_MONITOR_NAME: i32 = 8;
pub(super) const EXIT_FORMAT: i32 = 9;

/// A path filter as given: `-e`, `-i`, or a line of a `--filter-from` file.
pub(super) struct FilterSpec {
	pub text:           String,
	pub include:        bool,
	pub extended:       bool,
	pub case_sensitive: bool,
}

/// `--filter-mode`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum FilterMode {
	/// The last matching filter decides, and an include wins at once.
	Legacy,
	/// A path passes when no exclude matches and, if there are includes, one
	/// of them does.
	Conjunctive,
}

/// What the command line asks for.
pub(super) struct Options {
	pub print0:         bool,
	pub one_event:      bool,
	pub access:         bool,
	pub allow_overflow: bool,
	/// `--batch-marker[=marker]`: the line ending every batch.
	pub batch_marker:   Option<String>,
	pub bubble:         bool,
	pub directories:    bool,
	/// `-e` and `-i`, in order.
	pub filters:        Vec<FilterSpec>,
	pub prune:          Vec<String>,
	pub extended:       bool,
	pub insensitive:    bool,
	pub filter_files:   Vec<OsString>,
	pub filter_mode:    FilterMode,
	/// `--event`: the accepted flags, as `fsw_event_flag` values (`NoOp` is 0).
	pub events:         Vec<u32>,
	/// `--format`.
	pub format:         Option<String>,
	pub time_format:    String,
	pub idle_events:    bool,
	pub follow_links:   bool,
	pub latency:        f64,
	pub no_defer:       bool,
	pub monitor:        Option<String>,
	/// `--monitor-property name=value`, in order; the last of a name counts.
	pub properties:     Vec<(String, String)>,
	pub numeric:        bool,
	pub one_per_batch:  bool,
	pub recursive:      bool,
	pub timestamp:      bool,
	pub utc:            bool,
	pub event_flags:    bool,
	pub flag_separator: String,
	pub paths:          Vec<OsString>,
}

impl Default for Options {
	fn default() -> Self {
		Self {
			print0:         false,
			one_event:      false,
			access:         false,
			allow_overflow: false,
			batch_marker:   None,
			bubble:         false,
			directories:    false,
			filters:        Vec::new(),
			prune:          Vec::new(),
			extended:       false,
			insensitive:    false,
			filter_files:   Vec::new(),
			filter_mode:    FilterMode::Legacy,
			events:         Vec::new(),
			format:         None,
			time_format:    "%c".to_owned(),
			idle_events:    false,
			follow_links:   false,
			latency:        1.0,
			no_defer:       false,
			monitor:        None,
			properties:     Vec::new(),
			numeric:        false,
			one_per_batch:  false,
			recursive:      false,
			timestamp:      false,
			utc:            false,
			event_flags:    false,
			flag_separator: " ".to_owned(),
			paths:          Vec::new(),
		}
	}
}

impl Options {
	/// The value of the monitor property `name`, if set.
	pub(super) fn property(&self, name: &str) -> Option<&str> {
		self
			.properties
			.iter()
			.rev()
			.find(|(known, _)| known == name)
			.map(|(_, value)| value.as_str())
	}
}

/// An invocation that ends while its options are read: `-h`, `-M`,
/// `--version`, or an error.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Exit {
	pub code:   i32,
	pub stdout: String,
	pub stderr: String,
}

impl Exit {
	fn out(text: String) -> Self {
		Self { code: 0, stdout: text, stderr: String::new() }
	}

	pub(super) fn error(code: i32, message: impl Into<String>) -> Self {
		let mut stderr = message.into();
		stderr.push('\n');
		Self { code, stdout: String::new(), stderr }
	}
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Opt {
	Access,
	AllowOverflow,
	BatchMarker,
	Bubble,
	Directories,
	Event,
	EventFlags,
	EventFlagSeparator,
	Exclude,
	Extended,
	FilterMode,
	FilterFrom,
	FireIdle,
	FollowLinks,
	Format,
	FormatTime,
	Help,
	Include,
	Insensitive,
	Latency,
	NoDefer,
	ListMonitors,
	Monitor,
	MonitorProperty,
	Numeric,
	OnePerBatch,
	OneEvent,
	Print0,
	Prune,
	Recursive,
	Timestamp,
	Utc,
	Verbose,
	Version,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Arg {
	None,
	Required,
	Optional,
}

/// fswatch's `long_options`, in its order.
const LONG: [(&str, Arg, Opt); 34] = [
	("access", Arg::None, Opt::Access),
	("allow-overflow", Arg::None, Opt::AllowOverflow),
	("batch-marker", Arg::Optional, Opt::BatchMarker),
	("bubble-events", Arg::None, Opt::Bubble),
	("directories", Arg::None, Opt::Directories),
	("event", Arg::Required, Opt::Event),
	("event-flags", Arg::None, Opt::EventFlags),
	("event-flag-separator", Arg::Required, Opt::EventFlagSeparator),
	("exclude", Arg::Required, Opt::Exclude),
	("extended", Arg::None, Opt::Extended),
	("filter-mode", Arg::Required, Opt::FilterMode),
	("filter-from", Arg::Required, Opt::FilterFrom),
	("fire-idle-events", Arg::None, Opt::FireIdle),
	("follow-links", Arg::None, Opt::FollowLinks),
	("format", Arg::Required, Opt::Format),
	("format-time", Arg::Required, Opt::FormatTime),
	("help", Arg::None, Opt::Help),
	("include", Arg::Required, Opt::Include),
	("insensitive", Arg::None, Opt::Insensitive),
	("latency", Arg::Required, Opt::Latency),
	("no-defer", Arg::None, Opt::NoDefer),
	("list-monitors", Arg::None, Opt::ListMonitors),
	("monitor", Arg::Required, Opt::Monitor),
	("monitor-property", Arg::Required, Opt::MonitorProperty),
	("numeric", Arg::None, Opt::Numeric),
	("one-per-batch", Arg::None, Opt::OnePerBatch),
	("one-event", Arg::None, Opt::OneEvent),
	("print0", Arg::None, Opt::Print0),
	("prune", Arg::Required, Opt::Prune),
	("recursive", Arg::None, Opt::Recursive),
	("timestamp", Arg::None, Opt::Timestamp),
	("utc-time", Arg::None, Opt::Utc),
	("verbose", Arg::None, Opt::Verbose),
	("version", Arg::None, Opt::Version),
];

/// fswatch's short options (`01abde:Ef:hi:Il:LMm:nortuvx`).
const fn short(letter: u8) -> Option<(Arg, Opt)> {
	Some(match letter {
		b'0' => (Arg::None, Opt::Print0),
		b'1' => (Arg::None, Opt::OneEvent),
		b'a' => (Arg::None, Opt::Access),
		b'b' => (Arg::None, Opt::Bubble),
		b'd' => (Arg::None, Opt::Directories),
		b'e' => (Arg::Required, Opt::Exclude),
		b'E' => (Arg::None, Opt::Extended),
		b'f' => (Arg::Required, Opt::FormatTime),
		b'h' => (Arg::None, Opt::Help),
		b'i' => (Arg::Required, Opt::Include),
		b'I' => (Arg::None, Opt::Insensitive),
		b'l' => (Arg::Required, Opt::Latency),
		b'L' => (Arg::None, Opt::FollowLinks),
		b'M' => (Arg::None, Opt::ListMonitors),
		b'm' => (Arg::Required, Opt::Monitor),
		b'n' => (Arg::None, Opt::Numeric),
		b'o' => (Arg::None, Opt::OnePerBatch),
		b'r' => (Arg::None, Opt::Recursive),
		b't' => (Arg::None, Opt::Timestamp),
		b'u' => (Arg::None, Opt::Utc),
		b'v' => (Arg::None, Opt::Verbose),
		b'x' => (Arg::None, Opt::EventFlags),
		_ => return None,
	})
}

/// The monitors of this platform as fswatch lists them: by name.
pub(super) fn monitor_names() -> Vec<&'static str> {
	let mut names: Vec<_> = Backend::available()
		.iter()
		.map(|backend| backend.monitor_name())
		.collect();
	names.sort_unstable();
	names
}

fn monitor_list() -> String {
	let mut list = String::new();
	for name in monitor_names() {
		list.push_str("  ");
		list.push_str(name);
		list.push('\n');
	}
	list
}

fn usage() -> String {
	format!(
		"fswatch {VERSION}

Usage:
fswatch [OPTION] ... path ...

Options:
 -0, --print0          Use the ASCII NUL character (0) as line separator.
 -1, --one-event       Exit fswatch after the first set of events is received.
     --allow-overflow  Allow a monitor to overflow and report it as a change event.
     --batch-marker    Print a marker at the end of every batch.
 -a, --access          Watch file accesses.
 -b, --bubble-events   Bubble events with the same timestamp and path.
 -d, --directories     Watch directories only.
 -e, --exclude=REGEX   Exclude paths matching REGEX.
 -E, --extended        Use extended regular expressions.
     --filter-from=FILE
                       Load filters from file.
     --filter-mode=MODE
                       Set filter mode: legacy or conjunctive.
     --format=FORMAT   Use the specified record format.
                       Directives: %p path, %f flags, %t time, %c correlation, %K process id kind, \
		 %P process id.
 -f, --format-time     Print the event time using the specified format.
     --fire-idle-event Fire idle events.
 -h, --help            Show this message.
 -i, --include=REGEX   Include paths matching REGEX.
 -I, --insensitive     Use case insensitive regular expressions.
 -l, --latency=DOUBLE  Set the latency.
     --no-defer        Set the no defer flag in the monitor.
 -L, --follow-links    Follow symbolic links.
 -M, --list-monitors   List the available monitors.
 -m, --monitor=NAME    Use the specified monitor.
     --monitor-property name=value
                       Define the specified property.
 -n, --numeric         Print a numeric event mask.
 -o, --one-per-batch   Print a single message with the number of change events.
     --prune=REGEX     Do not descend into directories matching REGEX.
 -r, --recursive       Recurse subdirectories.
 -t, --timestamp       Print the event timestamp.
 -u, --utc-time        Print the event time as UTC time.
 -x, --event-flags     Print the event flags.
     --event=TYPE      Filter the event by the specified type.
     --event-flag-separator=STRING
                       Print event flags using the specified separator.
 -v, --verbose         Print verbose output.
     --version         Print the version of fswatch and exit.

Available monitors in this platform:

{}",
		monitor_list()
	)
}

/// `getopt_long`'s complaint about the command line, then the usage.
fn misuse(complaint: std::fmt::Arguments<'_>) -> Exit {
	Exit {
		code:   EXIT_UNKNOWN_OPTION,
		stdout: String::new(),
		stderr: format!("fswatch: {complaint}\n{}", usage()),
	}
}

/// A long option as `getopt_long` quotes it: BSD's `` `--name' `` on macOS,
/// GNU's `'--name'` elsewhere.
fn quoted(name: &str) -> String {
	if cfg!(target_os = "macos") { format!("`--{name}'") } else { format!("'--{name}'") }
}

/// A short option as `getopt_long` names it.
fn letter(option: char) -> String {
	if cfg!(target_os = "macos") { option.to_string() } else { format!("'{option}'") }
}

/// The long option `name` spells: the exact name, or the one option it is a
/// prefix of.
fn long(name: &str) -> Result<(&'static str, Arg, Opt), Exit> {
	if let Some(&exact) = LONG.iter().find(|(known, ..)| *known == name) {
		return Ok(exact);
	}
	let mut candidates = LONG.iter().filter(|(known, ..)| known.starts_with(name));
	let Some(&first) = candidates.next() else {
		return Err(misuse(format_args!("unrecognized option {}", quoted(name))));
	};
	let others: Vec<_> = candidates.filter(|(.., opt)| *opt != first.2).collect();
	if others.is_empty() {
		return Ok(first);
	}
	if cfg!(target_os = "macos") {
		return Err(misuse(format_args!("option {} is ambiguous", quoted(name))));
	}
	let mut possibilities = quoted(first.0);
	for (other, ..) in others {
		possibilities.push(' ');
		possibilities.push_str(&quoted(other));
	}
	Err(misuse(format_args!("option {} is ambiguous; possibilities: {possibilities}", quoted(name))))
}

/// The number `strtod` reads at the start of `text`; 0 when there is none.
fn strtod(text: &str) -> f64 {
	let text = text.trim_start();
	let bytes = text.as_bytes();
	let mut end = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
	let unsigned = &text[end..];
	for word in ["infinity", "inf", "nan"] {
		if unsigned.get(..word.len()).is_some_and(|head| head.eq_ignore_ascii_case(word)) {
			return text[..end + word.len()].parse().unwrap_or(0.0);
		}
	}
	let digits = |from: usize| bytes[from..].iter().take_while(|byte| byte.is_ascii_digit()).count();
	let whole = digits(end);
	end += whole;
	let mut fraction = 0;
	if bytes.get(end) == Some(&b'.') {
		fraction = digits(end + 1);
		if whole + fraction > 0 {
			end += 1 + fraction;
		}
	}
	if whole + fraction == 0 {
		return 0.0;
	}
	if matches!(bytes.get(end), Some(b'e' | b'E')) {
		let sign = usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
		let exponent = digits(end + 1 + sign);
		if exponent > 0 {
			end += 1 + sign + exponent;
		}
	}
	text[..end].parse().unwrap_or(0.0)
}

/// `--event`: a bit mask of `fsw_event_flag` values, or the name of one.
fn event_filter(text: &str, accepted: &mut Vec<u32>) -> Result<(), Exit> {
	let trimmed = text.trim_start();
	let (negative, digits) = match trimmed.as_bytes().first() {
		Some(b'-') => (true, &trimmed[1..]),
		Some(b'+') => (false, &trimmed[1..]),
		_ => (false, trimmed),
	};
	let count = digits.bytes().take_while(u8::is_ascii_digit).count();
	if count > 0
		&& let Ok(mask) = digits[..count].parse::<u64>()
	{
		let mask = if negative { mask.wrapping_neg() } else { mask };
		// `NoOp` is 0, which every mask holds.
		accepted.push(0);
		accepted.extend((0..15).map(|bit| 1u32 << bit).filter(|&flag| mask & u64::from(flag) != 0));
		return Ok(());
	}
	match omp_xfs::watch::Flags::from_name(text) {
		Some(flag) => {
			accepted.push(flag.bits());
			Ok(())
		},
		None => Err(Exit::error(EXIT_OPTION, format!("Unknown event type: {text}"))),
	}
}

impl Options {
	fn apply(&mut self, opt: Opt, value: Option<String>) -> Result<(), Exit> {
		if opt == Opt::BatchMarker {
			// Without a value, an earlier marker stays.
			match value {
				Some(marker) => self.batch_marker = Some(marker),
				None if self.batch_marker.is_none() => self.batch_marker = Some("NoOp".to_owned()),
				None => {},
			}
			return Ok(());
		}
		let value = value.unwrap_or_default();
		match opt {
			Opt::Print0 => self.print0 = true,
			Opt::OneEvent => self.one_event = true,
			Opt::Access => self.access = true,
			Opt::AllowOverflow => self.allow_overflow = true,
			Opt::Bubble => self.bubble = true,
			Opt::Directories => self.directories = true,
			Opt::Exclude | Opt::Include => self.filters.push(FilterSpec {
				text:           value,
				include:        opt == Opt::Include,
				extended:       false,
				case_sensitive: true,
			}),
			Opt::Extended => self.extended = true,
			Opt::FormatTime => self.time_format = value,
			Opt::Help => return Err(Exit::out(usage())),
			Opt::Insensitive => self.insensitive = true,
			Opt::Latency => {
				let latency = strtod(&value);
				if latency == 0.0 || latency.is_nan() {
					return Err(Exit::error(EXIT_LATENCY, format!("Invalid value: {value}")));
				}
				if latency.is_infinite() {
					return Err(Exit::error(EXIT_LATENCY, format!("Value out of range: {value}")));
				}
				self.latency = latency;
			},
			Opt::FollowLinks => self.follow_links = true,
			Opt::ListMonitors => return Err(Exit::out(monitor_list())),
			Opt::Monitor => self.monitor = Some(value),
			Opt::Numeric => {
				self.numeric = true;
				self.event_flags = true;
			},
			Opt::OnePerBatch => self.one_per_batch = true,
			Opt::Recursive => self.recursive = true,
			Opt::Timestamp => self.timestamp = true,
			Opt::Utc => self.utc = true,
			// Verbose output is libfswatch's trace of its own internals.
			Opt::Verbose | Opt::Version | Opt::BatchMarker => {},
			Opt::EventFlags => self.event_flags = true,
			Opt::Format => self.format = Some(value),
			Opt::EventFlagSeparator => self.flag_separator = value,
			Opt::Event => event_filter(&value, &mut self.events)?,
			Opt::MonitorProperty => match value.split_once('=') {
				Some((name, value)) => self.properties.push((name.to_owned(), value.to_owned())),
				None => return Err(Exit::error(EXIT_OPTION, "Invalid property format.")),
			},
			Opt::FireIdle => self.idle_events = true,
			Opt::FilterFrom => self.filter_files.push(value.into()),
			Opt::FilterMode => {
				self.filter_mode = match value.as_str() {
					"legacy" => FilterMode::Legacy,
					"conjunctive" => FilterMode::Conjunctive,
					_ => return Err(Exit::error(EXIT_OPTION, format!("Invalid filter mode: {value}"))),
				};
			},
			Opt::Prune => self.prune.push(value),
			Opt::NoDefer => self.no_defer = true,
		}
		Ok(())
	}
}

/// Whether `format` holds only directives fswatch knows.
fn format_is_valid(format: &str) -> bool {
	let mut bytes = format.bytes();
	while let Some(byte) = bytes.next() {
		if byte == b'%'
			&& !matches!(bytes.next(), Some(b'%' | b'0' | b'c' | b'n' | b'f' | b'K' | b'p' | b'P' | b't'))
		{
			return false;
		}
	}
	true
}

/// Reads the arguments after the command name as `getopt_long` does: options
/// anywhere among the paths until a `--`.
///
/// # Errors
///
/// The [`Exit`] of an invocation that watches nothing.
pub(super) fn parse(args: &[OsString]) -> Result<Options, Exit> {
	let mut options = Options::default();
	let mut version = false;
	let mut args = args.iter();
	while let Some(arg) = args.next() {
		let Some(text) = arg.to_str().filter(|text| text.len() > 1 && text.starts_with('-')) else {
			// A path, `-` included.
			options.paths.push(arg.clone());
			continue;
		};
		if text == "--" {
			options.paths.extend(args.by_ref().cloned());
			break;
		}
		if let Some(spelled) = text.strip_prefix("--") {
			let (name, attached) = match spelled.split_once('=') {
				Some((name, value)) => (name, Some(value)),
				None => (spelled, None),
			};
			let (name, takes, opt) = long(name)?;
			let value = match (takes, attached) {
				(Arg::None, Some(_)) => {
					return Err(misuse(format_args!("option {} doesn't allow an argument", quoted(name))));
				},
				(Arg::None, None) | (Arg::Optional, None) => None,
				(Arg::Required | Arg::Optional, Some(value)) => Some(value.to_owned()),
				(Arg::Required, None) => match args.next() {
					Some(value) => Some(value.to_string_lossy().into_owned()),
					None => {
						return Err(misuse(format_args!("option {} requires an argument", quoted(name))));
					},
				},
			};
			version |= opt == Opt::Version;
			options.apply(opt, value)?;
			continue;
		}
		let cluster = &text[1..];
		for (at, option) in cluster.char_indices() {
			let Some((takes, opt)) = u8::try_from(option).ok().and_then(short) else {
				return Err(misuse(format_args!("invalid option -- {}", letter(option))));
			};
			if takes == Arg::None {
				options.apply(opt, None)?;
				continue;
			}
			let rest = &cluster[at + 1..];
			let value = if rest.is_empty() {
				match args.next() {
					Some(value) => value.to_string_lossy().into_owned(),
					None => {
						return Err(misuse(format_args!(
							"option requires an argument -- {}",
							letter(option)
						)));
					},
				}
			} else {
				rest.to_owned()
			};
			options.apply(opt, Some(value))?;
			break;
		}
	}

	if version {
		return Err(Exit::out(format!("fswatch {VERSION}\n")));
	}
	if let Some(format) = &options.format {
		if options.timestamp || options.event_flags {
			return Err(Exit::error(
				EXIT_FORMAT,
				"--format is incompatible with any other format option such as -t and -x.",
			));
		}
		if options.one_per_batch {
			return Err(Exit::error(EXIT_FORMAT, "--format is incompatible with -o."));
		}
		if !format_is_valid(format) {
			return Err(Exit::error(EXIT_FORMAT, "Invalid format."));
		}
	}
	if options.paths.is_empty() {
		return Err(Exit::error(EXIT_UNKNOWN_OPTION, "Invalid number of arguments."));
	}
	if let Some(name) = &options.monitor
		&& !monitor_names().contains(&name.as_str())
	{
		return Err(Exit::error(EXIT_MONITOR_NAME, "Invalid monitor name."));
	}
	Ok(options)
}
