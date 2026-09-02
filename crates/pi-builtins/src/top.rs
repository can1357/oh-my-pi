//! `top` builtin, moved from `pi-shell`.

use std::{
	collections::{HashMap, HashSet},
	fmt::Write as _,
	future::Future,
	io::{self, Write},
	time::Duration,
};

use brush_core::{ExecutionContext, ExecutionExitCode, ExecutionResult, builtins};
use clap::Parser;
use tokio::time;

use crate::proc_snapshot::{ProcInfo, sanitize_process_command};

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum TopSortKey {
	Pid,
	Command,
	#[value(alias = "%cpu")]
	Cpu,
	#[value(alias = "%mem", alias = "memory")]
	Mem,
	#[value(alias = "time+")]
	Time,
}

/// Column keys accepted by macOS-style `-stats` (comma-separated).
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
enum TopStat {
	Pid,
	#[value(alias = "uid")]
	User,
	#[value(name = "pstate", alias = "state")]
	State,
	#[value(name = "nice", alias = "ni")]
	Nice,
	#[value(name = "th", alias = "threads")]
	Threads,
	#[value(name = "vsize", alias = "virt")]
	Virt,
	#[value(name = "mem", alias = "rsize", alias = "res")]
	Res,
	#[value(alias = "time+")]
	Time,
	#[value(alias = "%cpu")]
	Cpu,
	#[value(name = "%mem", alias = "pmem")]
	PctMem,
	#[value(alias = "comm")]
	Command,
}

/// Column order used when `-stats` is not given.
const DEFAULT_TOP_STATS: &[TopStat] = &[
	TopStat::Pid,
	TopStat::User,
	TopStat::State,
	TopStat::Nice,
	TopStat::Threads,
	TopStat::Virt,
	TopStat::Res,
	TopStat::Time,
	TopStat::Cpu,
	TopStat::PctMem,
	TopStat::Command,
];

impl TopStat {
	fn header(self) -> &'static str {
		match self {
			Self::Pid => "PID",
			Self::User => "USER",
			Self::State => "S",
			Self::Nice => "NI",
			Self::Threads => "TH",
			Self::Virt => "VIRT",
			Self::Res => "RES",
			Self::Time => "TIME+",
			Self::Cpu => "%CPU",
			Self::PctMem => "%MEM",
			Self::Command => "COMMAND",
		}
	}

	/// Right-align width; 0 renders as-is (used for the free-form command).
	fn width(self) -> usize {
		match self {
			Self::Pid => 7,
			Self::User => 8,
			Self::State => 2,
			Self::Nice => 3,
			Self::Threads => 4,
			Self::Virt | Self::Res => 9,
			Self::Time => 10,
			Self::Cpu | Self::PctMem => 4,
			Self::Command => 0,
		}
	}
}

/// Display processes.
#[derive(Parser)]
#[command(name = "top", version, about = "Display processes", disable_help_flag = false)]
pub(crate) struct TopCommand {
	/// Write plain-text snapshots suitable for pipes and files.
	#[arg(short = 'b', long)]
	batch: bool,

	/// Number of snapshots to produce.
	#[cfg(target_os = "macos")]
	#[arg(short = 'l', long = "samples", value_parser = clap::value_parser!(u64).range(1..))]
	iterations: Option<u64>,

	/// Number of snapshots to produce.
	#[cfg(not(target_os = "macos"))]
	#[arg(short = 'n', long = "iterations", value_parser = clap::value_parser!(u64).range(1..))]
	iterations: Option<u64>,

	/// Seconds between snapshots.
	#[cfg(target_os = "macos")]
	#[arg(short = 's', long = "delay", default_value_t = 1.0)]
	delay: f64,

	/// Seconds between snapshots.
	#[cfg(not(target_os = "macos"))]
	#[arg(short = 'd', long = "delay", default_value_t = 3.0)]
	delay: f64,

