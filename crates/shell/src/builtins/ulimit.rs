use std::{
	io::{self, ErrorKind, Write},
	mem,
	os::unix::process::CommandExt,
	process,
	str::FromStr,
};

use clap::{
	Parser, builder,
	builder::{IntoResettable, StyledStr},
};
use nix::{sys::resource, unistd::PathconfVar};

use crate::{Error, ExecutionContext, ExecutionResult, Shell, ShellExtensions, builtins};

#[derive(Clone, Copy)]
enum Unit {
	Block,
	Bytes,
	HalfKBytes,
	KBytes,
	Micros,
	Number,
	Seconds,
}

impl Unit {
	const fn scale(self) -> u64 {
		match self {
			Self::Block | Self::HalfKBytes => 512,
			Self::KBytes => 1024,
			_ => 1,
		}
	}
}

#[derive(Clone, Copy)]
enum Virtual {
	Pipe,
	VMem,
}

impl Virtual {
	fn get(self) -> io::Result<(u64, u64)> {
		match self {
			Self::Pipe => {
				let lim = PathconfVar::PIPE_BUF as u64 * 512;
				Ok((lim, lim))
			},
			Self::VMem => Physical::AS.get().or_else(|_| Physical::VMEM.get()),
		}
	}

	fn set(self, soft: u64, hard: u64) -> io::Result<()> {
		match self {
			Self::Pipe => Err(io::Error::from(ErrorKind::Unsupported)),
			Self::VMem => Physical::AS
				.set(soft, hard)
				.or_else(|_| Physical::VMEM.set(soft, hard)),
		}
	}

	const fn is_supported(self) -> bool {
		match self {
			Self::Pipe => true,
			Self::VMem => Physical::AS.is_supported() || Physical::VMEM.is_supported(),
		}
	}
}

#[derive(Clone, Copy)]
enum Physical {
	AS,
	CORE,
	CPU,
	DATA,
	FSIZE,
	KQUEUES,
	LOCKS,
	MEMLOCK,
	MSGQUEUE,
	NICE,
	NOFILE,
	NPROC,
	NPTS,
	RSS,
	RTPRIO,
	RTTIME,
	SBSIZE,
	SIGPENDING,
	STACK,
	THREADS,
	VMEM,
}

