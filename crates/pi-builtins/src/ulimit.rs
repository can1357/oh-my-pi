use std::{
	io::{self, ErrorKind, Write},
	str::FromStr,
};

use brush_core::{ExecutionResult, builtins};
use clap::{
	Parser,
	builder::{IntoResettable, StyledStr},
};

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
	fn get(self) -> std::io::Result<(u64, u64)> {
		match self {
			Self::Pipe => {
				let lim = nix::unistd::PathconfVar::PIPE_BUF as u64 * 512;
				Ok((lim, lim))
			},
			Self::VMem => rlimit::Resource::AS
				.get()
				.or_else(|_| rlimit::Resource::VMEM.get()),
		}
	}

	fn set(self, soft: u64, hard: u64) -> std::io::Result<()> {
		match self {
			Self::Pipe => Err(std::io::Error::from(ErrorKind::Unsupported)),
			Self::VMem => rlimit::Resource::AS
				.set(soft, hard)
				.or_else(|_| rlimit::Resource::VMEM.set(soft, hard)),
		}
	}

	const fn is_supported(self) -> bool {
		match self {
			Self::Pipe => true,
			Self::VMem => rlimit::Resource::AS.is_supported() || rlimit::Resource::VMEM.is_supported(),
		}
	}
}

#[derive(Clone, Copy)]
enum Resource {
	Phy(rlimit::Resource),
	Virt(Virtual),
}

impl Resource {
	fn get(self) -> std::io::Result<(u64, u64)> {
		match self {
			Self::Phy(res) => res.get(),
			Self::Virt(res) => res.get(),
		}
	}

	fn set(self, soft: u64, hard: u64) -> std::io::Result<()> {
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
		resource:    Resource::Phy(rlimit::Resource::CORE),
		help:        "the maximum size of core files created",
		description: "core file size",
		short:       'c',
		unit:        Unit::Block,
	};
	const CPU: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::CPU),
		help:        "the maximum amount of cpu time in seconds",
		description: "cpu time",
		short:       't',
		unit:        Unit::Seconds,
	};
	const DATA: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::DATA),
		help:        "the maximum size of a process's data segment",
		description: "data seg size",
		short:       'd',
		unit:        Unit::KBytes,
	};
	const FSIZE: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::FSIZE),
		help:        "the maximum size of files written by the shell and its children",
		description: "file size",
		short:       'f',
		unit:        Unit::Block,
	};
	const KQUEUES: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::KQUEUES),
		help:        "the maximum number of kqueues allocated for this process",
		description: "max kqueues",
		short:       'k',
		unit:        Unit::Number,
	};
	const LOCKS: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::LOCKS),
		help:        "the maximum number of file locks",
		description: "file locks",
		short:       'x',
		unit:        Unit::Number,
	};
	const MEMLOCK: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::MEMLOCK),
		help:        "the maximum size a process may lock into memory",
		description: "max locked memory",
		short:       'l',
		unit:        Unit::KBytes,
	};
	const MSGQUEUE: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::MSGQUEUE),
		help:        "the maximum number of bytes in POSIX message queues",
		description: "POSIX message queues",
		short:       'q',
		unit:        Unit::Bytes,
	};
	const NICE: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::NICE),
		help:        "the maximum scheduling priority (`nice`)",
		description: "scheduling priority",
		short:       'e',
		unit:        Unit::Number,
	};
	const NOFILE: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::NOFILE),
		help:        "the maximum number of open file descriptors",
		description: "open files",
		short:       'n',
		unit:        Unit::Number,
	};
	const NPROC: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::NPROC),
		help:        "the maximum number of user processes",
		description: "max user processes",
		short:       'u',
		unit:        Unit::Number,
	};
	const NPTS: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::NPTS),
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
		resource:    Resource::Phy(rlimit::Resource::RSS),
		help:        "the maximum resident set size",
		description: "max memory size",
		short:       'm',
		unit:        Unit::KBytes,
	};
	const RTPRIO: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::RTPRIO),
		help:        "the maximum real-time scheduling priority",
		description: "real-time priority",
		short:       'r',
		unit:        Unit::Number,
	};
	const RTTIME: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::RTTIME),
		help:        "the maximum real-time scheduling priority",
		description: "real-time non-blocking time",
		short:       'R',
		unit:        Unit::Micros,
	};
	const SBSIZE: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::SBSIZE),
		help:        "the socket buffer size",
		description: "socket buffer size",
		short:       'b',
		unit:        Unit::Bytes,
	};
	const SIGPENDING: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::SIGPENDING),
		help:        "the maximum number of pending signals",
		description: "pending signals",
		short:       'i',
		unit:        Unit::Number,
	};
	const STACK: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::STACK),
		help:        "the maximum stack size",
		description: "stack size",
		short:       's',
		unit:        Unit::KBytes,
	};
	const THREADS: Self = Self {
		resource:    Resource::Phy(rlimit::Resource::THREADS),
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

	fn get(&self, hard: bool) -> std::io::Result<String> {
		let (soft_limit, hard_limit) = self.resource.get()?;
		let val = if hard { hard_limit } else { soft_limit };

		if val == rlimit::INFINITY {
			Ok("unlimited".into())
		} else {
			Ok(format!("{}", val / self.unit.scale()))
		}
	}

	fn set(&self, set_hard: bool, value: LimitValue) -> std::io::Result<()> {
		let (soft, hard) = self.resource.get()?;
		let value = match value {
			LimitValue::Soft => soft,
			LimitValue::Hard => hard,
			LimitValue::Unlimited => rlimit::INFINITY,
			LimitValue::Value(v) => v * self.unit.scale(),
			LimitValue::Unset => return Ok(()),
		};

		if set_hard {
			self.resource.set(soft, value)
		} else {
			self.resource.set(value, hard)
		}
	}

	/// Print either soft or hard limit
	fn print(
		&self,
		context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		hard: bool,
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
		let resource = self.get(hard).unwrap_or_else(|e| format!("{e}"));
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
	fn into_resettable(self) -> clap::builder::Resettable<StyledStr> {
		clap::builder::Resettable::Value(self.help().into())
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
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
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
			resource.set(self.hard, value)?;
		}

		if resources_to_get.len() == 1 {
			writeln!(context.stdout(), "{}", resources_to_get[0].get(self.hard)?)?;
		} else {
			for resource in resources_to_get {
				resource.print(&context, self.hard)?;
			}
		}

		Ok(exit_code)
	}
}
