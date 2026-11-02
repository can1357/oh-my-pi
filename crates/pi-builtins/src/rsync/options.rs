//! rsync's command line: popt-compatible scanning, implications, validation,
//! environment defaults, and the argv the client sends to `rsync --server`.
//!
//! [`Options`] holds one field per upstream option variable with upstream's
//! value conventions (tri-states stay `i32` where `-1` means "not set"), so the
//! rest of the builtin can reason about options exactly as rsync 3.5.1 does.
//! [`parse`] handles both a client command line and the argv a server gets
//! (`--server [--sender] -<letters>e.<caps> … . paths`).

mod table;

use std::ffi::{OsStr, OsString};
use std::borrow::Cow;

use crate::host::os_bytes_lossy;
use crate::rsync::{cstr::atol, time::unix_now};
use crate::rsync::chmod::ChmodRules;
use crate::rsync::consts::{
	COMPARE_DEST, COPY_DEST, LINK_DEST, MAX_BLOCK_SIZE, MAXPATHLEN, OLD_MAX_BLOCK_SIZE,
};
use crate::rsync::exit::{RERR_SYNTAX, RERR_UNSUPPORTED, RsyncError};
use crate::rsync::log::{OutLevels, Priority, Words, strerror};
use crate::rsync::paths::vec_os_lossy;
use crate::rsync::transport::{FileArgRules, escape_shell_arg, safe_file_arg};
use crate::rsync::usage::help_text;

/// Upstream `MAX_BASIS_DIRS`.
pub(crate) const MAX_BASIS_DIRS: usize = 20;
/// Upstream `DEFAULT_MAX_ALLOC` (1 GiB).
pub(crate) const DEFAULT_MAX_ALLOC: u64 = 1024 * 1024 * 1024;
/// Largest size `parse_size_arg` accepts (upstream `SIZE_ARG_MAX` on 64-bit).
pub(crate) const SIZE_ARG_MAX: i64 = i64::MAX;
/// `do_compression` values (upstream `CPRES_*`).
pub(crate) const CPRES_AUTO: i32 = -1;
/// No compression.
pub(crate) const CPRES_NONE: i32 = 0;
/// zlib (old-style, `-z`).
pub(crate) const CPRES_ZLIB: i32 = 1;
/// zlibx (`-zz`, `--new-compress`).
pub(crate) const CPRES_ZLIBX: i32 = 2;
/// Default backup suffix (upstream `BACKUP_SUFFIX`).
pub(crate) const BACKUP_SUFFIX: &str = "~";
/// The partial dir `--delay-updates` implies (upstream `tmp_partialdir`).
pub(crate) const TMP_PARTIAL_DIR: &str = ".~tmp~";
/// Longest `--write-batch`/`--read-batch` name (upstream `MAX_BATCH_NAME_LEN`).
const MAX_BATCH_NAME_LEN: usize = 256;
/// Upstream `MAX_DAEMON_COMPRESSION_THREADS`.
const MAX_DAEMON_COMPRESSION_THREADS: i32 = 8;
/// Upstream's option error buffer (`err_buf[200]`): messages are cut to fit.
const ERR_BUF: usize = 200;

/// Every rsync option, after popt-style parsing, implications, and validation.
///
/// Field names follow upstream's variables; values follow upstream's
/// conventions (documented per field). `Default` is upstream's initial state.
#[derive(Clone, Debug)]
pub(crate) struct Options {
	/// Operands left after option parsing (client: sources + dest; server: `.` + paths).
	pub args: Vec<std::ffi::OsString>,
	/// `--info`/`--debug` levels with `-v`, `--stats`, `--progress` implications applied.
	pub levels: OutLevels,

	// ---- roles ----
	/// `--server`: we are the remote half.
	pub am_server: bool,
	/// `--sender` (server only): we send files.
	pub am_sender: bool,
	/// A daemon option was used and `--daemon` was given (the run fails: unsupported).
	pub am_daemon: bool,
	/// 0 normal user, 1 root, 2 `--super`, -1 `--fake-super` (upstream `am_root`).
	pub am_root: i32,

	// ---- daemon-mode parse results (only meaningful with `am_daemon`) ----
	/// `--config=FILE`.
	pub config_file: Option<OsString>,
	/// `--dparam=OVERRIDE` / `-M` in daemon mode.
	pub dparams: Vec<OsString>,
	/// `--no-detach`.
	pub no_detach: bool,
	/// Daemon-mode `--bwlimit=N`.
	pub daemon_bwlimit: i32,

	// ---- output ----
	/// `-v` count (`--no-v` resets).
	pub verbose: u32,
	/// `-q` count.
	pub quiet: u32,
	/// Upstream `msgs2stderr`: 2 = errors (default), 1 = all (`--msgs2stderr`), 0 = client.
	pub msgs2stderr: u8,
	/// An explicit `--stderr` was given or the mode is not the default.
	pub saw_stderr_opt: bool,
	/// Print the daemon MOTD (`--no-motd` clears).
	pub output_motd: bool,
	/// `--stats`.
	pub do_stats: bool,
	/// `-h` level (default 1; `--no-h` = 0).
	pub human_readable: u32,
	/// `--progress` / `-P`.
	pub do_progress: bool,
	/// `-i` count.
	pub itemize_changes: u32,
	/// `--out-format` (or the format implied by `-i` / `-v`).
	pub stdout_format: Option<Vec<u8>>,
	/// 0, `itemize_changes | 1` when the format has `%i`, 2 for a server `%I`.
	pub stdout_format_has_i: u32,
	/// The stdout format has `%i` or `%o`.
	pub stdout_format_has_o_or_i: bool,
	/// Log names before the transfer (no `%b`/`%c`/`%C` in the format).
	pub log_before_transfer: bool,
	/// `--log-file=FILE`.
	pub logfile_name: Option<OsString>,
	/// `--log-file-format=FMT` (defaults to `%i %n%L` with `--log-file`).
	pub logfile_format: Option<Vec<u8>>,
	/// The log-file format has `%i`.
	pub logfile_format_has_i: bool,
	/// The log-file format has `%i` or `%o`.
	pub logfile_format_has_o_or_i: bool,
	/// `-8`.
	pub allow_8bit_chars: bool,
	/// Raw `--outbuf=MODE`.
	pub outbuf_mode: Option<OsString>,
	/// Validated `--outbuf` (client only).
	pub outbuf: Option<OutBuf>,
	/// Informational lines upstream prints (FINFO) while parsing, e.g. ignored batch options.
	pub notices: Vec<String>,

	// ---- what to transfer ----
	/// `-n`.
	pub dry_run: bool,
	/// False under `--dry-run` (upstream `do_xfers`).
	pub do_xfers: bool,
	/// 0 off, 1 implied by `-a`, 2 explicit `-r`.
	pub recurse: u8,
	/// Incremental recursion permitted (`--no-i-r` clears).
	pub allow_inc_recurse: bool,
	/// -1 unset, 0 off, 1 on, 2 explicit `-d`, 4 `--old-dirs` (finalized to 0/1/2).
	pub xfer_dirs: i32,
	/// `--list-only`: 2 explicit, 1 implied by a missing destination.
	pub list_only: u8,
	/// `-R`: -1 unset (finalized to 0/1).
	pub relative_paths: i32,
	/// Send implied directories with `-R` (cleared when not relative).
	pub implied_dirs: bool,
	/// `-x` count.
	pub one_file_system: u32,
	/// `--files-from=FILE` (host part stripped when remote).
	pub files_from: Option<OsString>,
	/// Host of a remote `--files-from` ("" = the remote side / the socket on a server).
	pub filesfrom_host: Option<OsString>,
	/// Where this process reads the files-from list.
	pub filesfrom_fd: FilesFromFd,
	/// `-0`.
	pub eol_nulls: bool,
	/// `--ignore-missing-args` (1) / `--delete-missing-args` (2).
	pub missing_args: u8,
	/// `--mkpath`.
	pub mkpath_dest_arg: bool,
	/// `--qsort`.
	pub use_qsort: bool,

	// ---- symlinks / devices ----
	/// `-l`.
	pub preserve_links: bool,
	/// `-L`.
	pub copy_links: bool,
	/// `--copy-unsafe-links`.
	pub copy_unsafe_links: bool,
	/// `--safe-links`.
	pub safe_symlinks: bool,
	/// `--insecure-links`.
	pub insecure_links: bool,
	/// `--munge-links`.
	pub munge_symlinks: bool,
	/// `-k`.
	pub copy_dirlinks: bool,
	/// `-K`.
	pub keep_dirlinks: bool,
	/// `-H` count.
	pub preserve_hard_links: u32,
	/// `--devices` / `-D`.
	pub preserve_devices: bool,
	/// `--specials` / `-D`.
	pub preserve_specials: bool,
	/// `--copy-devices`.
	pub copy_devices: bool,
	/// `--write-devices` (implies `--inplace`).
	pub write_devices: bool,
	/// `--drop-D`.
	pub drop_devices: bool,
	/// `--confine-root=DIR` (normalized absolute path).
	pub confine_root: Option<OsString>,

	// ---- attributes ----
	/// `-p`.
	pub preserve_perms: bool,
	/// `-E`.
	pub preserve_executability: bool,
	/// `-A`.
	pub preserve_acls: bool,
	/// `-X` count.
	pub preserve_xattrs: u32,
	/// `-o`.
	pub preserve_uid: bool,
	/// `-g`.
	pub preserve_gid: bool,
	/// `-t`.
	pub preserve_mtimes: bool,
	/// `-U` count.
	pub preserve_atimes: u32,
	/// `--open-noatime` (also set by `-UU`).
	pub open_noatime: bool,
	/// `-N`.
	pub preserve_crtimes: bool,
	/// 1 = `-O`, -1 = implied by `--backup` without `--backup-dir`.
	pub omit_dir_times: i32,
	/// `-J`.
	pub omit_link_times: bool,
	/// `--modify-window=NUM` / `-@`.
	pub modify_window: i32,
	/// `--modify-window` was given.
	pub modify_window_set: bool,
	/// Raw `--chmod` specs in order.
	pub chmod: Vec<OsString>,
	/// Parsed `--chmod` rules.
	pub chmod_modes: Option<ChmodRules>,
	/// `--numeric-ids`.
	pub numeric_ids: bool,
	/// `--usermap` (or `*:USER` from `--chown`).
	pub usermap: Option<OsString>,
	/// `--groupmap` (or `*:GROUP` from `--chown`).
	pub groupmap: Option<OsString>,
	/// `usermap` came from `--chown`.
	pub usermap_via_chown: bool,
	/// `groupmap` came from `--chown`.
	pub groupmap_via_chown: bool,
	/// `--copy-as=USER[:GROUP]`.
	pub copy_as: Option<OsString>,

	// ---- quick check / deltas ----
	/// `-I`.
	pub ignore_times: bool,
	/// `--size-only`.
	pub size_only: bool,
	/// `-c`.
	pub always_checksum: bool,
	/// `--checksum-choice` (None when unset or "auto").
	pub checksum_choice: Option<OsString>,
	/// `--checksum-seed`.
	pub checksum_seed: i32,
	/// -1 unset, 0 `--no-W`, 1 `-W` (also forced by `--cc=none`).
	pub whole_file: i32,
	/// `-B` (0 = automatic).
	pub block_size: i32,
	/// `-u`.
	pub update_only: bool,
	/// `--existing`.
	pub ignore_non_existing: bool,
	/// `--ignore-existing`.
	pub ignore_existing: bool,
	/// `--max-size` in bytes (-1 unset).
	pub max_size: i64,
	/// `--min-size` in bytes (-1 unset).
	pub min_size: i64,
	/// `--max-size` normalized to plain digits (forwarded to the server).
	pub max_size_arg: Option<String>,
	/// `--min-size` normalized to plain digits.
	pub min_size_arg: Option<String>,
	/// Effective `--max-alloc` in bytes.
	pub max_alloc: u64,
	/// `--max-alloc` / RSYNC_MAX_ALLOC as given (forwarded un-normalized).
	pub max_alloc_arg: Option<OsString>,
	/// `--fuzzy` level (finalized to `basis_dirs.len() + 1` for `-yy`).
	pub fuzzy_basis: u32,
	/// `--compare-dest`/`--copy-dest`/`--link-dest` dirs in order.
	pub basis_dirs: Vec<OsString>,
	/// `COMPARE_DEST`/`COPY_DEST`/`LINK_DEST`, 0 when none.
	pub alt_dest_type: u8,

