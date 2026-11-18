//! The command-line option tables: every long/short option rsync 3.5.1 accepts,
//! with what it does to [`Options`](super::Options).
//!
//! Each entry maps a spelling to an action run by the popt-style scanner in
//! `options.rs`. Actions see the parse state and the option's value (if the
//! option takes one) and may stop the scan (errors, `--help`, mode switches).

use super::{FilterOpt, Kind, Parser, Spec, Step, Stop, Val};
use crate::host::os_bytes_lossy;
use crate::rsync::usage::{SUPPORT_ACLS, SUPPORT_CRTIMES, SUPPORT_XATTRS};

const fn s(long: &'static str, short: u8, kind: Kind, act: fn(&mut Parser<'_>, Val) -> Step) -> Spec {
	Spec { long, short, kind, act }
}

const N: Kind = Kind::None;
const S: Kind = Kind::Str;
const I: Kind = Kind::Int;

/// Refuses an option this build cannot honor (upstream `create_refuse_error`).
fn refuse(p: &mut Parser<'_>, long: &str, short: u8) -> Step {
	let who = if p.o.am_server { "The server does not support" } else { "This rsync does not support" };
	let mut text = format!("{who} --{long}");
	if short != 0 {
		text.push_str(&format!(" (-{})", short as char));
	}
	Err(p.option_error(text))
}