impl Physical {
	const fn nix(self) -> Option<resource::Resource> {
		match self {
			Self::CORE => Some(resource::Resource::RLIMIT_CORE),
			Self::CPU => Some(resource::Resource::RLIMIT_CPU),
			Self::DATA => Some(resource::Resource::RLIMIT_DATA),
			Self::FSIZE => Some(resource::Resource::RLIMIT_FSIZE),
			Self::NOFILE => Some(resource::Resource::RLIMIT_NOFILE),
			Self::STACK => Some(resource::Resource::RLIMIT_STACK),
			#[cfg(not(any(target_os = "freebsd", target_os = "netbsd", target_os = "openbsd")))]
			Self::AS => Some(resource::Resource::RLIMIT_AS),
			#[cfg(target_os = "freebsd")]
			Self::KQUEUES => Some(resource::Resource::RLIMIT_KQUEUES),
			#[cfg(any(target_os = "linux", target_os = "android"))]
			Self::LOCKS => Some(resource::Resource::RLIMIT_LOCKS),
			#[cfg(any(
				target_os = "linux",
				target_os = "android",
				target_os = "freebsd",
				target_os = "netbsd",
				target_os = "openbsd"
			))]
			Self::MEMLOCK => Some(resource::Resource::RLIMIT_MEMLOCK),
			#[cfg(any(target_os = "linux", target_os = "android"))]
			Self::MSGQUEUE => Some(resource::Resource::RLIMIT_MSGQUEUE),
			#[cfg(any(target_os = "linux", target_os = "android"))]
			Self::NICE => Some(resource::Resource::RLIMIT_NICE),
			#[cfg(any(
				target_os = "linux",
				target_os = "android",
				target_os = "freebsd",
				target_os = "netbsd",
				target_os = "openbsd"
			))]
			Self::NPROC => Some(resource::Resource::RLIMIT_NPROC),
			#[cfg(target_os = "freebsd")]
			Self::NPTS => Some(resource::Resource::RLIMIT_NPTS),
			#[cfg(any(
				target_os = "linux",
				target_os = "android",
				target_os = "freebsd",
				target_os = "netbsd",
				target_os = "openbsd"
			))]
			Self::RSS => Some(resource::Resource::RLIMIT_RSS),
			#[cfg(any(target_os = "linux", target_os = "android"))]
			Self::RTPRIO => Some(resource::Resource::RLIMIT_RTPRIO),
			#[cfg(target_os = "linux")]
			Self::RTTIME => Some(resource::Resource::RLIMIT_RTTIME),
			#[cfg(any(target_os = "freebsd", target_os = "dragonfly"))]
			Self::SBSIZE => Some(resource::Resource::RLIMIT_SBSIZE),
			#[cfg(any(target_os = "linux", target_os = "android"))]
			Self::SIGPENDING => Some(resource::Resource::RLIMIT_SIGPENDING),
			#[cfg(target_os = "freebsd")]
			Self::VMEM => Some(resource::Resource::RLIMIT_VMEM),
			_ => None,
		}
	}

	#[cfg(target_os = "macos")]
	const fn macos_raw(self) -> Option<libc::c_int> {
		match self {
			Self::MEMLOCK => Some(libc::RLIMIT_MEMLOCK),
			Self::NPROC => Some(libc::RLIMIT_NPROC),
			Self::RSS => Some(libc::RLIMIT_RSS),
			_ => None,
		}
	}

	fn get(self) -> io::Result<(u64, u64)> {
		if let Some(resource) = self.nix() {
			return resource::getrlimit(resource).map_err(io::Error::from);
		}
		#[cfg(target_os = "macos")]
		if let Some(resource) = self.macos_raw() {
			let mut limits = mem::MaybeUninit::<libc::rlimit>::uninit();
			// SAFETY: `limits` points to writable storage for getrlimit.
			if unsafe { libc::getrlimit(resource, limits.as_mut_ptr()) } == 0 {
				// SAFETY: a successful getrlimit initialized the structure.
				let limits = unsafe { limits.assume_init() };
				return Ok((limits.rlim_cur, limits.rlim_max));
			}
			return Err(io::Error::last_os_error());
		}
		Err(io::Error::from(ErrorKind::Unsupported))
	}

	fn set(self, soft: u64, hard: u64) -> io::Result<()> {
		if let Some(resource) = self.nix() {
			return resource::setrlimit(resource, soft, hard).map_err(io::Error::from);
		}
		#[cfg(target_os = "macos")]
		if let Some(resource) = self.macos_raw() {
			let limits = libc::rlimit { rlim_cur: soft, rlim_max: hard };
			// SAFETY: `limits` is fully initialized and the resource is a valid macOS
			// constant.
			if unsafe { libc::setrlimit(resource, &raw const limits) } == 0 {
				return Ok(());
			}
			return Err(io::Error::last_os_error());
		}
		Err(io::Error::from(ErrorKind::Unsupported))
	}

	const fn is_supported(self) -> bool {
		#[cfg(target_os = "macos")]
		if self.macos_raw().is_some() {
			return true;
		}
		self.nix().is_some()
	}
}

#[derive(Clone, Copy)]
enum Resource {
	Phy(Physical),
	Virt(Virtual),
}

impl Resource {
	fn get(self) -> io::Result<(u64, u64)> {
		match self {
			Self::Phy(res) => res.get(),
			Self::Virt(res) => res.get(),
		}
	}

	fn set(self, soft: u64, hard: u64) -> io::Result<()> {
		match self {
			Self::Phy(res) => res.set(soft, hard),
			Self::Virt(res) => res.set(soft, hard),
		}
	}

	const fn is_supported(self) -> bool {
		match self {
			Self::Phy(res) => res.is_supported(),
			Self::Virt(res) => res.is_supported(),
		}
	}
}

#[derive(Clone, Copy)]
struct ResourceDescription {
	resource:    Resource,
	help:        &'static str,
	description: &'static str,
	short:       char,
	unit:        Unit,
}

