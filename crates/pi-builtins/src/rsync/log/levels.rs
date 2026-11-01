//! `--info` / `--debug` output levels and their word grammar.
//!
//! Each flag has a level (0 = silent) and the priority of whoever set it last:
//! verbosity defaults never override words the user gave, so `-v` and
//! `--info=` combine in either order exactly as upstream's do.

/// `--info` flags, in upstream's table order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Info {
	Backup,
	Copy,
	Del,
	Flist,
	Misc,
	Mount,
	Name,
	Nonreg,
	Progress,
	Remove,
	Skip,
	Stats,
	Symsafe,
}

/// `--debug` flags this implementation reports on; the discriminant is the flag's position
/// in upstream's table (`DEBUG_WORDS`). BIND, CHDIR, EXIT, HASH, and IO parse and show in the
/// help but no code path emits their messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Debug {
	Acl = 0,
	Backup = 1,
	Connect = 4,
	Cmd = 5,
	Del = 6,
	Deltasum = 7,
	Dup = 8,
	Filter = 10,
	Flist = 11,
	Fuzzy = 12,
	Genr = 13,
	Hlink = 15,
	Iconv = 16,
	Nstr = 18,
	Own = 19,
	Proto = 20,
	Recv = 21,
	Send = 22,
	Time = 23,
}

/// Who set a level; a word only changes a flag last set at the same or a lower priority.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Priority {
	/// Implied by `-v`, `--stats`, `--progress`, ….
	Default = 0,
	/// Used while rendering the help text.
	Help = 1,
	/// `--info=` / `--debug=` on the command line.
	User = 2,
}

/// Outcome of parsing a word list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Words {
	/// Every word was applied.
	Done,
	/// A `help` word was reached (words before it were applied); the caller prints
	/// [`OutLevels::info_help`] / [`OutLevels::debug_help`] and exits 0.
	Help,
}

const W_CLI: u8 = 1 << 0;
const W_SRV: u8 = 1 << 1;
const W_SND: u8 = 1 << 2;
const W_REC: u8 = 1 << 3;

/// The largest N accepted in a `flagN` word.
const MAX_OUT_LEVEL: i16 = 4;
/// The largest meaningful `-v` count.
const MAX_VERBOSITY: usize = 5;

struct Word {
	name: &'static str,
	help: &'static str,
	scope: u8,
}

const fn word(name: &'static str, scope: u8, help: &'static str) -> Word {
	Word { name, help, scope }
}

const INFO_COUNT: usize = 13;
const DEBUG_COUNT: usize = 24;

static INFO_WORDS: [Word; INFO_COUNT] = [
	word("BACKUP", W_REC, "Mention files backed up"),
	word("COPY", W_REC, "Mention files copied locally on the receiving side"),
	word("DEL", W_REC, "Mention deletions on the receiving side"),
	word("FLIST", W_CLI, "Mention file-list receiving/sending (levels 1-2)"),
	word("MISC", W_SND | W_REC, "Mention miscellaneous information (levels 1-2)"),
	word("MOUNT", W_SND | W_REC, "Mention mounts that were found or skipped"),
	word("NAME", W_SND | W_REC, "Mention 1) updated file/dir names, 2) unchanged names"),
	word("NONREG", W_REC, "Mention skipped non-regular files (default 1, 0 disables)"),
	word("PROGRESS", W_CLI, "Mention 1) per-file progress or 2) total transfer progress"),
	word("REMOVE", W_SND, "Mention files removed on the sending side"),
	word("SKIP", W_REC, "Mention files skipped due to transfer overrides (levels 1-2)"),
	word("STATS", W_CLI | W_SRV, "Mention statistics at end of run (levels 1-3)"),
	word("SYMSAFE", W_SND | W_REC, "Mention symlinks that are unsafe"),
];

