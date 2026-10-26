//! `uname` builtin: print selected system information.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	ffi::{OsStr, OsString},
	io::Write,
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::display::Quotable;

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes};

mod options {
	pub(super) const ALL: &str = "all";
	pub(super) const KERNEL_NAME: &str = "kernel-name";
	pub(super) const NODENAME: &str = "nodename";
	pub(super) const KERNEL_VERSION: &str = "kernel-version";
	pub(super) const KERNEL_RELEASE: &str = "kernel-release";
	pub(super) const MACHINE: &str = "machine";
	pub(super) const PROCESSOR: &str = "processor";
	pub(super) const HARDWARE_PLATFORM: &str = "hardware-platform";
	pub(super) const OS: &str = "operating-system";
}

struct UNameOutput {
	kernel_name:       Option<OsString>,
	nodename:          Option<OsString>,
	kernel_release:    Option<OsString>,
	kernel_version:    Option<OsString>,
	machine:           Option<OsString>,
	os:                Option<OsString>,
	processor:         Option<OsString>,
	hardware_platform: Option<OsString>,
}

impl UNameOutput {
	fn display(&self) -> OsString {
		[
			self.kernel_name.as_ref(),
			self.nodename.as_ref(),
			self.kernel_release.as_ref(),
			self.kernel_version.as_ref(),
			self.machine.as_ref(),
			self.processor.as_ref(),
			self.hardware_platform.as_ref(),
			self.os.as_ref(),
		]
		.into_iter()
		.flatten()
		.map(OsString::as_os_str)
		.collect::<Vec<_>>()
		.join(OsStr::new(" "))
	}

	fn new(opts: &Options) -> Result<Self, &'static str> {
		let none = !(opts.all
			|| opts.kernel_name
			|| opts.nodename
			|| opts.kernel_release
			|| opts.kernel_version
			|| opts.machine
			|| opts.os
			|| opts.processor
			|| opts.hardware_platform);

		#[cfg(unix)]
		let (kernel_name, nodename, kernel_release, kernel_version, machine, os) = {
			use std::os::unix::ffi::OsStrExt;

			let uname = rustix::system::uname();
			let owned = |value: &std::ffi::CStr| OsStr::from_bytes(value.to_bytes()).to_owned();
			(
				(opts.kernel_name || opts.all || none).then(|| owned(uname.sysname())),
				(opts.nodename || opts.all).then(|| owned(uname.nodename())),
				(opts.kernel_release || opts.all).then(|| owned(uname.release())),
				(opts.kernel_version || opts.all).then(|| owned(uname.version())),
				(opts.machine || opts.all).then(|| owned(uname.machine())),
				(opts.os || opts.all).then(|| OS_NAME.into()),
			)
		};