	/// Maximum number of process rows per snapshot.
	#[cfg(target_os = "macos")]
	#[arg(short = 'n', long = "rows")]
	rows: Option<usize>,

	/// Maximum number of process rows per snapshot.
	#[cfg(not(target_os = "macos"))]
	#[arg(short = 'r', long = "rows")]
	rows: Option<usize>,

	/// Only show these process IDs (may be repeated or comma-separated).
	#[arg(short = 'p', long = "pid", value_delimiter = ',')]
	pids: Vec<i32>,

	/// Only show processes with this numeric real or effective user ID.
	#[arg(short = 'u', long = "user")]
	user: Option<u32>,

	#[arg(short = 'o', long = "sort", value_enum, ignore_case = true)]
	#[cfg_attr(target_os = "macos", arg(default_value_t = TopSortKey::Pid))]
	#[cfg_attr(not(target_os = "macos"), arg(default_value_t = TopSortKey::Cpu))]
	sort: TopSortKey,

	/// Show the complete command line instead of the executable name.
	#[arg(short = 'c', long = "full-command")]
	full_command: bool,

	/// Columns to display, in order (comma-separated, macOS `-stats` style).
	#[arg(long = "stats", value_enum, value_delimiter = ',', ignore_case = true)]
	stats: Vec<TopStat>,
}

#[derive(Clone)]
struct TopProcessRow {
	pid:           i32,
	user:          Option<u32>,
	state:         char,
	cpu_percent:   f64,
	cpu_time:      Option<Duration>,
	virtual_size:  Option<u64>,
	resident_size: Option<u64>,
	threads:       Option<u32>,
	nice:          Option<i32>,
	command:       String,
}

/// Long option names `top` accepts with a macOS-style single dash.
const TOP_LONG_OPTIONS: &[&str] = &[
	"batch",
	"samples",
	"iterations",
	"delay",
	"rows",
	"pid",
	"user",
	"sort",
	"full-command",
	"stats",
	"help",
	"version",
];

/// Rewrites macOS-style single-dash long options (`-pid`, `-stats pid,cpu`)
/// into clap-style `--` options; everything else passes through untouched.
fn normalize_top_flag(arg: String) -> String {
	if let Some(rest) = arg.strip_prefix('-')
		&& !rest.starts_with('-')
	{
		let name = rest.split('=').next().unwrap_or(rest);
		if name.len() > 1 && TOP_LONG_OPTIONS.contains(&name) {
			return format!("-{arg}");
		}
	}
	arg
}