static DEBUG_WORDS: [Word; DEBUG_COUNT] = [
	word("ACL", W_SND | W_REC, "Debug extra ACL info"),
	word("BACKUP", W_REC, "Debug backup actions (levels 1-2)"),
	word("BIND", W_CLI, "Debug socket bind actions"),
	word("CHDIR", W_CLI | W_SRV, "Debug when the current directory changes"),
	word("CONNECT", W_CLI, "Debug connection events (levels 1-2)"),
	word("CMD", W_CLI, "Debug commands+options that are issued (levels 1-2)"),
	word("DEL", W_REC, "Debug delete actions (levels 1-3)"),
	word("DELTASUM", W_SND | W_REC, "Debug delta-transfer checksumming (levels 1-4)"),
	word("DUP", W_REC, "Debug weeding of duplicate names"),
	word("EXIT", W_CLI | W_SRV, "Debug exit events (levels 1-3)"),
	word("FILTER", W_SND | W_REC, "Debug filter actions (levels 1-3)"),
	word("FLIST", W_SND | W_REC, "Debug file-list operations (levels 1-4)"),
	word("FUZZY", W_REC, "Debug fuzzy scoring (levels 1-2)"),
	word("GENR", W_REC, "Debug generator functions"),
	word("HASH", W_SND | W_REC, "Debug hashtable code"),
	word("HLINK", W_SND | W_REC, "Debug hard-link actions (levels 1-3)"),
	word("ICONV", W_CLI | W_SRV, "Debug iconv character conversions (levels 1-2)"),
	word("IO", W_CLI | W_SRV, "Debug I/O routines (levels 1-4)"),
	word("NSTR", W_CLI | W_SRV, "Debug negotiation strings"),
	word("OWN", W_REC, "Debug ownership changes in users & groups (levels 1-2)"),
	word("PROTO", W_CLI | W_SRV, "Debug protocol information"),
	word("RECV", W_REC, "Debug receiver functions"),
	word("SEND", W_SND, "Debug sender functions"),
	word("TIME", W_REC, "Debug setting of modified times (levels 1-2)"),
];

/// Words each `-v` level adds (index = verbosity).
static INFO_VERBOSITY: [Option<&str>; MAX_VERBOSITY + 1] = [
	Some("NONREG"),
	Some("COPY,DEL,FLIST,MISC,NAME,STATS,SYMSAFE"),
	Some("BACKUP,MISC2,MOUNT,NAME2,REMOVE,SKIP"),
	None,
	None,
	None,
];

static DEBUG_VERBOSITY: [Option<&str>; MAX_VERBOSITY + 1] = [
	None,
	None,
	Some("BIND,CMD,CONNECT,DEL,DELTASUM,DUP,FILTER,FLIST,ICONV"),
	Some(
		"ACL,BACKUP,CONNECT2,DELTASUM2,DEL2,EXIT,FILTER2,FLIST2,FUZZY,GENR,OWN,RECV,SEND,TIME",
	),
	Some("CMD2,DELTASUM3,DEL3,EXIT2,FLIST3,ICONV2,OWN2,PROTO,TIME2"),
	Some("CHDIR,DELTASUM4,FLIST4,FUZZY2,HASH,HLINK"),
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
	Info,
	Debug,
}

impl Kind {
	fn words(self) -> &'static [Word] {
		match self {
			Self::Info => &INFO_WORDS,
			Self::Debug => &DEBUG_WORDS,
		}
	}

	const fn option(self) -> &'static str {
		match self {
			Self::Info => "--info",
			Self::Debug => "--debug",
		}
	}

	fn verbosity(self) -> &'static [Option<&'static str>; MAX_VERBOSITY + 1] {
		match self {
			Self::Info => &INFO_VERBOSITY,
			Self::Debug => &DEBUG_VERBOSITY,
		}
	}
}

/// `--info`/`--debug` levels (parse_output_words, verbosity defaults).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct OutLevels {
	info: [i16; INFO_COUNT],
	info_prio: [u8; INFO_COUNT],
	debug: [i16; DEBUG_COUNT],
	debug_prio: [u8; DEBUG_COUNT],
}

impl OutLevels {
	/// The levels `-v` repeated `verbose` times implies (0 still sets NONREG).
	#[cfg(test)]
	pub(crate) fn from_verbose(verbose: u8) -> Self {
		let mut levels = Self::default();
		levels.apply_verbose(verbose);
		levels
	}