		#[cfg(windows)]
		let (kernel_name, nodename, kernel_release, kernel_version, machine, os) = {
			use windows_sys::{
				Wdk::System::SystemServices::RtlGetVersion,
				Win32::System::SystemInformation::{
					GetNativeSystemInfo, OSVERSIONINFOEXW, PROCESSOR_ARCHITECTURE_ALPHA,
					PROCESSOR_ARCHITECTURE_ALPHA64, PROCESSOR_ARCHITECTURE_AMD64,
					PROCESSOR_ARCHITECTURE_ARM, PROCESSOR_ARCHITECTURE_ARM64,
					PROCESSOR_ARCHITECTURE_IA64, PROCESSOR_ARCHITECTURE_INTEL,
					PROCESSOR_ARCHITECTURE_MIPS, PROCESSOR_ARCHITECTURE_PPC,
					PROCESSOR_ARCHITECTURE_SHX, SYSTEM_INFO,
				},
			};

			let nodename = windows_nodename().map_err(|_| "cannot get system name")?;
			let mut version = OSVERSIONINFOEXW {
				dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOEXW>() as u32,
				..Default::default()
			};
			// RtlGetVersion accepts the extended structure when its size is supplied.
			if unsafe { RtlGetVersion((&mut version as *mut OSVERSIONINFOEXW).cast()) } < 0 {
				return Err("cannot get system name");
			}
			let mut system = SYSTEM_INFO::default();
			unsafe { GetNativeSystemInfo(&mut system) };
			let architecture = match unsafe { system.Anonymous.Anonymous.wProcessorArchitecture } {
				PROCESSOR_ARCHITECTURE_AMD64 => "x86_64",
				PROCESSOR_ARCHITECTURE_INTEL => match system.wProcessorLevel {
					4 => "i486",
					5 => "i586",
					6 => "i686",
					_ => "i386",
				},
				PROCESSOR_ARCHITECTURE_IA64 => "ia64",
				PROCESSOR_ARCHITECTURE_ARM => "arm",
				PROCESSOR_ARCHITECTURE_ARM64 => "aarch64",
				PROCESSOR_ARCHITECTURE_MIPS => "mips",
				PROCESSOR_ARCHITECTURE_PPC => "powerpc",
				PROCESSOR_ARCHITECTURE_ALPHA | PROCESSOR_ARCHITECTURE_ALPHA64 => "alpha",
				PROCESSOR_ARCHITECTURE_SHX => "superh",
				_ => "unknown",
			};
			(
				(opts.kernel_name || opts.all || none).then(|| "Windows_NT".into()),
				(opts.nodename || opts.all).then_some(nodename),
				(opts.kernel_release || opts.all)
					.then(|| format!("{}.{}", version.dwMajorVersion, version.dwMinorVersion).into()),
				(opts.kernel_version || opts.all).then(|| version.dwBuildNumber.to_string().into()),
				(opts.machine || opts.all).then(|| architecture.into()),
				(opts.os || opts.all).then(|| windows_os_name(&version)),
			)
		};

		#[cfg(target_os = "wasi")]
		let (kernel_name, nodename, kernel_release, kernel_version, machine, os) = (
			(opts.kernel_name || opts.all || none).then(|| "wasi".into()),
			(opts.nodename || opts.all).then(|| {
				["HOSTNAME", "COMPUTERNAME"]
					.into_iter()
					.filter_map(|name| std::env::var(name).ok())
					.find(|value| !value.is_empty())
					.unwrap_or_else(|| "localhost".into())
					.into()
			}),
			(opts.kernel_release || opts.all).then(|| "0.0.0".into()),
			(opts.kernel_version || opts.all).then(|| "0.0.0".into()),
			(opts.machine || opts.all).then(|| std::env::consts::ARCH.into()),
			(opts.os || opts.all).then(|| OS_NAME.into()),
		);

		#[cfg(not(any(unix, windows, target_os = "wasi")))]
		let (kernel_name, nodename, kernel_release, kernel_version, machine, os) = (
			(opts.kernel_name || opts.all || none).then(|| OS_NAME.into()),
			(opts.nodename || opts.all).then(|| OS_NAME.into()),
			(opts.kernel_release || opts.all).then(|| OS_NAME.into()),
			(opts.kernel_version || opts.all).then(|| OS_NAME.into()),
			(opts.machine || opts.all).then(|| OS_NAME.into()),
			(opts.os || opts.all).then(|| OS_NAME.into()),
		);

		// This option is unsupported on modern Linux systems.
		// See: https://lists.gnu.org/archive/html/bug-coreutils/2005-09/msg00063.html
		let processor = opts.processor.then(|| "unknown".into());

		// This option is unsupported on modern Linux systems.
		// See: https://lists.gnu.org/archive/html/bug-coreutils/2005-09/msg00063.html
		let hardware_platform = opts.hardware_platform.then(|| "unknown".into());

		Ok(Self {
			kernel_name,
			nodename,
			kernel_release,
			kernel_version,
			machine,
			os,
			processor,
			hardware_platform,
		})
	}
}