/// "client"/"server" for the not-supported-on-this-side messages.
fn side(p: &Parser<'_>) -> &'static str {
	if p.o.am_server { "server" } else { "client" }
}

fn crtimes(p: &mut Parser<'_>, on: bool) -> Step {
	if on && !SUPPORT_CRTIMES {
		return refuse(p, "crtimes", b'N');
	}
	p.o.preserve_crtimes = on;
	Ok(())
}

fn alt_dest(p: &mut Parser<'_>, kind: u8, v: Val) -> Step {
	if p.o.alt_dest_type != 0 && p.o.alt_dest_type != kind {
		return Err(p.option_error(format!(
			"ERROR: the {} option conflicts with the {} option",
			super::alt_dest_opt(kind),
			super::alt_dest_opt(p.o.alt_dest_type)
		)));
	}
	p.o.alt_dest_type = kind;
	if p.o.basis_dirs.len() >= super::MAX_BASIS_DIRS {
		return Err(p.option_error(format!(
			"ERROR: at most {} {} args may be specified",
			super::MAX_BASIS_DIRS,
			super::alt_dest_opt(kind)
		)));
	}
	p.o.basis_dirs.push(v.os());
	Ok(())
}

fn filter(p: &mut Parser<'_>, rule: FilterOpt) -> Step {
	p.o.filter_rules.push(rule);
	Ok(())
}

/// The client/server option table (upstream `long_options[]`, same order).
pub(super) static LONG_OPTIONS: &[Spec] = &[
	s("help", 0, N, |p, _| Err(p.help())),
	s("version", b'V', N, |p, _| {
		p.version_cnt += 1;
		Ok(())
	}),
	s("verbose", b'v', N, |p, _| {
		p.o.verbose = p.o.verbose.saturating_add(1);
		Ok(())
	}),
	s("no-verbose", 0, N, |p, _| {
		p.o.verbose = 0;
		Ok(())
	}),
	s("no-v", 0, N, |p, _| {
		p.o.verbose = 0;
		Ok(())
	}),
	s("info", 0, S, |p, v| p.output_words(false, &v)),
	s("debug", 0, S, |p, v| p.output_words(true, &v)),
	s("stderr", 0, S, |p, v| p.stderr_mode(&v)),
	s("msgs2stderr", 0, N, |p, _| {
		p.o.msgs2stderr = 1;
		Ok(())
	}),
	s("no-msgs2stderr", 0, N, |p, _| {
		p.o.msgs2stderr = 0;
		Ok(())
	}),
	s("quiet", b'q', N, |p, _| {
		p.o.quiet = p.o.quiet.saturating_add(1);
		Ok(())
	}),
	s("motd", 0, N, |p, _| {
		p.o.output_motd = true;
		Ok(())
	}),
	s("no-motd", 0, N, |p, _| {
		p.o.output_motd = false;
		Ok(())
	}),
	s("stats", 0, N, |p, _| {
		p.o.do_stats = true;
		Ok(())
	}),
	s("human-readable", b'h', N, |p, _| {
		p.o.human_readable = p.o.human_readable.saturating_add(1);
		Ok(())
	}),
	s("no-human-readable", 0, N, |p, _| {
		p.o.human_readable = 0;
		Ok(())
	}),
	s("no-h", 0, N, |p, _| {
		p.o.human_readable = 0;
		Ok(())
	}),
	s("dry-run", b'n', N, |p, _| {
		p.o.dry_run = true;
		Ok(())
	}),
	s("archive", b'a', N, |p, _| {
		let o = &mut p.o;
		if o.recurse == 0 {
			o.recurse = 1;
		}
		o.preserve_links = true;
		o.preserve_perms = true;
		o.preserve_mtimes = true;
		o.preserve_gid = true;
		o.preserve_uid = true;
		o.preserve_devices = true;
		o.preserve_specials = true;
		Ok(())
	}),
	s("recursive", b'r', N, |p, _| {
		p.o.recurse = 2;
		Ok(())
	}),
	s("no-recursive", 0, N, |p, _| {
		p.o.recurse = 0;
		Ok(())
	}),
	s("no-r", 0, N, |p, _| {
		p.o.recurse = 0;
		Ok(())
	}),
	s("inc-recursive", 0, N, |p, _| {
		p.o.allow_inc_recurse = true;
		Ok(())
	}),
	s("no-inc-recursive", 0, N, |p, _| {
		p.o.allow_inc_recurse = false;
		Ok(())
	}),
	s("i-r", 0, N, |p, _| {
		p.o.allow_inc_recurse = true;
		Ok(())
	}),
	s("no-i-r", 0, N, |p, _| {
		p.o.allow_inc_recurse = false;
		Ok(())
	}),
	s("dirs", b'd', N, |p, _| {
		p.o.xfer_dirs = 2;
		Ok(())
	}),
	s("no-dirs", 0, N, |p, _| {
		p.o.xfer_dirs = 0;
		Ok(())
	}),
	s("no-d", 0, N, |p, _| {
		p.o.xfer_dirs = 0;
		Ok(())
	}),
	s("old-dirs", 0, N, |p, _| {
		p.o.xfer_dirs = 4;
		Ok(())
	}),
	s("old-d", 0, N, |p, _| {
		p.o.xfer_dirs = 4;
		Ok(())
	}),
	s("perms", b'p', N, |p, _| {
		p.o.preserve_perms = true;
		Ok(())
	}),
	s("no-perms", 0, N, |p, _| {
		p.o.preserve_perms = false;
		Ok(())
	}),
	s("no-p", 0, N, |p, _| {
		p.o.preserve_perms = false;
		Ok(())
	}),
	s("executability", b'E', N, |p, _| {
		p.o.preserve_executability = true;
		Ok(())
	}),
	s("acls", b'A', N, |p, _| {
		if !SUPPORT_ACLS {
			return Err(p.option_error(format!("ACLs are not supported on this {}", side(p))));
		}
		p.o.preserve_acls = true;
		p.o.preserve_perms = true;
		Ok(())
	}),
	s("no-acls", 0, N, |p, _| {
		p.o.preserve_acls = false;
		Ok(())
	}),
	s("no-A", 0, N, |p, _| {
		p.o.preserve_acls = false;
		Ok(())
	}),
	s("xattrs", b'X', N, |p, _| {
		if !SUPPORT_XATTRS {
			return Err(p.option_error(format!("extended attributes are not supported on this {}", side(p))));
		}
		p.o.preserve_xattrs = p.o.preserve_xattrs.saturating_add(1);
		Ok(())
	}),
	s("no-xattrs", 0, N, |p, _| {
		p.o.preserve_xattrs = 0;
		Ok(())
	}),
	s("no-X", 0, N, |p, _| {
		p.o.preserve_xattrs = 0;
		Ok(())
	}),
	s("times", b't', N, |p, _| {
		p.o.preserve_mtimes = true;
		Ok(())
	}),
	s("no-times", 0, N, |p, _| {
		p.o.preserve_mtimes = false;
		Ok(())
	}),
	s("no-t", 0, N, |p, _| {
		p.o.preserve_mtimes = false;
		Ok(())
	}),
	s("atimes", b'U', N, |p, _| {
		p.o.preserve_atimes = p.o.preserve_atimes.saturating_add(1);
		if p.o.preserve_atimes > 1 {
			p.o.open_noatime = true;
		}
		Ok(())
	}),
	s("no-atimes", 0, N, |p, _| {
		p.o.preserve_atimes = 0;
		Ok(())
	}),
	s("no-U", 0, N, |p, _| {
		p.o.preserve_atimes = 0;
		Ok(())
	}),
	s("open-noatime", 0, N, |p, _| {
		p.o.open_noatime = true;
		Ok(())
	}),
	s("no-open-noatime", 0, N, |p, _| {
		p.o.open_noatime = false;
		Ok(())
	}),
	s("crtimes", b'N', N, |p, _| crtimes(p, true)),
	s("no-crtimes", 0, N, |p, _| crtimes(p, false)),
	s("no-N", 0, N, |p, _| crtimes(p, false)),
	s("omit-dir-times", b'O', N, |p, _| {
		p.o.omit_dir_times = 1;
		Ok(())
	}),
	s("no-omit-dir-times", 0, N, |p, _| {
		p.o.omit_dir_times = 0;
		Ok(())
	}),
	s("no-O", 0, N, |p, _| {
		p.o.omit_dir_times = 0;
		Ok(())
	}),
	s("omit-link-times", b'J', N, |p, _| {
		p.o.omit_link_times = true;
		Ok(())
	}),
	s("no-omit-link-times", 0, N, |p, _| {
		p.o.omit_link_times = false;
		Ok(())
	}),
	s("no-J", 0, N, |p, _| {
		p.o.omit_link_times = false;
		Ok(())
	}),
	s("modify-window", b'@', I, |p, v| {
		p.o.modify_window = v.int();
		p.o.modify_window_set = true;
		Ok(())
	}),
	s("super", 0, N, |p, _| {
		p.o.am_root = 2;
		Ok(())
	}),
	s("no-super", 0, N, |p, _| {
		p.o.am_root = 0;
		Ok(())
	}),
	s("fake-super", 0, N, |p, _| {
		p.o.am_root = -1;
		Ok(())
	}),
	s("owner", b'o', N, |p, _| {
		p.o.preserve_uid = true;
		Ok(())
	}),
	s("no-owner", 0, N, |p, _| {
		p.o.preserve_uid = false;
		Ok(())
	}),
	s("no-o", 0, N, |p, _| {
		p.o.preserve_uid = false;
		Ok(())
	}),
	s("group", b'g', N, |p, _| {
		p.o.preserve_gid = true;
		Ok(())
	}),
	s("no-group", 0, N, |p, _| {
		p.o.preserve_gid = false;
		Ok(())
	}),
	s("no-g", 0, N, |p, _| {
		p.o.preserve_gid = false;
		Ok(())
	}),
	s("", b'D', N, |p, _| {
		p.o.preserve_devices = true;
		p.o.preserve_specials = true;
		Ok(())
	}),
	s("no-D", 0, N, |p, _| {
		p.o.preserve_devices = false;
		p.o.preserve_specials = false;
		Ok(())
	}),
	s("devices", 0, N, |p, _| {
		p.o.preserve_devices = true;
		Ok(())
	}),
	s("no-devices", 0, N, |p, _| {
		p.o.preserve_devices = false;
		Ok(())
	}),
	s("copy-devices", 0, N, |p, _| {
		p.o.copy_devices = true;
		Ok(())
	}),
	s("write-devices", 0, N, |p, _| {
		p.o.write_devices = true;
		Ok(())
	}),
	s("no-write-devices", 0, N, |p, _| {
		p.o.write_devices = false;
		Ok(())
	}),
	s("specials", 0, N, |p, _| {
		p.o.preserve_specials = true;
		Ok(())
	}),
	s("no-specials", 0, N, |p, _| {
		p.o.preserve_specials = false;
		Ok(())
	}),
	s("drop-D", 0, N, |p, _| {
		p.o.drop_devices = true;
		Ok(())
	}),
	s("no-drop-D", 0, N, |p, _| {
		p.o.drop_devices = false;
		Ok(())
	}),
	s("confine-root", 0, S, |p, v| {
		p.o.confine_root = Some(v.os());
		Ok(())
	}),
	s("links", b'l', N, |p, _| {
		p.o.preserve_links = true;
		Ok(())
	}),
	s("no-links", 0, N, |p, _| {
		p.o.preserve_links = false;
		Ok(())
	}),
	s("no-l", 0, N, |p, _| {
		p.o.preserve_links = false;
		Ok(())
	}),
	s("copy-links", b'L', N, |p, _| {
		p.o.copy_links = true;
		Ok(())
	}),
	s("copy-unsafe-links", 0, N, |p, _| {
		p.o.copy_unsafe_links = true;
		Ok(())
	}),
	s("safe-links", 0, N, |p, _| {
		p.o.safe_symlinks = true;
		Ok(())
	}),
	s("insecure-links", 0, N, |p, _| {
		p.o.insecure_links = true;
		Ok(())
	}),
	s("no-insecure-links", 0, N, |p, _| {
		p.o.insecure_links = false;
		Ok(())
	}),
	s("munge-links", 0, N, |p, _| {
		p.o.munge_symlinks = true;
		Ok(())
	}),
	s("no-munge-links", 0, N, |p, _| {
		p.o.munge_symlinks = false;
		Ok(())
	}),
	s("copy-dirlinks", b'k', N, |p, _| {
		p.o.copy_dirlinks = true;
		Ok(())
	}),
	s("keep-dirlinks", b'K', N, |p, _| {
		p.o.keep_dirlinks = true;
		Ok(())
	}),
	s("hard-links", b'H', N, |p, _| {
		p.o.preserve_hard_links = p.o.preserve_hard_links.saturating_add(1);
		Ok(())
	}),
	s("no-hard-links", 0, N, |p, _| {
		p.o.preserve_hard_links = 0;
		Ok(())
	}),
	s("no-H", 0, N, |p, _| {
		p.o.preserve_hard_links = 0;
		Ok(())
	}),
	s("relative", b'R', N, |p, _| {
		p.o.relative_paths = 1;
		Ok(())
	}),
	s("no-relative", 0, N, |p, _| {
		p.o.relative_paths = 0;
		Ok(())
	}),
	s("no-R", 0, N, |p, _| {
		p.o.relative_paths = 0;
		Ok(())
	}),
	s("implied-dirs", 0, N, |p, _| {
		p.o.implied_dirs = true;
		Ok(())
	}),
	s("no-implied-dirs", 0, N, |p, _| {
		p.o.implied_dirs = false;
		Ok(())
	}),
	s("i-d", 0, N, |p, _| {
		p.o.implied_dirs = true;
		Ok(())
	}),
	s("no-i-d", 0, N, |p, _| {
		p.o.implied_dirs = false;
		Ok(())
	}),
	s("chmod", 0, S, |p, v| p.chmod(v)),
	s("ignore-times", b'I', N, |p, _| {
		p.o.ignore_times = true;
		Ok(())
	}),
	s("size-only", 0, N, |p, _| {
		p.o.size_only = true;
		Ok(())
	}),
	s("one-file-system", b'x', N, |p, _| {
		p.o.one_file_system = p.o.one_file_system.saturating_add(1);
		Ok(())
	}),
	s("no-one-file-system", 0, N, |p, _| {
		p.o.one_file_system = 0;
		Ok(())
	}),
	s("no-x", 0, N, |p, _| {
		p.o.one_file_system = 0;
		Ok(())
	}),
	s("update", b'u', N, |p, _| {
		p.o.update_only = true;
		Ok(())
	}),
	s("existing", 0, N, |p, _| {
		p.o.ignore_non_existing = true;
		Ok(())
	}),
	s("ignore-non-existing", 0, N, |p, _| {
		p.o.ignore_non_existing = true;
		Ok(())
	}),
	s("ignore-existing", 0, N, |p, _| {
		p.o.ignore_existing = true;
		Ok(())
	}),
	s("max-size", 0, S, |p, v| p.min_max_size(true, &v)),
	s("min-size", 0, S, |p, v| p.min_max_size(false, &v)),
	s("max-alloc", 0, S, |p, v| {
		p.o.max_alloc_arg = Some(v.os());
		Ok(())
	}),
	s("sparse", b'S', N, |p, _| {
		p.o.sparse_files = true;
		Ok(())
	}),
	s("no-sparse", 0, N, |p, _| {
		p.o.sparse_files = false;
		Ok(())
	}),
	s("no-S", 0, N, |p, _| {
		p.o.sparse_files = false;
		Ok(())
	}),
	s("preallocate", 0, N, |p, _| {
		p.o.preallocate_files = true;
		Ok(())
	}),
	s("inplace", 0, N, |p, _| {
		p.o.inplace = true;
		Ok(())
	}),
	s("no-inplace", 0, N, |p, _| {
		p.o.inplace = false;
		Ok(())
	}),
	s("append", 0, N, |p, _| {
		p.o.append_mode = if p.o.am_server { p.o.append_mode.saturating_add(1) } else { 1 };
		Ok(())
	}),
	s("append-verify", 0, N, |p, _| {
		p.o.append_mode = 2;
		Ok(())
	}),
	s("no-append", 0, N, |p, _| {
		p.o.append_mode = 0;
		Ok(())
	}),
	s("del", 0, N, |p, _| {
		p.o.delete_during = 1;
		Ok(())
	}),
	s("delete", 0, N, |p, _| {
		p.o.delete_mode = true;
		Ok(())
	}),
	s("delete-before", 0, N, |p, _| {
		p.o.delete_before = true;
		Ok(())
	}),
	s("delete-during", 0, N, |p, _| {
		p.o.delete_during = 1;
		Ok(())
	}),
	s("delete-delay", 0, N, |p, _| {
		p.o.delete_during = 2;
		Ok(())
	}),
	s("delete-after", 0, N, |p, _| {
		p.o.delete_after = true;
		Ok(())
	}),
	s("delete-excluded", 0, N, |p, _| {
		p.o.delete_excluded = true;
		Ok(())
	}),
	s("delete-missing-args", 0, N, |p, _| {
		p.o.missing_args |= 2;
		Ok(())
	}),
	s("ignore-missing-args", 0, N, |p, _| {
		p.o.missing_args |= 1;
		Ok(())
	}),
	s("remove-sent-files", 0, N, |p, _| {
		p.o.remove_source_files = 2;
		Ok(())
	}),
	s("remove-source-files", 0, N, |p, _| {
		p.o.remove_source_files = 1;
		Ok(())
	}),
	s("force", 0, N, |p, _| {
		p.o.force_delete = true;
		Ok(())
	}),
	s("no-force", 0, N, |p, _| {
		p.o.force_delete = false;
		Ok(())
	}),
	s("ignore-errors", 0, N, |p, _| {
		p.o.ignore_errors = true;
		Ok(())
	}),
	s("no-ignore-errors", 0, N, |p, _| {
		p.o.ignore_errors = false;
		Ok(())
	}),
	s("max-delete", 0, I, |p, v| {
		p.o.max_delete = v.int();
		Ok(())
	}),
	s("", b'F', N, |p, _| {
		p.o.f_option_cnt = p.o.f_option_cnt.saturating_add(1);
		match p.o.f_option_cnt {
			1 => filter(p, FilterOpt::Filter(b": /.rsync-filter".to_vec())),
			2 => filter(p, FilterOpt::Filter(b"- .rsync-filter".to_vec())),
			_ => Ok(()),
		}
	}),
	s("filter", b'f', S, |p, v| filter(p, FilterOpt::Filter(v.bytes()))),
	s("exclude", 0, S, |p, v| filter(p, FilterOpt::Exclude(v.bytes()))),
	s("include", 0, S, |p, v| filter(p, FilterOpt::Include(v.bytes()))),
	s("exclude-from", 0, S, |p, v| filter(p, FilterOpt::ExcludeFrom(v.os()))),
	s("include-from", 0, S, |p, v| filter(p, FilterOpt::IncludeFrom(v.os()))),
	s("cvs-exclude", b'C', N, |p, _| {
		p.o.cvs_exclude = true;
		Ok(())
	}),
	s("whole-file", b'W', N, |p, _| {
		p.o.whole_file = 1;
		Ok(())
	}),
	s("no-whole-file", 0, N, |p, _| {
		p.o.whole_file = 0;
		Ok(())
	}),
	s("no-W", 0, N, |p, _| {
		p.o.whole_file = 0;
		Ok(())
	}),
	s("checksum", b'c', N, |p, _| {
		p.o.always_checksum = true;
		Ok(())
	}),
	s("no-checksum", 0, N, |p, _| {
		p.o.always_checksum = false;
		Ok(())
	}),
	s("no-c", 0, N, |p, _| {
		p.o.always_checksum = false;
		Ok(())
	}),
	s("checksum-choice", 0, S, |p, v| {
		p.o.checksum_choice = Some(v.os());
		Ok(())
	}),
	s("cc", 0, S, |p, v| {
		p.o.checksum_choice = Some(v.os());
		Ok(())
	}),
	s("block-size", b'B', S, |p, v| p.block_size(&v)),
	s("compare-dest", 0, S, |p, v| alt_dest(p, super::COMPARE_DEST, v)),
	s("copy-dest", 0, S, |p, v| alt_dest(p, super::COPY_DEST, v)),
	s("link-dest", 0, S, |p, v| alt_dest(p, super::LINK_DEST, v)),
	s("fuzzy", b'y', N, |p, _| {
		p.o.fuzzy_basis = p.o.fuzzy_basis.saturating_add(1);
		Ok(())
	}),
	s("no-fuzzy", 0, N, |p, _| {
		p.o.fuzzy_basis = 0;
		Ok(())
	}),
	s("no-y", 0, N, |p, _| {
		p.o.fuzzy_basis = 0;
		Ok(())
	}),
	s("compress", b'z', N, |p, _| {
		p.o.do_compression = p.o.do_compression.saturating_add(1);
		Ok(())
	}),
	s("old-compress", 0, N, |p, _| {
		p.o.compress_choice = Some("zlib".into());
		Ok(())
	}),
	s("new-compress", 0, N, |p, _| {
		p.o.compress_choice = Some("zlibx".into());
		Ok(())
	}),
	s("no-compress", 0, N, |p, _| {
		p.o.do_compression = 0;
		p.o.compress_choice = None;
		Ok(())
	}),
	s("no-z", 0, N, |p, _| {
		p.o.do_compression = 0;
		p.o.compress_choice = None;
		Ok(())
	}),
	s("compress-choice", 0, S, |p, v| {
		p.o.compress_choice = Some(v.os());
		Ok(())
	}),
	s("zc", 0, S, |p, v| {
		p.o.compress_choice = Some(v.os());
		Ok(())
	}),
	s("skip-compress", 0, S, |p, v| {
		p.o.skip_compress = Some(v.os());
		Ok(())
	}),
	s("compress-level", 0, I, |p, v| {
		p.o.set_compress_level(v.int());
		Ok(())
	}),
	s("zl", 0, I, |p, v| {
		p.o.set_compress_level(v.int());
		Ok(())
	}),
	s("compress-threads", 0, I, |p, v| {
		p.o.do_compression_threads = v.int();
		Ok(())
	}),
	s("zt", 0, I, |p, v| {
		p.o.do_compression_threads = v.int();
		Ok(())
	}),
	s("", b'P', N, |p, _| {
		p.o.do_progress = true;
		p.o.keep_partial = true;
		Ok(())
	}),
	s("progress", 0, N, |p, _| {
		p.o.do_progress = true;
		Ok(())
	}),
	s("no-progress", 0, N, |p, _| {
		p.o.do_progress = false;
		Ok(())
	}),
	s("partial", 0, N, |p, _| {
		p.o.keep_partial = true;
		Ok(())
	}),
	s("no-partial", 0, N, |p, _| {
		p.o.keep_partial = false;
		Ok(())
	}),
	s("partial-dir", 0, S, |p, v| {
		p.o.partial_dir = Some(v.os());
		p.o.partial_dir_is_tmp = false;
		Ok(())
	}),
	s("delay-updates", 0, N, |p, _| {
		p.o.delay_updates = true;
		Ok(())
	}),
	s("no-delay-updates", 0, N, |p, _| {
		p.o.delay_updates = false;
		Ok(())
	}),
	s("prune-empty-dirs", b'm', N, |p, _| {
		p.o.prune_empty_dirs = true;
		Ok(())
	}),
	s("no-prune-empty-dirs", 0, N, |p, _| {
		p.o.prune_empty_dirs = false;
		Ok(())
	}),
	s("no-m", 0, N, |p, _| {
		p.o.prune_empty_dirs = false;
		Ok(())
	}),
	s("log-file", 0, S, |p, v| {
		p.o.logfile_name = Some(v.os());
		Ok(())
	}),
	s("log-file-format", 0, S, |p, v| {
		p.o.logfile_format = Some(v.bytes());
		Ok(())
	}),
	s("out-format", 0, S, |p, v| {
		p.o.stdout_format = Some(v.bytes());
		Ok(())
	}),
	s("log-format", 0, S, |p, v| {
		p.o.stdout_format = Some(v.bytes());
		Ok(())
	}),
	s("itemize-changes", b'i', N, |p, _| {
		p.o.itemize_changes = p.o.itemize_changes.saturating_add(1);
		Ok(())
	}),
	s("no-itemize-changes", 0, N, |p, _| {
		p.o.itemize_changes = 0;
		Ok(())
	}),
	s("no-i", 0, N, |p, _| {
		p.o.itemize_changes = 0;
		Ok(())
	}),
	s("bwlimit", 0, S, |p, v| p.bwlimit(&v)),
	s("no-bwlimit", 0, N, |p, _| {
		p.o.bwlimit = 0;
		Ok(())
	}),
	s("backup", b'b', N, |p, _| {
		p.o.make_backups = true;
		Ok(())
	}),
	s("no-backup", 0, N, |p, _| {
		p.o.make_backups = false;
		Ok(())
	}),
	s("backup-dir", 0, S, |p, v| {
		p.o.backup_dir = Some(v.os());
		Ok(())
	}),
	s("suffix", 0, S, |p, v| {
		p.o.backup_suffix = Some(v.os());
		Ok(())
	}),
	s("list-only", 0, N, |p, _| {
		p.o.list_only = 2;
		Ok(())
	}),
	s("read-batch", 0, S, |p, v| {
		p.o.batch_name = Some(v.os());
		p.o.read_batch = true;
		Ok(())
	}),
	s("write-batch", 0, S, |p, v| {
		p.o.batch_name = Some(v.os());
		p.o.write_batch = 1;
		Ok(())
	}),
	s("only-write-batch", 0, S, |p, v| {
		p.o.batch_name = Some(v.os());
		p.o.write_batch = -1;
		Ok(())
	}),
	s("files-from", 0, S, |p, v| {
		p.o.files_from = Some(v.os());
		Ok(())
	}),
	s("from0", b'0', N, |p, _| {
		p.o.eol_nulls = true;
		Ok(())
	}),
	s("no-from0", 0, N, |p, _| {
		p.o.eol_nulls = false;
		Ok(())
	}),
	s("old-args", 0, N, |p, _| {
		p.o.old_style_args = if p.o.old_style_args <= 0 { 1 } else { p.o.old_style_args.saturating_add(1) };
		Ok(())
	}),
	s("no-old-args", 0, N, |p, _| {
		p.o.old_style_args = 0;
		Ok(())
	}),
	s("secluded-args", b's', N, |p, _| {
		p.o.protect_args = 1;
		Ok(())
	}),
	s("no-secluded-args", 0, N, |p, _| {
		p.o.protect_args = 0;
		Ok(())
	}),
	s("protect-args", 0, N, |p, _| {
		p.o.protect_args = 1;
		Ok(())
	}),
	s("no-protect-args", 0, N, |p, _| {
		p.o.protect_args = 0;
		Ok(())
	}),
	s("no-s", 0, N, |p, _| {
		p.o.protect_args = 0;
		Ok(())
	}),
	s("trust-sender", 0, N, |p, _| {
		p.o.trust_sender = true;
		Ok(())
	}),
	s("numeric-ids", 0, N, |p, _| {
		p.o.numeric_ids = true;
		Ok(())
	}),
	s("no-numeric-ids", 0, N, |p, _| {
		p.o.numeric_ids = false;
		Ok(())
	}),
	s("usermap", 0, S, |p, v| p.usermap(true, v)),
	s("groupmap", 0, S, |p, v| p.usermap(false, v)),
	s("chown", 0, S, |p, v| p.chown(&v)),
	s("timeout", 0, I, |p, v| {
		p.o.io_timeout = v.int();
		Ok(())
	}),
	s("no-timeout", 0, N, |p, _| {
		p.o.io_timeout = 0;
		Ok(())
	}),
	s("contimeout", 0, I, |p, v| {
		p.o.connect_timeout = v.int();
		Ok(())
	}),
	s("no-contimeout", 0, N, |p, _| {
		p.o.connect_timeout = 0;
		Ok(())
	}),
	s("fsync", 0, N, |p, _| {
		p.o.do_fsync = true;
		Ok(())
	}),
	s("stop-after", 0, S, |p, v| p.stop_after(&v)),
	s("time-limit", 0, S, |p, v| p.stop_after(&v)),
	s("stop-at", 0, S, |p, v| p.stop_at(&v)),
	s("rsh", b'e', S, |p, v| {
		p.o.shell_cmd = Some(v.os());
		Ok(())
	}),
	s("rsync-path", 0, S, |p, v| {
		p.o.rsync_path = v.os();
		Ok(())
	}),
	s("temp-dir", b'T', S, |p, v| {
		p.o.tmpdir = Some(v.os());
		Ok(())
	}),
	s("iconv", 0, S, |p, v| {
		if !crate::rsync::usage::SUPPORT_ICONV {
			// A build without ICONV_OPTION refuses the option outright.
			return refuse(p, "iconv", 0);
		}
		p.o.iconv_opt = Some(v.os());
		Ok(())
	}),
	s("no-iconv", 0, N, |p, _| {
		p.o.iconv_opt = None;
		Ok(())
	}),
	s("ipv4", b'4', N, |p, _| {
		p.o.af_hint = 4;
		Ok(())
	}),
	s("ipv6", b'6', N, |p, _| {
		p.o.af_hint = 6;
		Ok(())
	}),
	s("8-bit-output", b'8', N, |p, _| {
		p.o.allow_8bit_chars = true;
		Ok(())
	}),
	s("no-8-bit-output", 0, N, |p, _| {
		p.o.allow_8bit_chars = false;
		Ok(())
	}),
	s("no-8", 0, N, |p, _| {
		p.o.allow_8bit_chars = false;
		Ok(())
	}),
	s("mkpath", 0, N, |p, _| {
		p.o.mkpath_dest_arg = true;
		Ok(())
	}),
	s("no-mkpath", 0, N, |p, _| {
		p.o.mkpath_dest_arg = false;
		Ok(())
	}),
	s("qsort", 0, N, |p, _| {
		p.o.use_qsort = true;
		Ok(())
	}),
	s("copy-as", 0, S, |p, v| {
		p.o.copy_as = Some(v.os());
		Ok(())
	}),
	s("address", 0, S, |p, v| {
		p.o.bind_address = Some(v.os());
		Ok(())
	}),
	s("port", 0, I, |p, v| {
		p.o.rsync_port = v.int();
		Ok(())
	}),
	s("sockopts", 0, S, |p, v| {
		p.o.sockopts = Some(v.os());
		Ok(())
	}),
	s("password-file", 0, S, |p, v| {
		p.o.password_file = Some(v.os());
		Ok(())
	}),
	s("early-input", 0, S, |p, v| {
		p.o.early_input_file = Some(v.os());
		Ok(())
	}),
	s("blocking-io", 0, N, |p, _| {
		p.o.blocking_io = Some(true);
		Ok(())
	}),
	s("no-blocking-io", 0, N, |p, _| {
		p.o.blocking_io = Some(false);
		Ok(())
	}),
	s("outbuf", 0, S, |p, v| {
		p.o.outbuf_mode = Some(v.os());
		Ok(())
	}),
	s("remote-option", b'M', S, |p, v| {
		let arg = v.os();
		if !os_bytes_lossy(&arg).starts_with(b"-") {
			let text = format!("Remote option must start with a dash: {}", arg.display());
			return Err(p.option_error(text));
		}
		p.o.remote_options.push(arg);
		Ok(())
	}),
	s("protocol", 0, I, |p, v| {
		p.o.protocol_version = v.int();
		Ok(())
	}),
	s("checksum-seed", 0, I, |p, v| {
		p.o.checksum_seed = v.int();
		Ok(())
	}),
	s("server", 0, N, |p, _| {
		let first = !p.o.am_server;
		p.o.am_server = true;
		p.o.iconv_opt = None;
		if first { Err(Stop::Restart) } else { Ok(()) }
	}),
	s("sender", 0, N, |p, _| {
		if !p.o.am_server {
			return Err(p.usage_error(("options.c", 1533)));
		}
		p.o.am_sender = true;
		Ok(())
	}),
	s("config", 0, S, |_, _| Err(Stop::Daemon)),
	s("daemon", 0, N, |_, _| Err(Stop::Daemon)),
	s("dparam", 0, S, |_, _| Err(Stop::Daemon)),
	s("detach", 0, N, |_, _| Err(Stop::Daemon)),
	s("no-detach", 0, N, |_, _| Err(Stop::Daemon)),
];

/// The daemon-mode table (upstream `long_daemon_options[]`), used once any
/// daemon-only option is seen.
pub(super) static DAEMON_OPTIONS: &[Spec] = &[
	s("address", 0, S, |p, v| {
		p.o.bind_address = Some(v.os());
		Ok(())
	}),
	s("bwlimit", 0, I, |p, v| {
		p.o.daemon_bwlimit = v.int();
		Ok(())
	}),
	s("config", 0, S, |p, v| {
		p.o.config_file = Some(v.os());
		Ok(())
	}),
	s("daemon", 0, N, |p, _| {
		p.daemon_opt = true;
		Ok(())
	}),
	s("dparam", b'M', S, |p, v| {
		let arg = v.os();
		if !os_bytes_lossy(&arg).contains(&b'=') {
			let text = format!("--dparam value is missing an '=': {}", arg.display());
			return Err(p.daemon_error(text));
		}
		p.o.dparams.push(arg);
		Ok(())
	}),
	s("ipv4", b'4', N, |p, _| {
		p.o.af_hint = 4;
		Ok(())
	}),
	s("ipv6", b'6', N, |p, _| {
		p.o.af_hint = 6;
		Ok(())
	}),
	s("detach", 0, N, |p, _| {
		p.o.no_detach = false;
		Ok(())
	}),
	s("no-detach", 0, N, |p, _| {
		p.o.no_detach = true;
		Ok(())
	}),
	s("log-file", 0, S, |p, v| {
		p.o.logfile_name = Some(v.os());
		Ok(())
	}),
	s("log-file-format", 0, S, |p, v| {
		p.o.logfile_format = Some(v.bytes());
		Ok(())
	}),
	s("port", 0, I, |p, v| {
		p.o.rsync_port = v.int();
		Ok(())
	}),
	s("sockopts", 0, S, |p, v| {
		p.o.sockopts = Some(v.os());
		Ok(())
	}),
	s("protocol", 0, I, |p, v| {
		p.o.protocol_version = v.int();
		Ok(())
	}),
	s("server", 0, N, |p, _| {
		p.o.am_server = true;
		Ok(())
	}),
	s("temp-dir", b'T', S, |p, v| {
		p.o.tmpdir = Some(v.os());
		Ok(())
	}),
	s("verbose", b'v', N, |p, _| {
		p.o.verbose = p.o.verbose.saturating_add(1);
		Ok(())
	}),
	s("no-verbose", 0, N, |p, _| {
		p.o.verbose = 0;
		Ok(())
	}),
	s("no-v", 0, N, |p, _| {
		p.o.verbose = 0;
		Ok(())
	}),
	s("help", b'h', N, |_, _| Err(Stop::Done(super::Parsed::DaemonHelp))),
];
