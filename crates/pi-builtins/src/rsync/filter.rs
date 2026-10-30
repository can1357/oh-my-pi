//! Filter rules: include/exclude/merge grammar, matching, per-directory merge files,
//! `-C`/`-F`, the rule-list exchange with the peer, and the receiver's list of names it
//! asked for ("implied includes").
//!
//! Behavior follows rsync 3.5.1 (rsync(1) sections FILTER RULES through PER-DIRECTORY
//! RULES AND DELETE). Highlights:
//!
//! - First matching rule wins. A dir-merge (`:`) rule is a placeholder: the rules read
//!   from the per-directory files it names are consulted at its position, newest
//!   directory first, then inherited rules from parent directories.
//! - Rules carry the side(s) they apply to. After the exchange with the peer each global
//!   rule is tagged with whether it only applies locally or only on the peer; [`Side`]
//!   selects which tagged rules a lookup skips.
//! - Text that came out of a file's contents is never echoed in diagnostics (3.5.0):
//!   errors report `<rule from FILE line N>` instead.
//!
//! Paths handed to the reader closures are `/`-separated bytes. In per-directory
//! context ([`Filters::enter_dir`]) a path inside the current directory
//! ([`Filters::set_curr_dir`]) is passed relative to it; any other path is absolute.

use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::Arc;

use crate::host::os_bytes_lossy;
use crate::rsync::{
	cstr::{is_c_space, until_nul},
	paths,
};
use crate::rsync::consts::{BIGPATHBUFLEN, MAXPATHLEN};
use crate::rsync::exit::{
	RERR_FILEIO, RERR_MALLOC, RERR_PROTOCOL, RERR_SYNTAX, RsyncError,
};
use crate::rsync::log::{Debug as DebugFlag, LogCode, Logger, Role, syserr_text};
use crate::rsync::wildmatch::{self, Where};
use crate::rsync::wire::{Proto, ReadExt, WriteExt};

// Rule flag bits. The values match upstream's so `--debug=FILTER2` traces that print
// them in hex are identical.
const FILTRULE_WILD: u32 = 1 << 0;
const FILTRULE_WILD2: u32 = 1 << 1;
const FILTRULE_WILD2_PREFIX: u32 = 1 << 2;
const FILTRULE_WILD3_SUFFIX: u32 = 1 << 3;
const FILTRULE_ABS_PATH: u32 = 1 << 4;
const FILTRULE_INCLUDE: u32 = 1 << 5;
const FILTRULE_DIRECTORY: u32 = 1 << 6;
const FILTRULE_WORD_SPLIT: u32 = 1 << 7;
const FILTRULE_NO_INHERIT: u32 = 1 << 8;
const FILTRULE_NO_PREFIXES: u32 = 1 << 9;
const FILTRULE_MERGE_FILE: u32 = 1 << 10;
const FILTRULE_PERDIR_MERGE: u32 = 1 << 11;
const FILTRULE_EXCLUDE_SELF: u32 = 1 << 12;
const FILTRULE_FINISH_SETUP: u32 = 1 << 13;
const FILTRULE_NEGATE: u32 = 1 << 14;
const FILTRULE_CVS_IGNORE: u32 = 1 << 15;
const FILTRULE_SENDER_SIDE: u32 = 1 << 16;
const FILTRULE_RECEIVER_SIDE: u32 = 1 << 17;
const FILTRULE_CLEAR_LIST: u32 = 1 << 18;
const FILTRULE_PERISHABLE: u32 = 1 << 19;
const FILTRULE_XATTR: u32 = 1 << 20;
const FILTRULE_FROM_FILE: u32 = 1 << 21;
const FILTRULES_SIDES: u32 = FILTRULE_SENDER_SIDE | FILTRULE_RECEIVER_SIDE;
/// Flags a rule inherits from the merge rule (or option) it was read through.
const FILTRULES_FROM_CONTAINER: u32 = FILTRULE_ABS_PATH
	| FILTRULE_INCLUDE
	| FILTRULE_DIRECTORY
	| FILTRULE_NEGATE
	| FILTRULE_PERISHABLE;

// Parse-mode bits (upstream XFLG_* values, printed by the FILTER2 trace).
const XFLG_FATAL_ERRORS: u32 = 1 << 0;
const XFLG_OLD_PREFIXES: u32 = 1 << 1;
const XFLG_ANCHORED2ABS: u32 = 1 << 2;

/// Rule only applies on this side (not sent to the peer).
const LOCAL_RULE: u8 = 1;
/// Rule only applies on the peer's side (sent, skipped locally).
const REMOTE_RULE: u8 = 2;

const MAX_MERGE_DEPTH: usize = 32;

/// The `--cvs-exclude` default list (rsync(1), `--cvs-exclude`).
const DEFAULT_CVSIGNORE: &[u8] = b"RCS SCCS CVS CVS.adm RCSLOG cvslog.* tags TAGS .make.state \
.nse_depinfo *~ #* .#* ,* _$* *$ *.old *.bak *.BAK *.orig *.rej .del-* *.a *.olb *.o *.obj \
*.so *.exe *.Z *.elc *.ln core .svn/ .git/ .hg/ .bzr/";

const GLOBAL_CVS_TYPE: &[u8] = b" [global CVS]";
const IMPLIED_TYPE: &[u8] = b" [implied]";
/// What a from-file rule's text is replaced with once parsing is over.
const READ_EARLIER: &[u8] = b"<rule from a file read earlier>";

/// Which side evaluates a rule (sender hides/shows; receiver protects/risks).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Side {
	Sender,
	Receiver,
}

/// Result of matching one name.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Verdict {
	Include,
	Exclude,
	NoMatch,
}

/// What kind of name is being filtered.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum NameKind {
	File,
	Dir,
	/// An extended-attribute name (only `x` rules apply).
	Xattr,
}