#[cfg(not(windows))]
const OS_NAME: &str = if cfg!(all(target_os = "linux", any(target_env = "gnu", target_env = ""))) {
	"GNU/Linux"
} else if cfg!(target_os = "linux") {
	"Linux"
} else if cfg!(target_os = "android") {
	"Android"
} else if cfg!(target_os = "freebsd") {
	"FreeBSD"
} else if cfg!(target_os = "netbsd") {
	"NetBSD"
} else if cfg!(target_os = "openbsd") {
	"OpenBSD"
} else if cfg!(target_vendor = "apple") {
	"Darwin"
} else if cfg!(target_os = "fuchsia") {
	"Fuchsia"
} else if cfg!(target_os = "redox") {
	"Redox"
} else if cfg!(target_os = "illumos") {
	"illumos"
} else if cfg!(target_os = "solaris") {
	"Solaris"
} else if cfg!(target_os = "haiku") {
	"Haiku"
} else if cfg!(target_os = "dragonfly") {
	"DragonFly"
} else if cfg!(target_os = "aix") {
	"AIX"
} else if cfg!(target_os = "cygwin") {
	"Cygwin"
} else if cfg!(target_os = "wasi") {
	"WASI"
} else if cfg!(target_os = "hurd") {
	"GNU"
} else {
	"unknown"
};

#[cfg(windows)]
fn windows_nodename() -> std::io::Result<OsString> {
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
	// Only the code units written by the API become initialized elements.
	unsafe { buffer.set_len(size as usize) };
	Ok(OsString::from_wide(&buffer))
}

#[cfg(windows)]
fn windows_os_name(
	version: &windows_sys::Win32::System::SystemInformation::OSVERSIONINFOEXW,
) -> OsString {
	use windows_sys::Win32::System::SystemServices::{VER_NT_WORKSTATION, VER_SUITE_WH_SERVER};

	let workstation = u32::from(version.wProductType) == VER_NT_WORKSTATION;
	let name = match (version.dwMajorVersion, version.dwMinorVersion) {
		(5, 0) => "Windows 2000",
		(5, 1) => "Windows XP",
		(5, 2) if workstation => "Windows XP Professional x64 Edition",
		(5, 2) if u32::from(version.wSuiteMask) == VER_SUITE_WH_SERVER => "Windows Home Server",
		(5, 2) => "Windows Server 2003",
		(6, 0) if workstation => "Windows Vista",
		(6, 0) => "Windows Server 2008",
		(6, 1) if workstation => "Windows 7",
		(6, 1) => "Windows Server 2008 R2",
		(6, 2) if workstation => "Windows 8",
		(6, 2) => "Windows Server 2012",
		(6, 3) if workstation => "Windows 8.1",
		(6, 3) => "Windows Server 2012 R2",
		(10, 0) if workstation && version.dwBuildNumber >= 22000 => "Windows 11",
		(10, 0) if !workstation && (14000..17000).contains(&version.dwBuildNumber) => {
			"Windows Server 2016"
		},
		(10, 0) if !workstation && (17000..19000).contains(&version.dwBuildNumber) => {
			"Windows Server 2019"
		},
		(10, 0) if !workstation && version.dwBuildNumber >= 20000 => "Windows Server 2022",
		(10, _) => "Windows 10",
		_ => {
			let family = if workstation { "Windows" } else { "Windows Server" };
			return format!(
				"MS/Windows ({family} {}.{})",
				version.dwMajorVersion, version.dwMinorVersion,
			)
			.into();
		},
	};
	format!("MS/Windows ({name})").into()
}

struct Options {
	all:               bool,
	kernel_name:       bool,
	nodename:          bool,
	kernel_version:    bool,
	kernel_release:    bool,
	machine:           bool,
	processor:         bool,
	hardware_platform: bool,
	os:                bool,
}

/// Parsed `uname` invocation.
pub(crate) struct Uname {
	matches: ArgMatches,
}

matches_parser!(Uname, uu_app);

impl Utility for Uname {
	const NAME: &'static str = "uname";