impl ResourceDescription {
	const CORE: Self = Self {
		resource:    Resource::Phy(Physical::CORE),
		help:        "the maximum size of core files created",
		description: "core file size",
		short:       'c',
		unit:        Unit::Block,
	};
	const CPU: Self = Self {
		resource:    Resource::Phy(Physical::CPU),
		help:        "the maximum amount of cpu time in seconds",
		description: "cpu time",
		short:       't',
		unit:        Unit::Seconds,
	};
	const DATA: Self = Self {
		resource:    Resource::Phy(Physical::DATA),
		help:        "the maximum size of a process's data segment",
		description: "data seg size",
		short:       'd',
		unit:        Unit::KBytes,
	};
	const FSIZE: Self = Self {
		resource:    Resource::Phy(Physical::FSIZE),
		help:        "the maximum size of files written by the shell and its children",
		description: "file size",
		short:       'f',
		unit:        Unit::Block,
	};
	const KQUEUES: Self = Self {
		resource:    Resource::Phy(Physical::KQUEUES),
		help:        "the maximum number of kqueues allocated for this process",
		description: "max kqueues",
		short:       'k',
		unit:        Unit::Number,
	};
	const LOCKS: Self = Self {
		resource:    Resource::Phy(Physical::LOCKS),
		help:        "the maximum number of file locks",
		description: "file locks",
		short:       'x',
		unit:        Unit::Number,
	};
	const MEMLOCK: Self = Self {
		resource:    Resource::Phy(Physical::MEMLOCK),
		help:        "the maximum size a process may lock into memory",
		description: "max locked memory",
		short:       'l',
		unit:        Unit::KBytes,
	};
	const MSGQUEUE: Self = Self {
		resource:    Resource::Phy(Physical::MSGQUEUE),
		help:        "the maximum number of bytes in POSIX message queues",
		description: "POSIX message queues",
		short:       'q',
		unit:        Unit::Bytes,
	};
	const NICE: Self = Self {
		resource:    Resource::Phy(Physical::NICE),
		help:        "the maximum scheduling priority (`nice`)",
		description: "scheduling priority",
		short:       'e',
		unit:        Unit::Number,
	};
	const NOFILE: Self = Self {
		resource:    Resource::Phy(Physical::NOFILE),
		help:        "the maximum number of open file descriptors",
		description: "open files",
		short:       'n',
		unit:        Unit::Number,
	};
	const NPROC: Self = Self {
		resource:    Resource::Phy(Physical::NPROC),
		help:        "the maximum number of user processes",
		description: "max user processes",
		short:       'u',
		unit:        Unit::Number,
	};
	const NPTS: Self = Self {
		resource:    Resource::Phy(Physical::NPTS),
		help:        "the maximum number of pseudoterminals",
		description: "number of pseudoterminals",
		short:       'P',
		unit:        Unit::Number,
	};
	const PIPE: Self = Self {
		resource:    Resource::Virt(Virtual::Pipe),
		help:        "the pipe buffer size",
		description: "pipe size",
		short:       'p',
		unit:        Unit::HalfKBytes,
	};
	const RSS: Self = Self {
		resource:    Resource::Phy(Physical::RSS),
		help:        "the maximum resident set size",
		description: "max memory size",
		short:       'm',
		unit:        Unit::KBytes,
	};
	const RTPRIO: Self = Self {
		resource:    Resource::Phy(Physical::RTPRIO),
		help:        "the maximum real-time scheduling priority",
		description: "real-time priority",
		short:       'r',
		unit:        Unit::Number,
	};
	const RTTIME: Self = Self {
		resource:    Resource::Phy(Physical::RTTIME),
		help:        "the maximum real-time scheduling priority",
		description: "real-time non-blocking time",
		short:       'R',
		unit:        Unit::Micros,
	};
	const SBSIZE: Self = Self {
		resource:    Resource::Phy(Physical::SBSIZE),
		help:        "the socket buffer size",
		description: "socket buffer size",
		short:       'b',
		unit:        Unit::Bytes,
	};
	const SIGPENDING: Self = Self {
		resource:    Resource::Phy(Physical::SIGPENDING),
		help:        "the maximum number of pending signals",
		description: "pending signals",
		short:       'i',
		unit:        Unit::Number,
	};
	const STACK: Self = Self {
		resource:    Resource::Phy(Physical::STACK),
		help:        "the maximum stack size",
		description: "stack size",
		short:       's',
		unit:        Unit::KBytes,
	};
	const THREADS: Self = Self {
		resource:    Resource::Phy(Physical::THREADS),
		help:        "the maximum number of threads",
		description: "number of threads",
		short:       'T',
		unit:        Unit::Number,
	};
	const VMEM: Self = Self {
		resource:    Resource::Virt(Virtual::VMem),
		help:        "the size of virtual memory",
		description: "virtual memory",
		short:       'v',
		unit:        Unit::KBytes,
	};