impl builtins::Command for TopCommand {
	type Error = brush_core::Error;

	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		Self::try_parse_from(args.into_iter().map(normalize_top_flag))
	}

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let iterations = self.iterations;
		let delay = self.delay;
		let row_limit = self.rows;
		let pids = self.pids.clone();
		let user = self.user;
		let sort = self.sort;
		let full_command = self.full_command;
		let _ = self.batch;
		let stats = if self.stats.is_empty() {
			DEFAULT_TOP_STATS.to_vec()
		} else {
			self.stats.clone()
		};
		async move {
			if !delay.is_finite() || delay < 0.0 || delay > Duration::MAX.as_secs_f64() {
				writeln!(context.stderr(), "top: invalid delay '{delay}'")?;
				return Ok(ExecutionResult::new(1));
			}
			if row_limit == Some(0) {
				writeln!(context.stderr(), "top: row count must be greater than zero")?;
				return Ok(ExecutionResult::new(1));
			}
			#[cfg(target_os = "windows")]
			if user.is_some() {
				writeln!(context.stderr(), "top: user filtering is unavailable on Windows")?;
				return Ok(ExecutionResult::new(2));
			}

			let delay = Duration::from_secs_f64(delay);
			let pid_filter: HashSet<i32> = pids.into_iter().collect();
			let mut previous = HashMap::<i32, (u64, Duration)>::new();
			let mut previous_sample = std::time::Instant::now();
			let mut sample = 0_u64;

			loop {
				if context.is_cancelled() {
					return Ok(ExecutionExitCode::Interrupted.into());
				}

				let now = std::time::Instant::now();
				let elapsed = now.duration_since(previous_sample);
				let mut next_previous = HashMap::new();
				let mut rows = Vec::new();

				for process in ProcInfo::all() {
					if !pid_filter.is_empty() && !pid_filter.contains(&process.pid()) {
						continue;
					}
					let real_user = process.real_user_id();
					let effective_user = process.effective_user_id();
					if let Some(wanted) = user
						&& real_user != Some(wanted)
						&& effective_user != Some(wanted)
					{
						continue;
					}

					let start_time = process.start_time();
					let cpu_time = process.cpu_time();
					let cpu_percent = cpu_time
						.and_then(|current| {
							previous
								.get(&process.pid())
								.filter(|(previous_start, _)| *previous_start == start_time)
								.map(|(_, old)| current.saturating_sub(*old))
						})
						.map_or(0.0, |delta| {
							if elapsed.is_zero() {
								0.0
							} else {
								100.0 * delta.as_secs_f64() / elapsed.as_secs_f64()
							}
						});
					if let Some(cpu_time) = cpu_time {
						next_previous.insert(process.pid(), (start_time, cpu_time));
					}

					let command = sanitize_process_command(if full_command {
						let args = process.args();
						if args.is_empty() {
							process.command_name()
						} else {
							args.join(" ")
						}
					} else {
						process.command_name()
					});
					rows.push(TopProcessRow {
						pid: process.pid(),
						user: effective_user.or(real_user),
						state: process.state(),
						cpu_percent,
						cpu_time,
						virtual_size: process.virtual_bytes(),
						resident_size: process.resident_bytes(),
						threads: process.thread_count(),
						nice: process.nice(),
						command,
					});
				}

				sort_top_rows(&mut rows, sort);
				let output = render_top_snapshot(&rows, row_limit, sample + 1, &stats);
				if let Err(err) = write!(context.stdout(), "{output}") {
					if err.kind() == io::ErrorKind::BrokenPipe {
						return Ok(ExecutionResult::success());
					}
					return Err(err.into());
				}

				sample += 1;
				if iterations.is_some_and(|count| sample >= count) {
					return Ok(ExecutionResult::success());
				}
				previous = next_previous;
				previous_sample = now;

				let sleep = time::sleep(delay);
				tokio::pin!(sleep);
				if let Some(cancel_token) = context.cancel_token() {
					tokio::select! {
						() = &mut sleep => {},
						() = cancel_token.cancelled() => {
							return Ok(ExecutionExitCode::Interrupted.into());
						},
					}
				} else {
					sleep.await;
				}
			}
		}
	}
}

fn sort_top_rows(rows: &mut [TopProcessRow], key: TopSortKey) {
	rows.sort_by(|left, right| {
		let primary = match key {
			TopSortKey::Pid => right.pid.cmp(&left.pid),
			TopSortKey::Command => left.command.cmp(&right.command),
			TopSortKey::Cpu => right.cpu_percent.total_cmp(&left.cpu_percent),
			TopSortKey::Mem => right.resident_size.cmp(&left.resident_size),
			TopSortKey::Time => right.cpu_time.cmp(&left.cpu_time),
		};
		primary.then_with(|| right.pid.cmp(&left.pid))
	});
}

fn top_cell(row: &TopProcessRow, stat: TopStat) -> String {
	match stat {
		TopStat::Pid => row.pid.to_string(),
		TopStat::User => row
			.user
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		TopStat::State => row.state.to_string(),
		TopStat::Nice => row
			.nice
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		TopStat::Threads => row
			.threads
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		TopStat::Virt => row
			.virtual_size
			.map_or_else(|| "?".to_string(), format_top_bytes),
		TopStat::Res => row
			.resident_size
			.map_or_else(|| "?".to_string(), format_top_bytes),
		TopStat::Time => row
			.cpu_time
			.map_or_else(|| "?".to_string(), format_top_time),
		TopStat::Cpu => format!("{:.1}", row.cpu_percent),
		TopStat::PctMem => "?".to_string(),
		TopStat::Command => {
			if row.command.is_empty() {
				"?".to_string()
			} else {
				row.command.clone()
			}
		},
	}
}