	/// Adds the `-v` defaults at [`Priority::Default`] (never overrides user words).
	pub(crate) fn apply_verbose(&mut self, verbose: u8) {
		let top = usize::from(verbose).min(MAX_VERBOSITY);
		for level in 0..=top {
			for kind in [Kind::Info, Kind::Debug] {
				if let Some(words) = kind.verbosity()[level] {
					let _ = self.parse(kind, words, Priority::Default, true);
				}
			}
		}
	}

	/// `--info=WORDS` at user priority; `help` is accepted and ignored here (see `parse_info`).
	#[cfg(test)]
	pub(crate) fn apply_info(&mut self, words: &str) -> Result<(), String> {
		self.parse(Kind::Info, words, Priority::User, false).map(|_| ())
	}

	/// `--debug=WORDS` at user priority.
	#[cfg(test)]
	pub(crate) fn apply_debug(&mut self, words: &str) -> Result<(), String> {
		self.parse(Kind::Debug, words, Priority::User, false).map(|_| ())
	}

	/// Full `--info` word parsing. Err is `Unknown --info item: "x"` (RERR_SYNTAX); a server
	/// silently ignores unknown words.
	pub(crate) fn parse_info(
		&mut self,
		words: &str,
		priority: Priority,
		am_server: bool,
	) -> Result<Words, String> {
		self.parse(Kind::Info, words, priority, am_server)
	}

	/// Full `--debug` word parsing (see [`Self::parse_info`]).
	pub(crate) fn parse_debug(
		&mut self,
		words: &str,
		priority: Priority,
		am_server: bool,
	) -> Result<Words, String> {
		self.parse(Kind::Debug, words, priority, am_server)
	}

	/// Level of an info flag (0 while negated).
	pub(crate) fn info(&self, flag: Info) -> u8 {
		clamp_level(self.info[flag as usize])
	}

	/// Level of a debug flag (0 while negated).
	pub(crate) fn debug(&self, flag: Debug) -> u8 {
		clamp_level(self.debug[flag as usize])
	}

	/// Forces an info flag's level (no priority bookkeeping).
	#[cfg(test)]
	pub(crate) fn set_info(&mut self, flag: Info, level: u8) {
		self.info[flag as usize] = i16::from(level);
	}

	/// Flips every level's sign; negated levels read as 0 until negated back
	/// (negate_output_levels, used while files-from data shares the socket).
	pub(crate) fn negate(&mut self) {
		for level in self.info.iter_mut().chain(self.debug.iter_mut()) {
			*level = -*level;
		}
	}

	/// The `--info=…` argument conveying non-implied info levels to the peer
	/// (make_output_option), or None when nothing needs saying.
	pub(crate) fn server_info_arg(&self, am_server: bool, am_sender: bool) -> Option<String> {
		self.make_option(Kind::Info, scope_for(am_server, am_sender))
	}

	/// Text of `--info=help`.
	pub(crate) fn info_help() -> String {
		help_text(Kind::Info)
	}

	/// Text of `--debug=help`.
	pub(crate) fn debug_help() -> String {
		help_text(Kind::Debug)
	}

	fn slots(&mut self, kind: Kind) -> (&mut [i16], &mut [u8]) {
		match kind {
			Kind::Info => (&mut self.info, &mut self.info_prio),
			Kind::Debug => (&mut self.debug, &mut self.debug_prio),
		}
	}

	fn view(&self, kind: Kind) -> (&[i16], &[u8]) {
		match kind {
			Kind::Info => (&self.info, &self.info_prio),
			Kind::Debug => (&self.debug, &self.debug_prio),
		}
	}