/// Operator-supplied rule origins.
#[derive(Clone, Copy, Debug)]
pub(crate) enum RuleArg<'a> {
	/// `--include=PATTERN`.
	Include(&'a [u8]),
	/// `--exclude=PATTERN`.
	Exclude(&'a [u8]),
	/// `--filter=RULE`.
	Filter(&'a [u8]),
	/// `--include-from=FILE` (`-` = stdin on the client).
	IncludeFrom(&'a Path),
	/// `--exclude-from=FILE` (`-` = stdin on the client).
	ExcludeFrom(&'a Path),
	/// `-C`: the CVS rules are appended during the exchange ([`Filters::send`]/[`Filters::recv`]).
	Cvs,
}

/// Reads a whole operator-supplied file (used outside [`Filters::add`]/[`Filters::enter_dir`]).
pub(crate) type FileReader = Arc<dyn Fn(&[u8]) -> io::Result<Vec<u8>> + Send + Sync>;

/// Settings that shape parsing, matching, and the exchange.
#[derive(Clone)]
pub(crate) struct FilterConfig {
	/// `-0`: rule files are NUL-separated.
	pub from0: bool,
	/// `--delete-excluded` (in effect for rules parsed from now on; see
	/// [`Filters::set_delete_excluded`]).
	pub delete_excluded: bool,
	/// Any `--delete*` mode.
	pub delete_mode: bool,
	/// `--prune-empty-dirs`.
	pub prune_empty_dirs: bool,
	/// `-C`.
	pub cvs_exclude: bool,
	/// This process is the sending side.
	pub am_sender: bool,
	/// This process is a server (`-` then names a file, not stdin).
	pub am_server: bool,
	/// Both halves run in this process (local copy or `--read-batch`): no rule bytes travel.
	pub local_server: bool,
	/// Protocol in effect while parsing (the `--protocol` value until negotiation).
	pub protocol: u32,
	/// `$HOME` (for `$HOME/.cvsignore`).
	pub home: Option<Vec<u8>>,
	/// `$CVSIGNORE`.
	pub cvsignore_env: Option<Vec<u8>>,
	/// Whose name diagnostics carry (`who_am_i`).
	pub role: Role,
	/// Where `--debug=FILTER` traces and non-fatal errors go.
	pub logger: Option<Logger>,
	/// Reads files named while exchanging rules (`$HOME/.cvsignore`, merge rules a peer
	/// sent). `None` treats such files as missing.
	pub read_file: Option<FileReader>,
}

impl Default for FilterConfig {
	fn default() -> Self {
		Self {
			from0: false,
			delete_excluded: false,
			delete_mode: false,
			prune_empty_dirs: false,
			cvs_exclude: false,
			am_sender: false,
			am_server: false,
			local_server: false,
			protocol: crate::rsync::consts::PROTOCOL_VERSION,
			home: None,
			cvsignore_env: None,
			role: Role::Client,
			logger: None,
			read_file: None,
		}
	}
}

/// One parsed rule.
#[derive(Clone, Debug)]
struct Rule {
	rflags: u32,
	pattern: Vec<u8>,
	slash_cnt: u32,
	elide: u8,
	/// The merge-list slot a dir-merge rule owns.
	slot: Option<usize>,
}

impl Rule {
	fn new(rflags: u32, pattern: Vec<u8>, slash_cnt: u32) -> Self {
		Self { rflags, pattern, slash_cnt, elide: 0, slot: None }
	}
}

/// A rule list with per-directory layering: each layer holds the rules one directory
/// level contributed; lookups walk the visible layers newest first. Layers below `base`
/// are hidden (a `!` or a non-inheriting merge), and `open` says whether the top layer
/// still takes new rules (otherwise the next rule starts a new layer).
#[derive(Clone, Debug, Default)]
struct List {
	layers: Vec<Vec<Rule>>,
	base: usize,
	open: bool,
}

#[derive(Clone, Copy, Debug)]
struct ListState {
	len: usize,
	base: usize,
	open: bool,
}

impl List {
	fn visible(&self) -> impl Iterator<Item = &Rule> + '_ {
		self.layers[self.base.min(self.layers.len())..].iter().rev().flatten()
	}

	fn visible_mut(&mut self) -> impl Iterator<Item = &mut Rule> + '_ {
		let start = self.base.min(self.layers.len());
		self.layers[start..].iter_mut().rev().flatten()
	}

	fn has_visible(&self) -> bool {
		self.visible().next().is_some()
	}

	fn push(&mut self, rule: Rule) {
		if !self.open {
			self.layers.push(Vec::new());
			self.open = true;
		}
		if let Some(top) = self.layers.last_mut() {
			top.push(rule);
		}
	}

	/// Removes this level's own rules.
	fn take_local(&mut self) -> Vec<Rule> {
		if !self.open {
			return Vec::new();
		}
		self.open = false;
		self.layers.pop().unwrap_or_default()
	}

	/// Makes the current rules inherited (new rules start a new layer).
	fn inherit(&mut self) {
		self.open = false;
	}

	/// Hides every current rule.
	fn hide_all(&mut self) {
		self.open = false;
		self.base = self.layers.len();
	}

	/// Removes every visible rule.
	fn take_visible(&mut self) -> Vec<Rule> {
		let start = self.base.min(self.layers.len());
		self.open = false;
		self.layers.drain(start..).flatten().collect()
	}

	fn state(&self) -> ListState {
		ListState { len: self.layers.len(), base: self.base, open: self.open }
	}

	/// Returns to a saved state, handing back the rules added since.
	fn restore(&mut self, st: ListState) -> Vec<Rule> {
		let freed = if self.layers.len() > st.len {
			self.layers.drain(st.len..).flatten().collect()
		} else {
			Vec::new()
		};
		self.base = st.base.min(self.layers.len());
		self.open = st.open && !self.layers.is_empty();
		freed
	}
}

/// An active per-directory merge file.
#[derive(Clone, Debug)]
struct Slot {
	/// File to look for in each directory (a bare name once parent-dir setup ran).
	pattern: Vec<u8>,
	/// The dir-merge rule's flags: the template for the rules read from the file.
	rflags: u32,
	debug_type: Vec<u8>,
	list: List,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ListRef {
	Global,
	Cvs,
	Slot(usize),
}

/// Where the text being parsed comes from (for `<rule from …>` diagnostics).
#[derive(Clone, Debug, Default)]
struct Src {
	in_file: bool,
	/// The file's printable name (`None` when a file's contents named it).
	file: Option<Vec<u8>>,
	/// Line number; -1 when the file is split into words.
	line: i64,
	/// Where the file was named, when its own name is not printable.
	named_at: Option<Vec<u8>>,
}

/// Saved per-directory state returned by [`Filters::enter_dir`].
#[derive(Clone, Debug)]
pub(crate) struct DirMark {
	saved: Option<Vec<Option<ListState>>>,
}

/// The rule that decided a lookup, for `--debug=FILTER` messages.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FilterMatch {
	pub verdict: Verdict,
	/// The pattern as upstream prints it (trailing `/` for directory-only rules;
	/// `<rule from a file read earlier>` for rules read from files).
	pub pattern: Vec<u8>,
	/// `""`, `" [global CVS]"`, `" [per-dir NAME]"`, or `" [implied]"`.
	pub list_type: Vec<u8>,
}

impl FilterMatch {
	/// `[sender] hiding file x because of pattern y\n` (and the showing / protecting /
	/// risking variants upstream picks from the role and verdict).
	pub(crate) fn message(&self, role: Role, name: &[u8], kind: NameKind) -> Vec<u8> {
		let who = role.name();
		let excluded = self.verdict == Verdict::Exclude;
		let action: &[u8] = match (who.starts_with('g'), excluded) {
			(false, false) => b"show",
			(false, true) => b"hid",
			(true, false) => b"risk",
			(true, true) => b"protect",
		};
		let kind: &[u8] = match kind {
			NameKind::Xattr => b"xattr",
			NameKind::Dir => b"directory",
			NameKind::File => b"file",
		};
		[
			&b"["[..],
			who.as_bytes(),
			b"] ",
			action,
			b"ing ",
			kind,
			b" ",
			name,
			b" because of pattern ",
			&self.pattern,
			&self.list_type,
			b"\n",
		]
		.concat()
	}
}

/// A file opener in scope for one parse.
struct Reader<'a> {
	read: &'a dyn Fn(&[u8]) -> io::Result<Vec<u8>>,
	/// Pass paths under the current directory relative to it.
	relativize: bool,
}

/// One rule token located inside the text being parsed.
struct Tok {
	rflags: u32,
	start: usize,
	end: usize,
}

/// Facts the rule prefix and elision logic depend on.
#[derive(Clone, Copy)]
struct XferCtx {
	protocol: u32,
	am_sender: bool,
	delete_excluded: bool,
}

/// The full rule set: global list + per-directory merge stack.
#[derive(Clone)]
pub(crate) struct Filters {
	cfg: FilterConfig,
	global: List,
	cvs: List,
	cvs_loaded: bool,
	slots: Vec<Option<Slot>>,
	curr_dir: Vec<u8>,
	dirbuf: Vec<u8>,
	parent_dirscan: bool,
	merge_depth: usize,
	src: Src,
	saw_xattr_filter: bool,
	saw_dir_merge: bool,
	io_error: bool,
	depth_marks: Vec<Option<DirMark>>,
}

impl Filters {
	/// An empty rule set.
	pub(crate) fn new(cfg: FilterConfig) -> Self {
		Self {
			cfg,
			global: List::default(),
			cvs: List::default(),
			cvs_loaded: false,
			slots: Vec::new(),
			curr_dir: b"/".to_vec(),
			dirbuf: Vec::new(),
			parent_dirscan: false,
			merge_depth: 0,
			src: Src::default(),
			saw_xattr_filter: false,
			saw_dir_merge: false,
			io_error: false,
			depth_marks: Vec::new(),
		}
	}

	/// Adds operator rules in command-line order. `files` opens `--include-from`,
	/// `--exclude-from`, and merge files (and `$HOME/.cvsignore` for a `-C` rule); it gets
	/// the path as given (`-` means stdin).
	pub(crate) fn add(
		&mut self,
		arg: RuleArg<'_>,
		files: &dyn Fn(&Path) -> io::Result<Vec<u8>>,
	) -> Result<(), RsyncError> {
		let open = |p: &[u8]| -> io::Result<Vec<u8>> {
			// An unconvertible operator name is an invalid argument (EINVAL), not bad data.
			let path = paths::bytes_path(p)
				.map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err.to_string()))?;
			files(path)
		};
		let rd = Reader { read: &open, relativize: false };
		match arg {
			RuleArg::Include(p) => {
				self.parse_str(ListRef::Global, p, FILTRULE_INCLUDE, XFLG_OLD_PREFIXES, &rd)
			}
			RuleArg::Exclude(p) => self.parse_str(ListRef::Global, p, 0, XFLG_OLD_PREFIXES, &rd),
			RuleArg::Filter(p) => self.parse_str(ListRef::Global, p, 0, 0, &rd),
			RuleArg::IncludeFrom(path) => {
				let name = os_bytes_lossy(path.as_os_str());
				let xflags = XFLG_FATAL_ERRORS | XFLG_OLD_PREFIXES;
				self.parse_file(ListRef::Global, &name, FILTRULE_INCLUDE, xflags, &rd)
			}
			RuleArg::ExcludeFrom(path) => {
				let name = os_bytes_lossy(path.as_os_str());
				let xflags = XFLG_FATAL_ERRORS | XFLG_OLD_PREFIXES;
				self.parse_file(ListRef::Global, &name, 0, xflags, &rd)
			}
			RuleArg::Cvs => {
				self.cfg.cvs_exclude = true;
				Ok(())
			}
		}
	}

	/// `--delete-excluded` as seen at this point of the command line: unsided
	/// include/exclude rules parsed while it is on become sender-only.
	pub(crate) fn set_delete_excluded(&mut self, on: bool) {
		self.cfg.delete_excluded = on;
	}

	/// The role diagnostics name (`client` while parsing options, then `sender`,
	/// `generator`, …).
	pub(crate) fn set_role(&mut self, role: Role) {
		self.cfg.role = role;
	}

	/// Where traces and non-fatal errors go.
	pub(crate) fn set_logger(&mut self, logger: Option<Logger>) {
		self.cfg.logger = logger;
	}

	/// Whether this process is the sending side (decides which one-sided rules apply
	/// locally after the exchange).
	pub(crate) fn set_am_sender(&mut self, am_sender: bool) {
		self.cfg.am_sender = am_sender;
	}

	/// The absolute, `/`-separated directory transfer names are relative to (upstream
	/// `curr_dir`). Anchored per-directory rules and `/`-modifier rules match against it.
	pub(crate) fn set_curr_dir(&mut self, dir: &[u8]) {
		let mut d = dir.to_vec();
		while d.len() > 1 && d.last() == Some(&b'/') {
			d.pop();
		}
		if d.first() != Some(&b'/') {
			d.insert(0, b'/');
		}
		self.curr_dir = d;
	}

	/// Whether the global list has no rules (`filter_list.head == NULL`).
	pub(crate) fn is_empty(&self) -> bool {
		!self.global.has_visible()
	}

	/// The global rules as `--write-batch` replay-script lines (upstream
	/// `write_filter_rules`): prefix, pattern, and a `/` for directory-only rules, without
	/// a line terminator.
	pub(crate) fn script_lines(&self) -> Vec<Vec<u8>> {
		self.global
			.visible()
			.map(|r| {
				let mut line = rule_prefix(r.rflags, b"- ", None).unwrap_or_default();
				line.extend_from_slice(&r.pattern);
				if r.rflags & FILTRULE_DIRECTORY != 0 {
					line.push(b'/');
				}
				line
			})
			.collect()
	}

	/// Whether any `x` (xattr-name) rule was parsed.
	pub(crate) fn has_xattr_rules(&self) -> bool {
		self.saw_xattr_filter
	}

	/// Whether a dir-merge rule was parsed: the receiver must then trust the sender's
	/// filtering (upstream `trust_sender_filter`).
	pub(crate) fn saw_dir_merge(&self) -> bool {
		self.saw_dir_merge
	}

	/// Returns and clears the "some per-directory rules could not be read" flag
	/// (upstream `IOERR_GENERAL`).
	pub(crate) fn take_io_error(&mut self) -> bool {
		std::mem::take(&mut self.io_error)
	}

	/// Enter a directory: load dir-merge files found there (via `read`), returns a token for `leave_dir`.
	///
	/// `dir` is relative to the current directory (or absolute). `read` returns
	/// `Ok(None)` for a missing file.
	pub(crate) fn enter_dir(
		&mut self,
		dir: &[u8],
		read: &dyn Fn(&[u8]) -> io::Result<Option<Vec<u8>>>,
	) -> Result<DirMark, RsyncError> {
		let open = |p: &[u8]| -> io::Result<Vec<u8>> {
			read(p)?.ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
		};
		let rd = Reader { read: &open, relativize: true };
		self.push_local(dir, &rd)
	}

	/// Leaves the directory entered with `mark`, dropping its per-directory rules.
	pub(crate) fn leave_dir(&mut self, mark: DirMark) {
		self.pop_local(mark);
	}

	/// Depth-indexed enter/leave (upstream `change_local_filter_dir`): leaves every
	/// directory at `depth` or deeper, then enters `dir` at `depth`. `None` leaves all.
	pub(crate) fn change_dir(
		&mut self,
		dir: Option<&[u8]>,
		depth: usize,
		read: &dyn Fn(&[u8]) -> io::Result<Option<Vec<u8>>>,
	) -> Result<(), RsyncError> {
		let keep = if dir.is_some() { depth } else { 0 };
		while self.depth_marks.len() > keep {
			if let Some(Some(mark)) = self.depth_marks.pop() {
				self.pop_local(mark);
			}
		}
		let Some(dir) = dir else {
			return Ok(());
		};
		self.depth_marks.resize(depth, None);
		let mark = self.enter_dir(dir, read)?;
		self.depth_marks.push(Some(mark));
		Ok(())
	}

	/// Looks `name` up for `side` (logging the decision at `--debug=FILTER` like upstream).
	pub(crate) fn check(&self, name: &[u8], is_dir: bool, side: Side) -> Verdict {
		let kind = if is_dir { NameKind::Dir } else { NameKind::File };
		self.check_full(name, kind, side, false)
	}

	/// [`Filters::check`] with every knob: xattr names, and skipping perishable rules
	/// (inside a directory that is being deleted).
	pub(crate) fn check_full(
		&self,
		name: &[u8],
		kind: NameKind,
		side: Side,
		ignore_perishable: bool,
	) -> Verdict {
		let Some(m) = self.find_match(name, kind, side, ignore_perishable) else {
			return Verdict::NoMatch;
		};
		if let Some(logger) = &self.cfg.logger {
			let level = if matches!(self.cfg.role, Role::Sender | Role::Generator) { 1 } else { 3 };
			if logger.levels().debug(DebugFlag::Filter) >= level {
				logger.rprintf(LogCode::Info, &m.message(self.cfg.role, name, kind));
			}
		}
		m.verdict
	}

	/// Whether the xattr `name` is excluded on this side.
	pub(crate) fn xattr_excluded(&self, name: &[u8]) -> bool {
		self.check_full(name, NameKind::Xattr, self.own_side(), false) == Verdict::Exclude
	}

	/// The deciding rule for `name`, without logging.
	pub(crate) fn find_match(
		&self,
		name: &[u8],
		kind: NameKind,
		side: Side,
		ignore_perishable: bool,
	) -> Option<FilterMatch> {
		let skip = if side == self.own_side() { REMOTE_RULE } else { LOCAL_RULE };
		type RuleIter<'r> = Box<dyn Iterator<Item = &'r Rule> + 'r>;
		let first: (RuleIter<'_>, &[u8]) = (Box::new(self.global.visible()), b"");
		let mut stack = vec![first];
		loop {
			let (next, list_type) = match stack.last_mut() {
				Some((iter, list_type)) => (iter.next(), *list_type),
				None => return None,
			};
			let Some(rule) = next else {
				stack.pop();
				continue;
			};
			if ignore_perishable && rule.rflags & FILTRULE_PERISHABLE != 0 {
				continue;
			}
			if rule.rflags & FILTRULE_PERDIR_MERGE != 0 {
				if let Some(Some(slot)) = rule.slot.map(|j| self.slots.get(j).and_then(Option::as_ref)) {
					let iter: RuleIter<'_> = Box::new(slot.list.visible());
					stack.push((iter, slot.debug_type.as_slice()));
				}
				continue;
			}
			if rule.rflags & FILTRULE_CVS_IGNORE != 0 {
				let iter: RuleIter<'_> = Box::new(self.cvs.visible());
				stack.push((iter, GLOBAL_CVS_TYPE));
				continue;
			}
			if rule_matches(rule, name, kind, &self.curr_dir, skip) {
				return Some(describe_match(rule, list_type));
			}
		}
	}

	/// Exchange with the peer (send_filter_list / recv_filter_list) per protocol + roles.
	///
	/// Client side. `receiver_side` is true when this client receives files. Writes
	/// nothing when both halves are local or the receiving server has no use for the
	/// rules. Applies `-C` (adds the `.cvsignore` dir-merge and the CVS list) on the side
	/// upstream does, and fixes which one-sided rules apply locally.
	pub(crate) fn send(
		&mut self,
		w: &mut dyn Write,
		proto: Proto,
		receiver_side: bool,
	) -> Result<(), RsyncError> {
		self.cfg.am_sender = !receiver_side;
		self.cfg.protocol = proto.version;
		let am_sender = self.cfg.am_sender;
		let write = !(self.cfg.local_server || (am_sender && !self.receiver_wants_list()));
		let fallback = self.cfg.read_file.clone();
		let open = move |p: &[u8]| -> io::Result<Vec<u8>> {
			match &fallback {
				Some(f) => f(p),
				None => Err(io::ErrorKind::NotFound.into()),
			}
		};
		let rd = Reader { read: &open, relativize: false };
		if self.cfg.cvs_exclude && am_sender {
			if proto.version >= 29 {
				self.parse_str(ListRef::Global, b":C", 0, 0, &rd)?;
			}
			self.parse_str(ListRef::Global, b"-C", 0, 0, &rd)?;
		}
		let ctx = self.xfer_ctx();
		let mut encoded = Vec::new();
		let out = if write { Some(&mut encoded) } else { None };
		send_rules(&mut self.global, Some(&mut self.cvs), ctx, out)?;
		if write {
			w.write_all(&encoded).map_err(RsyncError::from_stream)?;
			w.write_int(0).map_err(RsyncError::from_stream)?;
		}
		if self.cfg.cvs_exclude {
			if !am_sender || proto.version < 29 {
				self.parse_str(ListRef::Global, b":C", 0, 0, &rd)?;
			}
			if !am_sender {
				self.parse_str(ListRef::Global, b"-C", 0, 0, &rd)?;
			}
		}
		Ok(())
	}

	/// Server side of the exchange: reads the client's rules (when this side uses
	/// them), validates lengths, parses each rule as peer text, and applies `-C`.
	pub(crate) fn recv(&mut self, r: &mut dyn Read, proto: Proto) -> Result<(), RsyncError> {
		self.cfg.protocol = proto.version;
		let xflags = if proto.version >= 29 { 0 } else { XFLG_OLD_PREFIXES };
		let fallback = self.cfg.read_file.clone();
		let open = move |p: &[u8]| -> io::Result<Vec<u8>> {
			match &fallback {
				Some(f) => f(p),
				None => Err(io::ErrorKind::NotFound.into()),
			}
		};
		let rd = Reader { read: &open, relativize: false };
		let local = self.cfg.local_server;
		let am_sender = self.cfg.am_sender;
		if !local && (am_sender || self.receiver_wants_list()) {
			loop {
				let len = r.read_int().map_err(RsyncError::from_stream)?;
				if len == 0 {
					break;
				}
				let len = len as u32 as usize;
				if len >= BIGPATHBUFLEN {
					let msg = format!(
						"[{}] buffer overflow: recv_rules (file=exclude.c, line=1982)",
						self.cfg.role.name()
					);
					return Err(RsyncError::new(RERR_MALLOC, msg).at("util2.c", 129));
				}
				let mut line = vec![0u8; len];
				r.read_exact(&mut line).map_err(RsyncError::from_stream)?;
				self.parse_str(ListRef::Global, &line, 0, xflags, &rd)?;
			}
		}
		if self.cfg.cvs_exclude {
			if local || am_sender || proto.version < 29 {
				self.parse_str(ListRef::Global, b":C", 0, 0, &rd)?;
			}
			if local || am_sender {
				self.parse_str(ListRef::Global, b"-C", 0, 0, &rd)?;
			}
		}
		if local {
			let ctx = self.xfer_ctx();
			send_rules(&mut self.global, Some(&mut self.cvs), ctx, None)?;
		}
		Ok(())
	}

	fn receiver_wants_list(&self) -> bool {
		self.cfg.prune_empty_dirs
			|| (self.cfg.delete_mode && (!self.cfg.delete_excluded || self.cfg.protocol >= 29))
	}

	fn xfer_ctx(&self) -> XferCtx {
		XferCtx {
			protocol: self.cfg.protocol,
			am_sender: self.cfg.am_sender,
			delete_excluded: self.cfg.delete_excluded,
		}
	}

	fn own_side(&self) -> Side {
		if self.cfg.am_sender { Side::Sender } else { Side::Receiver }
	}

	// ----- diagnostics -----

	fn who(&self) -> &'static str {
		self.cfg.role.name()
	}

	fn debug_level(&self) -> u8 {
		self.cfg.logger.as_ref().map_or(0, |l| l.levels().debug(DebugFlag::Filter))
	}

	fn info(&self, text: &[u8]) {
		if let Some(logger) = &self.cfg.logger {
			logger.rprintf(LogCode::Info, text);
		}
	}

	fn error_msg(&self, text: &[u8]) {
		if let Some(logger) = &self.cfg.logger {
			logger.rprintf(LogCode::Error, text);
		}
	}

	fn text_from_file(&self, template: u32) -> bool {
		self.src.in_file || template & FILTRULE_FROM_FILE != 0
	}

	/// Where the text being parsed came from.
	fn src_where(&self) -> Vec<u8> {
		match &self.src.file {
			None => match &self.src.named_at {
				None => b"a file read earlier".to_vec(),
				Some(at) => [&b"a file named at "[..], at].concat(),
			},
			Some(file) if self.src.line < 0 => file.clone(),
			Some(file) => [&file[..], b" line ", self.src.line.to_string().as_bytes()].concat(),
		}
	}

	/// Rule text as it may appear in a message: verbatim for operator arguments,
	/// `<rule from …>` for anything that came out of a file.
	fn rule_text(&self, template: u32, text: &[u8]) -> Vec<u8> {
		if self.text_from_file(template) {
			[&b"<rule from "[..], &self.src_where(), b">"].concat()
		} else {
			text.to_vec()
		}
	}

	/// Extra detail about rule text, dropped along with the text.
	fn rule_detail<'d>(&self, template: u32, detail: &'d [u8]) -> &'d [u8] {
		if self.text_from_file(template) { b"" } else { detail }
	}

	fn syntax_err(&self, what: &str, rulestr: &[u8]) -> RsyncError {
		let text = self.rule_text(0, rulestr);
		let msg = format!("{what}: {}", String::from_utf8_lossy(&text));
		RsyncError::new(RERR_SYNTAX, msg).at("exclude.c", 136)
	}

	fn list_type(&self, list: ListRef) -> Vec<u8> {
		match list {
			ListRef::Global => Vec::new(),
			ListRef::Cvs => GLOBAL_CVS_TYPE.to_vec(),
			ListRef::Slot(i) => self
				.slots
				.get(i)
				.and_then(Option::as_ref)
				.map_or_default(|s| s.debug_type.clone()),
		}
	}

	fn list_mut(&mut self, list: ListRef) -> Option<&mut List> {
		match list {
			ListRef::Global => Some(&mut self.global),
			ListRef::Cvs => Some(&mut self.cvs),
			ListRef::Slot(i) => self.slots.get_mut(i).and_then(Option::as_mut).map(|s| &mut s.list),
		}
	}

	// ----- parsing -----

	/// Parses rule text (one rule, or several when the template splits words).
	fn parse_str(
		&mut self,
		list: ListRef,
		text: &[u8],
		template: u32,
		xflags: u32,
		rd: &Reader<'_>,
	) -> Result<(), RsyncError> {
		let text = until_nul(text);
		let mut pos = 0;
		while let Some(tok) = self.parse_rule_tok(text, &mut pos, template, xflags)? {
			let mut rflags = tok.rflags;
			let mut pat = text[tok.start..tok.end].to_vec();
			if pat.len() >= MAXPATHLEN {
				let shown = self.rule_text(0, &pat);
				self.error_msg(&[&b"discarding over-long filter: "[..], &shown, b"\n"].concat());
				continue;
			}
			if rflags & FILTRULE_CLEAR_LIST != 0 {
				if self.debug_level() >= 2 {
					let msg = [
						&b"["[..],
						self.who().as_bytes(),
						b"] clearing filter list",
						&self.list_type(list),
						b"\n",
					]
					.concat();
					self.info(&msg);
				}
				self.clear_list(list);
				continue;
			}
			if rflags & FILTRULE_MERGE_FILE != 0 {
				if pat.is_empty() {
					pat = b".cvsignore".to_vec();
				}
				if rflags & FILTRULE_EXCLUDE_SELF != 0 {
					let own = paths::basename(&pat).to_vec();
					self.add_rule(list, own, rflags & FILTRULE_FROM_FILE, 0);
					rflags &= !FILTRULE_EXCLUDE_SELF;
				}
				if rflags & FILTRULE_PERDIR_MERGE != 0 {
					if self.parent_dirscan {
						if let Some(name) = self.parse_merge_name(rflags, &pat, 0) {
							self.add_rule(list, name, rflags, 0);
						}
						continue;
					}
				} else {
					if let Some(name) = self.parse_merge_name(rflags, &pat, 0) {
						self.parse_file(list, &name, rflags, XFLG_FATAL_ERRORS, rd)?;
					}
					continue;
				}
			}
			self.add_rule(list, pat, rflags, xflags);
			if rflags & FILTRULE_CVS_IGNORE != 0 && rflags & FILTRULE_MERGE_FILE == 0 {
				self.load_cvs_excludes(rflags, rd)?;
			}
		}
		Ok(())
	}

	/// Splits off the next rule of `s` at `*pos`: prefix, modifiers, pattern bounds.
	fn parse_rule_tok(
		&mut self,
		s: &[u8],
		pos: &mut usize,
		template: u32,
		xflags: u32,
	) -> Result<Option<Tok>, RsyncError> {
		if template & FILTRULE_WORD_SPLIT != 0 {
			while *pos < s.len() && is_c_space(s[*pos]) {
				*pos += 1;
			}
		}
		let start = *pos;
		if start >= s.len() {
			return Ok(None);
		}
		let rulestr = &s[start..];
		let at = |i: usize| s.get(i).copied().unwrap_or(0);
		let mut rflags = template & FILTRULES_FROM_CONTAINER;
		if self.src.in_file {
			rflags |= FILTRULE_FROM_FILE;
		}
		let mut i = start;
		if template & FILTRULE_NO_PREFIXES != 0 {
			if at(i) == b'!' && template & FILTRULE_CVS_IGNORE != 0 {
				rflags |= FILTRULE_CLEAR_LIST;
			}
		} else if xflags & XFLG_OLD_PREFIXES != 0 {
			match (at(i), at(i + 1)) {
				(b'-', b' ') => {
					rflags &= !FILTRULE_INCLUDE;
					i += 2;
				}
				(b'+', b' ') => {
					rflags |= FILTRULE_INCLUDE;
					i += 2;
				}
				(b'!', _) => rflags |= FILTRULE_CLEAR_LIST,
				_ => {}
			}
		} else {
			// Lowercase first letters introduce long rule names; anything else is a
			// one-character rule, optionally followed by a comma.
			let long: Option<(&[u8], u8)> = match at(i) {
				b'c' => Some((&b"clear"[..], b'!')),
				b'd' => Some((&b"dir-merge"[..], b':')),
				b'e' => Some((&b"exclude"[..], b'-')),
				b'h' => Some((&b"hide"[..], b'H')),
				b'i' => Some((&b"include"[..], b'+')),
				b'm' => Some((&b"merge"[..], b'.')),
				b'p' => Some((&b"protect"[..], b'P')),
				b'r' => Some((&b"risk"[..], b'R')),
				b's' => Some((&b"show"[..], b'S')),
				_ => None,
			};
			let ch = match long {
				Some((word, ch)) => match long_rule_end(rulestr, word) {
					Some(end) => {
						i = start + end;
						ch
					}
					None => 0,
				},
				None => {
					let ch = at(i);
					if at(i + 1) == b',' {
						i += 1;
					}
					ch
				}
			};
			let mut side_from_prefix = false;
			match ch {
				b':' => {
					self.saw_dir_merge = true;
					rflags |= FILTRULE_PERDIR_MERGE | FILTRULE_FINISH_SETUP | FILTRULE_MERGE_FILE;
				}
				b'.' => rflags |= FILTRULE_MERGE_FILE,
				b'+' => rflags |= FILTRULE_INCLUDE,
				b'-' => {}
				b'S' | b'H' => {
					if ch == b'S' {
						rflags |= FILTRULE_INCLUDE;
					}
					rflags |= FILTRULE_SENDER_SIDE;
					side_from_prefix = true;
				}
				b'R' | b'P' => {
					if ch == b'R' {
						rflags |= FILTRULE_INCLUDE;
					}
					rflags |= FILTRULE_RECEIVER_SIDE;
					side_from_prefix = true;
				}
				b'!' => rflags |= FILTRULE_CLEAR_LIST,
				_ => return Err(self.syntax_err("Unknown filter rule", rulestr)),
			}
			if ch != b'!' {
				loop {
					i += 1;
					let m = at(i);
					if m == 0 || m == b' ' || m == b'_' {
						break;
					}
					if template & FILTRULE_WORD_SPLIT != 0 && is_c_space(m) {
						i -= 1;
						break;
					}
					let merge = rflags & FILTRULE_MERGE_FILE != 0;
					let valid = match m {
						b'-' | b'+' => {
							let ok = merge && rflags & FILTRULE_NO_PREFIXES == 0;
							if ok {
								rflags |= FILTRULE_NO_PREFIXES;
								if m == b'+' {
									rflags |= FILTRULE_INCLUDE;
								}
							}
							ok
						}
						b'/' => {
							rflags |= FILTRULE_ABS_PATH;
							true
						}
						b'!' => {
							rflags |= FILTRULE_NEGATE;
							!merge
						}
						b'C' => {
							let ok = rflags & FILTRULE_NO_PREFIXES == 0 && !side_from_prefix;
							rflags |= FILTRULE_NO_PREFIXES
								| FILTRULE_WORD_SPLIT | FILTRULE_NO_INHERIT
								| FILTRULE_CVS_IGNORE;
							ok
						}
						b'e' => {
							rflags |= FILTRULE_EXCLUDE_SELF;
							merge
						}
						b'n' => {
							rflags |= FILTRULE_NO_INHERIT;
							merge
						}
						b'p' => {
							rflags |= FILTRULE_PERISHABLE;
							true
						}
						b'r' => {
							rflags |= FILTRULE_RECEIVER_SIDE;
							!side_from_prefix
						}
						b's' => {
							rflags |= FILTRULE_SENDER_SIDE;
							!side_from_prefix
						}
						b'w' => {
							rflags |= FILTRULE_WORD_SPLIT;
							merge
						}
						b'x' => {
							rflags |= FILTRULE_XATTR;
							self.saw_xattr_filter = true;
							true
						}
						_ => false,
					};
					if !valid {
						let detail = [
							&b" '"[..],
							&[m],
							b"' at position ",
							(i - start).to_string().as_bytes(),
						]
						.concat();
						let shown = self.rule_text(0, rulestr);
						let msg = [
							&b"invalid modifier"[..],
							self.rule_detail(0, &detail),
							b" in filter rule: ",
							&shown,
						]
						.concat();
						let msg = String::from_utf8_lossy_owned(msg);
						return Err(RsyncError::new(RERR_SYNTAX, msg).at("exclude.c", 1379));
					}
				}
			}
			if i < s.len() {
				i += 1;
			}
		}
		if template & FILTRULES_SIDES != 0 {
			if rflags & FILTRULES_SIDES != 0 {
				return Err(self.syntax_err(
					"specified-side merge file contains specified-side filter",
					rulestr,
				));
			}
			rflags |= template & FILTRULES_SIDES;
		}
		let i = i.min(s.len());
		let len = if template & FILTRULE_WORD_SPLIT != 0 {
			s[i..].iter().take_while(|&&b| !is_c_space(b)).count()
		} else {
			s.len() - i
		};
		if rflags & FILTRULE_CLEAR_LIST != 0 {
			if template & FILTRULE_NO_PREFIXES == 0 && xflags & XFLG_OLD_PREFIXES == 0 && len > 0 {
				return Err(self.syntax_err("'!' rule has trailing characters", rulestr));
			}
			if len > 1 {
				rflags &= !FILTRULE_CLEAR_LIST;
			}
		} else if len == 0 && rflags & FILTRULE_CVS_IGNORE == 0 {
			return Err(self.syntax_err("unexpected end of filter rule", rulestr));
		}
		if self.cfg.delete_excluded
			&& rflags & (FILTRULES_SIDES | FILTRULE_MERGE_FILE | FILTRULE_PERDIR_MERGE) == 0
		{
			rflags |= FILTRULE_SENDER_SIDE;
		}
		*pos = i + len;
		Ok(Some(Tok { rflags, start: i, end: i + len }))
	}

	/// Finishes a parsed rule and appends it to `list`.
	fn add_rule(&mut self, list: ListRef, mut pat: Vec<u8>, mut rflags: u32, xflags: u32) {
		let level = self.debug_level();
		if level >= 1 {
			let trailing_ws = matches!(pat.last(), Some(b' ' | b'\t'));
			let suffix: Option<&[u8]> = if trailing_ws {
				Some(&b" -- CAUTION: trailing whitespace!"[..])
			} else if level >= 2 {
				Some(&b""[..])
			} else {
				None
			};
			if let Some(suffix) = suffix {
				let prefix = rule_prefix(rflags, &pat, None).unwrap_or_default();
				let msg = [
					&b"["[..],
					self.who().as_bytes(),
					b"] add_rule(",
					self.rule_detail(rflags, &prefix),
					&self.rule_text(rflags, &pat),
					b")",
					&self.list_type(list),
					self.rule_detail(rflags, suffix),
					b"\n",
				]
				.concat();
				self.info(&msg);
			}
		}
		let other_side = if self.cfg.am_sender {
			FILTRULE_RECEIVER_SIDE
		} else {
			FILTRULE_SENDER_SIDE
		};
		if xflags & XFLG_ANCHORED2ABS != 0 && rflags & FILTRULES_SIDES == other_side {
			return;
		}
		if pat.len() > 1 && pat.pop_if(|b| *b == b'/').is_some() {
			rflags |= FILTRULE_DIRECTORY;
		}
		let mut slash_cnt = count_slashes(&pat);
		if rflags & (FILTRULE_ABS_PATH | FILTRULE_MERGE_FILE) == 0
			&& xflags & XFLG_ANCHORED2ABS != 0
			&& pat.first() == Some(&b'/')
		{
			rflags |= FILTRULE_ABS_PATH;
			let pre = &self.dirbuf[..self.dirbuf.len().saturating_sub(1)];
			slash_cnt += count_slashes(pre);
			let mut full = pre.to_vec();
			full.extend_from_slice(&pat);
			pat = full;
		}
		if pat.iter().any(|&b| matches!(b, b'*' | b'[' | b'?')) {
			rflags |= FILTRULE_WILD;
			if let Some(at) = find(&pat, b"**") {
				rflags |= FILTRULE_WILD2;
				if at == 0 {
					rflags |= FILTRULE_WILD2_PREFIX;
				}
				if pat.ends_with(b"***") {
					rflags |= FILTRULE_WILD3_SUFFIX;
				}
			}
		}
		let mut rule = Rule::new(rflags, pat, slash_cnt);
		if rflags & FILTRULE_PERDIR_MERGE != 0 {
			let name = paths::basename(&rule.pattern);
			if self.slots.iter().flatten().any(|s| paths::basename(&s.pattern) == name) {
				return;
			}
			let debug_type = [&b" [per-dir "[..], &self.rule_text(rflags, name), b"]"].concat();
			let index = self.slots.len();
			if level >= 2 {
				let msg = [
					&b"["[..],
					self.who().as_bytes(),
					b"] activating mergelist #",
					index.to_string().as_bytes(),
					&debug_type,
					b"\n",
				]
				.concat();
				self.info(&msg);
			}
			self.slots.push(Some(Slot {
				pattern: rule.pattern.clone(),
				rflags,
				debug_type,
				list: List::default(),
			}));
			rule.slot = Some(index);
		}
		match self.list_mut(list) {
			Some(l) => l.push(rule),
			None => self.free_rules(vec![rule]),
		}
	}

	/// `!`: drops this level's rules and hides inherited ones.
	fn clear_list(&mut self, list: ListRef) {
		let freed = match self.list_mut(list) {
			Some(l) => {
				let freed = l.take_local();
				l.hide_all();
				freed
			}
			None => Vec::new(),
		};
		self.free_rules(freed);
	}

	/// Releases rules, deactivating the merge files dir-merge rules among them own.
	fn free_rules(&mut self, rules: Vec<Rule>) {
		let mut work = rules;
		while let Some(rule) = work.pop() {
			if rule.rflags & FILTRULE_PERDIR_MERGE == 0 {
				continue;
			}
			let Some(index) = rule.slot else { continue };
			let Some(slot) = self.slots.get_mut(index).and_then(Option::take) else {
				continue;
			};
			if self.debug_level() >= 2 {
				let msg = [
					&b"["[..],
					self.who().as_bytes(),
					b"] deactivating mergelist #",
					self.slots.len().saturating_sub(1).to_string().as_bytes(),
					&slot.debug_type,
					b"\n",
				]
				.concat();
				self.info(&msg);
			}
			while matches!(self.slots.last(), Some(None)) {
				self.slots.pop();
			}
			work.extend(slot.list.layers.into_iter().flatten());
		}
	}

	/// Resolves a merge-file name: names with a slash (and every name while scanning
	/// parent directories) become absolute, relative to the current filter directory.
	fn parse_merge_name(&self, template: u32, name: &[u8], prefix_skip: usize) -> Option<Vec<u8>> {
		if !self.parent_dirscan && name.first() != Some(&b'/') && !name.contains(&b'/') {
			return Some(name.to_vec());
		}
		let cleaned = paths::clean_fname(name, true);
		if cleaned.first() == Some(&b'/') {
			return Some(cleaned);
		}
		let dir = &self.dirbuf[prefix_skip.min(self.dirbuf.len())..];
		if dir.len() + cleaned.len() >= MAXPATHLEN {
			let shown = self.rule_text(template, &cleaned);
			self.error_msg(&[&b"merge-file name overflows: "[..], &shown, b"\n"].concat());
			return None;
		}
		Some(paths::clean_fname(&[dir, &cleaned].concat(), true))
	}

	/// Reads a rule file (merge file, `--*-from` file, per-directory file).
	fn parse_file(
		&mut self,
		list: ListRef,
		fname: &[u8],
		template: u32,
		xflags: u32,
		rd: &Reader<'_>,
	) -> Result<(), RsyncError> {
		if fname.is_empty() {
			return Ok(());
		}
		let named_by_file = self.text_from_file(template);
		if self.merge_depth >= MAX_MERGE_DEPTH {
			let msg = [
				&b"["[..],
				self.who().as_bytes(),
				b"] merge-file include depth limit (",
				MAX_MERGE_DEPTH.to_string().as_bytes(),
				b") exceeded at ",
				&self.rule_text(template, fname),
			]
			.concat();
			if xflags & XFLG_FATAL_ERRORS != 0 {
				let msg = String::from_utf8_lossy_owned(msg);
				return Err(RsyncError::new(RERR_FILEIO, msg).at("exclude.c", 1626));
			}
			self.error_msg(&[&msg[..], b"\n"].concat());
			return Ok(());
		}
		let open_path: &[u8] = if fname == b"-" && self.cfg.am_server { b"./-" } else { fname };
		let data = self.read_via(rd, open_path);
		if self.debug_level() >= 2 {
			let found: &[u8] = if data.is_ok() { b"" } else { b" [not found]" };
			let msg = [
				&b"["[..],
				self.who().as_bytes(),
				b"] parse_filter_file(",
				&self.rule_text(template, fname),
				format!(",{template:x},{xflags:x})").as_bytes(),
				self.rule_detail(template, found),
				b"\n",
			]
			.concat();
			self.info(&msg);
		}
		let data = match data {
			Ok(d) => d,
			Err(err) => {
				if xflags & XFLG_FATAL_ERRORS == 0 {
					return Ok(());
				}
				let kind = if template & FILTRULE_INCLUDE != 0 { "in" } else { "ex" };
				let msg = if named_by_file {
					let shown = self.rule_text(template, fname);
					format!("failed to open {kind}clude file {}", String::from_utf8_lossy(&shown))
				} else {
					let what =
						format!("failed to open {kind}clude file {}", String::from_utf8_lossy(fname));
					syserr_text(self.cfg.role, &err, &what)
				};
				return Err(RsyncError::new(RERR_FILEIO, msg).at("exclude.c", 1719));
			}
		};
		self.merge_depth += 1;
		let saved = self.src.clone();
		if named_by_file {
			self.src.named_at = if self.src.in_file { Some(self.src_where()) } else { None };
		}
		let own_name = if named_by_file { None } else { Some(fname.to_vec()) };
		self.src.in_file = true;
		self.src.file = own_name.clone();
		self.src.line = if template & FILTRULE_WORD_SPLIT != 0 { -1 } else { 0 };
		let result = self.parse_lines(list, &data, own_name.as_deref(), template, xflags, rd);
		self.src = saved;
		self.merge_depth -= 1;
		result
	}

	/// Splits file contents into lines (or words) and parses each.
	fn parse_lines(
		&mut self,
		list: ListRef,
		data: &[u8],
		own_name: Option<&[u8]>,
		template: u32,
		xflags: u32,
		rd: &Reader<'_>,
	) -> Result<(), RsyncError> {
		let words = template & FILTRULE_WORD_SPLIT != 0;
		let from0 = self.cfg.from0;
		let mut pos = 0;
		loop {
			if self.src.line >= 0 {
				self.src.line += 1;
			}
			let mut line = Vec::new();
			let mut overflow = false;
			let mut at_eof = false;
			loop {
				let Some(&ch) = data.get(pos) else {
					at_eof = true;
					break;
				};
				pos += 1;
				if words && is_c_space(ch) {
					break;
				}
				let eol = if from0 { ch == 0 } else { ch == b'\n' || ch == b'\r' };
				if eol {
					if ch == b'\r' {
						match data.get(pos) {
							None => at_eof = true,
							Some(b'\n') => pos += 1,
							Some(_) => {}
						}
					}
					break;
				}
				if line.len() < BIGPATHBUFLEN - 1 {
					line.push(ch);
				} else {
					overflow = true;
				}
			}
			if overflow {
				let shown = self.rule_text(0, b"");
				self.error_msg(&[&b"discarding over-long filter: "[..], &shown, b"\n"].concat());
				line.clear();
			}
			let line = until_nul(&line);
			if !line.is_empty() && (words || (line[0] != b';' && line[0] != b'#')) {
				self.src.file = own_name.map(<[u8]>::to_vec);
				self.parse_str(list, line, template, xflags, rd)?;
			}
			if at_eof {
				return Ok(());
			}
		}
	}

	fn read_via(&self, rd: &Reader<'_>, path: &[u8]) -> io::Result<Vec<u8>> {
		if rd.relativize
			&& let Some(rel) = self.relative_to_curr(path)
		{
			return (rd.read)(rel);
		}
		(rd.read)(path)
	}

	fn relative_to_curr<'p>(&self, path: &'p [u8]) -> Option<&'p [u8]> {
		if self.curr_dir == b"/" {
			return path.strip_prefix(b"/");
		}
		path.strip_prefix(self.curr_dir.as_slice())?.strip_prefix(b"/")
	}

	/// The CVS list behind every `-C` rule: the defaults (perishable from protocol 30),
	/// `$HOME/.cvsignore`, and `$CVSIGNORE`. Loaded once.
	fn load_cvs_excludes(&mut self, rflags: u32, rd: &Reader<'_>) -> Result<(), RsyncError> {
		if self.cvs_loaded {
			return Ok(());
		}
		self.cvs_loaded = true;
		let perishable = if self.cfg.protocol >= 30 { FILTRULE_PERISHABLE } else { 0 };
		self.parse_str(ListRef::Cvs, DEFAULT_CVSIGNORE, rflags | perishable, 0, rd)?;
		if let Some(home) = self.cfg.home.clone() {
			let mut path = home;
			if path.last() != Some(&b'/') {
				path.push(b'/');
			}
			path.extend_from_slice(b".cvsignore");
			if path.len() < MAXPATHLEN {
				self.parse_file(ListRef::Cvs, &path, rflags, 0, rd)?;
			}
		}
		if let Some(env) = self.cfg.cvsignore_env.clone() {
			self.parse_str(ListRef::Cvs, &env, rflags, 0, rd)?;
		}
		Ok(())
	}

	// ----- per-directory merge files -----

	/// Sets the absolute filter directory (always ending in `/`).
	fn set_filter_dir(&mut self, dir: &[u8]) {
		let joined = if dir.first() == Some(&b'/') {
			dir.to_vec()
		} else {
			let mut buf = self.curr_dir.clone();
			buf.push(b'/');
			if buf.len() + dir.len() < MAXPATHLEN {
				buf.extend_from_slice(dir);
			}
			buf
		};
		let mut d = paths::clean_fname(&joined, true);
		if d.len() > 1 && d.ends_with(b"/.") {
			d.truncate(d.len() - 2);
		}
		while d.len() > 1 && d.last() == Some(&b'/') {
			d.pop();
		}
		if d.len() != 1 {
			d.push(b'/');
		}
		self.dirbuf = d;
	}

	fn push_local(&mut self, dir: &[u8], rd: &Reader<'_>) -> Result<DirMark, RsyncError> {
		self.set_filter_dir(dir);
		let level = self.debug_level();
		if level >= 2 {
			let msg = [
				&b"["[..],
				self.who().as_bytes(),
				b"] pushing local filters for ",
				&self.dirbuf,
				b"\n",
			]
			.concat();
			self.info(&msg);
		}
		if self.slots.is_empty() {
			return Ok(DirMark { saved: None });
		}
		let saved: Vec<Option<ListState>> =
			self.slots.iter().map(|s| s.as_ref().map(|s| s.list.state())).collect();
		// Merge files read below may activate more slots; those are entered too.
		let mut i = 0;
		while i < self.slots.len() {
			let Some(slot) = self.slots[i].as_mut() else {
				i += 1;
				continue;
			};
			slot.list.inherit();
			if slot.rflags & FILTRULE_NO_INHERIT != 0 {
				slot.list.hide_all();
			}
			let needs_setup = slot.rflags & FILTRULE_FINISH_SETUP != 0;
			slot.rflags &= !FILTRULE_FINISH_SETUP;
			if level >= 2 {
				let msg = [
					&b"["[..],
					self.who().as_bytes(),
					b"] pushing mergelist #",
					i.to_string().as_bytes(),
					&self.list_type(ListRef::Slot(i)),
					b"\n",
				]
				.concat();
				self.info(&msg);
			}
			if needs_setup && self.setup_merge_file(i, rd)? {
				self.set_filter_dir(dir);
			}
			let Some(slot) = self.slots.get(i).and_then(Option::as_ref) else {
				i += 1;
				continue;
			};
			let rflags = slot.rflags;
			let path = [&self.dirbuf[..], &slot.pattern].concat();
			if path.len() < MAXPATHLEN {
				self.parse_file(ListRef::Slot(i), &path, rflags, XFLG_ANCHORED2ABS, rd)?;
			} else {
				self.io_error = true;
				let shown = self.rule_text(rflags, &path[..MAXPATHLEN - 1]);
				self.error_msg(&[
					&b"cannot add local filter rules in long-named directory: "[..],
					&shown,
					b"\n",
				]
				.concat());
			}
			i += 1;
		}
		Ok(DirMark { saved: Some(saved) })
	}

	/// First entry of a dir-merge whose name has a directory part: if that directory is
	/// a parent of the current one, reads the file in it and in every directory between
	/// it and the current one (each level inherited by the next). Returns whether the
	/// name had such a part (the filter directory then needs resetting).
	fn setup_merge_file(&mut self, index: usize, rd: &Reader<'_>) -> Result<bool, RsyncError> {
		let Some(slot) = self.slots.get(index).and_then(Option::as_ref) else {
			return Ok(false);
		};
		let (pattern, rflags) = (slot.pattern.clone(), slot.rflags);
		let Some(full) = self.parse_merge_name(rflags, &pattern, 0) else {
			return Ok(false);
		};
		if full.first() != Some(&b'/') {
			return Ok(false);
		}
		let level = self.debug_level();
		let list_type = self.list_type(ListRef::Slot(index));
		if level >= 2 {
			let msg = [
				&b"["[..],
				self.who().as_bytes(),
				b"] performing parent_dirscan for mergelist #",
				index.to_string().as_bytes(),
				&list_type,
				b"\n",
			]
			.concat();
			self.info(&msg);
		}
		let cut = full.iter().rposition(|&b| b == b'/').unwrap_or(0);
		let name = full[cut + 1..].to_vec();
		if let Some(Some(slot)) = self.slots.get_mut(index) {
			slot.pattern = name.clone();
		}
		let dir_part: &[u8] = if cut == 0 { b"/" } else { &full[..cut] };
		let mut parent = paths::clean_fname(dir_part, true);
		if parent.len() != 1 && parent.len() < MAXPATHLEN - 1 {
			parent.push(b'/');
		}
		let dirbuf = self.dirbuf.clone();
		let common = parent.iter().zip(dirbuf.iter()).take_while(|(a, b)| a == b).count();
		let mut y = if common < parent.len() { dirbuf.len() } else { common };
		self.parent_dirscan = true;
		let mut result = Ok(());
		while y < dirbuf.len() {
			self.dirbuf = dirbuf[..y].to_vec();
			let fname = [&dirbuf[..y], &name].concat();
			result = self.parse_file(ListRef::Slot(index), &fname, rflags, XFLG_ANCHORED2ABS, rd);
			if result.is_err() {
				break;
			}
			let freed = match self.slots.get_mut(index).and_then(Option::as_mut) {
				Some(slot) => {
					let freed = if rflags & FILTRULE_NO_INHERIT != 0 {
						let freed = slot.list.take_visible();
						slot.list.hide_all();
						freed
					} else {
						Vec::new()
					};
					slot.list.inherit();
					freed
				}
				None => Vec::new(),
			};
			self.free_rules(freed);
			y = match dirbuf[y..].iter().position(|&b| b == b'/') {
				Some(p) => y + p + 1,
				None => dirbuf.len(),
			};
		}
		self.parent_dirscan = false;
		self.dirbuf = dirbuf;
		result?;
		if level >= 2 {
			let msg = [
				&b"["[..],
				self.who().as_bytes(),
				b"] completed parent_dirscan for mergelist #",
				index.to_string().as_bytes(),
				&list_type,
				b"\n",
			]
			.concat();
			self.info(&msg);
		}
		Ok(true)
	}

	fn pop_local(&mut self, mark: DirMark) {
		let level = self.debug_level();
		if level >= 2 {
			let msg = [&b"["[..], self.who().as_bytes(), b"] popping local filters\n"].concat();
			self.info(&msg);
		}
		let old_count = mark.saved.as_ref().map_or(0, Vec::len);
		for i in (0..self.slots.len()).rev() {
			let Some(slot) = self.slots.get_mut(i).and_then(Option::as_mut) else {
				continue;
			};
			let freed = slot.list.take_local();
			let leftover = i >= old_count && slot.list.has_visible();
			if level >= 2 {
				let list_type = self.list_type(ListRef::Slot(i));
				let msg = [
					&b"["[..],
					self.who().as_bytes(),
					b"] popping mergelist #",
					i.to_string().as_bytes(),
					&list_type,
					b"\n",
				]
				.concat();
				self.info(&msg);
				if leftover {
					let msg = [
						&b"["[..],
						self.who().as_bytes(),
						b"] freeing parent_dirscan filters of mergelist #",
						i.to_string().as_bytes(),
						&list_type,
						b"\n",
					]
					.concat();
					self.info(&msg);
				}
			}
			self.free_rules(freed);
		}
		let Some(saved) = mark.saved else { return };
		for (i, state) in saved.into_iter().enumerate() {
			let Some(state) = state else { continue };
			let freed = match self.slots.get_mut(i).and_then(Option::as_mut) {
				Some(slot) => slot.list.restore(state),
				None => continue,
			};
			self.free_rules(freed);
		}
	}

	/// Every global rule as `PREFIX PATTERN` text (diagnostic/test view).
	#[cfg(test)]
	fn rule_texts(&self) -> Vec<Vec<u8>> {
		self.global
			.visible()
			.map(|r| {
				let mut t = rule_prefix(r.rflags, &r.pattern, None).unwrap_or_default();
				t.extend_from_slice(&r.pattern);
				if r.rflags & FILTRULE_DIRECTORY != 0 {
					t.push(b'/');
				}
				t
			})
			.collect()
	}
}