	fn run(self, host: &mut Host) -> i32 {
		let options = Options {
			all:               self.matches.get_flag(options::ALL),
			kernel_name:       self.matches.get_flag(options::KERNEL_NAME),
			nodename:          self.matches.get_flag(options::NODENAME),
			kernel_release:    self.matches.get_flag(options::KERNEL_RELEASE),
			kernel_version:    self.matches.get_flag(options::KERNEL_VERSION),
			machine:           self.matches.get_flag(options::MACHINE),
			processor:         self.matches.get_flag(options::PROCESSOR),
			hardware_platform: self.matches.get_flag(options::HARDWARE_PLATFORM),
			os:                self.matches.get_flag(options::OS),
		};
		let output = match UNameOutput::new(&options) {
			Ok(output) => output,
			Err(message) => {
				host.error(message, 1);
				return 1;
			},
		};
		let display = output.display();
		let Some(bytes) = os_bytes(display.as_os_str()) else {
			let lossy = display.to_string_lossy();
			host.error(
				format!(
					"invalid UTF-8 input {} encountered when converting to bytes on a platform that doesn't expose byte arguments",
					lossy.quote()
				),
				1,
			);
			return 1;
		};
		if let Err(error) = host
			.stdout
			.write_all(bytes)
			.and_then(|()| host.stdout.write_all(b"\n"))
			.and_then(|()| host.stdout.flush())
		{
			host.error(error, 1);
			return 1;
		}
		0
	}
}

fn uu_app() -> Command {
	Command::new("uname")
		.version("0.8.0")
		.about("Print certain system information.\nWith no OPTION, same as -s.")
		.override_usage(format_usage("uname [OPTION]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(options::ALL)
				.short('a')
				.long(options::ALL)
				.help("Behave as though all of the options -mnrsvo were specified.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::KERNEL_NAME)
				.short('s')
				.long(options::KERNEL_NAME)
				.alias("sysname")
				.help("print the kernel name.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NODENAME)
				.short('n')
				.long(options::NODENAME)
				.help(
					"print the nodename (the nodename may be a name that the system is known by to a \
					 communications network).",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::KERNEL_RELEASE)
				.short('r')
				.long(options::KERNEL_RELEASE)
				.alias("release")
				.help("print the operating system release.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::KERNEL_VERSION)
				.short('v')
				.long(options::KERNEL_VERSION)
				.help("print the operating system version.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::MACHINE)
				.short('m')
				.long(options::MACHINE)
				.help("print the machine hardware name.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OS)
				.short('o')
				.long(options::OS)
				.help("print the operating system name.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PROCESSOR)
				.short('p')
				.long(options::PROCESSOR)
				.help("print the processor type (non-portable)")
				.action(ArgAction::SetTrue)
				.hide(true),
		)
		.arg(
			Arg::new(options::HARDWARE_PLATFORM)
				.short('i')
				.long(options::HARDWARE_PLATFORM)
				.help("print the hardware platform (non-portable)")
				.action(ArgAction::SetTrue)
				.hide(true),
		)
}

#[cfg(test)]
mod tests {
	use super::Uname;
	use crate::host::run_util;

	fn run(args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Uname>(args, "", ".");
		(code, capture.out(), capture.err())
	}

	#[test]
	fn kernel_name_is_one_nonempty_field() {
		let (code, stdout, stderr) = run(&["-s"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(stdout.lines().count(), 1);
		assert!(!stdout.trim_end().is_empty());
		assert!(!stdout.trim_end().contains(' '));
	}

	#[test]
	fn no_options_defaults_to_kernel_name() {
		let (code, bare, stderr) = run(&[]);
		let (_, with_s, _) = run(&["-s"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(bare, with_s);
	}

	#[test]
	fn all_uses_canonical_s_n_r_v_m_o_order() {
		let (code, all, stderr) = run(&["-a"]);
		let fields = ["-s", "-n", "-r", "-v", "-m", "-o"]
			.map(|flag| run(&[flag]).1.trim_end().to_owned());
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(all, format!("{}\n", fields.join(" ")));
	}

	#[test]
	fn processor_prints_unknown() {
		let (code, stdout, stderr) = run(&["-p"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "unknown\n", ""));
	}

	#[test]
	fn selected_fields_use_canonical_order() {
		let (_, kernel, _) = run(&["-s"]);
		let (_, release, _) = run(&["-r"]);
		let (_, processor, _) = run(&["-p"]);
		let (_, os, _) = run(&["-o"]);
		let (code, combined, stderr) = run(&["-o", "-p", "-r", "-s"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(
			combined,
			format!(
				"{} {} {} {}\n",
				kernel.trim_end(),
				release.trim_end(),
				processor.trim_end(),
				os.trim_end()
			)
		);
	}
}