	// ---- compression ----
	/// `CPRES_*` after finalization; `-z` count before.
	pub do_compression: i32,
	/// `--compress-choice` (normalized: Some("none") when choice resolves to none).
	pub compress_choice: Option<OsString>,
	/// `--compress-level` (None = not specified).
	pub do_compression_level: Option<i32>,
	/// `--compress-threads`.
	pub do_compression_threads: i32,
	/// `--skip-compress=LIST`.
	pub skip_compress: Option<OsString>,

	// ---- updating ----
	/// `--sparse`.
	pub sparse_files: bool,
	/// `--preallocate`.
	pub preallocate_files: bool,
	/// `--inplace` (also implied by `--append`/`--write-devices`).
	pub inplace: bool,
	/// 1 `--append`, 2 `--append-verify` (server: count of `--append`).
	pub append_mode: u32,
	/// `--partial` (cleared under `--inplace`).
	pub keep_partial: bool,
	/// `--partial-dir` (cleaned; `.~tmp~` under `--delay-updates`).
	pub partial_dir: Option<OsString>,
	/// `partial_dir` is the implied `.~tmp~`.
	pub partial_dir_is_tmp: bool,
	/// `--delay-updates`.
	pub delay_updates: bool,
	/// `-m`.
	pub prune_empty_dirs: bool,
	/// `-T DIR`.
	pub tmpdir: Option<OsString>,
	/// `--fsync`.
	pub do_fsync: bool,

	// ---- deletion ----
	/// Any `--delete*` (finalized).
	pub delete_mode: bool,
	/// `--delete-before`.
	pub delete_before: bool,
	/// 1 `--delete-during`/`--del`, 2 `--delete-delay`.
	pub delete_during: u8,
	/// `--delete-after`.
	pub delete_after: bool,
	/// `--delete-excluded`.
	pub delete_excluded: bool,
	/// `--force`.
	pub force_delete: bool,
	/// `--ignore-errors`.
	pub ignore_errors: bool,
	/// `--max-delete` (i32::MIN unset; negative given = 0).
	pub max_delete: i32,
	/// 1 `--remove-source-files`, 2 `--remove-sent-files`.
	pub remove_source_files: u8,
	/// Set by `--remove-source-files`.
	pub need_messages_from_generator: bool,

	// ---- filters ----
	/// Filter rules in command-line order (including -F and implied rules).
	pub filter_rules: Vec<FilterOpt>,
	/// `-F` count.
	pub f_option_cnt: u32,
	/// `-C`.
	pub cvs_exclude: bool,

	// ---- backups ----
	/// `-b` (implied by `--backup-dir`).
	pub make_backups: bool,
	/// `--backup-dir` with leading "./" removed (no trailing slash added).
	pub backup_dir: Option<OsString>,
	/// `--suffix` (finalized: "~" or "" with a backup dir).
	pub backup_suffix: Option<OsString>,

	// ---- batch ----
	/// `--read-batch`/`--write-batch`/`--only-write-batch` name.
	pub batch_name: Option<OsString>,
	/// 1 `--write-batch`, -1 `--only-write-batch`.
	pub write_batch: i32,
	/// `--read-batch`.
	pub read_batch: bool,

	// ---- connection ----
	/// `-e COMMAND` (RSYNC_RSH is not folded in).
	pub shell_cmd: Option<OsString>,
	/// `--rsync-path` (default "rsync").
	pub rsync_path: OsString,
	/// -1 unset, 0 `--no-old-args`, 1+ `--old-args` count (or RSYNC_OLD_ARGS).
	pub old_style_args: i32,
	/// -1 unset, 0 off, 1 `-s`, 2 server already read the secluded args.
	pub protect_args: i32,
	/// `--trust-sender`.
	pub trust_sender: bool,
	/// Trust the sender's file-list names (upstream `trust_sender_args`).
	pub trust_sender_args: bool,
	/// Trust the sender's filter decisions (upstream `trust_sender_filter`).
	pub trust_sender_filter: bool,
	/// `--blocking-io` / `--no-blocking-io`.
	pub blocking_io: Option<bool>,
	/// `--timeout=SECONDS`.
	pub io_timeout: i32,
	/// `--contimeout=SECONDS`.
	pub connect_timeout: i32,
	/// `--address`.
	pub bind_address: Option<OsString>,
	/// `--port` (0 = unset).
	pub rsync_port: i32,
	/// `--sockopts`.
	pub sockopts: Option<OsString>,
	/// `--password-file`.
	pub password_file: Option<OsString>,
	/// `--early-input`.
	pub early_input_file: Option<OsString>,
	/// 0 any, 4 `-4`, 6 `-6`.
	pub af_hint: u8,
	/// `-M OPTION` list.
	pub remote_options: Vec<OsString>,
	/// `--protocol=NUM` (default 33).
	pub protocol_version: i32,
	/// `--iconv` (RSYNC_ICONV default; "-" clears on the client).
	pub iconv_opt: Option<OsString>,
	/// An iconv spec is active (upstream `need_unsorted_flist`).
	pub need_unsorted_flist: bool,
	/// `--bwlimit` in KiB/s (0 = none).
	pub bwlimit: i32,
	/// `--bwlimit` normalized to plain digits of bytes.
	pub bwlimit_arg: Option<String>,

	// ---- time limits ----
	/// `--stop-after`/`--stop-at` as a Unix time (0 = none).
	pub stop_at_utime: i64,
}

impl Default for Options {
	fn default() -> Self {
		Self {
			args: Vec::new(),
			levels: OutLevels::default(),
			am_server: false,
			am_sender: false,
			am_daemon: false,
			am_root: 0,
			config_file: None,
			dparams: Vec::new(),
			no_detach: false,
			daemon_bwlimit: 0,
			verbose: 0,
			quiet: 0,
			msgs2stderr: 2,
			saw_stderr_opt: false,
			output_motd: true,
			do_stats: false,
			human_readable: 1,
			do_progress: false,
			itemize_changes: 0,
			stdout_format: None,
			stdout_format_has_i: 0,
			stdout_format_has_o_or_i: false,
			log_before_transfer: false,
			logfile_name: None,
			logfile_format: None,
			logfile_format_has_i: false,
			logfile_format_has_o_or_i: false,
			allow_8bit_chars: false,
			outbuf_mode: None,
			outbuf: None,
			notices: Vec::new(),
			dry_run: false,
			do_xfers: true,
			recurse: 0,
			allow_inc_recurse: true,
			xfer_dirs: -1,
			list_only: 0,
			relative_paths: -1,
			implied_dirs: true,
			one_file_system: 0,
			files_from: None,
			filesfrom_host: None,
			filesfrom_fd: FilesFromFd::None,
			eol_nulls: false,
			missing_args: 0,
			mkpath_dest_arg: false,
			use_qsort: false,
			preserve_links: false,
			copy_links: false,
			copy_unsafe_links: false,
			safe_symlinks: false,
			insecure_links: false,
			munge_symlinks: false,
			copy_dirlinks: false,
			keep_dirlinks: false,
			preserve_hard_links: 0,
			preserve_devices: false,
			preserve_specials: false,
			copy_devices: false,
			write_devices: false,
			drop_devices: false,
			confine_root: None,
			preserve_perms: false,
			preserve_executability: false,
			preserve_acls: false,
			preserve_xattrs: 0,
			preserve_uid: false,
			preserve_gid: false,
			preserve_mtimes: false,
			preserve_atimes: 0,
			open_noatime: false,
			preserve_crtimes: false,
			omit_dir_times: 0,
			omit_link_times: false,
			modify_window: 0,
			modify_window_set: false,
			chmod: Vec::new(),
			chmod_modes: None,
			numeric_ids: false,
			usermap: None,
			groupmap: None,
			usermap_via_chown: false,
			groupmap_via_chown: false,
			copy_as: None,
			ignore_times: false,
			size_only: false,
			always_checksum: false,
			checksum_choice: None,
			checksum_seed: 0,
			whole_file: -1,
			block_size: 0,
			update_only: false,
			ignore_non_existing: false,
			ignore_existing: false,
			max_size: -1,
			min_size: -1,
			max_size_arg: None,
			min_size_arg: None,
			max_alloc: DEFAULT_MAX_ALLOC,
			max_alloc_arg: None,
			fuzzy_basis: 0,
			basis_dirs: Vec::new(),
			alt_dest_type: 0,
			do_compression: 0,
			compress_choice: None,
			do_compression_level: None,
			do_compression_threads: 0,
			skip_compress: None,
			sparse_files: false,
			preallocate_files: false,
			inplace: false,
			append_mode: 0,
			keep_partial: false,
			partial_dir: None,
			partial_dir_is_tmp: false,
			delay_updates: false,
			prune_empty_dirs: false,
			tmpdir: None,
			do_fsync: false,
			delete_mode: false,
			delete_before: false,
			delete_during: 0,
			delete_after: false,
			delete_excluded: false,
			force_delete: false,
			ignore_errors: false,
			max_delete: i32::MIN,
			remove_source_files: 0,
			need_messages_from_generator: false,
			filter_rules: Vec::new(),
			f_option_cnt: 0,
			cvs_exclude: false,
			make_backups: false,
			backup_dir: None,
			backup_suffix: None,
			batch_name: None,
			write_batch: 0,
			read_batch: false,
			shell_cmd: None,
			rsync_path: OsString::from("rsync"),
			old_style_args: -1,
			protect_args: -1,
			trust_sender: false,
			trust_sender_args: false,
			trust_sender_filter: false,
			blocking_io: None,
			io_timeout: 0,
			connect_timeout: 0,
			bind_address: None,
			rsync_port: 0,
			sockopts: None,
			password_file: None,
			early_input_file: None,
			af_hint: 0,
			remote_options: Vec::new(),
			protocol_version: 33,
			iconv_opt: None,
			need_unsorted_flist: false,
			bwlimit: 0,
			bwlimit_arg: None,
			stop_at_utime: 0,
		}
	}
}

/// `--outbuf` modes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OutBuf {
	/// `N`/`U`: unbuffered.
	None,
	/// `L`: line buffered.
	Line,
	/// `B`/`F`: block buffered.
	Block,
}

/// Where this process reads `--files-from` names (upstream `filesfrom_fd`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FilesFromFd {
	/// Not read here (no option, remote list, or the local server half).
	None,
	/// Standard input (client `-`), or the protocol stream on a server.
	Stdin,
	/// The local file named by `files_from`; the session opens it with
	/// `paths::open_operator_file` and reports failure via [`files_from_open_error`].
	File,
}

/// One filter-producing option, in command-line order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum FilterOpt {
	/// `--filter=RULE` (also `-F` and rules implied by `--old-dirs` / backups).
	Filter(Vec<u8>),
	/// `--exclude=PATTERN`.
	Exclude(Vec<u8>),
	/// `--include=PATTERN`.
	Include(Vec<u8>),
	/// `--exclude-from=FILE`.
	ExcludeFrom(OsString),
	/// `--include-from=FILE`.
	IncludeFrom(OsString),
}

impl FilterOpt {
	/// The rule origin `filter::Filters::add` expects.
	pub(crate) fn rule_arg(&self) -> crate::rsync::filter::RuleArg<'_> {
		use crate::rsync::filter::RuleArg;
		match self {
			FilterOpt::Filter(r) => RuleArg::Filter(r),
			FilterOpt::Exclude(r) => RuleArg::Exclude(r),
			FilterOpt::Include(r) => RuleArg::Include(r),
			FilterOpt::ExcludeFrom(f) => RuleArg::ExcludeFrom(std::path::Path::new(f)),
			FilterOpt::IncludeFrom(f) => RuleArg::IncludeFrom(std::path::Path::new(f)),
		}
	}
}