/// Encodes (or, with `out == None`, only vets) the rules of `list`, tagging each with
/// the side it applies to. `cvs` is the list `-C` rules expand to.
fn send_rules(
	list: &mut List,
	mut cvs: Option<&mut List>,
	ctx: XferCtx,
	mut out: Option<&mut Vec<u8>>,
) -> Result<(), RsyncError> {
	for rule in list.visible_mut() {
		let mut elide = 0;
		if rule.rflags & FILTRULE_SENDER_SIDE != 0 {
			elide = if ctx.am_sender { LOCAL_RULE } else { REMOTE_RULE };
		}
		if rule.rflags & FILTRULE_RECEIVER_SIDE != 0 {
			elide = if elide != 0 {
				0
			} else if ctx.am_sender {
				REMOTE_RULE
			} else {
				LOCAL_RULE
			};
		} else if ctx.delete_excluded
			&& elide == 0
			&& (rule.rflags & FILTRULE_PERDIR_MERGE == 0
				|| rule.rflags & FILTRULE_NO_PREFIXES != 0)
		{
			elide = if ctx.am_sender { LOCAL_RULE } else { REMOTE_RULE };
		}
		rule.elide = elide;
		if elide == LOCAL_RULE {
			continue;
		}
		if rule.rflags & FILTRULE_CVS_IGNORE != 0 && rule.rflags & FILTRULE_MERGE_FILE == 0 {
			// A sender (or an old peer) gets the CVS list itself; a newer server
			// receiving from us builds its own from a "-C" rule.
			let expand_here = ctx.am_sender || ctx.protocol < 29;
			if let Some(cvs) = cvs.as_deref_mut() {
				let sink = if expand_here { out.as_mut().map(|w| &mut **w) } else { None };
				send_rules(cvs, None, ctx, sink)?;
			}
			if expand_here {
				continue;
			}
		}
		let Some(prefix) = rule_prefix(rule.rflags, &rule.pattern, Some(ctx)) else {
			let msg = "filter rules are too modern for remote rsync.";
			return Err(RsyncError::new(RERR_PROTOCOL, msg).at("exclude.c", 1926));
		};
		let Some(w) = out.as_mut() else { continue };
		let dir_slash = usize::from(rule.rflags & FILTRULE_DIRECTORY != 0);
		let total = prefix.len() + rule.pattern.len() + dir_slash;
		if total == 0 {
			continue;
		}
		// Bounded by MAXPATHLEN-limited patterns plus a short prefix.
		w.extend_from_slice(&(total as i32).to_le_bytes());
		w.extend_from_slice(&prefix);
		w.extend_from_slice(&rule.pattern);
		if dir_slash == 1 {
			w.push(b'/');
		}
	}
	Ok(())
}