	fn get(
		&self,
		shell: &Shell<impl ShellExtensions>,
		protected: bool,
		hard: bool,
	) -> io::Result<String> {
		let (soft_limit, hard_limit) = if protected {
			shell
				.virtual_resource_limit(self.short)
				.map_or_else(|| self.resource.get(), Ok)?
		} else {
			self.resource.get()?
		};
		let val = if hard { hard_limit } else { soft_limit };

		if val == resource::RLIM_INFINITY {
			Ok("unlimited".into())
		} else {
			Ok(format!("{}", val / self.unit.scale()))
		}
	}

	fn set(&self, set_hard: bool, value: LimitValue) -> io::Result<()> {
		let (soft, hard) = self.resource.get()?;
		let value = match value {
			LimitValue::Soft => soft,
			LimitValue::Hard => hard,
			LimitValue::Unlimited => resource::RLIM_INFINITY,
			LimitValue::Value(v) => v * self.unit.scale(),
			LimitValue::Unset => return Ok(()),
		};

		if set_hard {
			self.resource.set(soft, value)
		} else {
			self.resource.set(value, hard)
		}
	}

	fn set_virtual(
		&self,
		shell: &mut Shell<impl ShellExtensions>,
		set_hard: bool,
		value: LimitValue,
	) -> io::Result<()> {
		let (soft, hard) = shell
			.virtual_resource_limit(self.short)
			.map_or_else(|| self.resource.get(), Ok)?;
		let value = match value {
			LimitValue::Soft => soft,
			LimitValue::Hard => hard,
			LimitValue::Unlimited => resource::RLIM_INFINITY,
			LimitValue::Value(value) => value * self.unit.scale(),
			LimitValue::Unset => return Ok(()),
		};
		if matches!(self.resource, Resource::Virt(Virtual::Pipe)) {
			return Err(io::Error::from(ErrorKind::Unsupported));
		}
		let (soft, hard) = if set_hard {
			(soft, value)
		} else {
			(value, hard)
		};
		shell.set_virtual_resource_limit(self.short, soft, hard);
		Ok(())
	}

	/// Print either soft or hard limit
	fn print(
		&self,
		context: &ExecutionContext<'_, impl ShellExtensions>,
		hard: bool,
		protected: bool,
	) -> io::Result<()> {
		if !self.resource.is_supported() {
			return Ok(());
		}
		let unit = match self.unit {
			Unit::Block => format!("(block, -{})", self.short),
			Unit::Bytes => format!("(bytes, -{})", self.short),
			Unit::HalfKBytes => format!("(512 bytes, -{})", self.short),
			Unit::KBytes => format!("(kbytes, -{})", self.short),
			Unit::Micros => format!("(microseconds, -{})", self.short),
			Unit::Number => format!("(-{})", self.short),
			Unit::Seconds => format!("(seconds, -{})", self.short),
		};
		let resource = self
			.get(context.shell, protected, hard)
			.unwrap_or_else(|e| format!("{e}"));
		writeln!(context.stdout(), "{:<26}{:>16} {}", self.description, unit, resource)
	}

	/// Provide the matching help String
	fn help(&self) -> String {
		format!(
			"{} {}",
			self.help,
			if self.resource.is_supported() {
				"(supported)"
			} else {
				"(unsupported)"
			}
		)
	}
}

impl IntoResettable<StyledStr> for ResourceDescription {
	fn into_resettable(self) -> builder::Resettable<StyledStr> {
		builder::Resettable::Value(self.help().into())
	}
}

#[derive(Debug, Clone, Copy)]
enum LimitValue {
	Unset,
	Unlimited,
	Soft,
	Hard,
	Value(u64),
}

impl FromStr for LimitValue {
	type Err = <u64 as FromStr>::Err;

	fn from_str(s: &str) -> Result<Self, Self::Err> {
		let v = match s {
			"" => Self::Unset,
			"unlimited" => Self::Unlimited,
			"soft" => Self::Soft,
			"hard" => Self::Hard,
			_ => Self::Value(s.parse()?),
		};
		Ok(v)
	}
}

