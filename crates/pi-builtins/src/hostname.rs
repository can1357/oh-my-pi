//! `hostname` builtin: display or set the system's host name.
//!
//! Ported from uutils coreutils 0.8.0.

#[cfg(not(any(target_os = "freebsd", target_os = "openbsd")))]
use std::net::ToSocketAddrs;
use std::{collections::hash_set::HashSet, ffi::OsString, io::Write};

use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};
#[cfg(any(target_os = "freebsd", target_os = "openbsd"))]
use dns_lookup::lookup_host;

use crate::host::{Host, Utility, format_usage, matches_parser};

static OPT_DOMAIN: &str = "domain";
static OPT_IP_ADDRESS: &str = "ip-address";
static OPT_FQDN: &str = "fqdn";
static OPT_SHORT: &str = "short";
static OPT_HOST: &str = "host";

#[cfg(windows)]
mod wsa {
	use std::io;

	use windows_sys::Win32::Networking::WinSock::{WSACleanup, WSADATA, WSAStartup};

	pub(super) struct WsaHandle(());

	pub(super) fn start() -> io::Result<WsaHandle> {
		let mut data = std::mem::MaybeUninit::<WSADATA>::uninit();
		let err = unsafe { WSAStartup(0x0202, data.as_mut_ptr()) };
		if err == 0 {
			Ok(WsaHandle(()))
		} else {
			Err(io::Error::from_raw_os_error(err))
		}
	}

	impl Drop for WsaHandle {
		fn drop(&mut self) {
			// This possibly returns an error but we can't handle it.
			let _ = unsafe { WSACleanup() };
		}
	}
}

/// Parsed `hostname` invocation.
pub(crate) struct Hostname {
	matches: ArgMatches,
}

matches_parser!(Hostname, app);

impl Utility for Hostname {
	const NAME: &'static str = "hostname";

	fn run(self, host: &mut Host) -> i32 {
		#[cfg(windows)]
		let _handle = match wsa::start() {
			Ok(handle) => handle,
			Err(err) => {
				host.error(format!("failed to start Winsock: {err}"), 1);
				return 1;
			},
		};

		if self.matches.get_one::<OsString>(OPT_HOST).is_some() {
			// Changing the process host's name is not supported by this builtin.
			host.error("setting the hostname is not supported by the in-process builtin", 1);
			return 1;
		}

		match display_hostname(&self.matches, host) {
			Ok(()) => host.exit_code(),
			Err(message) => {
				host.error(message, 1);
				1
			},
		}
	}
}

/// The `hostname` argument model.
fn app() -> Command {
	Command::new(Hostname::NAME)
		.version("0.8.0")
		.about("Display or set the system's host name.")
		.override_usage(format_usage("hostname [OPTION]... [HOSTNAME]"))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_DOMAIN)
				.short('d')
				.long("domain")
				.overrides_with_all([OPT_DOMAIN, OPT_IP_ADDRESS, OPT_FQDN, OPT_SHORT])
				.help("Display the name of the DNS domain if possible")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_IP_ADDRESS)
				.short('i')
				.long("ip-address")
				.overrides_with_all([OPT_DOMAIN, OPT_IP_ADDRESS, OPT_FQDN, OPT_SHORT])
				.help("Display the network address(es) of the host")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_FQDN)
				.short('f')
				.long("fqdn")
				.overrides_with_all([OPT_DOMAIN, OPT_IP_ADDRESS, OPT_FQDN, OPT_SHORT])
				.help("Display the FQDN (Fully Qualified Domain Name) (default)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SHORT)
				.short('s')
				.long("short")
				.overrides_with_all([OPT_DOMAIN, OPT_IP_ADDRESS, OPT_FQDN, OPT_SHORT])
				.help("Display the short hostname (the portion before the first dot) if possible")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_HOST)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::Hostname),
		)
}

#[cfg(unix)]
fn get_hostname() -> std::io::Result<OsString> {
	use std::os::unix::ffi::OsStringExt;

	let limit = unsafe { uucore::libc::sysconf(uucore::libc::_SC_HOST_NAME_MAX) }.max(255);
	let mut buffer = vec![0; limit as usize + 1];
	if unsafe {
		uucore::libc::gethostname(buffer.as_mut_ptr().cast(), limit as usize)
	} != 0
	{
		return Err(std::io::Error::last_os_error());
	}
	buffer.truncate(buffer.iter().position(|&byte| byte == 0).unwrap_or(buffer.len()));
	Ok(OsString::from_vec(buffer))
}