/// The `RULE,MODIFIERS ` prefix that reproduces `rflags`. With `xfer` set, the form a
/// peer of that protocol understands, or `None` when it cannot express the rule.
fn rule_prefix(rflags: u32, pat: &[u8], xfer: Option<XferCtx>) -> Option<Vec<u8>> {
	let protocol = xfer.map_or(u32::MAX, |c| c.protocol);
	let mut legal_len = if xfer.is_some() && protocol < 29 { 1 } else { 15 };
	let mut op = Vec::with_capacity(16);
	if rflags & FILTRULE_PERDIR_MERGE != 0 {
		if legal_len == 1 {
			return None;
		}
		op.push(b':');
	} else if rflags & FILTRULE_INCLUDE != 0 {
		op.push(b'+');
	} else if legal_len != 1 || (matches!(pat.first(), Some(b'-' | b'+')) && pat.get(1) == Some(&b' ')) {
		op.push(b'-');
	} else {
		legal_len = 0;
	}
	if rflags & FILTRULE_ABS_PATH != 0 {
		op.push(b'/');
	}
	if rflags & FILTRULE_NEGATE != 0 {
		op.push(b'!');
	}
	if rflags & FILTRULE_CVS_IGNORE != 0 {
		op.push(b'C');
	} else {
		if rflags & FILTRULE_NO_INHERIT != 0 {
			op.push(b'n');
		}
		if rflags & FILTRULE_WORD_SPLIT != 0 {
			op.push(b'w');
		}
		if rflags & FILTRULE_NO_PREFIXES != 0 {
			op.push(if rflags & FILTRULE_INCLUDE != 0 { b'+' } else { b'-' });
		}
	}
	if rflags & FILTRULE_EXCLUDE_SELF != 0 {
		op.push(b'e');
	}
	if rflags & FILTRULE_XATTR != 0 {
		op.push(b'x');
	}
	if rflags & FILTRULE_SENDER_SIDE != 0 && (xfer.is_none() || protocol >= 29) {
		op.push(b's');
	}
	if rflags & FILTRULE_RECEIVER_SIDE != 0
		&& (xfer.is_none()
			|| protocol >= 29
			|| xfer.is_some_and(|c| c.delete_excluded && c.am_sender))
	{
		op.push(b'r');
	}
	if rflags & FILTRULE_PERISHABLE != 0 {
		if xfer.is_none() || protocol >= 30 {
			op.push(b'p');
		} else if xfer.is_some_and(|c| c.am_sender) {
			return None;
		}
	}
	if op.len() > legal_len {
		return None;
	}
	if legal_len != 0 {
		op.push(b' ');
	}
	Some(op)
}

