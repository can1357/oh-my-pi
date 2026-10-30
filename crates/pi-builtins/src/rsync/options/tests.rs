//! Option parsing and server-argv tests. Expected strings were captured from the
//! reference rsync 3.5.1 (`-e` pointed at a script printing its argv, stderr text
//! and exit sites from failing runs).

use std::collections::HashMap;
use std::ffi::OsString;

use super::*;

fn argv(args: &[&str]) -> Vec<OsString> {
	args.iter().map(OsString::from).collect()
}

fn no_env(_: &str) -> Option<String> {
	None
}

fn parse_env(args: &[&str], env: &[(&str, &str)]) -> Result<Parsed, RsyncError> {
	let map: HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
	parse(&argv(args), &move |k: &str| map.get(k).cloned())
}

fn run(args: &[&str]) -> Options {
	match parse(&argv(args), &no_env) {
		Ok(Parsed::Run(o)) => *o,
		other => panic!("{args:?}: {other:?}"),
	}
}

fn err(args: &[&str]) -> RsyncError {
	match parse(&argv(args), &no_env) {
		Err(e) => e,
		Ok(other) => panic!("{args:?}: expected an error, got {other:?}"),
	}
}

fn msg(args: &[&str]) -> String {
	err(args).message.unwrap_or_default()
}

/// Client options + two operands → the server argv tail, as strings.
fn remote(args: &[&str], remote_is_sender: bool) -> Vec<String> {
	remote_env(args, &[], remote_is_sender).0
}

fn remote_env(args: &[&str], env: &[(&str, &str)], remote_is_sender: bool) -> (Vec<String>, Option<usize>) {
	let mut full: Vec<&str> = args.to_vec();
	full.extend(["src", "dst"]);
	let opts = match parse_env(&full, env) {
		Ok(Parsed::Run(o)) => o,
		other => panic!("{args:?}: {other:?}"),
	};
	let (list, cut) = server_args_split(&opts, remote_is_sender);
	let list = list.iter().map(|s| s.to_string_lossy().into_owned());
	// The goldens come from a reference with iconv; a build without it omits the
	// `s` capability (checked exactly in `iconv_support_matches_platform`).
	let list = list.map(|s| if SUPPORT_ICONV { s } else { s.replace("LfxCIvu", "LsfxCIvu") });
	(list.collect(), cut)
}

const SUPPORT_ICONV: bool = crate::rsync::usage::SUPPORT_ICONV;

#[test]
fn iconv_support_matches_platform() {
	let tail = remote(&["-r"], PULL);
	let caps = if SUPPORT_ICONV { "-re.iLsfxCIvu" } else { "-re.iLfxCIvu" };
	let raw = server_args(&run(&["-r", "a", "b"]), PULL);
	assert_eq!(raw[0].to_string_lossy(), caps);
	assert_eq!(tail[0], "-re.iLsfxCIvu");
	if SUPPORT_ICONV {
		assert_eq!(remote(&["-a", "--iconv=utf8,latin1"], PULL), ["-logDtpre.iLsfxCIvu", "--iconv=latin1"]);
		assert_eq!(remote(&["-a", "--iconv=utf8"], PUSH), ["-logDtpre.iLsfxCIvu", "--iconv=utf8"]);
	} else {
		assert_eq!(msg(&["--iconv=utf8", "a", "b"]), "rsync: This rsync does not support --iconv");
		assert_eq!(msg(&["--server", "--iconv=x", ".", "d"]), "rsync: The server does not support --iconv");
		assert!(run(&["--no-iconv", "a", "b"]).iconv_opt.is_none());
		let o = match parse_env(&["a", "b"], &[("RSYNC_ICONV", "utf8")]) {
			Ok(Parsed::Run(o)) => o,
			other => panic!("{other:?}"),
		};
		assert!(o.iconv_opt.is_none());
	}
}

const PULL: bool = true;
const PUSH: bool = false;

// ---- popt semantics ----

#[test]
fn bundled_short_options_and_counts() {
	let o = run(&["-avvvz", "a", "b"]);
	assert_eq!(o.verbose, 3);
	assert_eq!(o.do_compression, CPRES_ZLIB);
	assert_eq!(o.recurse, 1);
	assert!(o.preserve_links && o.preserve_perms && o.preserve_mtimes);
	assert!(o.preserve_uid && o.preserve_gid && o.preserve_devices && o.preserve_specials);
}

#[test]
fn short_option_arguments_attached_detached_and_after_equals() {
	assert_eq!(run(&["-essh -p 2", "a", "b"]).shell_cmd, Some("ssh -p 2".into()));
	assert_eq!(run(&["-e", "ssh", "a", "b"]).shell_cmd, Some("ssh".into()));
	assert_eq!(run(&["-e=ssh", "a", "b"]).shell_cmd, Some("ssh".into()));
	assert_eq!(run(&["-vessh", "a", "b"]).shell_cmd, Some("ssh".into()));
	assert_eq!(run(&["-ve", "ssh", "a", "b"]).verbose, 1);
	// A detached value is taken even when it looks like an option.
	assert_eq!(run(&["-e", "-v", "a", "b"]).shell_cmd, Some("-v".into()));
	assert_eq!(run(&["--rsync-path", "--", "a", "b"]).rsync_path, OsString::from("--"));
	assert_eq!(run(&["-vB=1k", "a", "b"]).block_size, 1024);
	assert_eq!(run(&["-B=", "a", "b"]).block_size, 0);
	assert_eq!(run(&["-@-1", "a", "b"]).modify_window, -1);
	assert_eq!(run(&["-@", "-2", "a", "b"]).modify_window, -2);
}

#[test]
fn popt_error_messages_match_reference() {
	assert_eq!(msg(&["--foo", "a", "b"]), "rsync: --foo: unknown option");
	assert_eq!(msg(&["--foo=bar", "a", "b"]), "rsync: --foo=bar: unknown option");
	assert_eq!(msg(&["-avQ", "a", "b"]), "rsync: -avQ: unknown option");
	assert_eq!(msg(&["-x-", "a", "b"]), "rsync: -x-: unknown option");
	assert_eq!(msg(&["---", "a", "b"]), "rsync: ---: unknown option");
	// No long-option abbreviations.
	assert_eq!(msg(&["--hel"]), "rsync: --hel: unknown option");
	assert_eq!(msg(&["--verb", "a", "b"]), "rsync: --verb: unknown option");
	assert_eq!(msg(&["-e"]), "rsync: -e: missing argument");
	assert_eq!(msg(&["a", "b", "--rsh"]), "rsync: --rsh: missing argument");
	assert_eq!(msg(&["--info"]), "rsync: --info: missing argument");
	assert_eq!(msg(&["-v=3", "a", "b"]), "rsync: -v=3: option does not take an argument");
	assert_eq!(msg(&["-av=", "a", "b"]), "rsync: -av=: option does not take an argument");
	assert_eq!(msg(&["--no-v=3", "a", "b"]), "rsync: --no-v=3: option does not take an argument");
	assert_eq!(msg(&["--timeout=x", "a", "b"]), "rsync: --timeout=x: invalid numeric value");
	assert_eq!(msg(&["--timeout", "x", "a", "b"]), "rsync: x: invalid numeric value");
	assert_eq!(msg(&["-@x", "a", "b"]), "rsync: -@x: invalid numeric value");
	assert_eq!(
		msg(&["--timeout=2147483648", "a", "b"]),
		"rsync: --timeout=2147483648: number too large or too small"
	);
	assert_eq!(
		msg(&["--timeout=-2147483649", "a", "b"]),
		"rsync: --timeout=-2147483649: number too large or too small"
	);
	let e = err(&["--foo"]);
	assert_eq!(e.code, RERR_SYNTAX);
	assert_eq!(e.site, Some(("main.c", 1913)));
}