/// Modify shell resource limits.
///
/// Provides control over the resources available to the shell and processes
/// it creates, on systems that allow such control.
#[derive(Parser, Debug)]
pub(crate) struct ULimitCommand {
	/// use the `soft` resource limit
	#[arg(short = 'S')]
	soft:       bool,
	/// use the `hard` resource limit
	#[arg(short = 'H')]
	hard:       bool,
	/// all current limits are reported
	#[arg(short = 'a')]
	all:        bool,
	/// the maximum socket buffer size
	#[arg(short = 'b', default_missing_value = "", num_args(0..=1), help = ResourceDescription::SBSIZE)]
	sbsize:     Option<LimitValue>,
	/// the maximum size of core files created
	#[arg(short = 'c', default_missing_value = "", num_args(0..=1), help = ResourceDescription::CORE)]
	core:       Option<LimitValue>,
	/// the maximum size of a process's data segment
	#[arg(short = 'd', default_missing_value = "", num_args(0..=1), help = ResourceDescription::DATA)]
	data:       Option<LimitValue>,
	/// the maximum scheduling priority (`nice`)
	#[arg(short = 'e', default_missing_value = "", num_args(0..=1), help = ResourceDescription::NICE)]
	nice:       Option<LimitValue>,
	/// the maximum size of files written by the shell and its children
	#[arg(short = 'f', default_missing_value = "", num_args(0..=1), help = ResourceDescription::FSIZE)]
	file_size:  Option<LimitValue>,
	/// the maximum number of pending signals
	#[arg(short = 'i', default_missing_value = "", num_args(0..=1), help = ResourceDescription::SIGPENDING)]
	sigpending: Option<LimitValue>,
	/// the maximum size a process may lock into memory
	#[arg(short = 'l', default_missing_value = "", num_args(0..=1), help = ResourceDescription::MEMLOCK)]
	memlock:    Option<LimitValue>,
	/// the maximum number of kqueues allocated for this process
	#[arg(short = 'k', default_missing_value = "", num_args(0..=1), help = ResourceDescription::KQUEUES)]
	kqueues:    Option<LimitValue>,
	/// the maximum resident set size
	#[arg(short = 'm', default_missing_value = "", num_args(0..=1), help = ResourceDescription::RSS)]
	rss:        Option<LimitValue>,
	/// the maximum number of open file descriptors
	#[arg(short = 'n', default_missing_value = "", num_args(0..=1), help = ResourceDescription::NOFILE)]
	file_open:  Option<LimitValue>,
	/// the pipe buffer size
	#[arg(short = 'p', default_missing_value = "", num_args(0..=1), help = ResourceDescription::PIPE)]
	pipe:       Option<LimitValue>,
	/// the maximum number of bytes in POSIX message queues
	#[arg(short = 'q', default_missing_value = "", num_args(0..=1), help = ResourceDescription::MSGQUEUE)]
	msgqueue:   Option<LimitValue>,
	/// the maximum real-time scheduling priority
	#[arg(short = 'r', default_missing_value = "", num_args(0..=1), help = ResourceDescription::RTPRIO)]
	rtprio:     Option<LimitValue>,
	/// the maximum stack size
	#[arg(short = 's', default_missing_value = "", num_args(0..=1), help = ResourceDescription::STACK)]
	stack:      Option<LimitValue>,
	/// the maximum amount of cpu time in seconds
	#[arg(short = 't', default_missing_value = "", num_args(0..=1), help = ResourceDescription::CPU)]
	cpu:        Option<LimitValue>,
	/// the size of virtual memory
	#[arg(short = 'u', default_missing_value = "", num_args(0..=1), help = ResourceDescription::NPROC)]
	nproc:      Option<LimitValue>,
	/// the size of virtual memory
	#[arg(short = 'v', default_missing_value = "", num_args(0..=1), help = ResourceDescription::VMEM)]
	vmem:       Option<LimitValue>,
	/// the maximum number of file locks
	#[arg(short = 'x', default_missing_value = "", num_args(0..=1), help = ResourceDescription::LOCKS)]
	file_lock:  Option<LimitValue>,
	/// the maximum number of pseudoterminals
	#[arg(short = 'P', default_missing_value = "", num_args(0..=1), help = ResourceDescription::NPTS)]
	npts:       Option<LimitValue>,
	/// real-time non-blocking time
	#[arg(short = 'R', default_missing_value = "", num_args(0..=1), help = ResourceDescription::RTTIME)]
	rttime:     Option<LimitValue>,
	/// the maximum number of threads
	#[arg(short = 'T', default_missing_value = "", num_args(0..=1), help = ResourceDescription::THREADS)]
	threads:    Option<LimitValue>,

	/// argument for the implicit limit (`-f`)
	limit: Option<LimitValue>,
}