/// Does `rule` match `fname`? `skip_elide` names the side tag that makes a rule
/// inapplicable to this lookup.
fn rule_matches(rule: &Rule, fname: &[u8], kind: NameKind, curr_dir: &[u8], skip_elide: u8) -> bool {
	let hit = rule.rflags & FILTRULE_NEGATE == 0;
	let absolute_name = fname.first() == Some(&b'/');
	let name = if absolute_name { &fname[1..] } else { fname };
	if name.is_empty() || (rule.elide != 0 && rule.elide == skip_elide) {
		return false;
	}
	if (kind == NameKind::Xattr) != (rule.rflags & FILTRULE_XATTR != 0) {
		return false;
	}
	let wild2 = rule.rflags & FILTRULE_WILD2 != 0;
	let mut text: Vec<u8> = Vec::new();
	let mut pieces = 0;
	let subject: &[u8] = if rule.slash_cnt == 0 && !wild2 {
		paths::basename(name)
	} else {
		if rule.rflags & FILTRULE_ABS_PATH != 0 && !absolute_name && curr_dir.len() > 1 {
			text.extend_from_slice(&curr_dir[1..]);
			text.push(b'/');
			pieces += 2;
		} else if rule.rflags & FILTRULE_WILD2_PREFIX != 0 && !absolute_name {
			text.push(b'/');
			pieces += 1;
		}
		name
	};
	text.extend_from_slice(subject);
	pieces += 1;
	if kind == NameKind::Dir {
		if rule.rflags & FILTRULE_WILD3_SUFFIX != 0 {
			text.push(b'/');
			pieces += 1;
		}
	} else if rule.rflags & FILTRULE_DIRECTORY != 0 {
		return !hit;
	}
	let (pattern, anchored) = match rule.pattern.strip_prefix(b"/") {
		Some(rest) => (rest, true),
		None => (rule.pattern.as_slice(), false),
	};
	let place = if !anchored && rule.slash_cnt > 0 && !wild2 {
		Where::Trailing(rule.slash_cnt as usize + 1)
	} else if !anchored && rule.rflags & FILTRULE_WILD2_PREFIX == 0 && wild2 {
		Where::AnySlash
	} else {
		Where::Start
	};
	let matched = if rule.rflags & FILTRULE_WILD != 0 {
		wildmatch::wildmatch_at(pattern, &text, place)
	} else if pieces > 1 {
		wildmatch::litmatch_at(pattern, &text, place)
	} else if anchored {
		subject == pattern
	} else {
		subject.ends_with(pattern)
			&& (subject.len() == pattern.len()
				|| subject[subject.len() - pattern.len() - 1] == b'/')
	};
	if matched { hit } else { !hit }
}

fn describe_match(rule: &Rule, list_type: &[u8]) -> FilterMatch {
	let verdict = if rule.rflags & FILTRULE_INCLUDE != 0 {
		Verdict::Include
	} else {
		Verdict::Exclude
	};
	let pattern = if rule.rflags & FILTRULE_FROM_FILE != 0 {
		READ_EARLIER.to_vec()
	} else {
		let mut p = rule.pattern.clone();
		if rule.rflags & FILTRULE_DIRECTORY != 0 {
			p.push(b'/');
		}
		p
	};
	FilterMatch { verdict, pattern, list_type: list_type.to_vec() }
}

// ----- implied includes -----

/// The receiver's record of what it asked the sender for (upstream
/// `implied_filter_list`): every file-list name must match one of these, and directories
/// that only lead to requested names are marked implied (never content).
///
/// Callers skip [`ImpliedFilters::add`] when the sender's arguments are trusted
/// (`--trust-sender`, servers, batch reads, local copies).
#[derive(Clone, Default)]
pub(crate) struct ImpliedFilters {
	/// Insertion order; lookups walk newest first.
	rules: Vec<Rule>,
	relative_paths: bool,
	recurse: bool,
	xfer_dirs: bool,
	logger: Option<(Logger, Role)>,
}

impl ImpliedFilters {
	/// An empty list for the given `-R` / `-r` / `-d` settings.
	pub(crate) fn new(relative_paths: bool, recurse: bool, xfer_dirs: bool) -> Self {
		Self { relative_paths, recurse, xfer_dirs, ..Self::default() }
	}

	/// Where `--debug=FILTER` traces go and whose name they carry.
	pub(crate) fn set_logger(&mut self, logger: Option<Logger>, role: Role) {
		self.logger = logger.map(|l| (l, role));
	}

	/// Whether nothing was requested yet.
	pub(crate) fn is_empty(&self) -> bool {
		self.rules.is_empty()
	}

	/// Records one source argument sent to the remote sender (`add_implied_include`).
	/// `skip_daemon_module` drops the leading `module/` of a daemon path.
	pub(crate) fn add(&mut self, arg: &[u8], skip_daemon_module: bool) {
		let mut arg = until_nul(arg);
		if skip_daemon_module {
			arg = match arg.iter().position(|&b| b == b'/') {
				Some(i) => &arg[i + 1..],
				None => b"",
			};
		}
		if self.relative_paths {
			if let Some(i) = find(arg, b"/./") {
				arg = &arg[i + 3..];
			}
		} else {
			arg = paths::basename(arg);
		}
		if arg == b"." {
			arg = b"";
		}
		let saw_wild = arg.iter().any(|&b| matches!(b, b'*' | b'[' | b'?'));
		let mut backslash_cnt = 0usize;
		let mut live_bracket = false;
		let mut slash_cnt: i64 = 0;
		let mut cleaned: Vec<u8> = Vec::new();
		if !arg.is_empty() {
			let mut p = vec![b'/'];
			slash_cnt = 1;
			let mut i = 0;
			while i < arg.len() {
				let c = arg[i];
				let next = arg.get(i + 1).copied();
				match c {
					b'\\' => {
						if next == Some(b']') {
							if !saw_wild {
								i += 1;
							}
						} else if !matches!(next, Some(b'*' | b'[' | b'?')) {
							backslash_cnt += 1;
							if saw_wild {
								p.push(b'\\');
							}
						}
						p.push(arg[i]);
						i += 1;
					}
					b'/' => {
						if p.last() == Some(&b'/') {
							i += 1;
							if i == arg.len() {
								slash_cnt -= 1;
								p.pop();
							}
						} else if next.is_none() {
							i += 1;
						} else {
							slash_cnt += 1;
							p.push(b'/');
							i += 1;
						}
					}
					b'.' if p.last() == Some(&b'/') => match next {
						Some(b'/') => {
							i += 2;
							if i >= arg.len() {
								slash_cnt -= 1;
								p.pop();
							}
						}
						None => {
							i += 1;
							slash_cnt -= 1;
							p.pop();
						}
						Some(_) => {
							p.push(b'.');
							i += 1;
						}
					},
					b'[' => {
						live_bracket = true;
						p.push(b'[');
						i += 1;
					}
					_ => {
						p.push(c);
						i += 1;
					}
				}
			}
			if !p.is_empty() {
				let wild = if saw_wild { FILTRULE_WILD } else { 0 };
				let rule = Rule::new(FILTRULE_INCLUDE | wild, p.clone(), slash_cnt.max(0) as u32);
				self.push(rule.clone(), b"");
				if live_bracket {
					self.add_literal_brackets(&rule);
				}
				if self.relative_paths && slash_cnt > 0 {
					let mut sub = slash_cnt;
					let mut parent = p.clone();
					while let Some(cut) = parent.iter().rposition(|&b| b == b'/') {
						if cut == 0 {
							break;
						}
						parent.truncate(cut);
						if self.rules.iter().any(|r| r.pattern == parent) {
							break;
						}
						sub -= 1;
						let wild = saw_wild
							&& parent.iter().any(|&b| matches!(b, b'*' | b'[' | b'?' | b'\\'));
						let flags = FILTRULE_INCLUDE
							| FILTRULE_DIRECTORY | if wild { FILTRULE_WILD } else { 0 };
						let dir_rule = Rule::new(flags, parent.clone(), sub.max(0) as u32);
						self.push(dir_rule.clone(), b"/");
						if live_bracket {
							self.add_literal_brackets(&dir_rule);
						}
					}
				}
				cleaned = p;
			}
		}
		if self.recurse || self.xfer_dirs {
			let mut pat = Vec::with_capacity(cleaned.len() + backslash_cnt + 3);
			if !saw_wild && backslash_cnt > 0 {
				for &b in &cleaned {
					if b == b'\\' {
						pat.push(b'\\');
					}
					pat.push(b);
				}
			} else {
				pat.extend_from_slice(&cleaned);
			}
			pat.extend_from_slice(b"/*");
			let mut flags = FILTRULE_INCLUDE | FILTRULE_WILD;
			if self.recurse {
				pat.push(b'*');
				flags |= FILTRULE_WILD2;
			}
			let rule = Rule::new(flags, pat, (slash_cnt + 1).max(0) as u32);
			self.push(rule.clone(), b"");
			if live_bracket {
				self.add_literal_brackets(&rule);
			}
		}
	}

	/// When the remote shell left a `[...]` unexpanded, the sender may return a file
	/// literally named that way: also accept the name with every live `[` escaped.
	fn add_literal_brackets(&mut self, based_on: &Rule) {
		let pat = &based_on.pattern;
		let mut live = 0;
		let mut i = 0;
		while i < pat.len() {
			if pat[i] == b'\\' && i + 1 < pat.len() {
				i += 2;
				continue;
			}
			if pat[i] == b'[' {
				live += 1;
			}
			i += 1;
		}
		if live == 0 {
			return;
		}
		let mut escaped = Vec::with_capacity(pat.len() + live);
		let mut i = 0;
		while i < pat.len() {
			if pat[i] == b'\\' && i + 1 < pat.len() {
				escaped.extend_from_slice(&pat[i..i + 2]);
				i += 2;
				continue;
			}
			if pat[i] == b'[' {
				escaped.push(b'\\');
			}
			escaped.push(pat[i]);
			i += 1;
		}
		let suffix: &[u8] = if based_on.rflags & FILTRULE_DIRECTORY != 0 { b"/" } else { b"" };
		self.push(Rule::new(based_on.rflags, escaped, based_on.slash_cnt), suffix);
	}

	fn push(&mut self, rule: Rule, trace_suffix: &[u8]) {
		if let Some((logger, role)) = &self.logger
			&& logger.levels().debug(DebugFlag::Filter) >= 3
		{
			logger.rprintf(
				LogCode::Info,
				&[
					&b"["[..],
					role.name().as_bytes(),
					b"] add_implied_include(",
					&rule.pattern,
					trace_suffix,
					b")\n",
				]
				.concat(),
			);
		}
		self.rules.push(rule);
	}

	/// Whether `name` is something that was asked for (`Include`) or not (`NoMatch`).
	pub(crate) fn check(&self, name: &[u8], is_dir: bool) -> Verdict {
		let kind = if is_dir { NameKind::Dir } else { NameKind::File };
		for rule in self.rules.iter().rev() {
			if rule_matches(rule, name, kind, b"/", REMOTE_RULE) {
				let m = describe_match(rule, IMPLIED_TYPE);
				if let Some((logger, role)) = &self.logger {
					let level = if matches!(role, Role::Sender | Role::Generator) { 1 } else { 3 };
					if logger.levels().debug(DebugFlag::Filter) >= level {
						logger.rprintf(LogCode::Info, &m.message(*role, name, kind));
					}
				}
				return m.verdict;
			}
		}
		Verdict::NoMatch
	}