	fn parse(
		&mut self,
		kind: Kind,
		words: &str,
		priority: Priority,
		am_server: bool,
	) -> Result<Words, String> {
		let table = kind.words();
		let (levels, prios) = self.slots(kind);
		for item in words.as_bytes().split(|&b| b == b',') {
			if item.is_empty() {
				continue;
			}
			let mut len = item.len();
			if !item[0].is_ascii_digit() {
				while len > 0 && item[len - 1].is_ascii_digit() {
					len -= 1;
				}
			}
			let digits = &item[len..];
			let mut level = if digits.first().is_some_and(u8::is_ascii_digit) {
				parse_level(digits)
			} else {
				1
			};
			let mut name = &item[..len];
			if name.eq_ignore_ascii_case(b"help") {
				return Ok(Words::Help);
			}
			if name.eq_ignore_ascii_case(b"none") {
				name = b"";
				level = 0;
			} else if name.eq_ignore_ascii_case(b"all") {
				name = b"";
			}
			let mut matched = false;
			for (index, word) in table.iter().enumerate() {
				if name.is_empty() || name.eq_ignore_ascii_case(word.name.as_bytes()) {
					if priority as u8 >= prios[index] {
						prios[index] = priority as u8;
						levels[index] = level;
					}
					matched = true;
					if !name.is_empty() {
						break;
					}
				}
			}
			if !matched && !am_server {
				return Err(format!(
					"Unknown {} item: \"{}\"",
					kind.option(),
					String::from_utf8_lossy(name)
				));
			}
		}
		Ok(Words::Done)
	}

	fn make_option(&self, kind: Kind, scope: u8) -> Option<String> {
		let table = kind.words();
		let (levels, prios) = self.view(kind);
		let mut counts = [0usize; MAX_OUT_LEVEL as usize + 1];
		let mut skipped = false;
		let mut any = false;
		let mut best = (0i16, 0usize);
		for (index, word) in table.iter().enumerate() {
			if word.scope & scope == 0 {
				continue;
			}
			if prios[index] == Priority::Default as u8 {
				skipped = true;
				continue;
			}
			any = true;
			if prios[index] == Priority::Help as u8 {
				continue;
			}
			let level = levels[index].clamp(0, MAX_OUT_LEVEL);
			let count = &mut counts[level as usize];
			*count += 1;
			if *count > best.1 {
				best = (level, *count);
			}
		}
		if !any {
			return None;
		}
		let mut out = String::new();
		let abbreviated = if skipped || best.1 < 5 {
			None
		} else {
			out.push_str(kind.option());
			out.push('=');
			match best.0 {
				0 => out.push_str("NONE"),
				1 => out.push_str("ALL"),
				n => {
					out.push_str("ALL");
					out.push(char::from(b'0' + n as u8));
				}
			}
			Some(best.0)
		};
		for (index, word) in table.iter().enumerate() {
			let level = levels[index].clamp(0, MAX_OUT_LEVEL);
			if prios[index] == Priority::Default as u8
				|| abbreviated == Some(level)
				|| word.scope & scope == 0
			{
				continue;
			}
			if out.is_empty() {
				out.push_str(kind.option());
				out.push('=');
			} else {
				out.push(',');
			}
			out.push_str(word.name);
			if level != 1 {
				out.push(char::from(b'0' + level as u8));
			}
		}
		Some(out)
	}
}

const fn scope_for(am_server: bool, am_sender: bool) -> u8 {
	(if am_server { W_CLI } else { W_SRV }) | (if am_sender { W_REC } else { W_SND })
}

fn clamp_level(level: i16) -> u8 {
	u8::try_from(level.max(0)).unwrap_or(u8::MAX)
}

/// Trailing digits of a word; out-of-range values (including overflow) mean the maximum.
fn parse_level(digits: &[u8]) -> i16 {
	let mut value: u64 = 0;
	for &digit in digits.iter().take_while(|b| b.is_ascii_digit()) {
		value = value.saturating_mul(10).saturating_add(u64::from(digit - b'0'));
	}
	if value > MAX_OUT_LEVEL as u64 { MAX_OUT_LEVEL } else { value as i16 }
}