#[test]
fn popt_integers_use_strtoll_base_zero() {
	assert_eq!(run(&["--timeout=0x10", "a", "b"]).io_timeout, 16);
	assert_eq!(run(&["--timeout=010", "a", "b"]).io_timeout, 8);
	assert_eq!(run(&["--timeout= 7", "a", "b"]).io_timeout, 7);
	assert_eq!(run(&["--timeout=+5", "a", "b"]).io_timeout, 5);
	assert_eq!(run(&["--timeout=", "a", "b"]).io_timeout, 0);
	assert_eq!(run(&["--timeout=-2147483648", "a", "b"]).io_timeout, i32::MIN);
	assert_eq!(popt_int(b"08"), Err("invalid numeric value"));
	assert_eq!(popt_int(b"0x"), Err("invalid numeric value"));
	assert_eq!(popt_int(b" "), Err("invalid numeric value"));
	assert_eq!(popt_int(b"99999999999999999999"), Err("number too large or too small"));
}

#[test]
fn operands_anywhere_double_dash_and_posix_mode() {
	let o = run(&["a", "-v", "b"]);
	assert_eq!(o.args, argv(&["a", "b"]));
	assert_eq!(o.verbose, 1);
	let o = run(&["a", "--", "-v", "-"]);
	assert_eq!(o.args, argv(&["a", "-v", "-"]));
	assert_eq!(o.verbose, 0);
	let o = match parse_env(&["-r", "a", "b", "-v"], &[("POSIXLY_CORRECT", "")]) {
		Ok(Parsed::Run(o)) => o,
		other => panic!("{other:?}"),
	};
	assert_eq!(o.args, argv(&["a", "b", "-v"]));
	assert_eq!(o.verbose, 0);
}

#[test]
fn h_is_help_only_when_alone() {
	assert!(matches!(parse(&argv(&["-h"]), &no_env), Ok(Parsed::Help)));
	assert!(matches!(parse(&argv(&["-hh"]), &no_env), Ok(Parsed::Help)));
	assert!(matches!(parse(&argv(&["-hv"]), &no_env), Ok(Parsed::Help)));
	assert!(matches!(parse(&argv(&["--human-readable"]), &no_env), Ok(Parsed::Help)));
	assert!(matches!(parse(&argv(&["--help", "a", "b"]), &no_env), Ok(Parsed::Help)));
	assert_eq!(run(&["-h", "a", "b"]).human_readable, 2);
	assert_eq!(run(&["-hh", "a", "b"]).human_readable, 3);
	assert_eq!(run(&["--no-h", "a", "b"]).human_readable, 0);
	// Two argv elements: not help, and no operands is a usage error.
	let e = err(&["-h", "-h"]);
	assert_eq!(e.site, Some(("main.c", 1968)));
	assert!(e.message.unwrap_or_default().starts_with("rsync  version 3.5.1  protocol version 33\n"));
	// Errors before --help win; --help before errors wins.
	assert_eq!(msg(&["--foo", "--help"]), "rsync: --foo: unknown option");
	assert!(matches!(parse(&argv(&["--help", "--foo"]), &no_env), Ok(Parsed::Help)));
}

#[test]
fn usage_errors_and_meta_requests() {
	let e = parse(&[], &no_env).unwrap_err();
	assert_eq!((e.code, e.site), (RERR_SYNTAX, Some(("main.c", 1898))));
	let text = e.message.unwrap_or_default();
	assert!(text.ends_with("See https://rsync.samba.org/ for updates, bug reports, and answers"));
	assert_eq!(err(&["-v"]).site, Some(("main.c", 1968)));
	assert_eq!(err(&["--sender", "a", "b"]).site, Some(("options.c", 1533)));
	assert_eq!(err(&["--files-from=x", "a", "b", "c"]).site, Some(("options.c", 2621)));
	assert_eq!(err(&["--files-from=x", "a"]).site, Some(("options.c", 2621)));
	assert!(matches!(parse(&argv(&["--version", "a"]), &no_env), Ok(Parsed::Version)));
	assert!(matches!(parse(&argv(&["-VV"]), &no_env), Ok(Parsed::VersionJson)));
	assert!(matches!(parse(&argv(&["-V", "-V"]), &no_env), Ok(Parsed::VersionJson)));
	assert!(matches!(parse(&argv(&["--server", "-VV"]), &no_env), Ok(Parsed::Version)));
	assert!(matches!(parse(&argv(&["--info=help", "a", "b"]), &no_env), Ok(Parsed::InfoHelp)));
	assert!(matches!(parse(&argv(&["--debug=help"]), &no_env), Ok(Parsed::DebugHelp)));
	let e = err(&["--info=foo"]);
	assert_eq!(e.message.as_deref(), Some("Unknown --info item: \"foo\""));
	assert_eq!(e.site, Some(("options.c", 487)));
	assert_eq!(err(&["--debug=xx"]).message.as_deref(), Some("Unknown --debug item: \"xx\""));
}

#[test]
fn daemon_options_switch_modes() {
	assert!(matches!(parse(&argv(&["--daemon", "--help"]), &no_env), Ok(Parsed::DaemonHelp)));
	assert!(matches!(parse(&argv(&["--daemon", "-h"]), &no_env), Ok(Parsed::DaemonHelp)));
	let tail = "\n(Type \"rsync --daemon --help\" for assistance with daemon mode.)";
	let e = err(&["--config=x", "a", "b"]);
	assert_eq!(e.message, Some(format!("Daemon option(s) used without --daemon.{tail}")));
	assert_eq!(e.site, Some(("options.c", 1596)));
	assert_eq!(msg(&["--detach"]), format!("Daemon option(s) used without --daemon.{tail}"));
	assert_eq!(msg(&["--daemon", "--foo"]), format!("rsync: --foo: unknown option (in daemon mode){tail}"));
	assert_eq!(
		msg(&["--daemon", "--port=x"]),
		format!("rsync: --port=x: invalid numeric value (in daemon mode){tail}")
	);
	assert_eq!(msg(&["--daemon", "-v", "--dparam=x"]), format!("--dparam value is missing an '=': x{tail}"));
	let o = run(&["--daemon", "--no-detach", "--port=8730", "-M", "a=b"]);
	assert!(o.am_daemon && o.no_detach);
	assert_eq!(o.rsync_port, 8730);
	assert_eq!(o.dparams, argv(&["a=b"]));
}