	/// Whether directory `name` was only implied as a parent of requested names (never
	/// requested itself), so it must not be treated as a content directory.
	pub(crate) fn is_implied_parent_dir(&self, name: &[u8]) -> bool {
		if self.rules.is_empty() {
			return false;
		}
		if name == b"." || name == b"/." {
			return !self.rules.iter().any(|r| {
				r.rflags & FILTRULE_INCLUDE != 0 && (r.pattern == b"/**" || r.pattern == b"/*")
			});
		}
		let mut parent_match = false;
		for rule in self.rules.iter().rev() {
			if !rule_matches(rule, name, NameKind::Dir, b"/", REMOTE_RULE)
				|| rule.rflags & FILTRULE_INCLUDE == 0
			{
				continue;
			}
			if rule.rflags & FILTRULE_DIRECTORY != 0 {
				parent_match = true;
				continue;
			}
			return false;
		}
		parent_match
	}
}

// ----- small helpers -----

fn count_slashes(s: &[u8]) -> u32 {
	s.iter().filter(|&&b| b == b'/').count() as u32
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
	hay.windows(needle.len()).position(|w| w == needle)
}

/// For a long rule name at the start of `s`: the offset the modifier scan starts from
/// (the name's last byte, or the comma after it), when the name is properly terminated.
fn long_rule_end(s: &[u8], word: &[u8]) -> Option<usize> {
	let rest = s.strip_prefix(word)?;
	match rest.first() {
		None => Some(word.len() - 1),
		Some(&b) if is_c_space(b) || b == b'_' => Some(word.len() - 1),
		Some(b',') => Some(word.len()),
		Some(_) => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// `pwd -P` of the fixture's source directory when the reference outputs were taken.
	const CURR: &str = "/private/tmp/flt/fx/src";

	/// The fixture tree (directories end in `/`).
	const TREE: &[&str] = &[
		".cvsignore",
		".rsync-filter",
		"Abc",
		"[lit]",
		"a.o",
		"b.c",
		"bar/",
		"bar/.rsync-filter",
		"bar/baz.c",
		"bar/deep/",
		"bar/deep/.cvsignore",
		"bar/deep/foo/",
		"bar/deep/foo/x",
		"bar/deep/y.o",
		"bar/deep/z.c",
		"bar/foo",
		"bar/qux.c",
		"core",
		"dir1/",
		"dir1/.rules",
		"dir1/file",
		"dir1/sub/",
		"dir1/sub/.rules",
		"dir1/sub/file",
		"foo",
		"foo.txt",
		"x1",
		"x_",
	];

	/// Rule files of the fixture (absolute paths).
	const CONTENTS: &[(&str, &str)] = &[
		("/private/tmp/flt/fx/src/.cvsignore", "Abc\n"),
		("/private/tmp/flt/fx/src/.rsync-filter", "- *.txt\n"),
		("/private/tmp/flt/fx/src/bar/.rsync-filter", "- /baz.c\n+ y.o\n"),
		("/private/tmp/flt/fx/src/bar/deep/.cvsignore", "x\n"),
		("/private/tmp/flt/fx/src/dir1/.rules", "- file\n"),
		("/private/tmp/flt/fx/src/dir1/sub/.rules", "!\n+ file\n"),
		("/private/tmp/flt/fx/.rsync-filter", "- x1\n- /core\n"),
	];

	/// Operator files named on the command line.
	const OP_FILES: &[(&str, &[u8])] = &[
		("/tmp/flt/xf", b"# comment\n; also comment\n\n*.o\r\n+ core\ncore\n- foo\n+ x1\n!\nx*\n"),
		("/tmp/flt/if", b"bar/\nbar/deep/\n*.c\n"),
		("/tmp/flt/xl", b"- foo\n# c\n+ x1\nx*\n"),
		("/tmp/flt/x0", b"foo\0*.c\0# x\0"),
		("/tmp/flt/xm", b"- foo\n+ x1\n"),
		("f1", b"- a\n\nx bad\n"),
		("f2", b"- a\n-z foo\n"),
		("f3", b"!x\n"),
		("f4", b"- \n"),
		("f5", b". f2\n"),
		("f8", b"- a\n. nonexist\n"),
		("fw", b"- foo + bar\n"),
		("fw2", b"-_foo +_bar\n-_*\n"),
		("fcr", b"foo\r\nbar\rbaz\n"),
	];

	fn op_files(path: &Path) -> io::Result<Vec<u8>> {
		let key = path.to_str().unwrap_or_default();
		OP_FILES
			.iter()
			.find(|(name, _)| *name == key)
			.map(|(_, data)| data.to_vec())
			.ok_or_else(|| io::Error::from_raw_os_error(2))
	}

	fn tree_reader(path: &[u8]) -> io::Result<Option<Vec<u8>>> {
		let path = String::from_utf8_lossy(path);
		let key = if path.starts_with('/') { path.into_owned() } else { format!("{CURR}/{path}") };
		Ok(CONTENTS.iter().find(|(name, _)| *name == key).map(|(_, data)| data.as_bytes().to_vec()))
	}

	fn apply(f: &mut Filters, arg: &str) -> Result<(), RsyncError> {
		if let Some(rule) = arg.strip_prefix("-f") {
			f.add(RuleArg::Filter(rule.as_bytes()), &op_files)
		} else if let Some(p) = arg.strip_prefix("--exclude-from=") {
			f.add(RuleArg::ExcludeFrom(Path::new(p)), &op_files)
		} else if let Some(p) = arg.strip_prefix("--include-from=") {
			f.add(RuleArg::IncludeFrom(Path::new(p)), &op_files)
		} else if let Some(p) = arg.strip_prefix("--exclude=") {
			f.add(RuleArg::Exclude(p.as_bytes()), &op_files)
		} else if let Some(p) = arg.strip_prefix("--include=") {
			f.add(RuleArg::Include(p.as_bytes()), &op_files)
		} else if arg == "-F" {
			// What options.rs turns the first -F into.
			f.add(RuleArg::Filter(b": /.rsync-filter"), &op_files)
		} else if arg == "-C" {
			f.add(RuleArg::Cvs, &op_files)
		} else if arg == "--delete-excluded" {
			f.set_delete_excluded(true);
			Ok(())
		} else if arg == "--delete" {
			Ok(())
		} else {
			panic!("unhandled test arg {arg}")
		}
	}

	fn children(dir: &str) -> Vec<(&'static str, bool)> {
		TREE.iter()
			.copied()
			.filter_map(|entry| {
				let is_dir = entry.ends_with('/');
				let path = entry.trim_end_matches('/');
				let parent = path.rfind('/').map_or("", |i| &path[..i]);
				(parent == dir).then_some((path, is_dir))
			})
			.collect()
	}

	/// Scans the fixture like the sender: check each entry, then descend.
	fn walk(f: &mut Filters, dir: &str, out: &mut Vec<String>) {
		let mark = f.enter_dir(dir.as_bytes(), &tree_reader).expect("enter_dir");
		let mut subdirs = Vec::new();
		for (path, is_dir) in children(dir) {
			if f.check(path.as_bytes(), is_dir, Side::Sender) == Verdict::Exclude {
				continue;
			}
			out.push(if is_dir { format!("{path}/") } else { path.to_owned() });
			if is_dir {
				subdirs.push(path);
			}
		}
		for sub in subdirs {
			walk(f, sub, out);
		}
		f.leave_dir(mark);
	}

	/// `rsync -nr --out-format=%n ARGS src/ dst/ | LC_ALL=C sort`.
	fn local_list(args: &[&str]) -> Result<String, RsyncError> {
		let cfg = FilterConfig {
			local_server: true,
			am_sender: true,
			from0: args.contains(&"-0"),
			..FilterConfig::default()
		};
		let mut f = Filters::new(cfg);
		f.set_curr_dir(CURR.as_bytes());
		for arg in args.iter().filter(|a| **a != "-0") {
			if *arg == "-FF" {
				apply(&mut f, "-F")?;
				apply(&mut f, "-f- .rsync-filter")?;
			} else {
				apply(&mut f, arg)?;
			}
		}
		f.send(&mut io::sink(), Proto::new(33, 0), false)?;
		let mut out = vec!["./".to_owned()];
		walk(&mut f, "", &mut out);
		out.sort();
		Ok(out.join(" "))
	}

	/// Expected lists come from rsync 3.5.1 over the same tree.
	#[test]
	fn sender_verdicts_match_reference() {
		let all = "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c \
			bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c \
			bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules \
			dir1/sub/file foo foo.txt x1 x_";
		let cases: &[(&[&str], &str)] = &[
			(&[], all),
			(&["-f- foo"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/y.o bar/deep/z.c bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo.txt x1 x_"),
			(&["-f- /foo"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo.txt x1 x_"),
			(&["-f- foo/"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- bar/foo"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- **/foo"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/y.o bar/deep/z.c bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo.txt x1 x_"),
			(&["-f- bar/**"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- bar/***"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- *.[oc]"], "./ .cvsignore .rsync-filter Abc [lit] bar/ bar/.rsync-filter bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/foo core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- [[:upper:]]*"], "./ .cvsignore .rsync-filter [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- x[!1]"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1"),
			(&["-f- \\[lit\\]"], "./ .cvsignore .rsync-filter Abc a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- [lit]"], all),
			(&["-f+ */", "-f+ *.c", "-f- *"], "./ b.c bar/ bar/baz.c bar/deep/ bar/deep/foo/ bar/deep/z.c bar/qux.c dir1/ dir1/sub/"),
			(&["-f+ bar/", "-f+ bar/deep/***", "-f- *"], "./ bar/ bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c"),
			(&["-f-! */"], "./ bar/ bar/deep/ bar/deep/foo/ dir1/ dir1/sub/"),
			(&["-fexclude,! */"], "./ bar/ bar/deep/ bar/deep/foo/ dir1/ dir1/sub/"),
			(&["-f-! *.c"], "./ b.c"),
			(&["-F"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo x_"),
			(&["-FF"], "./ .cvsignore Abc [lit] a.o b.c bar/ bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo x_"),
			(&["-C"], "./ .cvsignore .rsync-filter [lit] b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/z.c bar/foo bar/qux.c dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-C", "-f+ core"], "./ .cvsignore .rsync-filter [lit] b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f: .rsync-filter", "-f- *.c"], "./ .cvsignore .rsync-filter Abc [lit] a.o bar/ bar/.rsync-filter bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/foo core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo x1 x_"),
			(&["-f- *.c", "-f: .rsync-filter"], "./ .cvsignore .rsync-filter Abc [lit] a.o bar/ bar/.rsync-filter bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/foo core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo x1 x_"),
			(&["-f:n .rsync-filter"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo x1 x_"),
			(&["-f: .rules"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- foo", "-f!", "-f- *.o"], "./ .cvsignore .rsync-filter Abc [lit] b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- /bar/deep/"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- deep/*.o"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- **.c"], "./ .cvsignore .rsync-filter Abc [lit] a.o bar/ bar/.rsync-filter bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/foo core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- b?r/"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f-/ /private/tmp/flt/fx/src/bar/foo"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- deep/**/x"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- /bar/**/x"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- bar/*/x"], all),
			(&["-f- ba*/f*"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f+ foo", "-f- f*"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/sub/ dir1/sub/.rules foo x1 x_"),
			(&["-f:e .rsync-filter"], "./ .cvsignore Abc [lit] a.o b.c bar/ bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo x1 x_"),
			(&["-f:- .cvsignore"], "./ .cvsignore .rsync-filter [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f:C"], "./ .cvsignore .rsync-filter [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f-C"], "./ .cvsignore .rsync-filter Abc [lit] b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/z.c bar/foo bar/qux.c dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- [a-c]*"], "./ .cvsignore .rsync-filter Abc [lit] dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- [^a-z]*"], "./ a.o b.c bar/ bar/baz.c bar/deep/ bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/file dir1/sub/ dir1/sub/file foo foo.txt x1 x_"),
			(&["-f- *[[:digit:]]"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core foo foo.txt x_"),
			(&["-f- [[:punct:]]*"], "./ Abc a.o b.c bar/ bar/baz.c bar/deep/ bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/file dir1/sub/ dir1/sub/file foo foo.txt x1 x_"),
			(&["--delete-excluded", "-f- *.c"], "./ .cvsignore .rsync-filter Abc [lit] a.o bar/ bar/.rsync-filter bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/foo/x bar/deep/y.o bar/foo core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt x1 x_"),
			(&["--exclude-from=/tmp/flt/xf"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt"),
			(&["--include-from=/tmp/flt/if", "-f- *"], "./ b.c bar/ bar/baz.c bar/deep/ bar/deep/z.c bar/qux.c"),
			(&["-f.- /tmp/flt/xl"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt"),
			(&["-f.+ /tmp/flt/if", "-f- *"], "./ b.c bar/ bar/baz.c bar/deep/ bar/deep/z.c bar/qux.c"),
			(&["-0", "--exclude-from=/tmp/flt/x0"], "./ .cvsignore .rsync-filter Abc [lit] a.o bar/ bar/.rsync-filter bar/deep/ bar/deep/.cvsignore bar/deep/y.o core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo.txt x1 x_"),
			(&["--exclude=- foo", "--exclude=+ x1", "--exclude=x*"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/y.o bar/deep/z.c bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo.txt x1"),
			(&["--include=+ bar", "--include=- x1", "--exclude=x*"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/foo/ bar/deep/y.o bar/deep/z.c bar/foo bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo foo.txt"),
			(&["-f.C /tmp/flt/xl"], "./ .cvsignore .rsync-filter Abc [lit] a.o b.c bar/ bar/.rsync-filter bar/baz.c bar/deep/ bar/deep/.cvsignore bar/deep/y.o bar/deep/z.c bar/qux.c core dir1/ dir1/.rules dir1/file dir1/sub/ dir1/sub/.rules dir1/sub/file foo.txt"),
		];
		for (args, expected) in cases {
			let expected = expected.split_whitespace().collect::<Vec<_>>().join(" ");
			let got = local_list(args).unwrap_or_else(|e| panic!("{args:?}: {e}"));
			assert_eq!(got, expected, "rules {args:?}");
		}
	}

	#[test]
	fn rule_file_line_handling() {
		// Outputs of rsync 3.5.1 over the fixture. fw2 is word-split into "-_foo",
		// "+_bar", "-_*".
		assert_eq!(local_list(&["-f.w fw2"]).unwrap(), "./ bar/");
		// CR, LF, and CRLF all end a line.
		let got = local_list(&["--exclude-from=fcr"]).unwrap();
		assert_eq!(
			got,
			"./ .cvsignore .rsync-filter Abc [lit] a.o b.c core dir1/ dir1/.rules dir1/file \
			 dir1/sub/ dir1/sub/.rules dir1/sub/file foo.txt x1 x_"
		);
		let mut f = Filters::new(FilterConfig::default());
		f.add(RuleArg::ExcludeFrom(Path::new("fcr")), &op_files).unwrap();
		assert_eq!(f.rule_texts(), vec![b"- foo".to_vec(), b"- bar".to_vec(), b"- baz".to_vec()]);
	}

	fn parse_err(rule: &str) -> RsyncError {
		let mut f = Filters::new(FilterConfig::default());
		apply(&mut f, rule).expect_err(rule)
	}

	fn assert_err(err: &RsyncError, code: i32, message: &str, site: (&str, u32)) {
		assert_eq!(err.code, code, "{message}");
		assert_eq!(err.message.as_deref(), Some(message));
		assert_eq!(err.site.map(|(f, l)| (f.to_owned(), l)), Some((site.0.to_owned(), site.1)));
	}

	/// Messages and exit sites printed by rsync 3.5.1 for each malformed rule.
	#[test]
	fn malformed_rules_report_upstream_errors() {
		let cases: &[(&str, &str, u32)] = &[
			("x foo", "Unknown filter rule: x foo", 136),
			("-z foo", "invalid modifier 'z' at position 1 in filter rule: -z foo", 1379),
			("- ", "unexpected end of filter rule: - ", 136),
			("-", "unexpected end of filter rule: -", 136),
			("!x", "'!' rule has trailing characters: !x", 136),
			("clear x", "'!' rule has trailing characters: clear x", 136),
			("-e foo", "invalid modifier 'e' at position 1 in filter rule: -e foo", 1379),
			("+n foo", "invalid modifier 'n' at position 1 in filter rule: +n foo", 1379),
			(".! foo", "invalid modifier '!' at position 1 in filter rule: .! foo", 1379),
			("Hs foo", "invalid modifier 's' at position 1 in filter rule: Hs foo", 1379),
			("H", "unexpected end of filter rule: H", 136),
			("P,r foo", "invalid modifier 'r' at position 2 in filter rule: P,r foo", 1379),
			(":-C", "invalid modifier 'C' at position 2 in filter rule: :-C", 1379),
			("excludefoo", "Unknown filter rule: excludefoo", 136),
			("exclude", "unexpected end of filter rule: exclude", 136),
			("exclude,foo", "invalid modifier 'f' at position 8 in filter rule: exclude,foo", 1379),
			("dir-merge,w", "unexpected end of filter rule: dir-merge,w", 136),
			("-x,foo", "invalid modifier ',' at position 2 in filter rule: -x,foo", 1379),
		];
		for (rule, message, line) in cases {
			let err = parse_err(&format!("-f{rule}"));
			assert_err(&err, RERR_SYNTAX, message, ("exclude.c", *line));
		}
		for ok in ["!", "clear", ":s foo", "-C", "+C", "-C foo", ":C", "-sr foo", "-,s foo"] {
			let mut f = Filters::new(FilterConfig::default());
			apply(&mut f, &format!("-f{ok}")).unwrap_or_else(|e| panic!("{ok}: {e}"));
		}
	}

	/// 3.5.0+: a bad rule read from a file is reported by location, never by content.
	#[test]
	fn file_rule_errors_hide_contents() {
		let cases: &[(&str, i32, &str, (&str, u32))] = &[
			("-f. f1", RERR_SYNTAX, "Unknown filter rule: <rule from f1 line 3>", ("exclude.c", 136)),
			("-f. f2", RERR_SYNTAX, "invalid modifier in filter rule: <rule from f2 line 2>", ("exclude.c", 1379)),
			("-f. f3", RERR_SYNTAX, "'!' rule has trailing characters: <rule from f3 line 1>", ("exclude.c", 136)),
			("-f. f4", RERR_SYNTAX, "unexpected end of filter rule: <rule from f4 line 1>", ("exclude.c", 136)),
			(
				"-f. f5",
				RERR_SYNTAX,
				"invalid modifier in filter rule: <rule from a file named at f5 line 1>",
				("exclude.c", 1379),
			),
			("-f.w fw", RERR_SYNTAX, "unexpected end of filter rule: <rule from fw>", ("exclude.c", 136)),
			("-f. f8", RERR_FILEIO, "failed to open exclude file <rule from f8 line 2>", ("exclude.c", 1719)),
			(
				"--exclude-from=/nonexist",
				RERR_FILEIO,
				"rsync: [client] failed to open exclude file /nonexist: No such file or directory (2)",
				("exclude.c", 1719),
			),
			(
				"--include-from=/nonexist",
				RERR_FILEIO,
				"rsync: [client] failed to open include file /nonexist: No such file or directory (2)",
				("exclude.c", 1719),
			),
			(
				"-f. /tmp/flt/xl",
				RERR_SYNTAX,
				"Unknown filter rule: <rule from /tmp/flt/xl line 4>",
				("exclude.c", 136),
			),
		];
		for (arg, code, message, site) in cases {
			assert_err(&parse_err(arg), *code, message, *site);
		}
	}

	#[test]
	fn per_dir_file_errors_name_the_file() {
		let read = |p: &[u8]| -> io::Result<Option<Vec<u8>>> {
			Ok((p == b"f6").then(|| b"- a\n-z foo\n".to_vec()))
		};
		let mut f = Filters::new(FilterConfig { am_sender: true, ..FilterConfig::default() });
		f.add(RuleArg::Filter(b": f6"), &op_files).unwrap();
		f.set_curr_dir(b"/private/tmp/flt/src");
		let err = f.enter_dir(b"", &read).expect_err("bad per-dir rule");
		let msg = "invalid modifier in filter rule: <rule from /private/tmp/flt/src/f6 line 2>";
		assert_err(&err, RERR_SYNTAX, msg, ("exclude.c", 1379));
	}

	#[test]
	fn merge_depth_is_limited() {
		let looping = |_: &Path| -> io::Result<Vec<u8>> { Ok(b". loop\n".to_vec()) };
		let mut f = Filters::new(FilterConfig::default());
		let err = f.add(RuleArg::Filter(b". loop"), &looping).expect_err("endless merge");
		assert_eq!(err.code, RERR_FILEIO);
		// rsync 3.5.1 with a file "loop" containing ". loop".
		let expected = format!(
			"[client] merge-file include depth limit (32) exceeded at <rule from {}loop line 1>",
			"a file named at ".repeat(31)
		);
		assert_eq!(err.message.as_deref(), Some(expected.as_str()));
		assert_eq!(err.site, Some(("exclude.c", 1626)));
	}

	#[test]
	fn match_messages() {
		let mut f = Filters::new(FilterConfig { am_sender: true, ..FilterConfig::default() });
		f.add(RuleArg::Filter(b"- a.o"), &op_files).unwrap();
		f.add(RuleArg::Filter(b"-! */"), &op_files).unwrap();
		f.add(RuleArg::Filter(b": .rf"), &op_files).unwrap();
		f.set_curr_dir(b"/private/tmp/flt/src");
		let read = |p: &[u8]| -> io::Result<Option<Vec<u8>>> {
			Ok((p == b".rf").then(|| b"- x\n- d/\n".to_vec()))
		};
		// Texts rsync 3.5.1 printed for these rules at --debug=FILTER.
		let mark = f.enter_dir(b"", &read).unwrap();
		let m = f.find_match(b"a.o", NameKind::File, Side::Sender, false).unwrap();
		assert_eq!(
			m.message(Role::Sender, b"a.o", NameKind::File),
			b"[sender] hiding file a.o because of pattern a.o\n"
		);
		let m = f.find_match(b"b", NameKind::File, Side::Sender, false).unwrap();
		assert_eq!(
			m.message(Role::Sender, b"b", NameKind::File),
			b"[sender] hiding file b because of pattern */\n"
		);
		let m = f.find_match(b"d", NameKind::Dir, Side::Sender, false).unwrap();
		assert_eq!(
			m.message(Role::Sender, b"d", NameKind::Dir),
			b"[sender] hiding directory d because of pattern <rule from a file read earlier> [per-dir .rf]\n".to_vec()
		);
		f.leave_dir(mark);
		assert_eq!(f.find_match(b"d", NameKind::Dir, Side::Sender, false), None);
		let protect = FilterMatch { verdict: Verdict::Exclude, pattern: b"b".to_vec(), list_type: Vec::new() };
		assert_eq!(
			protect.message(Role::Generator, b"b", NameKind::File),
			b"[generator] protecting file b because of pattern b\n"
		);
		let risk = FilterMatch { verdict: Verdict::Include, pattern: b"/s/".to_vec(), list_type: IMPLIED_TYPE.to_vec() };
		assert_eq!(
			risk.message(Role::Receiver, b"s", NameKind::Dir),
			b"[receiver] showing directory s because of pattern /s/ [implied]\n"
		);
	}

	#[test]
	fn script_lines_match_reference_batch_script() {
		// rsync 3.5.1 --write-batch: the here-doc of the generated .sh file.
		let mut f = Filters::new(FilterConfig::default());
		for rule in [
			"-f- *.o",
			"-f+ foo/",
			"-fH bar",
			"-fP baz",
			"-f-/p! x*",
			"-f:n- .ex",
			"-fexclude,x user.foo",
			"-C",
		] {
			apply(&mut f, rule).unwrap();
		}
		let lines: Vec<String> =
			f.script_lines().iter().map(|l| String::from_utf8_lossy(l).into_owned()).collect();
		assert_eq!(lines, ["- *.o", "+ foo/", "-s bar", "-r baz", "-/!p x*", ":n- .ex", "-x user.foo"]);
	}

	#[test]
	fn sides_follow_the_exchange() {
		let cfg = FilterConfig { delete_mode: true, ..FilterConfig::default() };
		let mut f = Filters::new(cfg);
		for rule in ["-fP keep", "-fH hide", "-f- both", "-fR risky", "-fS shown"] {
			apply(&mut f, rule).unwrap();
		}
		f.send(&mut io::sink(), Proto::new(33, 0), false).unwrap();
		assert_eq!(f.check(b"keep", false, Side::Sender), Verdict::NoMatch);
		assert_eq!(f.check(b"keep", false, Side::Receiver), Verdict::Exclude);
		assert_eq!(f.check(b"hide", false, Side::Sender), Verdict::Exclude);
		assert_eq!(f.check(b"hide", false, Side::Receiver), Verdict::NoMatch);
		assert_eq!(f.check(b"both", false, Side::Sender), Verdict::Exclude);
		assert_eq!(f.check(b"both", false, Side::Receiver), Verdict::Exclude);
		assert_eq!(f.check(b"risky", false, Side::Receiver), Verdict::Include);
		assert_eq!(f.check(b"shown", false, Side::Sender), Verdict::Include);

		// A receiving client: hide/show rules are for the remote sender only.
		let mut f = Filters::new(FilterConfig { delete_mode: true, ..FilterConfig::default() });
		for rule in ["-fP keep", "-fH hide", "--delete-excluded", "-f- gone"] {
			apply(&mut f, rule).unwrap();
		}
		f.send(&mut io::sink(), Proto::new(33, 0), true).unwrap();
		assert_eq!(f.check(b"keep", false, Side::Receiver), Verdict::Exclude);
		assert_eq!(f.check(b"hide", false, Side::Receiver), Verdict::NoMatch);
		assert_eq!(f.check(b"hide", false, Side::Sender), Verdict::Exclude);
		// --delete-excluded: excluded files are not protected from deletion.
		assert_eq!(f.check(b"gone", false, Side::Receiver), Verdict::NoMatch);
		assert_eq!(f.check(b"gone", false, Side::Sender), Verdict::Exclude);
	}

	#[test]
	fn perishable_rules_ignored_in_doomed_dirs() {
		let mut f = Filters::new(FilterConfig { delete_mode: true, ..FilterConfig::default() });
		apply(&mut f, "-f-p *.o").unwrap();
		apply(&mut f, "-f- *.keep").unwrap();
		f.send(&mut io::sink(), Proto::new(33, 0), true).unwrap();
		assert_eq!(f.check_full(b"x.o", NameKind::File, Side::Receiver, false), Verdict::Exclude);
		assert_eq!(f.check_full(b"x.o", NameKind::File, Side::Receiver, true), Verdict::NoMatch);
		assert_eq!(f.check_full(b"x.keep", NameKind::File, Side::Receiver, true), Verdict::Exclude);

		// -C defaults are perishable from protocol 30 on.
		for (version, expected) in [(33, Verdict::NoMatch), (29, Verdict::Exclude)] {
			let cfg = FilterConfig { cvs_exclude: true, local_server: true, ..FilterConfig::default() };
			let mut f = Filters::new(cfg);
			f.send(&mut io::sink(), Proto::new(version, 0), true).unwrap();
			assert_eq!(f.check_full(b"a.o", NameKind::File, Side::Receiver, true), expected);
			assert_eq!(f.check_full(b"a.o", NameKind::File, Side::Receiver, false), Verdict::Exclude);
		}
	}

	#[test]
	fn xattr_rules_only_match_xattr_names() {
		let mut f = Filters::new(FilterConfig { am_sender: true, ..FilterConfig::default() });
		apply(&mut f, "-f-x user.secret").unwrap();
		assert!(f.has_xattr_rules());
		assert!(f.xattr_excluded(b"user.secret"));
		assert!(!f.xattr_excluded(b"user.other"));
		assert_eq!(f.check(b"user.secret", false, Side::Sender), Verdict::NoMatch);
	}

	fn wire(rules: &[&str]) -> Vec<u8> {
		let mut out = Vec::new();
		for rule in rules {
			out.extend_from_slice(&(rule.len() as i32).to_le_bytes());
			out.extend_from_slice(rule.as_bytes());
		}
		out.extend_from_slice(&0i32.to_le_bytes());
		out
	}

	fn send_bytes(cfg: FilterConfig, args: &[&str], version: u32, receiver_side: bool) -> Result<Vec<u8>, RsyncError> {
		let mut f = Filters::new(cfg);
		for arg in args {
			apply(&mut f, arg)?;
		}
		let mut out = Vec::new();
		f.send(&mut out, Proto::new(version, 0), receiver_side)?;
		Ok(out)
	}

	fn cvs_defaults(prefix: &str) -> Vec<String> {
		DEFAULT_CVSIGNORE
			.split(|&b| b == b' ')
			.map(|w| format!("{prefix}{}", String::from_utf8_lossy(w)))
			.collect()
	}

	/// Byte streams captured from rsync 3.5.1 clients through an `-e` wrapper.
	#[test]
	fn send_matches_reference_bytes() {
		let delete = FilterConfig { delete_mode: true, ..FilterConfig::default() };
		let plain = FilterConfig::default();

		// rsync -r -f'- *.o' -f'+ foo/' -f'H bar' -f'P baz' -f'-/p! x*' -f':n- .ex'
		//   -f'exclude,x user.foo' --delete host:src/ dst/
		let golden = b"\x05\x00\x00\x00- *.o\x06\x00\x00\x00+ foo/\x06\x00\x00\x00-s bar\
			\x07\x00\x00\x00-/!p x*\x07\x00\x00\x00:n- .ex\x0b\x00\x00\x00-x user.foo\x00\x00\x00\x00";
		let args = ["-f- *.o", "-f+ foo/", "-fH bar", "-fP baz", "-f-/p! x*", "-f:n- .ex", "-fexclude,x user.foo"];
		assert_eq!(send_bytes(delete.clone(), &args, 33, true).unwrap(), golden.to_vec());

		let mixed = ["-f- *.o", "-fH bar", "-fP baz", "-fR qq", "-fS ss"];
		// Push without a delete mode: the receiver gets no rules at all.
		assert_eq!(send_bytes(plain.clone(), &mixed, 33, false).unwrap(), b"");
		// Push with --delete: receiver-relevant rules.
		assert_eq!(
			send_bytes(delete.clone(), &mixed, 33, false).unwrap(),
			wire(&["- *.o", "-r baz", "+r qq"])
		);
		// --delete-excluded after the rules: unsided rules become sender-only at send time.
		let mut late = mixed.to_vec();
		late.push("--delete-excluded");
		assert_eq!(send_bytes(delete.clone(), &late, 33, false).unwrap(), wire(&["-r baz", "+r qq"]));
		// Pulling: the unsided rule parsed before --delete-excluded keeps no side.
		assert_eq!(send_bytes(plain.clone(), &late, 33, true).unwrap(), wire(&["- *.o", "-s bar", "+s ss"]));
		// --delete-excluded before the rules marks them sender-side as they are parsed.
		let early = ["--delete-excluded", "-f- *.o", "-f:n- .ex", "-f: .rr"];
		assert_eq!(send_bytes(plain.clone(), &early, 33, true).unwrap(), wire(&["-s *.o", ":n- .ex", ": .rr"]));

		// -C on a pushing client: the .cvsignore dir-merge and the CVS list travel.
		let mut expected = vec!["- *.o".to_owned(), ":C .cvsignore".to_owned()];
		expected.extend(cvs_defaults("-p "));
		let expected: Vec<&str> = expected.iter().map(String::as_str).collect();
		assert_eq!(send_bytes(delete.clone(), &["-C", "-f- *.o"], 33, false).unwrap(), wire(&expected));
		// -C on a pulling client: the server applies -C itself.
		assert_eq!(send_bytes(plain.clone(), &["-C", "-f- *.o"], 33, true).unwrap(), wire(&["- *.o"]));
		// Protocol 29: no perishable modifier.
		assert_eq!(
			send_bytes(plain.clone(), &["-C", "-f- *.o", "-f-p foo"], 29, true).unwrap(),
			wire(&["- *.o", "- foo"])
		);
		let mut expected = vec![":C .cvsignore".to_owned()];
		expected.extend(cvs_defaults("- "));
		let expected: Vec<&str> = expected.iter().map(String::as_str).collect();
		assert_eq!(send_bytes(delete.clone(), &["-C"], 29, false).unwrap(), wire(&expected));
		assert_eq!(
			send_bytes(delete.clone(), &["-f-p foo", "-f- bar/"], 30, false).unwrap(),
			wire(&["-p foo", "- bar/"])
		);
		assert_eq!(
			send_bytes(delete.clone(), &["-f-p foo", "-fH x", "-fS y"], 29, true).unwrap(),
			wire(&["- foo", "-s x", "+s y"])
		);
		// Merge files are expanded; -C rules travel as text to a newer server.
		let args = ["-f:e .rsync-filter", "-f. /tmp/flt/xm", "-f-C", "-f+/C", "-f-! a/", "-f+ b c"];
		assert_eq!(
			send_bytes(plain.clone(), &args, 33, true).unwrap(),
			wire(&["- .rsync-filter", ": .rsync-filter", "- foo", "+ x1", "-C ", "+/C ", "-! a/", "+ b c"])
		);
		let args = ["-fmerge,-w /tmp/flt/xm", "-fdir-merge,+nw .x", "-f:s .y", "-f-x foo"];
		assert_eq!(
			send_bytes(plain.clone(), &args, 33, true).unwrap(),
			wire(&["- -", "- foo", "- +", "- x1", ":nw+ .x", ":s .y", "-x foo"])
		);
		// Local transfers exchange nothing.
		let local = FilterConfig { local_server: true, delete_mode: true, ..FilterConfig::default() };
		assert_eq!(send_bytes(local, &mixed, 33, true).unwrap(), b"");
	}

	#[test]
	fn send_rejects_rules_an_old_peer_cannot_express() {
		let delete = FilterConfig { delete_mode: true, ..FilterConfig::default() };
		let err = send_bytes(delete, &["-f-p foo"], 29, false).expect_err("too modern");
		assert_err(&err, RERR_PROTOCOL, "filter rules are too modern for remote rsync.", ("exclude.c", 1926));
	}

	fn server(am_sender: bool, delete_mode: bool) -> Filters {
		Filters::new(FilterConfig {
			am_sender,
			am_server: true,
			delete_mode,
			role: if am_sender { Role::Sender } else { Role::Receiver },
			..FilterConfig::default()
		})
	}

	#[test]
	fn recv_round_trips_sent_rules() {
		let rules = ["- *.o", "+ foo/", "-s bar", "-/!p x*", ":n- .ex", "-x user.foo"];
		for version in 29..=33 {
			let mut f = server(true, false);
			f.recv(&mut &wire(&rules)[..], Proto::new(version, 0)).unwrap();
			let texts: Vec<Vec<u8>> = rules.iter().map(|r| r.as_bytes().to_vec()).collect();
			assert_eq!(f.rule_texts(), texts, "protocol {version}");
			assert_eq!(f.check(b"a.o", false, Side::Sender), Verdict::Exclude);
			assert_eq!(f.check(b"foo", true, Side::Sender), Verdict::Include);
			assert_eq!(f.check(b"bar", false, Side::Sender), Verdict::Exclude);
			// "-/!p x*" excludes every name that does not start with x.
			assert_eq!(f.check(b"zzz", false, Side::Sender), Verdict::Exclude);
			assert_eq!(f.check(b"xyz", false, Side::Sender), Verdict::NoMatch);
			assert!(f.xattr_excluded(b"user.foo"));
			assert!(f.saw_dir_merge());
		}
		// What a pushing client sends with -C reaches a receiver intact.
		let mut sent = Filters::new(FilterConfig { delete_mode: true, ..FilterConfig::default() });
		apply(&mut sent, "-C").unwrap();
		let mut bytes = Vec::new();
		sent.send(&mut bytes, Proto::new(33, 0), false).unwrap();
		let mut f = server(false, true);
		f.recv(&mut &bytes[..], Proto::new(33, 0)).unwrap();
		assert_eq!(f.rule_texts().len(), 1 + DEFAULT_CVSIGNORE.split(|&b| b == b' ').count());
		assert_eq!(f.check(b"x.o", false, Side::Receiver), Verdict::Exclude);
	}

	#[test]
	fn recv_applies_cvs_exclude_and_skips_unused_lists() {
		let mut f = server(true, false);
		f.cfg.cvs_exclude = true;
		f.recv(&mut &wire(&["- a"])[..], Proto::new(33, 0)).unwrap();
		assert_eq!(f.rule_texts(), vec![b"- a".to_vec(), b":C .cvsignore".to_vec(), b"-C ".to_vec()]);
		assert_eq!(f.check(b"core", false, Side::Sender), Verdict::Exclude);

		// A receiver with no delete mode reads nothing.
		let mut f = server(false, false);
		let mut empty: &[u8] = b"";
		f.recv(&mut empty, Proto::new(33, 0)).unwrap();
		assert!(f.is_empty());
	}

	#[test]
	fn recv_validates_peer_data() {
		let mut f = server(true, false);
		let err = f.recv(&mut &5120i32.to_le_bytes()[..], Proto::new(33, 0)).expect_err("overflow");
		assert_err(
			&err,
			RERR_MALLOC,
			"[sender] buffer overflow: recv_rules (file=exclude.c, line=1982)",
			("util2.c", 129),
		);
		let mut f = server(true, false);
		assert!(f.recv(&mut &(-1i32).to_le_bytes()[..], Proto::new(33, 0)).is_err());
		let mut f = server(true, false);
		assert!(f.recv(&mut &b"\x05\x00\x00\x00- a"[..], Proto::new(33, 0)).is_err());
		let mut f = server(true, false);
		let err = f.recv(&mut &wire(&["x foo"])[..], Proto::new(33, 0)).expect_err("bad rule");
		assert_err(&err, RERR_SYNTAX, "Unknown filter rule: x foo", ("exclude.c", 136));
		// Peer text is cut at an embedded NUL like a C string.
		let mut f = server(true, false);
		f.recv(&mut &wire(&["- a\0junk"])[..], Proto::new(33, 0)).unwrap();
		assert_eq!(f.rule_texts(), vec![b"- a".to_vec()]);
		// Below protocol 29 rules arrive in the old "+ "/"- " form.
		let mut f = server(true, false);
		f.recv(&mut &wire(&["+ keep", "keep*"])[..], Proto::new(28, 0)).unwrap();
		assert_eq!(f.check(b"keep", false, Side::Sender), Verdict::Include);
		assert_eq!(f.check(b"keeper", false, Side::Sender), Verdict::Exclude);
	}

	#[test]
	fn parent_dirscan_and_anchoring() {
		let mut f = Filters::new(FilterConfig { am_sender: true, ..FilterConfig::default() });
		apply(&mut f, "-F").unwrap();
		f.set_curr_dir(CURR.as_bytes());
		let root = f.enter_dir(b"", &tree_reader).unwrap();
		// From /private/tmp/flt/fx/.rsync-filter.
		assert_eq!(f.check(b"x1", false, Side::Sender), Verdict::Exclude);
		// "/core" there is anchored to fx/, not to the transfer root.
		assert_eq!(f.check(b"core", false, Side::Sender), Verdict::NoMatch);
		let bar = f.enter_dir(b"bar", &tree_reader).unwrap();
		assert_eq!(f.check(b"bar/baz.c", false, Side::Sender), Verdict::Exclude);
		assert_eq!(f.check(b"bar/deep/baz.c", false, Side::Sender), Verdict::NoMatch);
		assert_eq!(f.check(b"bar/deep/y.o", false, Side::Sender), Verdict::Include);
		f.leave_dir(bar);
		assert_eq!(f.check(b"bar/deep/y.o", false, Side::Sender), Verdict::NoMatch);
		assert_eq!(f.check(b"foo.txt", false, Side::Sender), Verdict::Exclude);
		f.leave_dir(root);
		assert_eq!(f.check(b"foo.txt", false, Side::Sender), Verdict::NoMatch);
	}

	#[test]
	fn per_dir_rules_drop_the_other_side() {
		let read = |p: &[u8]| -> io::Result<Option<Vec<u8>>> {
			Ok((p == b".rf").then(|| b"P keep\nH hide\n- both\n".to_vec()))
		};
		for (am_sender, keep, hide) in
			[(true, Verdict::NoMatch, Verdict::Exclude), (false, Verdict::Exclude, Verdict::NoMatch)]
		{
			let mut f = Filters::new(FilterConfig { am_sender, ..FilterConfig::default() });
			apply(&mut f, "-f: .rf").unwrap();
			let mark = f.enter_dir(b"", &read).unwrap();
			let side = if am_sender { Side::Sender } else { Side::Receiver };
			assert_eq!(f.check(b"keep", false, side), keep);
			assert_eq!(f.check(b"hide", false, side), hide);
			assert_eq!(f.check(b"both", false, side), Verdict::Exclude);
			f.leave_dir(mark);
		}
	}

	#[test]
	fn nested_dir_merge_lives_with_its_directory() {
		let read = |p: &[u8]| -> io::Result<Option<Vec<u8>>> {
			Ok(match p {
				b"d/.a" => Some(b": .b\n".to_vec()),
				b"d/.b" | b"d/e/.b" => Some(b"- tmp\n".to_vec()),
				b".b" => Some(b"- nope\n".to_vec()),
				_ => None,
			})
		};
		let mut f = Filters::new(FilterConfig { am_sender: true, ..FilterConfig::default() });
		apply(&mut f, "-f: .a").unwrap();
		let root = f.enter_dir(b"", &read).unwrap();
		assert_eq!(f.check(b"nope", false, Side::Sender), Verdict::NoMatch);
		let d = f.enter_dir(b"d", &read).unwrap();
		assert_eq!(f.check(b"d/tmp", false, Side::Sender), Verdict::Exclude);
		let e = f.enter_dir(b"d/e", &read).unwrap();
		assert_eq!(f.check(b"d/e/tmp", false, Side::Sender), Verdict::Exclude);
		f.leave_dir(e);
		f.leave_dir(d);
		assert_eq!(f.slots.len(), 1);
		assert_eq!(f.check(b"tmp", false, Side::Sender), Verdict::NoMatch);
		f.leave_dir(root);
	}

	#[test]
	fn change_dir_tracks_depth() {
		let read = |p: &[u8]| -> io::Result<Option<Vec<u8>>> {
			Ok((p == b"a/.rf").then(|| b"- x\n".to_vec()))
		};
		let mut f = Filters::new(FilterConfig { am_sender: true, ..FilterConfig::default() });
		apply(&mut f, "-f: .rf").unwrap();
		f.change_dir(Some(b"a"), 1, &read).unwrap();
		assert_eq!(f.check(b"a/x", false, Side::Sender), Verdict::Exclude);
		f.change_dir(Some(b"b"), 1, &read).unwrap();
		assert_eq!(f.check(b"b/x", false, Side::Sender), Verdict::NoMatch);
		f.change_dir(None, 0, &read).unwrap();
		assert!(f.depth_marks.is_empty());
	}

	#[test]
	fn implied_includes_match_reference_patterns() {
		fn patterns(f: &ImpliedFilters) -> Vec<String> {
			f.rules.iter().map(|r| String::from_utf8_lossy(&r.pattern).into_owned()).collect()
		}
		// Patterns logged by rsync 3.5.1 at --debug=FILTER3 for each pulled argument.
		let mut f = ImpliedFilters::new(false, true, true);
		f.add(b"/tmp/flt/w/s/sub/deep/f", false);
		assert_eq!(patterns(&f), ["/f", "/f/**"]);
		assert_eq!(f.check(b"f", false), Verdict::Include);
		assert_eq!(f.check(b"f/x/y", false), Verdict::Include);
		assert_eq!(f.check(b"g", false), Verdict::NoMatch);

		let mut f = ImpliedFilters::new(true, true, true);
		f.add(b"/tmp/flt/w/./s/sub/deep/f", false);
		assert_eq!(patterns(&f), ["/s/sub/deep/f", "/s/sub/deep", "/s/sub", "/s", "/s/sub/deep/f/**"]);
		assert_eq!(f.check(b"s", true), Verdict::Include);
		assert_eq!(f.check(b"s", false), Verdict::NoMatch);
		assert_eq!(f.check(b"s/other", false), Verdict::NoMatch);
		assert!(f.is_implied_parent_dir(b"s/sub"));
		assert!(!f.is_implied_parent_dir(b"s/sub/deep/f"));
		assert!(f.is_implied_parent_dir(b"."));

		let mut f = ImpliedFilters::new(true, true, true);
		f.add(b"/tmp/flt/w/./s//sub/./deep/", false);
		assert_eq!(patterns(&f), ["/s/sub/deep", "/s/sub", "/s", "/s/sub/deep/**"]);

		let mut f = ImpliedFilters::new(false, true, true);
		f.add(b"/tmp/flt/w/s/", false);
		assert_eq!(patterns(&f), ["/**"]);
		assert!(!f.is_implied_parent_dir(b"."));
		assert_eq!(f.check(b"sub/deep/f", false), Verdict::Include);

		let mut f = ImpliedFilters::new(false, true, true);
		f.add(b"/tmp/flt/w/x[ab]", false);
		assert_eq!(patterns(&f), ["/x[ab]", "/x\\[ab]", "/x[ab]/**", "/x\\[ab]/**"]);
		assert_eq!(f.check(b"x[ab]", true), Verdict::Include);
		assert_eq!(f.check(b"xa", false), Verdict::Include);

		let mut f = ImpliedFilters::new(false, false, true);
		f.add(b"/tmp/flt/w/s/sub", false);
		assert_eq!(patterns(&f), ["/sub", "/sub/*"]);
		assert_eq!(f.check(b"sub/x/y", false), Verdict::NoMatch);

		let mut f = ImpliedFilters::new(false, true, true);
		f.add(b"/tmp/flt/w/a\\b", false);
		assert_eq!(patterns(&f), ["/a\\b", "/a\\\\b/**"]);
		assert_eq!(f.check(b"a\\b", false), Verdict::Include);
		assert_eq!(f.check(b"a\\b/c", false), Verdict::Include);

		let mut f = ImpliedFilters::new(false, true, true);
		f.add(b"module/dir/file", true);
		assert_eq!(patterns(&f), ["/file", "/file/**"]);
	}
}