impl builtins::Command for ULimitCommand {
	type Error = Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		let exit_code = ExecutionResult::success();
		let mut resources_to_set = Vec::new();
		let mut resources_to_get = Vec::new();

		let mut set_or_get = |val, descr| {
			match val {
				Some(LimitValue::Unset) => resources_to_get.push(descr),
				Some(v) => resources_to_set.push((descr, v)),
				None => {},
			}
			if self.all {
				resources_to_get.push(descr);
			}
		};

		set_or_get(self.sbsize, ResourceDescription::SBSIZE);
		set_or_get(self.core, ResourceDescription::CORE);
		set_or_get(self.data, ResourceDescription::DATA);
		set_or_get(self.file_size, ResourceDescription::FSIZE);
		set_or_get(self.sigpending, ResourceDescription::SIGPENDING);
		set_or_get(self.kqueues, ResourceDescription::KQUEUES);
		set_or_get(self.memlock, ResourceDescription::MEMLOCK);
		set_or_get(self.rss, ResourceDescription::RSS);
		set_or_get(self.file_lock, ResourceDescription::LOCKS);
		set_or_get(self.file_open, ResourceDescription::NOFILE);
		set_or_get(self.pipe, ResourceDescription::PIPE);
		set_or_get(self.npts, ResourceDescription::NPTS);
		set_or_get(self.nice, ResourceDescription::NICE);
		set_or_get(self.msgqueue, ResourceDescription::MSGQUEUE);
		set_or_get(self.rtprio, ResourceDescription::RTPRIO);
		set_or_get(self.rttime, ResourceDescription::RTTIME);
		set_or_get(self.stack, ResourceDescription::STACK);
		set_or_get(self.threads, ResourceDescription::THREADS);
		set_or_get(self.cpu, ResourceDescription::CPU);
		set_or_get(self.nproc, ResourceDescription::NPROC);
		set_or_get(self.vmem, ResourceDescription::VMEM);

		if resources_to_set.is_empty() {
			if resources_to_get.is_empty() {
				if let Some(fsize) = self.limit {
					resources_to_set.push((ResourceDescription::FSIZE, fsize));
				} else {
					resources_to_get.push(ResourceDescription::FSIZE);
				}
			}
		}

		for (resource, value) in resources_to_set {
			if context.params.protect_host_process() {
				resource.set_virtual(context.shell, self.hard, value)?;
			} else {
				resource.set(self.hard, value)?;
			}
		}

		if resources_to_get.len() == 1 {
			writeln!(
				context.stdout(),
				"{}",
				resources_to_get[0].get(
					context.shell,
					context.params.protect_host_process(),
					self.hard,
				)?
			)?;
		} else {
			for resource in resources_to_get {
				resource.print(&context, self.hard, context.params.protect_host_process())?;
			}
		}

		Ok(exit_code)
	}
}
pub(crate) fn apply_virtual_limits(
	shell: &Shell<impl ShellExtensions>,
	command: &mut process::Command,
) {
	let limits: Vec<_> = RESOURCE_DESCRIPTIONS
		.iter()
		.filter_map(|description| {
			shell
				.virtual_resource_limit(description.short)
				.map(|(soft, hard)| (description.resource, soft, hard))
		})
		.collect();
	if limits.is_empty() {
		return;
	}
	// SAFETY: setrlimit is async-signal-safe and each resource was validated when
	// the shell-local value was set.
	unsafe {
		command.pre_exec(move || {
			for (resource, soft, hard) in &limits {
				resource.set(*soft, *hard)?;
			}
			Ok(())
		});
	}
}

const RESOURCE_DESCRIPTIONS: [ResourceDescription; 21] = [
	ResourceDescription::SBSIZE,
	ResourceDescription::CORE,
	ResourceDescription::DATA,
	ResourceDescription::FSIZE,
	ResourceDescription::SIGPENDING,
	ResourceDescription::KQUEUES,
	ResourceDescription::MEMLOCK,
	ResourceDescription::RSS,
	ResourceDescription::LOCKS,
	ResourceDescription::NOFILE,
	ResourceDescription::PIPE,
	ResourceDescription::NPTS,
	ResourceDescription::NICE,
	ResourceDescription::MSGQUEUE,
	ResourceDescription::RTPRIO,
	ResourceDescription::RTTIME,
	ResourceDescription::STACK,
	ResourceDescription::THREADS,
	ResourceDescription::CPU,
	ResourceDescription::NPROC,
	ResourceDescription::VMEM,
];