// ---- size arguments ----

#[test]
fn size_arg_suffixes_and_boundaries() {
	let size = |s: &str| parse_size_arg(s.as_bytes(), b'b', "max-size", 0, -1, false);
	assert_eq!(size("1.5k"), Ok(1536));
	assert_eq!(size("1kb"), Ok(1000));
	assert_eq!(size("1KiB"), Ok(1024));
	assert_eq!(size("1kib"), Ok(1024));
	assert_eq!(size("1k+1"), Ok(1025));
	assert_eq!(size("1k-1"), Ok(1023));
	assert_eq!(size("1+1"), Ok(2));
	assert_eq!(size("1-1"), Ok(0));
	assert_eq!(size(".5k"), Ok(512));
	assert_eq!(size(""), Ok(0));
	assert_eq!(size("1p"), Ok(1 << 50));
	assert_eq!(size("8191p"), Ok(8191 << 50));
	assert!(size("8191.99p").is_ok());
	assert_eq!(size("8192p"), Err("--max-size=8192p is too large".into()));
	assert_eq!(size("9223372036854775806"), Err("--max-size=9223372036854775806 is too large".into()));
	assert_eq!(size("+1"), Err("--max-size=+1 is invalid".into()));
	assert_eq!(size("-1"), Err("--max-size=-1 is too large".into()));
	assert_eq!(size("1e3"), Err("--max-size=1e3 is invalid".into()));
	assert_eq!(size("1x"), Err("--max-size=1x is invalid".into()));
	assert_eq!(size("1k+2"), Err("--max-size=1k+2 is invalid".into()));
	assert_eq!(size("1,5k"), Err("--max-size=1,5k is invalid".into()));
	let o = run(&["--max-size=1.5k", "--min-size=1t", "a", "b"]);
	assert_eq!((o.max_size, o.max_size_arg.as_deref()), (1536, Some("1536")));
	assert_eq!(o.min_size, 1 << 40);
}

#[test]
fn size_arg_limits_in_messages() {
	assert_eq!(msg(&["--bwlimit=511b", "a", "b"]), "rsync: --bwlimit=511b is too small (min: 512 or 0 for unlimited)");
	assert_eq!(run(&["--bwlimit=512b", "a", "b"]).bwlimit, 1);
	assert_eq!(run(&["--bwlimit=0", "a", "b"]).bwlimit, 0);
	assert_eq!(run(&["--bwlimit=1.5", "a", "b"]).bwlimit, 2);
	assert_eq!(run(&["--block-size=131072", "a", "b"]).block_size, 131072);
	assert_eq!(msg(&["--block-size=131073", "a", "b"]), "rsync: --block-size=131073 is too large (max: 128.00K)");
	assert_eq!(run(&["--protocol=29", "--block-size=131073", "a", "b"]).block_size, 131073);
	assert_eq!(msg(&["--protocol=29", "--block-size=1g", "a", "b"]), "rsync: --block-size=1g is too large (max: 512.00M)");
	assert_eq!(msg(&["--max-alloc=1", "a", "b"]), "rsync: --max-alloc=1 is too small (min: 1.00M or 0 for unlimited)");
	assert_eq!(msg(&["--max-alloc=1m-1", "a", "b"]), "rsync: --max-alloc=1m-1 is too small (min: 1.00M or 0 for unlimited)");
	assert_eq!(msg(&["--max-alloc=x", "a", "b"]), "rsync: --max-alloc=x is invalid");
	assert_eq!(msg(&["--max-alloc=9223372036854775807", "a", "b"]), "rsync: --max-alloc=9223372036854775807 is too large");
	assert_eq!(run(&["--max-alloc=0", "a", "b"]).max_alloc, i64::MAX as u64);
	assert_eq!(run(&["--max-alloc=2g", "a", "b"]).max_alloc, 2 << 30);
	assert_eq!(run(&["a", "b"]).max_alloc, DEFAULT_MAX_ALLOC);
	let o = match parse_env(&["a", "b"], &[("RSYNC_MAX_ALLOC", "4m")]) {
		Ok(Parsed::Run(o)) => o,
		other => panic!("{other:?}"),
	};
	assert_eq!(o.max_alloc, 4 << 20);
}

#[test]
fn long_size_errors_are_cut_like_err_buf() {
	let long = "9".repeat(300);
	let text = msg(&[&format!("--max-size={long}"), "a", "b"]);
	assert_eq!(text.len(), "rsync: ".len() + 198);
}

// ---- implications and conflicts ----

#[test]
fn archive_partial_progress_and_delete_implications() {
	let o = run(&["-P", "a", "b"]);
	assert!(o.do_progress && o.keep_partial);
	let o = run(&["-r", "--del", "a", "b"]);
	assert_eq!(o.delete_during, 1);
	assert!(o.delete_mode);
	let o = run(&["-r", "--delete-excluded", "a", "b"]);
	assert!(o.delete_mode);
	let o = run(&["-r", "--del", "--delete-during", "a", "b"]);
	assert_eq!(o.delete_during, 1);
	let o = run(&["-a", "--no-D", "--no-p", "a", "b"]);
	assert!(!o.preserve_devices && !o.preserve_specials && !o.preserve_perms);
	assert_eq!(run(&["-r", "-a", "a", "b"]).recurse, 2);
	let o = run(&["--append", "a", "b"]);
	assert!(o.inplace && o.append_mode == 1);
	let o = run(&["--write-devices", "a", "b"]);
	assert!(o.inplace);
	let o = run(&["--delay-updates", "a", "b"]);
	assert_eq!(o.partial_dir, Some(TMP_PARTIAL_DIR.into()));
	assert!(o.partial_dir_is_tmp && o.keep_partial);
	let o = run(&["-UU", "a", "b"]);
	assert!(o.open_noatime && o.preserve_atimes == 2);
	let o = run(&["--old-dirs", "a", "b"]);
	assert_eq!((o.recurse, o.xfer_dirs), (1, 1));
	assert_eq!(o.filter_rules, vec![FilterOpt::Filter(b"- /*/*".to_vec())]);
	assert_eq!(run(&["a"]).list_only, 1);
	assert_eq!(run(&["a"]).xfer_dirs, 1);
	let o = run(&["--files-from=list", "-a", "a", "b"]);
	assert_eq!((o.recurse, o.xfer_dirs, o.relative_paths), (0, 1, 1));
	assert_eq!(o.filesfrom_fd, FilesFromFd::File);
	let o = run(&["--chown=u:g", "a", "b"]);
	assert_eq!((o.usermap, o.groupmap), (Some("*:u".into()), Some("*:g".into())));
	assert!(o.preserve_uid && o.preserve_gid);
}