/// What argv asked for.
#[derive(Debug)]
pub(crate) enum Parsed {
	/// Run a transfer (or, with `am_daemon`, the unsupported daemon).
	Run(Box<Options>),
	/// `--help` (or `-h` alone): print `usage::help_text()` to stdout, exit 0.
	Help,
	/// `--version`: print `usage::version_text()` to stdout, exit 0.
	Version,
	/// `--info=help`: print `OutLevels::info_help()`, exit 0.
	InfoHelp,
	/// `--debug=help`: print `OutLevels::debug_help()`, exit 0.
	DebugHelp,
	/// `-VV` on a client: print `usage::version_json_text()` to stdout, exit 0.
	VersionJson,
	/// `--daemon --help`: print `usage::daemon_help_text()` to stdout, exit 0.
	DaemonHelp,
}

impl Options {
	/// The `--stderr` mode in `LogConfig::stderr_mode` encoding: 0 errors (default),
	/// 1 all, 2 client.
	pub(crate) fn stderr_mode(&self) -> u8 {
		match self.msgs2stderr {
			1 => 1,
			0 => 2,
			_ => 0,
		}
	}

	/// The server is waiting for its secluded args (`-s`); call [`parse_secluded`] next.
	pub(crate) fn secluded_pending(&self) -> bool {
		self.am_server && self.protect_args == 1
	}

	/// The capability string a client sent with `-e.<caps>` (server side), "" if none.
	pub(crate) fn client_info(&self) -> Cow<'_, [u8]> {
		self.shell_cmd.as_deref().map_or(Cow::Borrowed(b""), os_bytes_lossy)
	}

	/// Upstream `set_allow_inc_recurse` for this side. `client_info` is the
	/// peer's `-e` capability string when we are a (remote or local) server.
	pub(crate) fn inc_recurse_allowed(&self, client_info: &[u8]) -> bool {
		if self.recurse == 0 || self.use_qsort || !self.allow_inc_recurse {
			return false;
		}
		if !self.am_sender && (self.delete_before || self.delete_after || self.delay_updates || self.prune_empty_dirs) {
			return false;
		}
		!(self.am_server && !client_info.contains(&b'i'))
	}

	/// setup_protocol's check in a build without preallocation support: the
	/// receiving side refuses `--preallocate` right after the version exchange
	/// ("preallocation is not supported on this Server|Client", RERR_SYNTAX at
	/// compat.c(660)). `am_server`/`am_sender` are this side's roles.
	pub(crate) fn preallocate_refusal(&self, am_server: bool, am_sender: bool) -> Option<RsyncError> {
		if crate::rsync::usage::SUPPORT_PREALLOCATION || !self.preallocate_files || am_sender {
			return None;
		}
		let who = if am_server { "Server" } else { "Client" };
		Some(RsyncError::new(RERR_SYNTAX, format!("preallocation is not supported on this {who}")).at("compat.c", 660))
	}

	fn set_compress_level(&mut self, level: i32) {
		// INT_MIN is upstream's CLVL_NOT_SPECIFIED marker.
		self.do_compression_level = (level != i32::MIN).then_some(level);
	}
}

/// Parses argv[1..] (client or `--server` argv) with env lookups (RSYNC_*), exactly like upstream.
///
/// Includes main()'s checks around option parsing: an empty argv and a run
/// without operands are usage errors (help text on stderr, exit 1).
pub(crate) fn parse(argv: &[std::ffi::OsString], env: &dyn Fn(&str) -> Option<String>) -> Result<Parsed, crate::rsync::exit::RsyncError> {
	if argv.is_empty() {
		return Err(usage_err(("main.c", 1898)));
	}
	let opts = Options { am_root: process_am_root(), ..Options::default() };
	let mut p = Parser::new(opts, env, ("main.c", 1913));
	let parsed = p.parse_arguments(argv)?;
	after_parse(parsed)
}

/// Upstream initializes `am_root` from the real uid before parsing. Windows has no
/// POSIX root, so the process is never am_root there.
fn process_am_root() -> i32 {
	#[cfg(unix)]
	{
		i32::from(rustix::process::getuid().is_root())
	}
	#[cfg(not(unix))]
	{
		0
	}
}

/// Server side of `-s`: parses the secluded argv (without its "rsync" arg0) on top
/// of the options from the remote command line ([`Options::secluded_pending`]).
pub(crate) fn parse_secluded(opts: Options, argv: &[OsString], env: &dyn Fn(&str) -> Option<String>) -> Result<Parsed, RsyncError> {
	let mut opts = opts;
	opts.protect_args = 2;
	let mut p = Parser::new(opts, env, ("main.c", 1962));
	let parsed = p.parse_arguments(argv)?;
	after_parse(parsed)
}

/// The server half of a local transfer (upstream `local_child`): the client's
/// options with the roles flipped, client-only state dropped, and `-M` options
/// applied. `args` is left empty for the session to fill.
pub(crate) fn local_server_options(client: &Options, env: &dyn Fn(&str) -> Option<String>) -> Result<Options, RsyncError> {
	let mut o = client.clone();
	o.am_sender = false;
	o.am_server = true;
	o.filesfrom_fd = FilesFromFd::None;
	o.munge_symlinks = false;
	o.chmod_modes = None;
	o.chmod.clear();
	o.logfile_name = None;
	o.args.clear();
	o.notices.clear();
	if !o.remote_options.is_empty() {
		let argv = o.remote_options.clone();
		let mut p = Parser::new(o, env, ("pipe.c", 148));
		match p.parse_arguments(&argv)? {
			Parsed::Run(opts) => o = *opts,
			// Help/version requests end the server half with status 0 and no message.
			_ => return Err(RsyncError { code: 0, message: None, site: None }),
		}
		o.args.clear();
	}
	Ok(o)
}

/// The error `--files-from=FILE` produces when the session cannot open FILE.
pub(crate) fn files_from_open_error(name: &OsStr, err: &std::io::Error) -> RsyncError {
	let text = format!("failed to open files-from file {}: {}", name.display(), strerror(err));
	RsyncError::new(RERR_SYNTAX, format!("rsync: {}", err_buf(&text))).at("main.c", 1913)
}

/// main()'s checks right after parse_arguments().
fn after_parse(parsed: Parsed) -> Result<Parsed, RsyncError> {
	let mut o = match parsed {
		Parsed::Run(o) => o,
		other => return Ok(other),
	};
	if o.am_daemon || o.secluded_pending() {
		return Ok(Parsed::Run(o));
	}
	if o.write_batch < 0 {
		o.dry_run = true;
	}
	if o.args.is_empty() {
		return Err(usage_err(("main.c", 1968)));
	}
	Ok(Parsed::Run(o))
}

/// A usage error: the help text on stderr then exit 1.
fn usage_err(site: (&'static str, u32)) -> RsyncError {
	let text = help_text();
	RsyncError::new(RERR_SYNTAX, text.strip_suffix('\n').unwrap_or(&text).to_string()).at(site.0, site.1)
}

/// Mimics upstream's 200-byte `err_buf`: the text (with its newline) is cut to fit.
fn err_buf(text: &str) -> String {
	let mut full = format!("{text}\n");
	if full.len() > ERR_BUF - 1 {
		full.truncate(full.floor_char_boundary(ERR_BUF - 1));
	}
	full.strip_suffix('\n').map(str::to_string).unwrap_or(full)
}

/// `--compare-dest` etc. spelled for messages and server args.
pub(crate) fn alt_dest_opt(kind: u8) -> &'static str {
	match kind {
		COMPARE_DEST => "--compare-dest",
		COPY_DEST => "--copy-dest",
		_ => "--link-dest",
	}
}

// ---------------------------------------------------------------------------
// popt-compatible scanner

/// Whether an option takes a value.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
	None,
	Str,
	Int,
}

/// A parsed option value.
enum Val {
	None,
	Str(Vec<u8>),
	Int(i32),
}

impl Val {
	fn os(self) -> OsString {
		match self {
			Val::Str(s) => vec_os_lossy(s),
			Val::Int(n) => OsString::from(n.to_string()),
			Val::None => OsString::new(),
		}
	}
	fn bytes(self) -> Vec<u8> {
		match self {
			Val::Str(s) => s,
			Val::Int(n) => n.to_string().into_bytes(),
			Val::None => Vec::new(),
		}
	}
	fn int(&self) -> i32 {
		match self {
			Val::Int(n) => *n,
			_ => 0,
		}
	}
	fn as_bytes(&self) -> &[u8] {
		match self {
			Val::Str(s) => s,
			_ => b"",
		}
	}
}

/// One option-table row.
struct Spec {
	/// Long name ("" = short only).
	long: &'static str,
	/// Short letter (0 = long only).
	short: u8,
	kind: Kind,
	act: fn(&mut Parser<'_>, Val) -> Step,
}

/// Why an option action stopped the scan.
enum Stop {
	Err(RsyncError),
	Done(Parsed),
	/// `--server` seen first time: rescan argv as a server.
	Restart,
	/// A daemon-only option: rescan argv with the daemon table.
	Daemon,
}

type Step = Result<(), Stop>;

impl From<RsyncError> for Stop {
	fn from(e: RsyncError) -> Self {
		Stop::Err(e)
	}
}

/// Parse state shared by the scanner and the option actions.
struct Parser<'e> {
	o: Options,
	env: &'e dyn Fn(&str) -> Option<String>,
	/// Exit site for option_error() failures.
	site: (&'static str, u32),
	version_cnt: u32,
	daemon_opt: bool,
	operands: Vec<OsString>,
}

impl<'e> Parser<'e> {
	fn new(o: Options, env: &'e dyn Fn(&str) -> Option<String>, site: (&'static str, u32)) -> Self {
		Self { o, env, site, version_cnt: 0, daemon_opt: false, operands: Vec::new() }
	}

	fn getenv(&self, name: &str) -> Option<String> {
		(self.env)(name)
	}

	/// A non-empty environment value.
	fn getenv_set(&self, name: &str) -> Option<String> {
		self.getenv(name).filter(|v| !v.is_empty())
	}

	/// option_error(): "rsync: <err_buf>" then exit RERR_SYNTAX.
	fn option_error(&self, text: impl AsRef<str>) -> Stop {
		let msg = format!("rsync: {}", err_buf(text.as_ref()));
		Stop::Err(RsyncError::new(RERR_SYNTAX, msg).at(self.site.0, self.site.1))
	}