fn help_text(kind: Kind) -> String {
	let mut out =
		String::from("Use OPT or OPT1 for level 1 output, OPT2 for level 2, etc.; OPT0 silences.\n\n");
	for word in kind.words() {
		out.push_str(&format!("{:<10} {}\n", word.name, word.help));
	}
	out.push('\n');
	let option = kind.option();
	out.push_str(&format!(
		"{:<10} {}\n",
		"ALL",
		format!("Set all {option} options (e.g. all{MAX_OUT_LEVEL})")
	));
	out.push_str(&format!("{:<10} {}\n", "NONE", format!("Silence all {option} options (same as all0)")));
	out.push_str(&format!("{:<10} {}\n", "HELP", "Output this help message"));
	out.push('\n');
	out.push_str("Options added at each level of verbosity:\n");
	for (level, words) in kind.verbosity().iter().enumerate() {
		let mut levels = OutLevels::default();
		if let Some(words) = words {
			let _ = levels.parse(kind, words, Priority::Help, true);
		}
		if let Some(option) = levels.make_option(kind, W_CLI | W_SRV | W_SND | W_REC)
			&& let Some((_, list)) = option.split_once('=')
		{
			out.push_str(&format!("{level}) {list}\n"));
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	/// `rsync --info=help` from the 3.5.1 reference binary.
	const INFO_HELP: &str = "\
Use OPT or OPT1 for level 1 output, OPT2 for level 2, etc.; OPT0 silences.

BACKUP     Mention files backed up
COPY       Mention files copied locally on the receiving side
DEL        Mention deletions on the receiving side
FLIST      Mention file-list receiving/sending (levels 1-2)
MISC       Mention miscellaneous information (levels 1-2)
MOUNT      Mention mounts that were found or skipped
NAME       Mention 1) updated file/dir names, 2) unchanged names
NONREG     Mention skipped non-regular files (default 1, 0 disables)
PROGRESS   Mention 1) per-file progress or 2) total transfer progress
REMOVE     Mention files removed on the sending side
SKIP       Mention files skipped due to transfer overrides (levels 1-2)
STATS      Mention statistics at end of run (levels 1-3)
SYMSAFE    Mention symlinks that are unsafe

ALL        Set all --info options (e.g. all4)
NONE       Silence all --info options (same as all0)
HELP       Output this help message

Options added at each level of verbosity:
0) NONREG
1) COPY,DEL,FLIST,MISC,NAME,STATS,SYMSAFE
2) BACKUP,MISC2,MOUNT,NAME2,REMOVE,SKIP
";

	/// `rsync --debug=help` from the 3.5.1 reference binary.
	const DEBUG_HELP: &str = "\
Use OPT or OPT1 for level 1 output, OPT2 for level 2, etc.; OPT0 silences.

ACL        Debug extra ACL info
BACKUP     Debug backup actions (levels 1-2)
BIND       Debug socket bind actions
CHDIR      Debug when the current directory changes
CONNECT    Debug connection events (levels 1-2)
CMD        Debug commands+options that are issued (levels 1-2)
DEL        Debug delete actions (levels 1-3)
DELTASUM   Debug delta-transfer checksumming (levels 1-4)
DUP        Debug weeding of duplicate names
EXIT       Debug exit events (levels 1-3)
FILTER     Debug filter actions (levels 1-3)
FLIST      Debug file-list operations (levels 1-4)
FUZZY      Debug fuzzy scoring (levels 1-2)
GENR       Debug generator functions
HASH       Debug hashtable code
HLINK      Debug hard-link actions (levels 1-3)
ICONV      Debug iconv character conversions (levels 1-2)
IO         Debug I/O routines (levels 1-4)
NSTR       Debug negotiation strings
OWN        Debug ownership changes in users & groups (levels 1-2)
PROTO      Debug protocol information
RECV       Debug receiver functions
SEND       Debug sender functions
TIME       Debug setting of modified times (levels 1-2)

ALL        Set all --debug options (e.g. all4)
NONE       Silence all --debug options (same as all0)
HELP       Output this help message