#[test]
fn filter_options_keep_command_line_order() {
	let o = run(&["-F", "--exclude=*.o", "-FF", "--include", "x", "-f", "- y", "a", "b"]);
	assert_eq!(o.f_option_cnt, 3);
	assert_eq!(
		o.filter_rules,
		vec![
			FilterOpt::Filter(b": /.rsync-filter".to_vec()),
			FilterOpt::Exclude(b"*.o".to_vec()),
			FilterOpt::Filter(b"- .rsync-filter".to_vec()),
			FilterOpt::Include(b"x".to_vec()),
			FilterOpt::Filter(b"- y".to_vec()),
		]
	);
	let o = run(&["-rb", "--delete", "a", "b"]);
	assert_eq!(o.filter_rules, vec![FilterOpt::Filter(b"P *~".to_vec())]);
	assert_eq!(o.omit_dir_times, -1);
}

#[test]
fn conflicting_options_are_rejected_with_reference_text() {
	let cases: &[(&[&str], &str)] = &[
		(&["--delete"], "--delete does not work without --recursive (-r) or --dirs (-d)."),
		(&["--delete-before", "--delete-after", "-r"], "You may not combine multiple --delete-WHEN options."),
		(&["--append", "-W"], "--append cannot be used with --whole-file"),
		(&["--inplace", "--partial-dir=x"], "--inplace cannot be used with --partial-dir"),
		(&["--append", "--delay-updates"], "--append cannot be used with --delay-updates"),
		(&["--usermap=a", "--usermap=b"], "You can only specify --usermap once."),
		(&["--chown=a", "--usermap=b"], "--usermap conflicts with prior --chown."),
		(&["--usermap=b", "--chown=a"], "--chown conflicts with prior --usermap."),
		(&["--chown=a:", "--chown=b"], "You can only specify a user-affecting --chown once."),
		(&["--chown=:g", "--groupmap=x"], "--groupmap conflicts with prior --chown."),
		(&["--old-args", "-s"], "--secluded-args conflicts with --old-args."),
		(&["--write-batch=x", "--read-batch=y"], "--write-batch and --read-batch can not be used together"),
		(&["--outbuf=x"], "Invalid --outbuf setting -- specify N, L, or B."),
		(&["--stderr=x"], "--stderr mode \"x\" is not one of errors, all, or client"),
		(&["--stderr="], "--stderr mode \"\" is not one of errors, all, or client"),
		(&["--confine-root=x"], "--confine-root must be an absolute path"),
		(&["--confine-root=/", "--insecure-links"], "--insecure-links cannot be combined with --confine-root"),
		(&["--suffix=a/b"], "--suffix cannot contain slashes: a/b"),
		(&["--suffix="], "--suffix cannot be empty without a --backup-dir"),
		(&["--backup-dir=.", "--suffix="], "--suffix cannot be empty when --backup-dir is the same as the dest dir"),
		(&["--stop-after=0"], "invalid --stop-after value: 0"),
		(&["--stop-after=x"], "invalid --stop-after value: x"),
		(&["--stop-at=x"], "invalid --stop-at format: x"),
		(&["--stop-at=2001-01-01"], "--stop-at time is not in the future: 2001-01-01"),
		(&["-M", "a"], "Remote option must start with a dash: a"),
		(&["--compare-dest=a", "--link-dest=b"], "ERROR: the --link-dest option conflicts with the --compare-dest option"),
		(&["--read-batch=x", "--remove-source-files"], "--read-batch cannot be used with --remove-source-files"),
		(&["--files-from=h:-"], "Invalid --files-from remote filename"),
	];
	for (args, text) in cases {
		let mut full = args.to_vec();
		full.extend(["a", "b"]);
		let e = err(&full);
		assert_eq!(e.message.as_deref(), Some(format!("rsync: {text}").as_str()), "{args:?}");
		assert_eq!((e.code, e.site), (RERR_SYNTAX, Some(("main.c", 1913))), "{args:?}");
	}
	assert!(run(&["--backup-dir=x", "--suffix=", "a", "b"]).make_backups);
	assert!(run(&["--stderr=e", "a", "b"]).saw_stderr_opt);
	assert_eq!(run(&["--stderr=a", "a", "b"]).stderr_mode(), 1);
	assert_eq!(run(&["--stderr=c", "a", "b"]).stderr_mode(), 2);
	assert!(run(&["--stop-after=5", "a", "b"]).stop_at_utime > unix_now());
	assert!(run(&["--stop-at=T00:00", "a", "b"]).stop_at_utime > unix_now());
}

#[cfg(unix)]
#[test]
fn fake_super_conflicts_with_double_x() {
	assert_eq!(msg(&["--fake-super", "-XX", "a", "b"]), "rsync: --fake-super conflicts with -XX");
}

#[test]
fn checksum_and_compress_choices() {
	let e = err(&["--cc=foo", "a", "b"]);
	assert_eq!((e.code, e.message.as_deref()), (RERR_UNSUPPORTED, Some("unknown checksum name: foo")));
	assert_eq!(e.site, Some(("checksum.c", 157)));
	assert_eq!(msg(&["--cc=md5,foo", "a", "b"]), "unknown checksum name: foo");
	assert_eq!(msg(&["--cc=foo,md5", "a", "b"]), "unknown checksum name: foo,md5");
	let e = err(&["--zc=foo", "a", "b"]);
	assert_eq!((e.code, e.message.as_deref()), (RERR_UNSUPPORTED, Some("unknown compress name: foo")));
	assert_eq!(e.site, Some(("compat.c", 190)));
	assert_eq!(run(&["--cc=auto", "a", "b"]).checksum_choice, None);
	assert_eq!(run(&["--cc=none", "a", "b"]).whole_file, 1);
	let o = run(&["--zc=ZSTD", "a", "b"]);
	let zstd = i32::from(crate::rsync::token::Compress::Zstd.num());
	assert_eq!((o.do_compression, o.compress_choice), (zstd, Some("ZSTD".into())));
	let o = run(&["--zc=none", "-z", "a", "b"]);
	assert_eq!((o.do_compression, o.compress_choice), (CPRES_NONE, Some("none".into())));
	assert_eq!(run(&["-zz", "a", "b"]).do_compression, CPRES_ZLIBX);
	assert_eq!(run(&["--compress-level=3", "a", "b"]).do_compression, CPRES_AUTO);
	assert_eq!(run(&["--zl=-2147483648", "a", "b"]).do_compression_level, None);
	// A server checks the client's choice against its own env list.
	let e = match parse_env(&["--server", "--compress-choice=zstd", ".", "x"], &[("RSYNC_COMPRESS_LIST", "lz4 zlib")]) {
		Err(e) => e,
		other => panic!("{other:?}"),
	};
	assert_eq!(e.message.as_deref(), Some("Your --compress-choice value (zstd) was refused by the server."));
	assert!(parse_env(&["--server", "--zc=zstd", ".", "x"], &[("RSYNC_COMPRESS_LIST", "zlib&zstd")]).is_ok());
}