	fn usage_error(&self, site: (&'static str, u32)) -> Stop {
		Stop::Err(usage_err(site))
	}

	fn daemon_error(&self, text: String) -> Stop {
		let msg = format!("{text}\n(Type \"rsync --daemon --help\" for assistance with daemon mode.)");
		Stop::Err(RsyncError::new(RERR_SYNTAX, msg).at("options.c", 1596))
	}

	fn help(&self) -> Stop {
		Stop::Done(Parsed::Help)
	}

	/// A popt-level error about argv element `bad`.
	fn popt_error(&self, bad: &[u8], what: &str, daemon: bool) -> Stop {
		if daemon {
			return self.daemon_error(format!("rsync: {}: {what} (in daemon mode)", String::from_utf8_lossy(bad)));
		}
		let prefix = if self.o.am_server { "on remote machine: " } else { "" };
		self.option_error(format!("{prefix}{}: {what}", String::from_utf8_lossy(bad)))
	}

	/// Upstream parse_arguments(): scan, then implications and validation.
	fn parse_arguments(&mut self, argv: &[OsString]) -> Result<Parsed, RsyncError> {
		let orig_protect_args = self.o.protect_args;
		if !self.o.am_daemon && self.o.protect_args <= 0 {
			if let Some(v) = self.getenv_set("RSYNC_ICONV").filter(|_| crate::rsync::usage::SUPPORT_ICONV) {
				self.o.iconv_opt = Some(v.into());
			}
		}
		loop {
			match self.scan(argv, table::LONG_OPTIONS, false) {
				Ok(()) => break,
				Err(Stop::Restart) => continue,
				Err(Stop::Err(e)) => return Err(e),
				Err(Stop::Done(p)) => return Ok(p),
				Err(Stop::Daemon) => return self.daemon_mode(argv),
			}
		}
		match self.finish(argv.len(), orig_protect_args) {
			Ok(()) => Ok(Parsed::Run(Box::new(std::mem::take(&mut self.o)))),
			Err(Stop::Err(e)) => Err(e),
			Err(Stop::Done(p)) => Ok(p),
			Err(Stop::Restart | Stop::Daemon) => Err(RsyncError::new(RERR_SYNTAX, "rsync: internal option state")),
		}
	}

	/// Re-parse argv with the daemon table (any daemon-only option switches modes).
	fn daemon_mode(&mut self, argv: &[OsString]) -> Result<Parsed, RsyncError> {
		self.o.iconv_opt = None;
		self.o.protect_args = 0;
		match self.scan(argv, table::DAEMON_OPTIONS, true) {
			Ok(()) => {}
			Err(Stop::Err(e)) => return Err(e),
			Err(Stop::Done(p)) => return Ok(p),
			Err(Stop::Restart | Stop::Daemon) => {}
		}
		if self.o.tmpdir.as_ref().is_some_and(|t| t.len() >= MAXPATHLEN - 10) {
			if let Stop::Err(e) = self.option_error("the --temp-dir path is WAY too long.") {
				return Err(e);
			}
		}
		if !self.daemon_opt {
			if let Stop::Err(e) = self.daemon_error("Daemon option(s) used without --daemon.".into()) {
				return Err(e);
			}
		}
		self.o.am_daemon = true;
		self.o.args = std::mem::take(&mut self.operands);
		Ok(Parsed::Run(Box::new(std::mem::take(&mut self.o))))
	}

	/// popt's option loop over the whole argv (options may follow operands).
	fn scan(&mut self, argv: &[OsString], table: &'static [Spec], daemon: bool) -> Step {
		self.operands.clear();
		let posix = self.getenv("POSIXLY_CORRECT").is_some() || self.getenv("POSIX_ME_HARDER").is_some();
		let mut rest = false;
		let mut i = 0;
		while i < argv.len() {
			let elem = &argv[i];
			let arg_bytes = os_bytes_lossy(elem);
			let arg: &[u8] = &arg_bytes;
			i += 1;
			if rest || arg.first() != Some(&b'-') || arg == b"-" {
				self.operands.push(elem.clone());
				rest |= posix;
				continue;
			}
			if arg == b"--" {
				rest = true;
				continue;
			}
			if let Some(body) = arg.strip_prefix(b"--") {
				let (name, inline) = match body.iter().position(|&c| c == b'=') {
					Some(eq) => (&body[..eq], Some(&body[eq + 1..])),
					None => (body, None),
				};
				let Some(spec) = table.iter().find(|s| !s.long.is_empty() && s.long.as_bytes() == name) else {
					return Err(self.popt_error(arg, "unknown option", daemon));
				};
				let val = match (spec.kind, inline) {
					(Kind::None, Some(_)) => {
						return Err(self.popt_error(arg, "option does not take an argument", daemon));
					}
					(Kind::None, None) => Val::None,
					(kind, Some(v)) => self.value(kind, v, arg, daemon)?,
					(kind, None) => {
						let Some(next) = argv.get(i) else {
							return Err(self.popt_error(arg, "missing argument", daemon));
						};
						i += 1;
						let next = os_bytes_lossy(next);
						self.value(kind, &next, &next, daemon)?
					}
				};
				(spec.act)(self, val)?;
				continue;
			}
			// A bundle of short options.
			let mut j = 1;
			while j < arg.len() {
				let c = arg[j];
				j += 1;
				let Some(spec) = table.iter().find(|s| s.short != 0 && s.short == c) else {
					return Err(self.popt_error(arg, "unknown option", daemon));
				};
				if spec.kind == Kind::None {
					if arg.get(j) == Some(&b'=') {
						return Err(self.popt_error(arg, "option does not take an argument", daemon));
					}
					(spec.act)(self, Val::None)?;
					continue;
				}
				let val = if j < arg.len() {
					let start = if arg[j] == b'=' { j + 1 } else { j };
					self.value(spec.kind, &arg[start..], arg, daemon)?
				} else {
					let Some(next) = argv.get(i) else {
						return Err(self.popt_error(arg, "missing argument", daemon));
					};
					i += 1;
					let next = os_bytes_lossy(next);
					self.value(spec.kind, &next, &next, daemon)?
				};
				(spec.act)(self, val)?;
				break;
			}
		}
		Ok(())
	}

	fn value(&self, kind: Kind, v: &[u8], bad: &[u8], daemon: bool) -> Result<Val, Stop> {
		match kind {
			Kind::Int => match popt_int(v) {
				Ok(n) => Ok(Val::Int(n)),
				Err(what) => Err(self.popt_error(bad, what, daemon)),
			},
			_ => Ok(Val::Str(v.to_vec())),
		}
	}

	// ---- option actions needing more than a field store ----

	fn output_words(&mut self, debug: bool, v: &Val) -> Step {
		let words = String::from_utf8_lossy(v.as_bytes()).into_owned();
		let am_server = self.o.am_server;
		let res = if debug {
			self.o.levels.parse_debug(&words, Priority::User, am_server)
		} else {
			self.o.levels.parse_info(&words, Priority::User, am_server)
		};
		match res {
			Ok(Words::Done) => Ok(()),
			Ok(Words::Help) => Err(Stop::Done(if debug { Parsed::DebugHelp } else { Parsed::InfoHelp })),
			Err(text) => Err(Stop::Err(RsyncError::new(RERR_SYNTAX, text).at("options.c", 487))),
		}
	}

	fn stderr_mode(&mut self, v: &Val) -> Step {
		let arg = v.as_bytes();
		let is_prefix = |word: &[u8]| !arg.is_empty() && word.starts_with(arg);
		self.o.msgs2stderr = if is_prefix(b"errors") {
			2
		} else if is_prefix(b"all") {
			1
		} else if is_prefix(b"client") {
			0
		} else {
			return Err(self.option_error(format!(
				"--stderr mode \"{}\" is not one of errors, all, or client",
				String::from_utf8_lossy(arg)
			)));
		};
		self.o.saw_stderr_opt = true;
		Ok(())
	}

	fn chmod(&mut self, v: Val) -> Step {
		let spec = v.os();
		let text = spec.to_string_lossy().into_owned();
		match ChmodRules::parse(&text, self.o.chmod_modes.take()) {
			Ok(rules) => {
				self.o.chmod_modes = Some(rules);
				self.o.chmod.push(spec);
				Ok(())
			}
			Err(_) => Err(self.option_error(format!("Invalid argument passed to --chmod ({text})"))),
		}
	}

	fn min_max_size(&mut self, max: bool, v: &Val) -> Step {
		let name = if max { "max-size" } else { "min-size" };
		let size = parse_size_arg(v.as_bytes(), b'b', name, 0, -1, false).map_err(|t| self.option_error(t))?;
		let normalized = size.to_string();
		if max {
			self.o.max_size = size;
			self.o.max_size_arg = Some(normalized);
		} else {
			self.o.min_size = size;
			self.o.min_size_arg = Some(normalized);
		}
		Ok(())
	}

	fn bwlimit(&mut self, v: &Val) -> Step {
		let size = parse_size_arg(v.as_bytes(), b'K', "bwlimit", 512, -1, true).map_err(|t| self.option_error(t))?;
		self.o.bwlimit_arg = Some(size.to_string());
		self.o.bwlimit = i32::try_from((size + 512) / 1024).unwrap_or(i32::MAX);
		Ok(())
	}

	fn block_size(&mut self, v: &Val) -> Step {
		let max = i64::from(if self.o.protocol_version < 30 { OLD_MAX_BLOCK_SIZE } else { MAX_BLOCK_SIZE });
		let size = parse_size_arg(v.as_bytes(), b'b', "block-size", 0, max, false).map_err(|t| self.option_error(t))?;
		self.o.block_size = size as i32;
		Ok(())
	}

	fn usermap(&mut self, user: bool, v: Val) -> Step {
		let (name, set, via_chown) = if user {
			("usermap", self.o.usermap.is_some(), self.o.usermap_via_chown)
		} else {
			("groupmap", self.o.groupmap.is_some(), self.o.groupmap_via_chown)
		};
		if set {
			if via_chown {
				return Err(self.option_error(format!("--{name} conflicts with prior --chown.")));
			}
			return Err(self.option_error(format!("You can only specify --{name} once.")));
		}
		if user {
			self.o.usermap = Some(v.os());
			self.o.usermap_via_chown = false;
			self.o.preserve_uid = true;
		} else {
			self.o.groupmap = Some(v.os());
			self.o.groupmap_via_chown = false;
			self.o.preserve_gid = true;
		}
		Ok(())
	}

	fn chown(&mut self, v: &Val) -> Step {
		let spec = v.as_bytes();
		let (user, group) = match spec.iter().position(|&c| c == b':') {
			Some(colon) => (&spec[..colon], Some(&spec[colon + 1..])),
			None => (spec, None),
		};
		if !user.is_empty() {
			if self.o.usermap.is_some() {
				if !self.o.usermap_via_chown {
					return Err(self.option_error("--chown conflicts with prior --usermap."));
				}
				return Err(self.option_error("You can only specify a user-affecting --chown once."));
			}
			let mut map = b"*:".to_vec();
			map.extend_from_slice(user);
			self.o.usermap = Some(vec_os_lossy(map));
			self.o.usermap_via_chown = true;
			self.o.preserve_uid = true;
		}
		if let Some(group) = group.filter(|g| !g.is_empty()) {
			if self.o.groupmap.is_some() {
				if !self.o.groupmap_via_chown {
					return Err(self.option_error("--chown conflicts with prior --groupmap."));
				}
				return Err(self.option_error("You can only specify a group-affecting --chown once."));
			}
			let mut map = b"*:".to_vec();
			map.extend_from_slice(group);
			self.o.groupmap = Some(vec_os_lossy(map));
			self.o.groupmap_via_chown = true;
			self.o.preserve_gid = true;
		}
		Ok(())
	}

	fn stop_after(&mut self, v: &Val) -> Step {
		let arg = v.as_bytes();
		let now = unix_now();
		let val = atol(arg).wrapping_mul(60);
		if val <= 0 || i64::MAX - val < now {
			return Err(self.option_error(format!("invalid --stop-after value: {}", String::from_utf8_lossy(arg))));
		}
		self.o.stop_at_utime = now + val;
		Ok(())
	}

	fn stop_at(&mut self, v: &Val) -> Step {
		let arg = v.as_bytes();
		let now = unix_now();
		let Some(when) = parse_time(arg, now) else {
			return Err(self.option_error(format!("invalid --stop-at format: {}", String::from_utf8_lossy(arg))));
		};
		if when <= now {
			return Err(self.option_error(format!("--stop-at time is not in the future: {}", String::from_utf8_lossy(arg))));
		}
		self.o.stop_at_utime = when;
		Ok(())
	}

	// ---- post-scan processing (upstream parse_arguments after the loop) ----

	fn finish(&mut self, argc: usize, orig_protect_args: i32) -> Step {
		let o = &mut self.o;
		if o.msgs2stderr != 2 {
			o.saw_stderr_opt = true;
		}
		if self.version_cnt > 0 {
			let json = self.version_cnt > 1 && !self.o.am_server;
			return Err(Stop::Done(if json { Parsed::VersionJson } else { Parsed::Version }));
		}

		if self.o.max_alloc_arg.is_none() {
			self.o.max_alloc_arg = self.getenv_set("RSYNC_MAX_ALLOC").map(OsString::from);
		}
		if let Some(arg) = self.o.max_alloc_arg.clone() {
			let size = parse_size_arg(&os_bytes_lossy(&arg), b'B', "max-alloc", 1024 * 1024, -1, true)
				.map_err(|t| self.option_error(t))?;
			self.o.max_alloc = size as u64;
		}
		if self.o.max_alloc == 0 {
			self.o.max_alloc = SIZE_ARG_MAX as u64;
		}

		if self.o.old_style_args < 0 {
			let env_old = if !self.o.am_server && self.o.protect_args <= 0 { self.getenv_set("RSYNC_OLD_ARGS") } else { None };
			if let Some(v) = env_old {
				self.o.protect_args = 0;
				self.o.old_style_args = atol(v.as_bytes()) as i32;
			} else {
				self.o.old_style_args = 0;
			}
		} else if self.o.old_style_args > 0 {
			if self.o.protect_args > 0 {
				return Err(self.option_error("--secluded-args conflicts with --old-args."));
			}
			self.o.protect_args = 0;
		}

		if self.o.protect_args < 0 {
			self.o.protect_args = if self.o.am_server {
				0
			} else if let Some(v) = self.getenv_set("RSYNC_PROTECT_ARGS") {
				i32::from(atol(v.as_bytes()) != 0)
			} else {
				0
			};
		}

		self.checksum_choice()?;

		if self.o.human_readable > 1 && argc == 1 && !self.o.am_server {
			return Err(Stop::Done(Parsed::Help));
		}

		self.compress_choice()?;

		let o = &mut self.o;
		if o.do_compression != 0 || o.do_compression_level.is_some() {
			if o.do_compression == 0 {
				o.do_compression = CPRES_AUTO;
			}
			if o.do_compression_threads < 0 {
				o.do_compression_threads = 0;
			}
			if o.am_daemon && o.do_compression_threads > MAX_DAEMON_COMPRESSION_THREADS {
				o.do_compression_threads = MAX_DAEMON_COMPRESSION_THREADS;
			}
		}

		if let Some(mode) = self.o.outbuf_mode.as_ref().filter(|_| !self.o.am_server) {
			self.o.outbuf = Some(match os_bytes_lossy(mode).first().map(u8::to_ascii_uppercase) {
				Some(b'N' | b'U') => OutBuf::None,
				Some(b'L') => OutBuf::Line,
				Some(b'B' | b'F') => OutBuf::Block,
				_ => return Err(self.option_error("Invalid --outbuf setting -- specify N, L, or B.")),
			});
		}

		let o = &mut self.o;
		o.levels.apply_verbose(o.verbose.min(u32::from(u8::MAX)) as u8);
		if o.do_stats {
			let words = if o.verbose > 1 { "stats3" } else { "stats2" };
			let _ = o.levels.parse_info(words, Priority::Default, o.am_server);
		}

		if o.iconv_opt.is_some() && o.protect_args != 2 {
			if !o.am_server && o.iconv_opt.as_deref() == Some(OsStr::new("-")) {
				o.iconv_opt = None;
			} else {
				o.need_unsorted_flist = true;
			}
		}

		if o.fuzzy_basis > 1 {
			o.fuzzy_basis = o.basis_dirs.len() as u32 + 1;
		}

		if orig_protect_args == 2 && o.am_server {
			o.protect_args = 2;
		}
		o.args = std::mem::take(&mut self.operands);
		if self.o.protect_args == 1 && self.o.am_server {
			return Ok(());
		}
		self.finish_args()
	}

	fn checksum_choice(&mut self) -> Step {
		let Some(choice) = self.o.checksum_choice.clone() else { return Ok(()) };
		let text = choice.to_string_lossy().into_owned();
		if text.eq_ignore_ascii_case("auto") || text.eq_ignore_ascii_case("auto,auto") {
			self.o.checksum_choice = None;
			return Ok(());
		}
		let choice = crate::rsync::checksum::ChecksumChoice::parse(&text)
			.map_err(|msg| Stop::Err(RsyncError::new(RERR_UNSUPPORTED, msg).at("checksum.c", 157)))?;
		// "auto" halves resolve to the pre-negotiation default of the requested protocol.
		let proto = crate::rsync::wire::Proto { version: u32::try_from(self.o.protocol_version).unwrap_or(0), compat: 0 };
		let (xfer, file) = choice.resolve(proto);
		if self.o.am_server && !crate::rsync::checksum::checksum_env_allows(self.nstr_env(false).as_deref(), xfer, file) {
			return Err(Stop::Err(crate::rsync::checksum::choice_refused("checksum", &text)));
		}
		if xfer == crate::rsync::checksum::CsumType::None {
			self.o.whole_file = 1;
		}
		Ok(())
	}

	fn compress_choice(&mut self) -> Step {
		if self.o.compress_choice.is_none() && self.o.do_compression > 1 {
			self.o.compress_choice = Some("zlibx".into());
		}
		let Some(choice) = self.o.compress_choice.clone() else { return Ok(()) };
		let text = choice.to_string_lossy().into_owned();
		let kind = match crate::rsync::token::parse_compress_choice(&text) {
			Err(msg) => return Err(Stop::Err(RsyncError::new(RERR_UNSUPPORTED, msg).at("compat.c", 190))),
			Ok(None) => {
				self.o.compress_choice = None;
				return Ok(());
			}
			Ok(Some(kind)) => kind,
		};
		let num = i32::from(kind.num());
		self.o.do_compression = num;
		if self.o.am_server && !crate::rsync::token::compress_env_allows(self.nstr_env(true).as_deref(), kind) {
			return Err(Stop::Err(crate::rsync::checksum::choice_refused("compress", &text)));
		}
		if num == CPRES_NONE {
			self.o.compress_choice = Some("none".into());
		}
		Ok(())
	}

	/// The raw negotiation-list env var as upstream's getenv_nstr() sees it before
	/// the server's '&' split (the env checks in checksum.rs/token.rs do that split).
	fn nstr_env(&self, compress: bool) -> Option<String> {
		if self.o.write_batch != 0 {
			let fixed = if compress { "zlib" } else if self.o.protocol_version >= 30 { "md5" } else { "md4" };
			return Some(fixed.to_string());
		}
		self.getenv(if compress { "RSYNC_COMPRESS_LIST" } else { "RSYNC_CHECKSUM_LIST" })
	}

	/// The part of parse_arguments that runs once the operands are known.
	fn finish_args(&mut self) -> Step {
		let argc = self.o.args.len();
		if crate::rsync::usage::SUPPORT_XATTRS {
			if self.o.am_root < 0 && self.o.preserve_xattrs > 1 {
				return Err(self.option_error("--fake-super conflicts with -XX"));
			}
		} else if self.o.am_root < 0 {
			return Err(self.option_error("--fake-super requires an rsync with extended attributes enabled"));
		}

		if self.o.write_batch != 0 && self.o.read_batch {
			return Err(self.option_error("--write-batch and --read-batch can not be used together"));
		}
		let o = &mut self.o;
		if o.write_batch > 0 || o.read_batch {
			if o.am_server {
				let which = if o.write_batch != 0 { "write" } else { "read" };
				o.notices.push(format!("ignoring --{which}-batch option sent to server"));
				o.read_batch = false;
				o.write_batch = 0;
				o.batch_name = None;
			} else if o.dry_run {
				o.write_batch = 0;
			}
		} else if o.write_batch < 0 && o.dry_run {
			o.write_batch = 0;
		}
		if self.o.read_batch && self.o.files_from.is_some() {
			return Err(self.option_error("--read-batch cannot be used with --files-from"));
		}
		if self.o.read_batch && self.o.remove_source_files != 0 {
			let which = if self.o.remove_source_files == 1 { "source" } else { "sent" };
			return Err(self.option_error(format!("--read-batch cannot be used with --remove-{which}-files")));
		}
		if self.o.batch_name.as_ref().is_some_and(|b| b.len() > MAX_BATCH_NAME_LEN) {
			return Err(self.option_error(format!("the batch-file name must be {MAX_BATCH_NAME_LEN} characters or less.")));
		}
		if self.o.tmpdir.as_ref().is_some_and(|t| t.len() >= MAXPATHLEN - 10) {
			return Err(self.option_error("the --temp-dir path is WAY too long."));
		}

		let o = &mut self.o;
		if o.max_delete < 0 && o.max_delete != i32::MIN {
			o.max_delete = 0;
		}
		if o.files_from.is_some() {
			if o.recurse == 1 {
				o.recurse = 0;
			}
			if o.xfer_dirs < 0 {
				o.xfer_dirs = 1;
			}
		}
		if argc < 2 && !o.read_batch && !o.am_server {
			o.list_only |= 1;
		}
		if o.xfer_dirs >= 4 {
			o.filter_rules.push(FilterOpt::Filter(b"- /*/*".to_vec()));
			o.recurse = 1;
			o.xfer_dirs = 1;
		} else if o.recurse != 0 {
			o.xfer_dirs = 1;
		} else if o.xfer_dirs < 0 {
			o.xfer_dirs = i32::from(o.list_only != 0);
		}
		if o.relative_paths < 0 {
			o.relative_paths = i32::from(o.files_from.is_some());
		}
		if o.relative_paths == 0 {
			o.implied_dirs = false;
		}

		let whens = u8::from(o.delete_before) + u8::from(o.delete_during != 0) + u8::from(o.delete_after);
		if whens > 1 {
			return Err(self.option_error("You may not combine multiple --delete-WHEN options."));
		}
		let o = &mut self.o;
		if whens > 0 || o.delete_excluded {
			o.delete_mode = true;
		}
		if o.xfer_dirs == 0 && o.delete_mode {
			return Err(self.option_error("--delete does not work without --recursive (-r) or --dirs (-d)."));
		}
		let o = &mut self.o;
		if o.missing_args == 3 {
			o.missing_args = 2;
		}
		if o.remove_source_files != 0 {
			o.need_messages_from_generator = true;
		}

		if o.munge_symlinks && !o.am_daemon && std::fs::metadata("/rsyncd-munged").is_ok_and(|m| m.is_dir()) {
			return Err(Stop::Err(
				RsyncError::new(
					RERR_UNSUPPORTED,
					"Symlink munging is unsafe when a /rsyncd-munged directory exists.",
				)
				.at("options.c", 2387),
			));
		}

		if let Some(root) = self.o.confine_root.clone() {
			if self.o.am_daemon {
				self.o.confine_root = None;
			} else if !is_absolute_operator_path(&os_bytes_lossy(&root), cfg!(windows)) {
				return Err(self.option_error("--confine-root must be an absolute path"));
			} else if self.o.insecure_links {
				return Err(self.option_error("--insecure-links cannot be combined with --confine-root"));
			} else {
				let bytes = crate::rsync::paths::path_bytes(std::path::Path::new(&root));
				let clean = crate::rsync::paths::clean_fname(&bytes, true);
				self.o.confine_root = Some(vec_os_lossy(clean));
			}
		}

		self.finish_backups()?;
		self.finish_formats();

		let o = &mut self.o;
		if o.append_mode != 0 {
			if o.whole_file > 0 {
				return Err(self.option_error("--append cannot be used with --whole-file"));
			}
			self.o.inplace = true;
		}
		let o = &mut self.o;
		if o.write_devices {
			o.inplace = true;
		}
		if o.delay_updates && o.partial_dir.is_none() {
			o.partial_dir = Some(TMP_PARTIAL_DIR.into());
			o.partial_dir_is_tmp = true;
		}
		if o.inplace {
			if o.partial_dir.is_some() {
				let a = if o.append_mode != 0 { "append" } else { "inplace" };
				let b = if o.delay_updates { "delay-updates" } else { "partial-dir" };
				return Err(self.option_error(format!("--{a} cannot be used with --{b}")));
			}
			self.o.keep_partial = false;
		} else {
			if self.o.keep_partial && self.o.partial_dir.is_none() && !self.o.am_server {
				if let Some(dir) = self.getenv_set("RSYNC_PARTIAL_DIR") {
					self.o.partial_dir = Some(dir.into());
				}
			}
			let o = &mut self.o;
			if let Some(dir) = o.partial_dir.take() {
				let mut bytes = os_bytes_lossy(&dir).into_owned();
				if !bytes.is_empty() && !o.partial_dir_is_tmp {
					bytes = crate::rsync::paths::clean_fname(&bytes, true);
				}
				if !bytes.is_empty() && bytes != b"." {
					o.partial_dir = Some(vec_os_lossy(bytes));
				} else {
					o.partial_dir_is_tmp = false;
				}
				o.keep_partial = true;
			}
		}

		self.finish_files_from(argc)?;

		let o = &mut self.o;
		if o.trust_sender || o.am_server || o.read_batch {
			o.trust_sender_args = true;
			o.trust_sender_filter = true;
		} else if o.old_style_args != 0 || o.filesfrom_host.is_some() {
			o.trust_sender_args = true;
		}
		Ok(())
	}

	fn finish_backups(&mut self) -> Step {
		let o = &mut self.o;
		let suffix = o
			.backup_suffix
			.clone()
			.unwrap_or_else(|| if o.backup_dir.is_some() { OsString::new() } else { BACKUP_SUFFIX.into() });
		o.backup_suffix = Some(suffix.clone());
		if os_bytes_lossy(&suffix).contains(&b'/') {
			return Err(self.option_error(format!("--suffix cannot contain slashes: {}", suffix.display())));
		}
		// None: no --backup-dir; Some(false): given but empty after cleanup.
		let mut dir_state = None;
		if let Some(dir) = self.o.backup_dir.take() {
			self.o.make_backups = true;
			let dir_bytes = os_bytes_lossy(&dir).into_owned();
			let mut bytes: &[u8] = &dir_bytes;
			while bytes.starts_with(b"./") {
				bytes = &bytes[2..];
			}
			if bytes == b"." {
				bytes = b"";
			}
			if bytes.len() > MAXPATHLEN - 128 {
				return Err(self.option_error("the --backup-dir path is WAY too long."));
			}
			dir_state = Some(!bytes.is_empty());
			if !bytes.is_empty() {
				self.o.backup_dir = Some(vec_os_lossy(bytes.to_vec()));
			}
		}
		let o = &mut self.o;
		if o.backup_dir.is_some() {
			// No suffix or protect rule needed.
		} else if suffix.is_empty() && (!o.am_server || !o.am_sender) {
			let why = if dir_state == Some(false) {
				"when --backup-dir is the same as the dest dir"
			} else {
				"without a --backup-dir"
			};
			return Err(self.option_error(format!("--suffix cannot be empty {why}")));
		} else if o.make_backups && o.delete_mode && !o.delete_excluded && !o.am_server {
			let mut rule = b"P *".to_vec();
			rule.extend_from_slice(&os_bytes_lossy(&suffix));
			o.filter_rules.push(FilterOpt::Filter(rule));
		}
		let o = &mut self.o;
		if o.make_backups && o.backup_dir.is_none() {
			o.omit_dir_times = -1;
		}
		Ok(())
	}

	fn finish_formats(&mut self) {
		let o = &mut self.o;
		if let Some(fmt) = &o.stdout_format {
			if o.am_server && log_format_has(fmt, b'I') {
				o.stdout_format_has_i = 2;
			} else if log_format_has(fmt, b'i') {
				o.stdout_format_has_i = o.itemize_changes | 1;
			}
			if !log_format_has(fmt, b'b') && !log_format_has(fmt, b'c') && !log_format_has(fmt, b'C') {
				o.log_before_transfer = !o.am_server;
			}
		} else if o.itemize_changes != 0 {
			o.stdout_format = Some(b"%i %n%L".to_vec());
			o.stdout_format_has_i = o.itemize_changes;
			o.log_before_transfer = !o.am_server;
		}

		if o.do_progress && !o.am_server {
			if !o.log_before_transfer && o.levels.info(crate::rsync::log::Info::Name) == 0 {
				let _ = o.levels.parse_info("name", Priority::Default, o.am_server);
			}
			let _ = o.levels.parse_info("FLIST2,PROGRESS", Priority::Default, o.am_server);
		}
		if o.dry_run {
			o.do_xfers = false;
		}
		if o.levels.info(crate::rsync::log::Info::Name) >= 1 && o.stdout_format.is_none() {
			o.stdout_format = Some(b"%n%L".to_vec());
			o.log_before_transfer = !o.am_server;
		}
		if o.stdout_format_has_i != 0 || o.stdout_format.as_deref().is_some_and(|f| log_format_has(f, b'o')) {
			o.stdout_format_has_o_or_i = true;
		}

		if o.logfile_name.is_some() && !o.am_daemon {
			match &o.logfile_format {
				None => {
					o.logfile_format = Some(b"%i %n%L".to_vec());
					o.logfile_format_has_i = true;
					o.logfile_format_has_o_or_i = true;
				}
				Some(fmt) => {
					if log_format_has(fmt, b'i') {
						o.logfile_format_has_i = true;
					}
					if o.logfile_format_has_i || log_format_has(fmt, b'o') {
						o.logfile_format_has_o_or_i = true;
					}
				}
			}
		} else if !o.am_daemon {
			o.logfile_format = None;
		}
	}

	fn finish_files_from(&mut self, argc: usize) -> Step {
		let Some(files_from) = self.o.files_from.clone() else { return Ok(()) };
		let o = &self.o;
		if argc > 2 || (!o.am_daemon && !o.am_server && argc == 1) {
			return Err(self.usage_error(("options.c", 2621)));
		}
		let name_bytes = os_bytes_lossy(&files_from).into_owned();
		let name: &[u8] = &name_bytes;
		if name == b"-" {
			self.o.filesfrom_fd = FilesFromFd::Stdin;
			if self.o.am_server {
				self.o.filesfrom_host = Some(OsString::new());
			}
		} else if let Some((host, path)) = files_from_hostspec(name, cfg!(windows)) {
			if self.o.am_server {
				return Err(self.option_error("The --files-from sent to the server cannot specify a host."));
			}
			if path == b"-" {
				return Err(self.option_error("Invalid --files-from remote filename"));
			}
			self.o.files_from = Some(vec_os_lossy(path.to_vec()));
			self.o.filesfrom_host = Some(vec_os_lossy(host));
		} else {
			self.o.filesfrom_fd = FilesFromFd::File;
		}
		Ok(())
	}
}

// ---------------------------------------------------------------------------
// value parsers

/// popt's POPT_ARG_INT conversion (strtoll base 0, then an int range check).
fn popt_int(v: &[u8]) -> Result<i32, &'static str> {
	const BAD: &str = "invalid numeric value";
	const RANGE: &str = "number too large or too small";
	let mut i = 0;
	while i < v.len() && matches!(v[i], b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) {
		i += 1;
	}
	let neg = match v.get(i) {
		Some(b'-') => {
			i += 1;
			true
		}
		Some(b'+') => {
			i += 1;
			false
		}
		_ => false,
	};
	let hex = v.get(i) == Some(&b'0')
		&& matches!(v.get(i + 1), Some(b'x' | b'X'))
		&& v.get(i + 2).is_some_and(u8::is_ascii_hexdigit);
	let (radix, start) = if hex {
		(16, i + 2)
	} else if v.get(i) == Some(&b'0') {
		(8, i)
	} else {
		(10, i)
	};
	let digits = v[start..].iter().take_while(|c| char::from(**c).is_digit(radix)).count();
	if digits == 0 {
		// strtoll converted nothing, so its end pointer is the whole string.
		return if v.is_empty() { Ok(0) } else { Err(BAD) };
	}
	if start + digits != v.len() {
		return Err(BAD);
	}
	let mut acc: i128 = 0;
	for &c in &v[start..] {
		acc = acc * i128::from(radix) + i128::from(char::from(c).to_digit(radix).unwrap_or(0));
		if acc > i128::from(i64::MAX) + 1 {
			return Err(RANGE);
		}
	}
	let n = if neg { -acc } else { acc };
	i32::try_from(n).map_err(|_| RANGE)
}