fn render_top_snapshot(
	rows: &[TopProcessRow],
	row_limit: Option<usize>,
	sample: u64,
	stats: &[TopStat],
) -> String {
	let mut running = 0_usize;
	let mut sleeping = 0_usize;
	let mut stopped = 0_usize;
	let mut zombie = 0_usize;
	let mut resident = 0_u64;
	let mut virtual_size = 0_u64;
	let mut cpu = 0.0;
	for row in rows {
		match row.state {
			'R' => running += 1,
			'S' | 'I' | 'D' => sleeping += 1,
			'T' => stopped += 1,
			'Z' => zombie += 1,
			_ => {},
		}
		resident = resident.saturating_add(row.resident_size.unwrap_or(0));
		virtual_size = virtual_size.saturating_add(row.virtual_size.unwrap_or(0));
		cpu += row.cpu_percent;
	}

	let mut output = String::new();
	let _ = writeln!(output, "top - snapshot {sample}");
	#[cfg(target_os = "macos")]
	let _ = writeln!(
		output,
		"Processes: {:>5} total, {:>5} running, {:>5} sleeping, {:>5} stopped, {:>5} zombie",
		rows.len(),
		running,
		sleeping,
		stopped,
		zombie
	);
	#[cfg(not(target_os = "macos"))]
	let _ = writeln!(
		output,
		"Tasks: {:>5} total, {:>5} running, {:>5} sleeping, {:>5} stopped, {:>5} zombie",
		rows.len(),
		running,
		sleeping,
		stopped,
		zombie
	);
	let _ = writeln!(output, "%Cpu(s): {cpu:>6.1} process");
	let _ = writeln!(
		output,
		"Process memory: {} resident, {} virtual",
		format_top_bytes(resident),
		format_top_bytes(virtual_size)
	);
	let mut line = String::new();
	for (index, stat) in stats.iter().enumerate() {
		if index > 0 {
			line.push(' ');
		}
		let _ = write!(line, "{:>width$}", stat.header(), width = stat.width());
	}
	let _ = writeln!(output, "{line}");

	for row in rows.iter().take(row_limit.unwrap_or(usize::MAX)) {
		line.clear();
		for (index, stat) in stats.iter().enumerate() {
			if index > 0 {
				line.push(' ');
			}
			let _ = write!(line, "{:>width$}", top_cell(row, *stat), width = stat.width());
		}
		let _ = writeln!(output, "{line}");
	}
	output.push('\n');
	output
}

fn format_top_bytes(bytes: u64) -> String {
	const KIB: f64 = 1024.0;
	const MIB: f64 = KIB * 1024.0;
	const GIB: f64 = MIB * 1024.0;
	let bytes = bytes as f64;
	if bytes >= GIB {
		format!("{:.1}g", bytes / GIB)
	} else if bytes >= MIB {
		format!("{:.1}m", bytes / MIB)
	} else if bytes >= KIB {
		format!("{:.1}k", bytes / KIB)
	} else {
		format!("{bytes:.0}")
	}
}

fn format_top_time(duration: Duration) -> String {
	let total_seconds = duration.as_secs();
	let minutes = total_seconds / 60;
	let seconds = total_seconds % 60;
	let hundredths = duration.subsec_millis() / 10;
	format!("{minutes}:{seconds:02}.{hundredths:02}")
}

#[cfg(test)]
mod tests {
	use super::*;