#[test]
fn environment_defaults() {
	let get = |args: &[&str], env: &[(&str, &str)]| match parse_env(args, env) {
		Ok(Parsed::Run(o)) => o,
		other => panic!("{other:?}"),
	};
	assert_eq!(get(&["a", "b"], &[("RSYNC_PROTECT_ARGS", "1")]).protect_args, 1);
	assert_eq!(get(&["a", "b"], &[("RSYNC_PROTECT_ARGS", "0")]).protect_args, 0);
	let o = get(&["a", "b"], &[("RSYNC_OLD_ARGS", "2"), ("RSYNC_PROTECT_ARGS", "1")]);
	assert_eq!((o.old_style_args, o.protect_args), (2, 0));
	let o = get(&["-P", "a", "b"], &[("RSYNC_PARTIAL_DIR", ".p/../q")]);
	assert_eq!(o.partial_dir, Some("q".into()));
	assert_eq!(get(&["a", "b"], &[("RSYNC_PARTIAL_DIR", "x")]).partial_dir, None);
	if SUPPORT_ICONV {
		assert_eq!(get(&["a", "b"], &[("RSYNC_ICONV", "utf8")]).iconv_opt, Some("utf8".into()));
		assert_eq!(get(&["--iconv=-", "a", "b"], &[]).iconv_opt, None);
	}
	assert!(get(&["--files-from=h:/l", "a", "b"], &[]).trust_sender_args);
}

#[test]
fn files_from_host_specs() {
	let o = run(&["--files-from=u@h::mod/list", "a", "b"]);
	assert_eq!((o.filesfrom_host, o.files_from), (Some("u@h".into()), Some("mod/list".into())));
	let o = run(&["--files-from=[::1]:/l", "a", "b"]);
	assert_eq!((o.filesfrom_host, o.files_from), (Some("::1".into()), Some("/l".into())));
	let o = run(&["--files-from=:/l", "a", "b"]);
	assert_eq!(o.filesfrom_host, Some("".into()));
	assert_eq!(run(&["--files-from=dir/x:y", "a", "b"]).filesfrom_host, None);
	assert_eq!(run(&["--files-from=-", "a", "b"]).filesfrom_fd, FilesFromFd::Stdin);
	assert_eq!(files_from_hostspec(b"C:\\list", true), None);
	assert_eq!(files_from_hostspec(b"\\\\srv\\share\\list", true), None);
	assert!(files_from_hostspec(b"C:\\list", false).is_some());
	assert!(is_absolute_operator_path(b"C:\\x", true));
	assert!(is_absolute_operator_path(b"\\\\srv\\x", true));
	assert!(!is_absolute_operator_path(b"C:x", true));
	assert!(!is_absolute_operator_path(b"C:\\x", false));
}

#[test]
fn log_format_escape_detection() {
	assert!(log_format_has(b"%i %n", b'i'));
	assert!(log_format_has(b"%-10'n", b'n'));
	assert!(!log_format_has(b"%%i", b'i'));
	assert!(!log_format_has(b"100%", b'i'));
	let o = run(&["--out-format=%i%n", "a", "b"]);
	assert_eq!(o.stdout_format_has_i, 1);
	assert!(o.stdout_format_has_o_or_i && o.log_before_transfer);
	let o = run(&["-ii", "a", "b"]);
	assert_eq!(o.stdout_format.as_deref(), Some(&b"%i %n%L"[..]));
	assert_eq!(o.stdout_format_has_i, 2);
	assert_eq!(run(&["-v", "a", "b"]).stdout_format.as_deref(), Some(&b"%n%L"[..]));
	let o = run(&["--log-file=/tmp/x", "a", "b"]);
	assert_eq!(o.logfile_format.as_deref(), Some(&b"%i %n%L"[..]));
}

#[test]
fn stop_at_time_forms() {
	let tz = jiff::tz::TimeZone::UTC;
	// 2026-10-29 12:00:00 UTC
	let now = 1_793_275_200;
	let at = |s: &str| parse_time_in(s.as_bytes(), now, &tz);
	assert_eq!(at("2026-10-30"), Some(now + 12 * 3600));
	assert_eq!(at("2026-10-29T13:30"), Some(now + 5400));
	assert_eq!(at("T13:30"), Some(now + 5400));
	assert_eq!(at("T11:00"), Some(now + 23 * 3600));
	assert_eq!(at(":30"), Some(now + 1800));
	assert_eq!(at("30"), Some(now + 12 * 3600));
	// A day already past this month rolls to next month.
	assert_eq!(at("28"), Some(now + 2_548_800));
	assert_eq!(at("26-10-30"), Some(now + 12 * 3600));
	assert_eq!(at("2026/10/30"), Some(now + 12 * 3600));
	assert_eq!(at("2026-10-29T25:00"), None);
	assert_eq!(at("T13"), None);
	assert_eq!(at("x"), None);
}

// ---- server argv (captured from the reference) ----