/// strtod() prefix of a size argument (digits, one '.', more digits; sign allowed).
fn c_strtod(v: &[u8]) -> f64 {
	let v = v.trim_ascii_start();
	let mut i = 0;
	if matches!(v.get(i), Some(b'+' | b'-')) {
		i += 1;
	}
	let int_start = i;
	while v.get(i).is_some_and(u8::is_ascii_digit) {
		i += 1;
	}
	let mut end = i;
	if v.get(i) == Some(&b'.') {
		let mut k = i + 1;
		while v.get(k).is_some_and(u8::is_ascii_digit) {
			k += 1;
		}
		if k > i + 1 || i > int_start {
			end = k;
		}
	}
	if end == int_start || (end == int_start + 1 && v[int_start] == b'.') {
		return 0.0;
	}
	if matches!(v.get(end), Some(b'e' | b'E')) {
		let mut k = end + 1;
		if matches!(v.get(k), Some(b'+' | b'-')) {
			k += 1;
		}
		let exp_digits = k;
		while v.get(k).is_some_and(u8::is_ascii_digit) {
			k += 1;
		}
		if k > exp_digits {
			end = k;
		}
	}
	std::str::from_utf8(&v[..end]).ok().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0)
}

/// Upstream parse_size_arg(): `N[.N][KMGTP][B|iB][+1|-1]`. Returns the error text
/// (without "rsync: ") on failure.
fn parse_size_arg(arg: &[u8], def_suf: u8, opt: &str, min: i64, max: i64, unlimited_0: bool) -> Result<i64, String> {
	let size_max = if max >= 0 { max } else { SIZE_ARG_MAX };
	let fail = |err: &str, limit: Option<(&str, i64)>| -> String {
		let mut text = format!("--{opt}={} is {err}", String::from_utf8_lossy(arg));
		if let Some((which, limit)) = limit.filter(|(_, l)| *l >= 0) {
			if text.len() < ERR_BUF - 10 {
				let zero = if unlimited_0 && which == "min" { " or 0 for unlimited" } else { "" };
				text.push_str(&format!(" ({which}: {}{zero})", crate::rsync::log::big_num(limit, 3)));
			}
		}
		// parse_size_arg formats into err_buf minus one byte and reserves the
		// newline slot, so at most ERR_BUF - 2 (198) bytes of text survive.
		text.truncate(text.floor_char_boundary(ERR_BUF - 2));
		text
	};
	let too_large = || fail("too large", Some(("max", max)));

	let mut p = 0;
	while arg.get(p).is_some_and(u8::is_ascii_digit) {
		p += 1;
	}
	if arg.get(p) == Some(&b'.') {
		p += 1;
		while arg.get(p).is_some_and(u8::is_ascii_digit) {
			p += 1;
		}
	}
	let suffix = match arg.get(p) {
		Some(&c) if c != b'+' && c != b'-' => {
			p += 1;
			c
		}
		_ => def_suf,
	};
	let reps = match suffix.to_ascii_lowercase() {
		b'b' => 0,
		b'k' => 1,
		b'm' => 2,
		b'g' => 3,
		b't' => 4,
		b'p' => 5,
		_ => return Err(fail("invalid", None)),
	};
	let mult: i64 = match arg.get(p) {
		Some(b'b' | b'B') => {
			p += 1;
			1000
		}
		None | Some(b'+' | b'-') => 1024,
		Some(_) if arg.len() >= p + 2 && arg[p..p + 2].eq_ignore_ascii_case(b"ib") => {
			p += 2;
			1024
		}
		Some(_) => return Err(fail("invalid", None)),
	};
	let mut unit: i64 = 1;
	for _ in 0..reps {
		if unit > size_max / mult {
			return Err(too_large());
		}
		unit *= mult;
	}
	let dsize = c_strtod(arg);
	if !dsize.is_finite() || dsize < 0.0 || dsize > size_max as f64 / unit as f64 || (max < 0 && dsize >= size_max as f64 / unit as f64) {
		return Err(too_large());
	}
	let mut size = (dsize * unit as f64) as i64;
	if matches!(arg.get(p), Some(b'+' | b'-')) && arg.get(p + 1) == Some(&b'1') && p != 0 {
		if arg[p] == b'+' {
			if size == size_max {
				return Err(too_large());
			}
			size += 1;
		} else {
			size -= 1;
		}
		p += 2;
	}
	if p != arg.len() {
		return Err(fail("invalid", None));
	}
	if size < 0 || (max >= 0 && size > max) {
		return Err(too_large());
	}
	if size < min && (!unlimited_0 || size != 0) {
		return Err(fail("too small", Some(("min", min))));
	}
	Ok(size)
}

