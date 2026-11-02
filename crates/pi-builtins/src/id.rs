//! `id` builtin: print real and effective user and group IDs.
//!
//! Group lists are deduplicated.
//! The reported identity is the host process's, which is correct for an
//! in-process builtin.

use std::{fmt::NumBuffer, io::Write};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use libc::{gid_t, uid_t};
use uucore::{
	display::Quotable,
	entries::{Locate, Passwd, get_groups_gnu, gid2grp, uid2usr},
	process::{getegid, geteuid, getgid, getuid},
};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

mod options {
	pub const OPT_IGNORE: &str = "ignore";
	pub const OPT_CONTEXT: &str = "context";
	pub const OPT_GROUP: &str = "group";
	pub const OPT_GROUPS: &str = "groups";
	pub const OPT_NAME: &str = "name";
	pub const OPT_REAL_ID: &str = "real";
	pub const OPT_EFFECTIVE_USER: &str = "user";
	pub const OPT_ZERO: &str = "zero";
	pub const ARG_USERS: &str = "USER";
}

/// Parsed `id` invocation.
pub(crate) struct Id {
	matches: ArgMatches,
}

matches_parser!(Id, app);

/// What a single `id` record prints.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
	Full,
	User,
	Group,
	Groups,
}

struct Ids {
	ruid: uid_t,
	euid: uid_t,
	rgid: gid_t,
	egid: gid_t,
}

impl Utility for Id {
	const NAME: &'static str = "id";

	fn run(self, host: &mut Host) -> i32 {
		let m = &self.matches;
		let use_name = m.get_flag(options::OPT_NAME);
		let use_real = m.get_flag(options::OPT_REAL_ID);
		let zero = m.get_flag(options::OPT_ZERO);
		let users: Vec<&String> = m.get_many::<String>(options::ARG_USERS).into_iter().flatten().collect();

		// No SELinux/SMACK support exists for an in-process builtin.
		if m.get_flag(options::OPT_CONTEXT) {
			host.error("--context (-Z) works only on an SELinux-enabled kernel", 1);
			return 1;
		}
		let mode = if m.get_flag(options::OPT_EFFECTIVE_USER) {
			Mode::User
		} else if m.get_flag(options::OPT_GROUP) {
			Mode::Group
		} else if m.get_flag(options::OPT_GROUPS) {
			Mode::Groups
		} else {
			Mode::Full
		};
		if mode == Mode::Full && (use_real || use_name) {
			host.error("printing only names or real IDs requires -u, -g, or -G", 1);
			return 1;
		}
		if mode == Mode::Full && zero {
			host.error("option --zero not permitted in default format", 1);
			return 1;
		}

		let mut printer = Printer { out: Vec::new(), errors: Vec::new(), ok: true, use_name, use_real, zero };
		if users.is_empty() {
			let ids = Ids { ruid: getuid(), euid: geteuid(), rgid: getgid(), egid: getegid() };
			printer.print_stuff(mode, None, &ids, false);
		} else {
			let multiple = users.len() > 1;
			for spec in users {
				if host.is_cancelled() {
					break;
				}
				if let Ok(pw) = Passwd::locate(spec.as_str()) {
					let ids = Ids { ruid: pw.uid, euid: pw.uid, rgid: pw.gid, egid: pw.gid };
					printer.print_stuff(mode, Some(&pw), &ids, multiple);
				} else {
					printer.flush(host);
					host.error(no_such_user(spec), 1);
					printer.ok = false;
				}
			}
		}
		printer.flush(host);
		if printer.ok { 0 } else { 1 }
	}
}

/// GNU's message for an unknown USER. Its numeric fallback runs `strtoumax`,
/// which on Darwin leaves EINVAL for non-numeric input, and GNU reports it.
fn no_such_user(spec: &str) -> String {
	let numeric = spec.strip_prefix('+').unwrap_or(spec).parse::<uid_t>().is_ok();
	if cfg!(target_vendor = "apple") && !numeric {
		format!("{}: no such user: Invalid argument", spec.quote())
	} else {
		format!("{}: no such user", spec.quote())
	}
}

struct Printer {
	out:      Vec<u8>,
	errors:   Vec<String>,
	ok:       bool,
	use_name: bool,
	use_real: bool,
	zero:     bool,
}

impl Printer {
	fn flush(&mut self, host: &mut Host) {
		if !self.out.is_empty() {
			if let Err(e) = host.stdout.write_all(&self.out) {
				host.error(e, 1);
				self.ok = false;
			}
			self.out.clear();
		}
		for msg in std::mem::take(&mut self.errors) {
			let _ = host.stdout.flush();
			host.error(msg, 1);
		}
	}