	fn row(
		pid: i32,
		command: &str,
		cpu_percent: f64,
		resident_size: u64,
		cpu_time: u64,
	) -> TopProcessRow {
		TopProcessRow {
			pid,
			user: Some(501),
			state: 'S',
			cpu_percent,
			cpu_time: Some(Duration::from_secs(cpu_time)),
			virtual_size: Some(2048),
			resident_size: Some(resident_size),
			threads: Some(2),
			nice: Some(0),
			command: command.to_string(),
		}
	}

	fn sorted_pids(key: TopSortKey) -> Vec<i32> {
		let mut rows = vec![
			row(1, "zeta", 20.0, 300, 2),
			row(3, "alpha", 10.0, 200, 3),
			row(2, "alpha", 30.0, 100, 1),
		];
		sort_top_rows(&mut rows, key);
		rows.into_iter().map(|row| row.pid).collect()
	}

	#[test]
	fn formats_byte_units() {
		assert_eq!(format_top_bytes(999), "999");
		assert_eq!(format_top_bytes(1536), "1.5k");
		assert_eq!(format_top_bytes(2 * 1024 * 1024), "2.0m");
		assert_eq!(format_top_bytes(3 * 1024 * 1024 * 1024), "3.0g");
	}

	#[test]
	fn formats_cpu_time() {
		assert_eq!(format_top_time(Duration::from_millis(62_349)), "1:02.34");
		assert_eq!(format_top_time(Duration::from_secs(3_600)), "60:00.00");
	}

	#[test]
	fn sorts_rows_by_each_key() {
		assert_eq!(sorted_pids(TopSortKey::Pid), vec![3, 2, 1]);
		assert_eq!(sorted_pids(TopSortKey::Command), vec![3, 2, 1]);
		assert_eq!(sorted_pids(TopSortKey::Cpu), vec![2, 1, 3]);
		assert_eq!(sorted_pids(TopSortKey::Mem), vec![1, 3, 2]);
		assert_eq!(sorted_pids(TopSortKey::Time), vec![3, 1, 2]);
	}

	#[test]
	fn snapshot_honors_row_limit() {
		let rows = vec![
			row(3, "visible-three", 0.0, 0, 0),
			row(2, "visible-two", 0.0, 0, 0),
			row(1, "hidden-one", 0.0, 0, 0),
		];
		let output = render_top_snapshot(&rows, Some(2), 7, DEFAULT_TOP_STATS);
		assert!(output.contains("top - snapshot 7"));
		assert!(output.contains("visible-three"));
		assert!(output.contains("visible-two"));
		assert!(!output.contains("hidden-one"));
	}

	#[test]
	fn parses_macos_single_dash_long_options() {
		use brush_core::builtins::Command as _;
		let cmd = TopCommand::new(
			["top", "-pid", "56943,101", "-stats", "pid,cpu,th,mem,pstate"]
				.into_iter()
				.map(String::from),
		)
		.expect("macOS-style flags must parse");
		assert_eq!(cmd.pids, vec![56943, 101]);
		assert_eq!(cmd.stats, vec![
			TopStat::Pid,
			TopStat::Cpu,
			TopStat::Threads,
			TopStat::Res,
			TopStat::State
		]);
	}

	#[test]
	fn snapshot_renders_selected_stats_in_order() {
		let rows = vec![row(42, "worker", 12.3, 4096, 61)];
		let output = render_top_snapshot(&rows, None, 1, &[
			TopStat::Pid,
			TopStat::Cpu,
			TopStat::Threads,
			TopStat::Res,
			TopStat::State,
		]);
		let header = output
			.lines()
			.find(|line| line.contains("PID"))
			.expect("header line");
		assert_eq!(header.split_whitespace().collect::<Vec<_>>(), vec![
			"PID", "%CPU", "TH", "RES", "S"
		]);
		let row_line = output
			.lines()
			.find(|line| line.contains("42"))
			.expect("process row");
		assert_eq!(row_line.split_whitespace().collect::<Vec<_>>(), vec![
			"42", "12.3", "2", "4.0k", "S"
		]);
		assert!(!output.contains("worker"));
	}
}