#[cfg(windows)]
fn get_hostname() -> std::io::Result<OsString> {
	use std::os::windows::ffi::OsStringExt;
	use windows_sys::Win32::System::SystemInformation::{
		ComputerNamePhysicalDnsHostname, GetComputerNameExW,
	};

	let mut size = 0;
	unsafe {
		GetComputerNameExW(ComputerNamePhysicalDnsHostname, std::ptr::null_mut(), &mut size);
	}
	if size == 0 {
		return Err(std::io::Error::last_os_error());
	}
	let mut buffer = Vec::with_capacity(size as usize);
	if unsafe {
		GetComputerNameExW(ComputerNamePhysicalDnsHostname, buffer.as_mut_ptr(), &mut size)
	} == 0
	{
		return Err(std::io::Error::last_os_error());
	}
	// The API initializes exactly `size` UTF-16 code units, excluding the terminator.
	unsafe { buffer.set_len(size as usize) };
	Ok(OsString::from_wide(&buffer))
}

#[cfg(not(any(unix, windows)))]
fn get_hostname() -> std::io::Result<OsString> {
	Err(std::io::Error::new(
		std::io::ErrorKind::Unsupported,
		"hostname lookup is not supported on this platform",
	))
}

fn display_hostname(matches: &ArgMatches, host: &mut Host) -> Result<(), String> {
	let hostname = get_hostname()
		.map_err(|err| format!("failed to get hostname: {err}"))?
		.to_string_lossy()
		.into_owned();

	if matches.get_flag(OPT_IP_ADDRESS) {
		let addresses;

		#[cfg(not(any(target_os = "freebsd", target_os = "openbsd")))]
		{
			let hostname = hostname + ":1";
			addresses = hostname
				.to_socket_addrs()
				.map_err(|err| format!("failed to resolve socket addresses: {err}"))?;
		}

		// DNS reverse lookup via "hostname:1" does not work on FreeBSD and OpenBSD;
		// use the dns-lookup crate instead.
		#[cfg(any(target_os = "freebsd", target_os = "openbsd"))]
		{
			addresses = lookup_host(hostname.as_str())
				.map_err(|err| format!("failed to lookup hostname: {err}"))?;
		}

		let mut hashset = HashSet::new();
		let mut output = String::new();
		for addr in addresses {
			// XXX: not sure why this is necessary...
			if !hashset.contains(&addr) {
				let mut ip = addr.to_string();
				if ip.ends_with(":1") {
					let len = ip.len();
					ip.truncate(len - 2);
				}
				output.push_str(&ip);
				output.push(' ');
				hashset.insert(addr);
			}
		}
		let len = output.len();
		if len > 0 {
			writeln!(host.stdout, "{}", &output[0..len - 1])
				.map_err(|err| err.to_string())?;
		}

		Ok(())
	} else {
		if matches.get_flag(OPT_SHORT) || matches.get_flag(OPT_DOMAIN) {
			let mut it = hostname.char_indices().filter(|&ci| ci.1 == '.');
			if let Some(ci) = it.next() {
				if matches.get_flag(OPT_SHORT) {
					writeln!(host.stdout, "{}", &hostname[0..ci.0])
						.map_err(|err| err.to_string())?;
				} else {
					writeln!(host.stdout, "{}", &hostname[ci.0 + 1..])
						.map_err(|err| err.to_string())?;
				}
			} else if matches.get_flag(OPT_SHORT) {
				writeln!(host.stdout, "{hostname}").map_err(|err| err.to_string())?;
			}
			return Ok(());
		}

		writeln!(host.stdout, "{hostname}").map_err(|err| err.to_string())?;
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::Hostname;
	use crate::host::run_util;

	fn hostname(argv: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Hostname>(argv, "", "/");
		(code, capture.out(), capture.err())
	}

	#[test]
	fn bare_invocation_prints_a_nonempty_line() {
		let (code, stdout, stderr) = hostname(&[]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert!(stdout.ends_with('\n'));
		assert!(!stdout.trim_end().is_empty());
	}

	#[test]
	fn set_attempt_is_rejected() {
		let (code, stdout, stderr) = hostname(&["new-name.example.com"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(
			stderr,
			"hostname: setting the hostname is not supported by the in-process builtin\n"
		);
	}

	#[test]
	fn short_is_dotless_prefix_of_full_hostname() {
		let (code, short, stderr) = hostname(&["-s"]);
		let (_, full, _) = hostname(&[]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		let short = short.trim_end();
		assert!(!short.contains('.'), "-s must strip everything after the first dot");
		assert!(full.trim_end().starts_with(short));
	}

	#[test]
	fn fqdn_flag_matches_default_display() {
		let (code, fqdn, stderr) = hostname(&["-f"]);
		let (_, bare, _) = hostname(&[]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(fqdn, bare);
	}
}