/// Broken-down local time with C `struct tm` conventions (year since 1900, month 0-11).
#[derive(Clone, Copy)]
struct Tm {
	year: i32,
	mon: i32,
	mday: i32,
	hour: i32,
	min: i32,
}

fn local_tm(t: i64, tz: &jiff::tz::TimeZone) -> Option<Tm> {
	let z = jiff::Timestamp::from_second(t).ok()?.to_zoned(tz.clone());
	Some(Tm {
		year: i32::from(z.year()) - 1900,
		mon: i32::from(z.month()) - 1,
		mday: i32::from(z.day()),
		hour: i32::from(z.hour()),
		min: i32::from(z.minute()),
	})
}

/// C mktime(): normalizes an overflowing month/day in place, then converts the
/// local time (DST resolved like `tm_isdst = -1`) to a Unix time.
fn mktime(t: &mut Tm, tz: &jiff::tz::TimeZone) -> Option<i64> {
	let year = i64::from(t.year) + 1900 + i64::from(t.mon.div_euclid(12));
	let mon = t.mon.rem_euclid(12);
	let first = jiff::civil::Date::new(i16::try_from(year).ok()?, (mon + 1) as i8, 1).ok()?;
	let date = first.checked_add(jiff::Span::new().try_days(i64::from(t.mday) - 1).ok()?).ok()?;
	t.year = i32::from(date.year()) - 1900;
	t.mon = i32::from(date.month()) - 1;
	t.mday = i32::from(date.day());
	let hour = i8::try_from(t.hour).ok()?;
	let min = i8::try_from(t.min).ok()?;
	let zoned = date.at(hour, min, 0, 0).to_zoned(tz.clone()).ok()?;
	Some(zoned.timestamp().as_second())
}