Options added at each level of verbosity:
2) BIND,CONNECT,CMD,DEL,DELTASUM,DUP,FILTER,FLIST,ICONV
3) ACL,BACKUP,CONNECT2,DEL2,DELTASUM2,EXIT,FILTER2,FLIST2,FUZZY,GENR,OWN,RECV,SEND,TIME
4) CMD2,DEL3,DELTASUM3,EXIT2,FLIST3,ICONV2,OWN2,PROTO,TIME2
5) CHDIR,DELTASUM4,FLIST4,FUZZY2,HASH,HLINK
";

	#[test]
	fn help_matches_reference() {
		assert_eq!(OutLevels::info_help(), INFO_HELP);
		assert_eq!(OutLevels::debug_help(), DEBUG_HELP);
	}

	#[test]
	fn unknown_words_error_like_upstream() {
		let mut levels = OutLevels::default();
		assert_eq!(levels.apply_info("foo"), Err("Unknown --info item: \"foo\"".to_owned()));
		// Trailing digits are a level, not part of the reported name.
		assert_eq!(levels.apply_debug("xyz3"), Err("Unknown --debug item: \"xyz\"".to_owned()));
		// A leading digit keeps the whole word.
		assert_eq!(levels.apply_info("4name"), Err("Unknown --info item: \"4name\"".to_owned()));
		// Servers ignore words they do not know.
		assert_eq!(levels.parse_info("foo,name2", Priority::User, true), Ok(Words::Done));
		assert_eq!(levels.info(Info::Name), 2);
	}

	#[test]
	fn word_grammar() {
		let mut levels = OutLevels::default();
		levels.apply_info("name2,,Progress,stats9,del0").unwrap();
		assert_eq!(levels.info(Info::Name), 2);
		assert_eq!(levels.info(Info::Progress), 1);
		assert_eq!(levels.info(Info::Stats), 4);
		assert_eq!(levels.info(Info::Del), 0);
		levels.apply_debug("ALL3").unwrap();
		assert_eq!(levels.debug(Debug::Time), 3);
		levels.apply_debug("none,proto2").unwrap();
		assert_eq!(levels.debug(Debug::Time), 0);
		assert_eq!(levels.debug(Debug::Proto), 2);
		// Overflowing digit strings clamp to the maximum level.
		levels.apply_info("misc99999999999999999999").unwrap();
		assert_eq!(levels.info(Info::Misc), 4);
		assert_eq!(levels.parse_info("name,HELP2,bogus", Priority::User, false), Ok(Words::Help));
	}

	#[test]
	fn verbosity_never_overrides_user_words() {
		let mut levels = OutLevels::default();
		levels.apply_info("name0").unwrap();
		levels.apply_verbose(2);
		assert_eq!(levels.info(Info::Name), 0);
		assert_eq!(levels.info(Info::Misc), 2);
		assert_eq!(levels.info(Info::Nonreg), 1);
		// -vv is the first level that adds debug words.
		assert_eq!(levels.debug(Debug::Cmd), 1);
		assert_eq!(OutLevels::from_verbose(1).debug(Debug::Cmd), 0);
		let v3 = OutLevels::from_verbose(3);
		assert_eq!(v3.debug(Debug::Cmd), 1);
		assert_eq!(v3.debug(Debug::Connect), 2);
		assert_eq!(OutLevels::from_verbose(0).info(Info::Nonreg), 1);
		assert_eq!(OutLevels::from_verbose(0).info(Info::Name), 0);
	}

	#[test]
	fn negate_round_trips() {
		let mut levels = OutLevels::from_verbose(2);
		levels.apply_debug("proto3").unwrap();
		levels.negate();
		assert_eq!(levels.info(Info::Name), 0);
		assert_eq!(levels.debug(Debug::Proto), 0);
		levels.negate();
		assert_eq!(levels.info(Info::Name), 2);
		assert_eq!(levels.debug(Debug::Proto), 3);
	}

	#[test]
	fn server_option_strings() {
		// Implied levels are never sent.
		assert_eq!(OutLevels::from_verbose(2).server_info_arg(false, true), None);
		let mut levels = OutLevels::from_verbose(1);
		levels.apply_info("progress2,skip2,name0").unwrap();
		// Sender client tells the receiving server: PROGRESS is client-only.
		assert_eq!(levels.server_info_arg(false, true).as_deref(), Some("--info=NAME0,SKIP2"));
		// Five or more words at one level abbreviate to ALL<n>.
		let mut all = OutLevels::default();
		all.apply_info("all2,name3").unwrap();
		assert_eq!(all.server_info_arg(false, false).as_deref(), Some("--info=ALL2,NAME3"));
	}
}