#[test]
fn server_args_pull_match_reference() {
	let cases: &[(&[&str], &[&str])] = &[
		(&["-a"], &["-logDtpre.iLsfxCIvu"]),
		(&["-av", "--delete"], &["-vlogDtpre.iLsfxCIvu"]),
		(&["-d", "--delete"], &["-de.LsfxCIvu"]),
		(&["-avzP", "--stats"], &["-vlogDtprze.iLsfxCIvu"]),
		(&["-auv", "--inplace", "--sparse"], &["-vulogDtprSe.iLsfxCIvu", "--inplace"]),
		(&["-a", "--append"], &["-logDtpre.iLsfxCIvu", "--append"]),
		(&["-a", "--append-verify"], &["-logDtpre.iLsfxCIvu", "--append", "--append"]),
		(&["-a", "--partial-dir=.pd", "--delay-updates"], &["-logDtpre.LsfxCIvu"]),
		(
			&["-a", "--backup", "--backup-dir=/b", "--suffix=.bak"],
			&["-blogDtpre.iLsfxCIvu", "--backup-dir", "/b", "--suffix=.bak"],
		),
		(
			&["-r", "--exclude=*.o", "--max-size=1.5k", "--min-size=10", "--bwlimit=100", "-B", "2k", "--timeout=30"],
			&["-re.iLsfxCIvu", "-B2048", "--timeout=30", "--bwlimit=100"],
		),
		(&["-a", "--info=progress2,name0", "-i"], &["-logDtpre.iLsfxCIvu", "--info=NAME0"]),
		(&["-a", "--files-from=-", "--from0"], &["-logDtpRe.LsfxCIvu", "--files-from=-", "--from0"]),
		(&["-a", "--files-from=h:/list"], &["-logDtpRe.LsfxCIvu", "--files-from", "/list"]),
		(&["-R", "--no-implied-dirs"], &["-Re.LsfxCIvu", "--no-implied-dirs"]),
		(&["-a", "--checksum-seed=7", "--size-only", "--super", "--force"], &["-logDtpre.iLsfxCIvu", "--checksum-seed=7"]),
		(
			&["-a", "--write-devices", "--copy-devices", "--preallocate", "--open-noatime", "--mkpath"],
			&["-logDtpre.iLsfxCIvu", "--inplace", "--copy-devices", "--open-noatime"],
		),
		(&["-a", "-O", "-J", "-m", "-K", "-k", "-L", "-W"], &["-lLkWogDtpre.LsfxCIvu"]),
		(&["-a", "-q"], &["-qlogDtpre.iLsfxCIvu"]),
		(&["-a", "--stderr=client"], &["-logDtpre.iLsfxCIvu", "--no-msgs2stderr"]),
		(&["-a", "--msgs2stderr"], &["-logDtpre.iLsfxCIvu", "--msgs2stderr"]),
		(&["-a", "--list-only"], &["-logDtpre.iLsfxCIvu", "--list-only"]),
		(
			&["-a", "--copy-unsafe-links", "--safe-links", "--ignore-errors"],
			&["-logDtpre.iLsfxCIvu", "--ignore-errors", "--copy-unsafe-links", "--safe-links"],
		),
		(&["-a", "--protocol=29"], &["-logDtpr"]),
		(&["-a", "--max-alloc=2g"], &["-logDtpre.iLsfxCIvu", "--max-alloc=2g"]),
		(&["-a", "--max-alloc=1g"], &["-logDtpre.iLsfxCIvu"]),
		(&["-a", "--skip-compress=gz/jpg"], &["-logDtpre.iLsfxCIvu", "--skip-compress=gz/jpg"]),
		(&["-a", "-xx", "-C", "-I", "-c", "-S", "-n"], &["-nlogDtprcCIxxSe.iLsfxCIvu"]),
		(&["-a", "-M--foo=a b", "-M-x"], &["-logDtpre.iLsfxCIvu", "--foo=a\\ b", "-x"]),
		(&["-a", "--suffix=~a b*"], &["-logDtpre.iLsfxCIvu", "--suffix=~a\\ b\\*"]),
		(&["-a", "--no-i-r"], &["-logDtpre.LsfxCIvu"]),
		(&["-r", "--qsort"], &["-re.LsfxCIvu", "--use-qsort"]),
		(&["-a", "--trust-sender", "--insecure-links", "-8", "--no-motd"], &["-logDtpre.iLsfxCIvu"]),
		(&["--qsort"], &["-e.LsfxCIvu", "--use-qsort"]),
		(&["--compress-level=3"], &["-e.LsfxCIvu", "--compress-level=3"]),
		(&["-z"], &["-ze.LsfxCIvu"]),
		(&["-zz"], &["-e.LsfxCIvu", "--new-compress"]),
		(&["--zc=zstd"], &["-e.LsfxCIvu", "--compress-choice=zstd"]),
		(&["--zc=zlib"], &["-ze.LsfxCIvu", "--old-compress"]),
		(&["--zc=none", "-z"], &["-e.LsfxCIvu", "--compress-choice=none"]),
		(&["--zc=lz4", "--zl=1"], &["-e.LsfxCIvu", "--compress-level=1", "--compress-choice=lz4"]),
		(&["--cc=xxh128"], &["-e.LsfxCIvu", "--checksum-choice=xxh128"]),
		(&["--cc=md5,md4"], &["-e.LsfxCIvu", "--checksum-choice=md5,md4"]),
		(
			&["--old-args", "--suffix=a b*", "-M--foo=a b*", "--backup-dir=q r"],
			&["-be.LsfxCIvu", "--backup-dir", "q\\ r", "--suffix=a\\ b\\*", "--foo=a b*"],
		),
		(&["--old-args", "--old-args", "--suffix=a b", "-M--foo=a b"], &["-e.LsfxCIvu", "--suffix=a b", "--foo=a b"]),
	];
	for (args, want) in cases {
		assert_eq!(remote(args, PULL), *want, "{args:?}");
	}
}

#[test]
fn server_args_push_match_reference() {
	let cases: &[(&[&str], &[&str])] = &[
		(&["-a"], &["-logDtpre.iLsfxCIvu"]),
		(&["-av", "--delete"], &["-vlogDtpre.iLsfxCIvu", "--delete"]),
		(&["-d", "--delete"], &["-de.LsfxCIvu", "--no-r", "--delete"]),
		(&["-avzP", "--stats"], &["-vlogDtprze.iLsfxCIvu", "--stats", "--partial"]),
		(&["-a", "--partial-dir=.pd", "--delay-updates"], &["-logDtpre.iLsfxCIvu", "--partial-dir", ".pd", "--delay-updates"]),
		(&["-a", "--delay-updates"], &["-logDtpre.iLsfxCIvu", "--delay-updates"]),
		(
			&["-r", "--exclude=*.o", "--max-size=1.5k", "--min-size=10", "--bwlimit=100", "-B", "2k", "--timeout=30"],
			&["-re.iLsfxCIvu", "-B2048", "--timeout=30", "--bwlimit=100", "--min-size=10", "--max-size=1536"],
		),
		(&["-a", "--info=progress2,name0", "-i"], &["-logDtpre.iLsfxCIvu", "--log-format=%i", "--info=NAME0"]),
		(&["-a", "--out-format=%n"], &["-logDtpre.iLsfxCIvu", "--log-format=X"]),
		(&["-a", "--out-format=%i%n"], &["-logDtpre.iLsfxCIvu", "--log-format=%i"]),
		(&["-a", "-i"], &["-logDtpre.iLsfxCIvu", "--log-format=%i"]),
		(
			&["-a", "--link-dest=/l1", "--link-dest=/l2"],
			&["-logDtpre.iLsfxCIvu", "--link-dest", "/l1", "--link-dest", "/l2"],
		),
		(&["-a", "--compare-dest=x"], &["-logDtpre.iLsfxCIvu", "--compare-dest", "x"]),
		(&["-a", "-yy", "--copy-dest=c"], &["-lyyogDtpre.iLsfxCIvu", "--copy-dest", "c"]),
		(&["-a", "--max-delete=0"], &["-logDtpre.iLsfxCIvu", "--max-delete=-1"]),
		(&["-a", "--max-delete=5", "--delete-delay"], &["-logDtpre.iLsfxCIvu", "--max-delete=5", "--delete-delay"]),
		(&["-a", "--remove-source-files"], &["-logDtpre.iLsfxCIvu", "--remove-source-files"]),
		(&["-a", "--remove-sent-files"], &["-logDtpre.iLsfxCIvu", "--remove-sent-files"]),
		(&["-a", "--chown=u:g"], &["-logDtpre.iLsfxCIvu", "--usermap=\\*:u", "--groupmap=\\*:g"]),
		(&["-a", "--usermap=1:2", "--groupmap=3:4"], &["-logDtpre.iLsfxCIvu", "--usermap=1:2", "--groupmap=3:4"]),
		(
			&["-a", "--temp-dir=/t mp", "--fsync", "--existing", "--ignore-existing"],
			&["-logDtpre.iLsfxCIvu", "--ignore-existing", "--existing", "--temp-dir", "/t\\ mp", "--fsync"],
		),
		(&["-a", "--files-from=-", "--from0"], &["-logDtpRe.LsfxCIvu"]),
		(&["-a", "--files-from=h:/list"], &["-logDtpRe.LsfxCIvu", "--files-from", "/list"]),
		(&["-a", "--modify-window=2"], &["-logDtpre.iLsfxCIvu", "--modify-window=2"]),
		(&["-a", "-@-1"], &["-logDtpre.iLsfxCIvu", "-@-1"]),
		(
			&["-a", "--checksum-seed=7", "--size-only", "--super", "--force"],
			&["-logDtpre.iLsfxCIvu", "--force", "--super", "--size-only", "--checksum-seed=7"],
		),
		(&["-a", "--delete-excluded"], &["-logDtpre.iLsfxCIvu", "--delete-excluded"]),
		(&["-a", "--ignore-missing-args"], &["-logDtpre.iLsfxCIvu"]),
		(&["-a", "--delete-missing-args"], &["-logDtpre.iLsfxCIvu", "--delete-missing-args"]),
		(
			&["-a", "--write-devices", "--copy-devices", "--preallocate", "--open-noatime", "--mkpath"],
			&["-logDtpre.iLsfxCIvu", "--inplace", "--write-devices", "--preallocate", "--open-noatime", "--mkpath"],
		),
		(&["-a", "-UU"], &["-logDtUUpre.iLsfxCIvu"]),
		(&["-a", "-U", "--open-noatime"], &["-logDtUpre.iLsfxCIvu", "--open-noatime"]),
		(&["-rE"], &["-Ere.iLsfxCIvu"]),
		(&["-a", "--no-specials"], &["-logDtpre.iLsfxCIvu", "--no-specials"]),
		(&["-r", "--specials"], &["-re.iLsfxCIvu", "--specials"]),
		(&["-r", "--devices"], &["-Dre.iLsfxCIvu", "--no-specials"]),
		(&["-a", "-O", "-J", "-m", "-K", "-k", "-L", "-W"], &["-lKmOJWogDtpre.iLsfxCIvu"]),
		(&["-a", "--only-write-batch=f"], &["-logDtpre.iLsfxCIvu", "--only-write-batch=X"]),
		(&["-a", "--skip-compress=gz/jpg"], &["-logDtpre.iLsfxCIvu"]),
		(&["-a", "-xx", "-C", "-I", "-c", "-S", "-n"], &["-nlogDtprcCIxxSe.iLsfxCIvu"]),
		(&["-a", "--protocol=29"], &["-logDtpr"]),
	];
	for (args, want) in cases {
		assert_eq!(remote(args, PUSH), *want, "{args:?}");
	}
}