/// `--stop-at` parsing: `[[[YY]YY-]MM-]DD[Thh:mm]`, `Thh:mm`, `:mm`, with '/' for '-';
/// omitted parts pick the next matching time in the future (upstream parse_time).
fn parse_time(arg: &[u8], now: i64) -> Option<i64> {
	parse_time_in(arg, now, &jiff::tz::TimeZone::system())
}

fn parse_time_in(arg: &[u8], now: i64, tz: &jiff::tz::TimeZone) -> Option<i64> {
	let today = local_tm(now, tz)?;
	let (mut year, mut mon, mut mday, mut hour, mut min) = (-1i64, -1i64, -1i64, -1i64, -1i64);
	let mut p = 0;
	let mut in_date: i32 = match arg.first() {
		Some(b'T' | b't') => {
			p = 1;
			-1
		}
		Some(b':') => {
			p = 1;
			0
		}
		_ => 1,
	};
	loop {
		if !arg.get(p).is_some_and(u8::is_ascii_digit) {
			return None;
		}
		let mut n: i64 = 0;
		while let Some(d) = arg.get(p).filter(|c| c.is_ascii_digit()) {
			n = n.saturating_mul(10).saturating_add(i64::from(d - b'0'));
			p += 1;
		}
		let next = arg.get(p).copied();
		if next == Some(b':') {
			in_date = 0;
		}
		if in_date > 0 {
			if year != -1 {
				return None;
			}
			year = mon;
			mon = mday;
			mday = n;
			match next {
				None => break,
				Some(b'T' | b't') => {
					if p + 1 == arg.len() {
						break;
					}
					in_date = -1;
				}
				Some(b'-' | b'/') => {}
				Some(_) => return None,
			}
			p += 1;
			continue;
		}
		if hour != -1 {
			return None;
		}
		hour = min;
		min = n;
		match next {
			None => {
				if in_date < 0 {
					return None;
				}
				break;
			}
			Some(b':') => {
				in_date = 0;
				p += 1;
			}
			Some(_) => return None,
		}
	}

	let mut in_date = 0;
	let today_year = i64::from(today.year);
	if year < 0 {
		year = today_year;
		in_date = 1;
	} else if year < 100 {
		while year < today_year {
			year += 100;
		}
	} else {
		year -= 1900;
	}
	if mon < 0 {
		mon = i64::from(today.mon);
		in_date = 2;
	} else {
		mon -= 1;
	}
	if mday < 0 {
		mday = i64::from(today.mday);
		in_date = 3;
	}
	let mut step = 0;
	if min < 0 {
		hour = 0;
		min = 0;
	} else if hour < 0 {
		if in_date != 3 {
			return None;
		}
		in_date = 0;
		hour = i64::from(today.hour);
		step = 60 * 60;
	}
	if hour > 23 || min > 59 || !(0..12).contains(&mon) || !(1..=31).contains(&mday) || year > i64::from(i32::MAX) {
		return None;
	}
	let mut t = Tm { year: year as i32, mon: mon as i32, mday: mday as i32, hour: hour as i32, min: min as i32 };
	let mut old_mday = t.mday;
	let mut val = mktime(&mut t, tz)?;
	let mut guard = 0;
	while in_date != 0 && (val <= now || t.mday < old_mday) {
		guard += 1;
		if guard > 10_000 {
			return None;
		}
		match in_date {
			3 => {
				t.mday += 1;
				old_mday = t.mday;
			}
			2 => {
				if t.mday < old_mday {
					t.mday = old_mday;
				} else {
					t.mon += 1;
					if t.mon == 12 {
						t.mon = 0;
						t.year += 1;
					}
				}
			}
			_ => {
				if t.mday < old_mday {
					if t.mon != 2 || old_mday != 29 {
						return None;
					}
					t.mon = 1;
					t.mday = 29;
				}
				t.year += 1;
			}
		}
		match mktime(&mut t, tz) {
			Some(v) => val = v,
			None => {
				if in_date != 3 || t.mday <= 28 {
					return None;
				}
				t.mday = 1;
				old_mday = 1;
				in_date = 2;
			}
		}
	}
	if step != 0 {
		while val <= now {
			val += step;
		}
	}
	Some(val)
}

// ---------------------------------------------------------------------------
// helpers

/// Upstream log_format_has(): does `format` use the `%<esc>` escape?
pub(crate) fn log_format_has(format: &[u8], esc: u8) -> bool {
	const LOG_FMT_SIZE: usize = 32;
	let mut p = 0;
	while let Some(off) = format[p..].iter().position(|&c| c == b'%') {
		p += off + 1;
		while format.get(p) == Some(&b'\'') {
			p += 1;
		}
		let mut width = 1;
		if format.get(p) == Some(&b'-') {
			p += 1;
			width += 1;
		}
		while format.get(p).is_some_and(u8::is_ascii_digit) && width < LOG_FMT_SIZE - 8 {
			p += 1;
			width += 1;
		}
		while format.get(p) == Some(&b'\'') {
			p += 1;
		}
		let Some(&c) = format.get(p) else { break };
		if c == esc {
			return true;
		}
		if c == b'%' {
			p += 1;
		}
	}
	false
}

/// A Windows drive-letter (`C:\x`, `C:/x`, `C:x`) or UNC (`\\server\share`) path,
/// which is always local there.
fn is_windows_local_path(p: &[u8]) -> bool {
	(p.len() >= 2 && p[0].is_ascii_alphabetic() && p[1] == b':') || p.starts_with(b"\\\\")
}

/// `--confine-root` absoluteness: a leading '/'; on Windows also a leading '\',
/// `C:\`/`C:/`, or a UNC path.
fn is_absolute_operator_path(p: &[u8], windows: bool) -> bool {
	if p.first() == Some(&b'/') {
		return true;
	}
	windows
		&& (p.first() == Some(&b'\\')
			|| (p.len() >= 3 && p[0].is_ascii_alphabetic() && p[1] == b':' && matches!(p[2], b'/' | b'\\')))
}

/// The host part of a `--files-from` value, if it names one (Windows local
/// drive/UNC paths never do).
fn files_from_hostspec(name: &[u8], windows: bool) -> Option<(Vec<u8>, &[u8])> {
	if windows && is_windows_local_path(name) {
		return None;
	}
	check_for_hostspec(name)
}

/// `HOST:PATH` / `HOST::PATH` (no rsync:// form) → ([USER@]HOST, PATH); IPv6
/// literals lose their brackets. None when `s` is not a host spec.
fn check_for_hostspec(s: &[u8]) -> Option<(Vec<u8>, &[u8])> {
	let mut user_len = 0;
	let mut host_start = 0;
	let mut host_len: Option<usize> = None;
	let mut i = 0;
	loop {
		let c = *s.get(i)?;
		if c == b':' || c == b'/' {
			if c == b'/' {
				return None;
			}
			let len = host_len.unwrap_or(i - host_start);
			let mut path = &s[i + 1..];
			if path.first() == Some(&b':') {
				path = &path[1..];
			}
			let mut host = s[..user_len].to_vec();
			host.extend_from_slice(&s[host_start..host_start + len]);
			return Some((host, path));
		}
		if c == b'@' {
			user_len = i + 1;
			host_start = i + 1;
		} else if c == b'[' {
			if i != host_start {
				return None;
			}
			host_start += 1;
			let mut k = i;
			while k < s.len() && s[k] != b']' && s[k] != b'/' {
				k += 1;
			}
			let len = k - host_start;
			let next = s.get(k + 1).copied();
			if s.get(k) != Some(&b']') || next.is_some_and(|n| n != b'/' && n != b':') || len == 0 {
				return None;
			}
			host_len = Some(len);
			i = k;
		}
		i += 1;
	}
}

// ---------------------------------------------------------------------------
// server argv

/// How [`safe_arg`] treats a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SafeOpt<'a> {
	/// A filename operand (wildcards stay live; leading '-' gets "./").
	Filename,
	/// An option value; `Opt("--suffix")` yields `--suffix=VALUE`, `Opt("")` the bare value.
	Opt(&'a str),
	/// A `-M` remote option: not escaped under `--old-args`.
	SplitWhenOld,
}

/// Upstream safe_arg(): backslash-quote shell (and, for options, wildcard)
/// characters for the remote shell, honoring `-s` and `--old-args`.
pub(crate) fn safe_arg(opts: &Options, am_sender: bool, opt: SafeOpt<'_>, arg: &[u8]) -> Vec<u8> {
	let is_filename = opt == SafeOpt::Filename;
	let escape = opts.protect_args <= 0
		&& opts.old_style_args < 2
		&& (opts.old_style_args == 0 || (!is_filename && opt != SafeOpt::SplitWhenOld));
	if is_filename {
		let rules = FileArgRules {
			escape,
			am_sender,
			trust_sender_args: opts.trust_sender_args,
			relative_paths: opts.relative_paths > 0,
		};
		return safe_file_arg(arg, rules);
	}
	let mut out = Vec::with_capacity(arg.len() + 16);
	if let SafeOpt::Opt(name) = opt
		&& !name.is_empty()
	{
		out.extend_from_slice(name.as_bytes());
		out.push(b'=');
	}
	if escape {
		escape_shell_arg(&mut out, arg, false);
	} else {
		out.extend_from_slice(arg);
	}
	out
}

/// server_options(): the remote argv tail after `rsync --server [--sender]`.
pub(crate) fn server_args(opts: &Options, remote_is_sender: bool) -> Vec<std::ffi::OsString> {
	server_args_split(opts, remote_is_sender).0
}