	fn print_stuff(&mut self, mode: Mode, pw: Option<&Passwd>, ids: &Ids, multiple: bool) {
		match mode {
			Mode::User => self.print_user(if self.use_real { ids.ruid } else { ids.euid }),
			Mode::Group => self.print_group(if self.use_real { ids.rgid } else { ids.egid }),
			Mode::Groups => self.print_group_list(pw, ids, if self.zero { b'\0' } else { b' ' }),
			Mode::Full => self.print_full_info(pw, ids),
		}
		if self.zero && mode == Mode::Groups && multiple {
			self.out.extend_from_slice(b"\0\0");
		} else {
			self.out.push(if self.zero { b'\0' } else { b'\n' });
		}
	}

	fn print_user(&mut self, uid: uid_t) {
		if self.use_name {
			if let Ok(name) = uid2usr(uid) {
				self.out.extend_from_slice(name.as_bytes());
				return;
			}
			self.errors.push(format!("cannot find name for user ID {uid}"));
			self.ok = false;
		}
		self.out.extend_from_slice(uid.format_into(&mut NumBuffer::new()).as_bytes());
	}

	fn print_group(&mut self, gid: gid_t) {
		if self.use_name {
			if let Ok(name) = gid2grp(gid) {
				self.out.extend_from_slice(name.as_bytes());
				return;
			}
			self.errors.push(format!("cannot find name for group ID {gid}"));
			self.ok = false;
		}
		self.out.extend_from_slice(gid.format_into(&mut NumBuffer::new()).as_bytes());
	}

	/// The user's groups (getgrouplist) or the process's (getgroups, egid
	/// first), deduplicated like GNU's `mgetgroups`.
	fn groups_for(&mut self, pw: Option<&Passwd>) -> Vec<gid_t> {
		let groups = match pw {
			Some(pw) => pw.belongs_to(),
			None => match get_groups_gnu(None) {
				Ok(groups) => groups,
				Err(_) => {
					self.errors.push("failed to get groups for the current process".to_owned());
					self.ok = false;
					return Vec::new();
				},
			},
		};
		mgetgroups_dedup(groups)
	}

	fn print_group_list(&mut self, pw: Option<&Passwd>, ids: &Ids, delim: u8) {
		self.print_group(ids.rgid);
		if ids.egid != ids.rgid {
			self.out.push(delim);
			self.print_group(ids.egid);
		}
		for g in self.groups_for(pw) {
			if g != ids.rgid && g != ids.egid {
				self.out.push(delim);
				self.print_group(g);
			}
		}
	}

	fn print_full_info(&mut self, pw: Option<&Passwd>, ids: &Ids) {
		let field = |out: &mut Vec<u8>, label: &str, id: u32, name: Option<String>| {
			out.extend_from_slice(label.as_bytes());
			out.extend_from_slice(id.format_into(&mut NumBuffer::new()).as_bytes());
			if let Some(name) = name {
				out.extend_from_slice(format!("({name})").as_bytes());
			}
		};
		field(&mut self.out, "uid=", ids.ruid, uid2usr(ids.ruid).ok());
		field(&mut self.out, " gid=", ids.rgid, gid2grp(ids.rgid).ok());
		if ids.euid != ids.ruid {
			field(&mut self.out, " euid=", ids.euid, uid2usr(ids.euid).ok());
		}
		if ids.egid != ids.rgid {
			field(&mut self.out, " egid=", ids.egid, gid2grp(ids.egid).ok());
		}
		self.out.extend_from_slice(b" groups=");
		for (i, g) in self.groups_for(pw).into_iter().enumerate() {
			if i > 0 {
				self.out.push(b',');
			}
			field(&mut self.out, "", g, gid2grp(g).ok());
		}
	}
}

/// GNU `mgetgroups` dedup, which uucore's group lists lack: drop entries equal
/// to the first or to the previously kept entry.
fn mgetgroups_dedup(mut groups: Vec<gid_t>) -> Vec<gid_t> {
	let Some(&first) = groups.first() else { return groups };
	let mut kept = 1;
	for i in 1..groups.len() {
		let g = groups[i];
		if g != first && g != groups[kept - 1] {
			groups[kept] = g;
			kept += 1;
		}
	}
	groups.truncate(kept);
	groups
}