#[cfg(unix)]
#[test]
fn server_args_with_acls_and_xattrs() {
	let want = ["-vvvlHogDtpAXre.iLsfxCIvu", "--numeric-ids"];
	assert_eq!(remote(&["-rlptgoDvvv", "-HAX", "--numeric-ids"], PULL), want);
	assert_eq!(remote(&["-rlptgoDvvv", "-HAX", "--numeric-ids"], PUSH), want);
}

#[cfg(target_os = "macos")]
#[test]
fn server_args_with_crtimes() {
	assert_eq!(remote(&["-aN", "-E"], PUSH), ["-logDtNpre.iLsfxCIvu"]);
}

#[test]
fn secluded_args_cut_and_env_protection() {
	let (args, cut) = remote_env(&["-a", "-s"], &[], PULL);
	assert_eq!((args, cut), (vec!["-slogDtpre.iLsfxCIvu".to_string()], Some(1)));
	let (args, cut) = remote_env(&["-s", "--suffix=a b", "--temp-dir=x y", "-M--foo=a b"], &[], PUSH);
	assert_eq!(args, ["-se.LsfxCIvu", "--suffix=a b", "--temp-dir", "x y", "--foo=a b"]);
	assert_eq!(cut, Some(1));
	assert_eq!(remote_env(&["-a"], &[("RSYNC_PROTECT_ARGS", "1")], PULL).0, ["-slogDtpre.iLsfxCIvu"]);
	assert_eq!(remote_env(&["--suffix=a b"], &[("RSYNC_OLD_ARGS", "2")], PULL).0, ["-e.LsfxCIvu", "--suffix=a b"]);
	assert_eq!(
		remote_env(&["--suffix=a b"], &[("RSYNC_OLD_ARGS", "1"), ("RSYNC_PROTECT_ARGS", "1")], PULL).0,
		["-e.LsfxCIvu", "--suffix=a\\ b"]
	);
	assert_eq!(remote_env(&["-a"], &[], PULL).1, None);
}

#[test]
fn safe_arg_filename_rules() {
	let o = run(&["a", "b"]);
	assert_eq!(safe_arg(&o, false, SafeOpt::Filename, b"-x y"), b"./-x\\ y");
	assert_eq!(safe_arg(&o, false, SafeOpt::Filename, b"a*b\\*"), b"a*b\\*");
	assert_eq!(safe_arg(&o, false, SafeOpt::Filename, b"~/x"), b"~/x");
	assert_eq!(safe_arg(&o, false, SafeOpt::Filename, b"~x"), b"\\~x");
	assert_eq!(safe_arg(&o, true, SafeOpt::Filename, b"~x"), b"~x");
	assert_eq!(safe_arg(&o, false, SafeOpt::Opt("--x"), b"a\\*"), b"--x=a\\\\\\*");
	let o = run(&["-s", "a", "b"]);
	assert_eq!(safe_arg(&o, false, SafeOpt::Filename, b"-a b"), b"./-a b");
}

// ---- server-side parsing ----

#[test]
fn server_argv_round_trips() {
	let client = run(&["-avz", "--delete", "-H", "--max-size=1.5k", "--bwlimit=100", "-B2k", "--timeout=30", "src", "dst"]);
	let tail = server_args(&client, PUSH);
	let mut server_argv = argv(&["--server"]);
	server_argv.extend(tail);
	server_argv.extend(argv(&[".", "dst"]));
	let s = match parse(&server_argv, &no_env) {
		Ok(Parsed::Run(o)) => o,
		other => panic!("{other:?}"),
	};
	assert!(s.am_server && !s.am_sender);
	assert_eq!(s.args, argv(&[".", "dst"]));
	assert_eq!(s.verbose, 1);
	assert_eq!(s.recurse, 2);
	assert!(s.preserve_links && s.preserve_perms && s.preserve_mtimes && s.preserve_uid && s.preserve_gid);
	assert!(s.preserve_devices && s.preserve_specials);
	assert_eq!(s.preserve_hard_links, 1);
	assert_eq!(s.do_compression, CPRES_ZLIB);
	assert!(s.delete_mode);
	assert_eq!((s.max_size, s.bwlimit, s.block_size, s.io_timeout), (1536, 100, 2048, 30));
	let caps: &[u8] = if SUPPORT_ICONV { b".iLsfxCIvu" } else { b".iLfxCIvu" };
	assert_eq!(&*s.client_info(), caps);
	assert!(s.inc_recurse_allowed(&s.client_info()));
	assert!(s.trust_sender_args && s.trust_sender_filter);

	let client = run(&["-rtv", "--partial-dir=.pd", "--delay-updates", "-yy", "--copy-dest=c", "src", "h:dst"]);
	let mut server_argv = argv(&["--server"]);
	server_argv.extend(server_args(&client, PUSH));
	server_argv.extend(argv(&[".", "dst"]));
	let s = match parse(&server_argv, &no_env) {
		Ok(Parsed::Run(o)) => o,
		other => panic!("{other:?}"),
	};
	assert_eq!(s.partial_dir, Some(".pd".into()));
	assert!(s.delay_updates && s.keep_partial);
	assert_eq!(s.fuzzy_basis, 2);
	assert_eq!((s.alt_dest_type, s.basis_dirs.clone()), (COPY_DEST, argv(&["c"])));
	assert!(!s.inc_recurse_allowed(&s.client_info()));
}