/// [`server_args`] plus upstream's secluded-args cut: with `-s`, `args[..cut]` go on
/// the remote command line and `args[cut..]` (followed by "." and the operands)
/// are sent through the protocol by send_protected_args.
pub(crate) fn server_args_split(opts: &Options, remote_is_sender: bool) -> (Vec<OsString>, Option<usize>) {
	let o = opts;
	let am_sender = !remote_is_sender;
	let mut args: Vec<Vec<u8>> = Vec::new();
	let mut cut = None;
	let safe = |name: &str, v: &[u8]| safe_arg(o, am_sender, SafeOpt::Opt(name), v);

	let mut s = vec![b'-'];
	if o.protect_args > 0 {
		s.push(b's');
	}
	for _ in 0..o.verbose.min(9) {
		s.push(b'v');
	}
	if o.quiet != 0 && o.msgs2stderr != 0 {
		s.push(b'q');
	}
	if o.make_backups {
		s.push(b'b');
	}
	if o.update_only {
		s.push(b'u');
	}
	if !o.do_xfers {
		s.push(b'n');
	}
	if o.preserve_links {
		s.push(b'l');
	}
	if (o.xfer_dirs >= 2 && o.xfer_dirs < 4)
		|| (o.xfer_dirs != 0 && o.recurse == 0 && (o.list_only != 0 || (o.delete_mode && am_sender)))
	{
		s.push(b'd');
	}
	if am_sender {
		if o.keep_dirlinks {
			s.push(b'K');
		}
		if o.prune_empty_dirs {
			s.push(b'm');
		}
		if o.omit_dir_times > 0 {
			s.push(b'O');
		}
		if o.omit_link_times {
			s.push(b'J');
		}
		if o.fuzzy_basis != 0 {
			s.push(b'y');
			if o.fuzzy_basis > 1 {
				s.push(b'y');
			}
		}
	} else {
		if o.copy_links {
			s.push(b'L');
		}
		if o.copy_dirlinks {
			s.push(b'k');
		}
	}
	if o.whole_file > 0 {
		s.push(b'W');
	}
	if o.preserve_hard_links != 0 {
		s.push(b'H');
		if o.preserve_hard_links > 1 {
			s.push(b'H');
		}
	}
	if o.preserve_uid {
		s.push(b'o');
	}
	if o.preserve_gid {
		s.push(b'g');
	}
	if o.preserve_devices {
		s.push(b'D');
	}
	if o.preserve_mtimes {
		s.push(b't');
	}
	if o.preserve_atimes != 0 {
		s.push(b'U');
		if o.preserve_atimes > 1 {
			s.push(b'U');
		}
	}
	if o.preserve_crtimes && crate::rsync::usage::SUPPORT_CRTIMES {
		s.push(b'N');
	}
	if o.preserve_perms {
		s.push(b'p');
	} else if o.preserve_executability && am_sender {
		s.push(b'E');
	}
	if o.preserve_acls && crate::rsync::usage::SUPPORT_ACLS {
		s.push(b'A');
	}
	if o.preserve_xattrs != 0 && crate::rsync::usage::SUPPORT_XATTRS {
		s.push(b'X');
		if o.preserve_xattrs > 1 {
			s.push(b'X');
		}
	}
	if o.recurse != 0 {
		s.push(b'r');
	}
	if o.always_checksum {
		s.push(b'c');
	}
	if o.cvs_exclude {
		s.push(b'C');
	}
	if o.ignore_times {
		s.push(b'I');
	}
	if o.relative_paths > 0 {
		s.push(b'R');
	}
	if o.one_file_system != 0 {
		s.push(b'x');
		if o.one_file_system > 1 {
			s.push(b'x');
		}
	}
	if o.sparse_files {
		s.push(b'S');
	}
	if o.do_compression == CPRES_ZLIB {
		s.push(b'z');
	}
	if o.protocol_version >= 30 {
		// set_allow_inc_recurse() as the (non-server) client sees it.
		let inc_recurse = o.recurse != 0
			&& !o.use_qsort
			&& o.allow_inc_recurse
			&& (am_sender || !(o.delete_before || o.delete_after || o.delay_updates || o.prune_empty_dirs));
		s.extend_from_slice(b"e.");
		if inc_recurse {
			s.push(b'i');
		}
		s.push(b'L');
		if crate::rsync::usage::SUPPORT_ICONV {
			s.push(b's');
		}
		s.extend_from_slice(b"fxCIvu");
	}
	if s.len() > 1 {
		args.push(s);
	}

	if let Some(iconv) = &o.iconv_opt {
		let spec_bytes = os_bytes_lossy(iconv);
		let spec: &[u8] = &spec_bytes;
		let set = spec.iter().position(|&c| c == b',').map_or(spec, |c| &spec[c + 1..]);
		args.push(safe("--iconv", set));
	}

	if o.protect_args > 0 {
		cut = Some(args.len());
	}

	if o.list_only > 1 {
		args.push(b"--list-only".to_vec());
	}
	if o.xfer_dirs != 0 && o.recurse == 0 && o.delete_mode && am_sender {
		args.push(b"--no-r".to_vec());
	}
	if o.do_compression != 0 {
		if let Some(level) = o.do_compression_level {
			args.push(format!("--compress-level={level}").into_bytes());
		}
	}
	if o.preserve_devices {
		if !o.preserve_specials {
			args.push(b"--no-specials".to_vec());
		}
	} else if o.preserve_specials {
		args.push(b"--specials".to_vec());
	}
	if o.stdout_format.is_some() && am_sender {
		if o.stdout_format_has_i > 1 {
			args.push(b"--log-format=%i%I".to_vec());
		} else if o.stdout_format_has_i != 0 {
			args.push(b"--log-format=%i".to_vec());
		} else if o.stdout_format_has_o_or_i {
			args.push(b"--log-format=%o".to_vec());
		} else if o.verbose == 0 {
			args.push(b"--log-format=X".to_vec());
		}
	}
	match o.msgs2stderr {
		1 => args.push(b"--msgs2stderr".to_vec()),
		0 => args.push(b"--no-msgs2stderr".to_vec()),
		_ => {}
	}
	if o.block_size != 0 {
		args.push(format!("-B{}", o.block_size as u32).into_bytes());
	}
	if o.io_timeout != 0 {
		args.push(format!("--timeout={}", o.io_timeout).into_bytes());
	}
	if o.bwlimit != 0 {
		args.push(format!("--bwlimit={}", o.bwlimit).into_bytes());
	}
	if let Some(dir) = &o.backup_dir {
		args.push(b"--backup-dir".to_vec());
		args.push(safe("", &os_bytes_lossy(dir)));
	}
	let default_suffix: &[u8] = if o.backup_dir.is_some() { b"" } else { BACKUP_SUFFIX.as_bytes() };
	let suffix_bytes = o.backup_suffix.as_deref().map(os_bytes_lossy);
	let suffix: &[u8] = suffix_bytes.as_deref().unwrap_or(default_suffix);
	if suffix != default_suffix {
		args.push(safe("--suffix", suffix));
	}
	if let Some(choice) = &o.checksum_choice {
		args.push(safe("--checksum-choice", &os_bytes_lossy(choice)));
	}
	if o.do_compression == CPRES_ZLIBX {
		args.push(b"--new-compress".to_vec());
	} else if o.compress_choice.is_some() && o.do_compression == CPRES_ZLIB {
		args.push(b"--old-compress".to_vec());
	} else if let Some(choice) = &o.compress_choice {
		args.push(safe("--compress-choice", &os_bytes_lossy(choice)));
	}

	if am_sender {
		if o.max_delete > 0 {
			args.push(format!("--max-delete={}", o.max_delete).into_bytes());
		} else if o.max_delete == 0 {
			args.push(b"--max-delete=-1".to_vec());
		}
		if o.min_size >= 0 {
			args.push(safe("--min-size", o.min_size_arg.as_deref().unwrap_or("0").as_bytes()));
		}
		if o.max_size >= 0 {
			args.push(safe("--max-size", o.max_size_arg.as_deref().unwrap_or("0").as_bytes()));
		}
		if o.delete_before {
			args.push(b"--delete-before".to_vec());
		} else if o.delete_during == 2 {
			args.push(b"--delete-delay".to_vec());
		} else if o.delete_during != 0 {
			args.push(b"--delete-during".to_vec());
		} else if o.delete_after {
			args.push(b"--delete-after".to_vec());
		} else if o.delete_mode && !o.delete_excluded {
			args.push(b"--delete".to_vec());
		}
		if o.delete_excluded {
			args.push(b"--delete-excluded".to_vec());
		}
		if o.force_delete {
			args.push(b"--force".to_vec());
		}
		if o.write_batch < 0 {
			args.push(b"--only-write-batch=X".to_vec());
		}
		if o.am_root > 1 {
			args.push(b"--super".to_vec());
		}
		if o.size_only {
			args.push(b"--size-only".to_vec());
		}
		if o.do_stats {
			args.push(b"--stats".to_vec());
		}
	} else if let Some(skip) = &o.skip_compress {
		args.push(safe("--skip-compress", &os_bytes_lossy(skip)));
	}

	if let Some(arg) = &o.max_alloc_arg {
		if o.max_alloc != DEFAULT_MAX_ALLOC {
			args.push(safe("--max-alloc", &os_bytes_lossy(arg)));
		}
	}
	if o.missing_args == 2 {
		args.push(b"--delete-missing-args".to_vec());
	} else if o.missing_args == 1 && !am_sender {
		args.push(b"--ignore-missing-args".to_vec());
	}
	if o.modify_window_set && am_sender {
		if o.modify_window < 0 {
			args.push(format!("-@{}", o.modify_window).into_bytes());
		} else {
			args.push(format!("--modify-window={}", o.modify_window).into_bytes());
		}
	}
	if o.checksum_seed != 0 {
		args.push(format!("--checksum-seed={}", o.checksum_seed).into_bytes());
	}
	if let Some(dir) = o.partial_dir.as_ref().filter(|_| am_sender) {
		if !o.partial_dir_is_tmp {
			args.push(b"--partial-dir".to_vec());
			args.push(safe("", &os_bytes_lossy(dir)));
		}
		if o.delay_updates {
			args.push(b"--delay-updates".to_vec());
		}
	} else if o.keep_partial && am_sender {
		args.push(b"--partial".to_vec());
	}
	if o.ignore_errors {
		args.push(b"--ignore-errors".to_vec());
	}
	if o.copy_unsafe_links {
		args.push(b"--copy-unsafe-links".to_vec());
	}
	if o.safe_symlinks {
		args.push(b"--safe-links".to_vec());
	}
	if o.numeric_ids {
		args.push(b"--numeric-ids".to_vec());
	}
	if o.use_qsort {
		// Upstream sends this spelling although the option table only knows --qsort.
		args.push(b"--use-qsort".to_vec());
	}
	if am_sender {
		if let Some(map) = &o.usermap {
			args.push(safe("--usermap", &os_bytes_lossy(map)));
		}
		if let Some(map) = &o.groupmap {
			args.push(safe("--groupmap", &os_bytes_lossy(map)));
		}
		if o.ignore_existing {
			args.push(b"--ignore-existing".to_vec());
		}
		if o.ignore_non_existing {
			args.push(b"--existing".to_vec());
		}
		if let Some(dir) = &o.tmpdir {
			args.push(b"--temp-dir".to_vec());
			args.push(safe("", &os_bytes_lossy(dir)));
		}
		if o.do_fsync {
			args.push(b"--fsync".to_vec());
		}
		for dir in &o.basis_dirs {
			args.push(alt_dest_opt(o.alt_dest_type).as_bytes().to_vec());
			args.push(safe("", &os_bytes_lossy(dir)));
		}
	}
	if let Some(info) = o.levels.server_info_arg(o.am_server, am_sender) {
		args.push(info.into_bytes());
	}
	if o.append_mode != 0 {
		if o.append_mode > 1 {
			args.push(b"--append".to_vec());
		}
		args.push(b"--append".to_vec());
	} else if o.inplace {
		args.push(b"--inplace".to_vec());
		if o.sparse_files && o.whole_file == 0 && am_sender {
			args.push(b"--no-W".to_vec());
		}
	}
	if let Some(files_from) = &o.files_from {
		if !am_sender || o.filesfrom_host.is_some() {
			if o.filesfrom_host.is_some() {
				args.push(b"--files-from".to_vec());
				args.push(safe("", &os_bytes_lossy(files_from)));
				if o.eol_nulls {
					args.push(b"--from0".to_vec());
				}
			} else {
				args.push(b"--files-from=-".to_vec());
				args.push(b"--from0".to_vec());
			}
			if o.relative_paths <= 0 {
				args.push(b"--no-relative".to_vec());
			}
		}
	}
	if o.relative_paths > 0 && !o.implied_dirs && (!am_sender || o.protocol_version >= 30) {
		args.push(b"--no-implied-dirs".to_vec());
	}
	if o.write_devices && am_sender {
		args.push(b"--write-devices".to_vec());
	}
	match o.remove_source_files {
		0 => {}
		1 => args.push(b"--remove-source-files".to_vec()),
		_ => args.push(b"--remove-sent-files".to_vec()),
	}
	if o.copy_devices && !am_sender {
		args.push(b"--copy-devices".to_vec());
	}
	if o.preallocate_files && am_sender {
		args.push(b"--preallocate".to_vec());
	}
	if o.open_noatime && o.preserve_atimes <= 1 {
		args.push(b"--open-noatime".to_vec());
	}
	if o.mkpath_dest_arg && am_sender {
		args.push(b"--mkpath".to_vec());
	}
	for opt in &o.remote_options {
		args.push(safe_arg(o, am_sender, SafeOpt::SplitWhenOld, &os_bytes_lossy(opt)));
	}
	(args.into_iter().map(vec_os_lossy).collect(), cut)
}

#[cfg(test)]
mod tests;