fn app() -> Command {
	Command::new("id")
		.version("0.8.0")
		.about(
			"Print user and group information for each specified USER,\nor (when USER omitted) for \
			 the current process.",
		)
		.override_usage(format_usage("id [OPTION]... [USER]..."))
		.infer_long_args(true)
		.args_override_self(true)
		.after_help("Without any OPTION, print some useful set of identified information.")
		.arg(
			Arg::new(options::OPT_IGNORE)
				.short('a')
				.long(options::OPT_IGNORE)
				.help("ignore, for compatibility with other versions")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OPT_EFFECTIVE_USER)
				.short('u')
				.long(options::OPT_EFFECTIVE_USER)
				.conflicts_with(options::OPT_GROUP)
				.help("print only the effective user ID")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OPT_GROUP)
				.short('g')
				.long(options::OPT_GROUP)
				.conflicts_with(options::OPT_EFFECTIVE_USER)
				.help("print only the effective group ID")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OPT_GROUPS)
				.short('G')
				.long(options::OPT_GROUPS)
				.conflicts_with_all([options::OPT_GROUP, options::OPT_EFFECTIVE_USER])
				.help("print all group IDs")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OPT_NAME)
				.short('n')
				.long(options::OPT_NAME)
				.help("print a name instead of a number, for -u, -g, -G")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OPT_REAL_ID)
				.short('r')
				.long(options::OPT_REAL_ID)
				.help("print the real ID instead of the effective ID, with -u, -g, -G")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OPT_ZERO)
				.short('z')
				.long(options::OPT_ZERO)
				.help("delimit entries with NUL characters, not whitespace;\nnot permitted in default format")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OPT_CONTEXT)
				.short('Z')
				.long(options::OPT_CONTEXT)
				.help("print only the security context of the process")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ARG_USERS)
				.action(ArgAction::Append)
				.value_name(options::ARG_USERS)
				.value_hint(clap::ValueHint::Username),
		)
}

/// Creates the `id` builtin registration.
pub(crate) fn id_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Id, SE>()
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::host::run_util;

	fn run(args: &[&str]) -> (i32, Vec<u8>, String) {
		let (code, cap) = run_util::<Id>(args, "", ".");
		(code, cap.stdout(), cap.err())
	}

	#[test]
	fn default_format_rejects_name_real_and_zero() {
		let msg = "id: printing only names or real IDs requires -u, -g, or -G\n";
		assert_eq!(run(&["-n"]), (1, Vec::new(), msg.into()));
		assert_eq!(run(&["-r"]), (1, Vec::new(), msg.into()));
		assert_eq!(run(&["-z"]), (1, Vec::new(), "id: option --zero not permitted in default format\n".into()));
	}

	#[test]
	fn more_than_one_choice_is_a_usage_error() {
		let (code, out, err) = run(&["-ug"]);
		assert_eq!((code, out.is_empty()), (1, true));
		assert!(!err.is_empty());
	}

	#[test]
	fn context_is_unsupported() {
		assert_eq!(
			run(&["-Z"]),
			(1, Vec::new(), "id: --context (-Z) works only on an SELinux-enabled kernel\n".into())
		);
	}

	#[test]
	fn root_by_name_and_number_agree() {
		let (code, by_name, _) = run(&["-u", "root"]);
		assert_eq!((code, by_name), (0, b"0\n".to_vec()));
		let (code, by_num, _) = run(&["-un", "0"]);
		assert_eq!((code, by_num), (0, b"root\n".to_vec()));
	}

	#[test]
	fn unknown_user_fails_but_continues() {
		let (code, out, err) = run(&["-u", "nosuchuser", "root"]);
		assert_eq!((code, out), (1, b"0\n".to_vec()));
		assert!(err.starts_with("id: 'nosuchuser': no such user"), "{err}");
		let (code, _, err) = run(&["99999"]);
		assert_eq!((code, err.as_str()), (1, "id: '99999': no such user\n"));
	}

	#[test]
	fn zero_group_lists_for_several_users_end_with_double_nul() {
		let (code, out, _) = run(&["-zG", "root", "root"]);
		assert_eq!(code, 0);
		assert!(out.ends_with(b"\0\0") && out.starts_with(b"0\0"));
		let (_, single, _) = run(&["-zG", "root"]);
		assert!(single.ends_with(b"\0") && !single.ends_with(b"\0\0"));
	}

	#[test]
	fn current_group_list_starts_with_egid_without_duplicates() {
		let (code, out, _) = run(&["-G"]);
		assert_eq!(code, 0);
		let ids: Vec<u32> = String::from_utf8(out).unwrap().split_whitespace().map(|s| s.parse().unwrap()).collect();
		assert_eq!(ids[0], getegid());
		assert!(!ids[1..].contains(&ids[0]));
	}

	#[test]
	fn dedup_follows_mgetgroups() {
		assert_eq!(mgetgroups_dedup(vec![20, 20, 1, 1, 20, 2, 1]), vec![20, 1, 2, 1]);
	}
}