#[test]
fn server_sender_side_and_server_only_rules() {
	let s = run(&["--server", "--sender", "-logDtprze.iLsfxCIvu", "--append", "--append", ".", "src/"]);
	assert!(s.am_server && s.am_sender);
	assert_eq!(s.append_mode, 2);
	assert_eq!(s.args, argv(&[".", "src/"]));
	assert!(s.notices.is_empty());
	let s = run(&["--server", "--write-batch=x", ".", "d"]);
	assert_eq!(s.notices, ["ignoring --write-batch option sent to server"]);
	assert_eq!(s.write_batch, 0);
	assert_eq!(
		msg(&["--server", "--foo", ".", "d"]),
		"rsync: on remote machine: --foo: unknown option"
	);
	assert_eq!(
		msg(&["--server", "--files-from=h:x", ".", "d"]),
		"rsync: The --files-from sent to the server cannot specify a host."
	);
	// Unknown --info words are ignored by a server.
	assert!(parse(&argv(&["--server", "--info=bogus", ".", "d"]), &no_env).is_ok());
	// -h never means --help on a server.
	assert_eq!(err(&["--server", "-h"]).site, Some(("main.c", 1968)));
	let s = run(&["--server", "--files-from=-", "--from0", ".", "d"]);
	assert_eq!((s.filesfrom_fd, s.filesfrom_host.clone()), (FilesFromFd::Stdin, Some(OsString::new())));
}

#[test]
fn server_secluded_args_are_parsed_in_a_second_pass() {
	let first = match parse(&argv(&["--server", "-slogDtpre.iLsfxCIvu"]), &no_env) {
		Ok(Parsed::Run(o)) => o,
		other => panic!("{other:?}"),
	};
	assert!(first.secluded_pending());
	let second = match parse_secluded(*first, &argv(&["--suffix=a b", ".", "dst dir"]), &no_env) {
		Ok(Parsed::Run(o)) => o,
		other => panic!("{other:?}"),
	};
	assert!(!second.secluded_pending());
	assert_eq!(second.protect_args, 2);
	assert_eq!(second.backup_suffix, Some("a b".into()));
	assert_eq!(second.args, argv(&[".", "dst dir"]));
	assert_eq!(second.recurse, 2);
	let first = match parse(&argv(&["--server", "-s"]), &no_env) {
		Ok(Parsed::Run(o)) => o,
		other => panic!("{other:?}"),
	};
	let e = parse_secluded(*first, &argv(&["--bogus"]), &no_env).unwrap_err();
	assert_eq!(e.site, Some(("main.c", 1962)));
}

/// Reference: `rsync --preallocate f h` → "preallocation is not supported on this
/// Server" / code 1 at compat.c(660) from the receiving server; a pull's receiving
/// client says "Client". The sender never refuses (it only forwards the option).
#[test]
fn preallocate_is_refused_by_the_receiver() {
	let o = run(&["--preallocate", "f", "h"]);
	assert!(o.preallocate_files);
	let e = o.preallocate_refusal(true, false).expect("server receiver refuses");
	assert_eq!(e.code, RERR_SYNTAX);
	assert_eq!(e.message.as_deref(), Some("preallocation is not supported on this Server"));
	assert_eq!(e.site, Some(("compat.c", 660)));
	let e = o.preallocate_refusal(false, false).expect("client receiver refuses");
	assert_eq!(e.message.as_deref(), Some("preallocation is not supported on this Client"));
	assert!(o.preallocate_refusal(false, true).is_none());
	assert!(o.preallocate_refusal(true, true).is_none());
	assert!(run(&["f", "h"]).preallocate_refusal(true, false).is_none());
	// The server half of a push still receives the option.
	assert!(remote(&["--preallocate"], PUSH).iter().any(|a| a == "--preallocate"));
}

#[test]
fn local_server_half_flips_roles_and_applies_remote_options() {
	let client = run(&["-av", "--chmod=u+x", "--log-file=/tmp/l", "-M--size-only", "src", "dst"]);
	let s = local_server_options(&client, &no_env).unwrap();
	assert!(s.am_server && !s.am_sender);
	assert!(s.chmod_modes.is_none() && s.logfile_name.is_none());
	assert!(s.size_only && s.args.is_empty());
	let client = run(&["-M--bogus", "src", "dst"]);
	let e = local_server_options(&client, &no_env).unwrap_err();
	assert_eq!(e.site, Some(("pipe.c", 148)));
	assert_eq!(e.message.as_deref(), Some("rsync: on remote machine: --bogus: unknown option"));
}

#[test]
fn every_upstream_option_is_accepted() {
	// Each spelling once, with a value where one is required.
	for spec in table::LONG_OPTIONS {
		if spec.long.is_empty() || matches!(spec.long, "help" | "version" | "server" | "sender" | "config" | "daemon" | "dparam" | "detach" | "no-detach") {
			continue;
		}
		if !crate::rsync::usage::SUPPORT_CRTIMES && spec.long == "crtimes" {
			continue;
		}
		if !SUPPORT_ICONV && spec.long == "iconv" {
			continue;
		}
		if !crate::rsync::usage::SUPPORT_ACLS && spec.long == "acls" {
			continue;
		}
		if !crate::rsync::usage::SUPPORT_XATTRS && matches!(spec.long, "xattrs" | "fake-super") {
			continue;
		}
		let value = match spec.long {
			"stderr" => "all",
			"outbuf" => "L",
			"remote-option" => "-x",
			"chmod" => "u+r",
			"stop-after" | "time-limit" => "5",
			"stop-at" => "T00:00",
			"confine-root" => "/",
			"files-from" => "-",
			"max-size" | "min-size" | "bwlimit" | "block-size" => "2k",
			"max-alloc" => "2m",
			"info" | "debug" => "none",
			"checksum-choice" | "cc" => "md5",
			"compress-choice" | "zc" => "zstd",
			"usermap" | "groupmap" => "a:b",
			"chown" => "a:b",
			_ => "1",
		};
		let mut args: Vec<String> = Vec::new();
		args.push(match spec.kind {
			Kind::None => format!("--{}", spec.long),
			_ => format!("--{}={value}", spec.long),
		});
		if spec.long.starts_with("delete") || spec.long == "del" {
			args.push("-r".into());
		}
		args.extend(["src".into(), "dst".into()]);
		let refs: Vec<&str> = args.iter().map(String::as_str).collect();
		match parse(&argv(&refs), &no_env) {
			Ok(Parsed::Run(_)) => {}
			other => panic!("--{}: {other:?}", spec.long),
		}
	}
	assert_eq!(table::LONG_OPTIONS.len(), 258);
	assert_eq!(table::DAEMON_OPTIONS.len(), 20);
}
