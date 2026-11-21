//! `--stats` and the end-of-run summary text.

use std::time::Duration;

use super::format::{big_dnum, big_num};
use super::levels::{Info, OutLevels};

/// Transfer statistics (both peers' counters after the stats exchange).
///
/// `total_written` / `total_read` are the byte counts the summary prints (for a client
/// receiver: the values the server sent in the stats exchange, swapped).
#[derive(Clone, Debug, Default)]
pub(crate) struct Stats {
	pub total_size: i64,
	pub total_transferred_size: i64,
	pub total_written: i64,
	pub total_read: i64,
	pub literal_data: i64,
	pub matched_data: i64,
	/// Protocol 33: 4 KiB logical blocks the receiver wrote.
	pub touched_blocks_4k: i64,
	/// Milliseconds.
	pub flist_buildtime: i64,
	/// Milliseconds.
	pub flist_xfertime: i64,
	pub flist_size: i64,
	/// Every entry (regular files are what is left after the other kinds).
	pub num_files: i32,
	pub num_dirs: i32,
	pub num_symlinks: i32,
	pub num_devices: i32,
	pub num_specials: i32,
	pub created_files: i32,
	pub created_dirs: i32,
	pub created_symlinks: i32,
	pub created_devices: i32,
	pub created_specials: i32,
	pub deleted_files: i32,
	pub deleted_dirs: i32,
	pub deleted_symlinks: i32,
	pub deleted_devices: i32,
	pub deleted_specials: i32,
	pub xferred_files: i32,
}

/// `Number of files: 8 (reg: 5, dir: 2, link: 1)`.
fn itemized_counts(prefix: &str, counts: [i32; 5], human: u8) -> String {
	let comma = human.min(1);
	let total = counts[0];
	let mut line = format!("{prefix}: {}", big_num(i64::from(total), comma));
	if total != 0 {
		let reg = total - counts[1] - counts[2] - counts[3] - counts[4];
		let parts = [reg, counts[1], counts[2], counts[3], counts[4]];
		let labels = ["reg", "dir", "link", "dev", "special"];
		let mut sep = " (";
		for (label, count) in labels.iter().zip(parts) {
			if count != 0 {
				line.push_str(sep);
				line.push_str(label);
				line.push_str(": ");
				line.push_str(&big_num(i64::from(count), comma));
				sep = ", ";
			}
		}
		line.push(')');
	}
	line.push('\n');
	line
}

impl Stats {
	/// The --stats block (INFO stats ≥ 2), one `\n`-terminated line per entry, honoring -h
	/// and protocol-dependent lines. The blank line upstream prints before it (to stdout only)
	/// is not included; see `Logger::output_summary`.
	pub(super) fn stats_lines(&self, human: u8, proto: u32, levels: &OutLevels) -> Vec<String> {
		if levels.info(Info::Stats) < 2 {
			return Vec::new();
		}
		let comma = human.min(1);
		let num = |n: i64| big_num(n, human);
		let mut lines = vec![itemized_counts(
			"Number of files",
			[self.num_files, self.num_dirs, self.num_symlinks, self.num_devices, self.num_specials],
			human,
		)];
		if proto >= 29 {
			lines.push(itemized_counts(
				"Number of created files",
				[
					self.created_files,
					self.created_dirs,
					self.created_symlinks,
					self.created_devices,
					self.created_specials,
				],
				human,
			));
		}
		if proto >= 31 {
			lines.push(itemized_counts(
				"Number of deleted files",
				[
					self.deleted_files,
					self.deleted_dirs,
					self.deleted_symlinks,
					self.deleted_devices,
					self.deleted_specials,
				],
				human,
			));
		}
		lines.push(format!(
			"Number of regular files transferred: {}\n",
			big_num(i64::from(self.xferred_files), comma)
		));
		lines.push(format!("Total file size: {} bytes\n", num(self.total_size)));
		lines.push(format!(
			"Total transferred file size: {} bytes\n",
			num(self.total_transferred_size)
		));
		lines.push(format!("Literal data: {} bytes\n", num(self.literal_data)));
		if proto >= 33 {
			lines.push(format!(
				"Number of 4 KiB logical blocks touched: {}\n",
				big_num(self.touched_blocks_4k, comma)
			));
		}
		lines.push(format!("Matched data: {} bytes\n", num(self.matched_data)));
		lines.push(format!("File list size: {}\n", num(self.flist_size)));
		if self.flist_buildtime != 0 {
			lines.push(format!(
				"File list generation time: {} seconds\n",
				big_dnum(self.flist_buildtime as f64 / 1000.0, comma, 3)
			));
			lines.push(format!(
				"File list transfer time: {} seconds\n",
				big_dnum(self.flist_xfertime as f64 / 1000.0, comma, 3)
			));
		}
		lines.push(format!("Total bytes sent: {}\n", num(self.total_written)));
		lines.push(format!("Total bytes received: {}\n", num(self.total_read)));
		lines
	}

	/// "sent … bytes  received … bytes  … bytes/sec" and "total size is …  speedup is …":
	/// `elapsed` None prints `UNKNOWN` bytes/sec, `suffix` is `" (BATCH ONLY)"`,
	/// `" (DRY RUN)"`, or empty. The preceding blank line is not included.
	pub(crate) fn summary_lines(
		&self,
		human: u8,
		elapsed: Option<Duration>,
		suffix: &str,
	) -> [String; 2] {
		let total = self.total_written.saturating_add(self.total_read);
		let rate = match elapsed {
			// Upstream measures whole seconds between two time() calls.
			Some(elapsed) => big_dnum(total as f64 / (0.5 + elapsed.as_secs() as f64), human, 2),
			None => "UNKNOWN".to_owned(),
		};
		let speedup = self.total_size as f64 / total as f64;
		[
			format!(
				"sent {} bytes  received {} bytes  {rate} bytes/sec\n",
				big_num(self.total_written, human),
				big_num(self.total_read, human)
			),
			format!(
				"total size is {}  speedup is {}{suffix}\n",
				big_num(self.total_size, human),
				big_dnum(speedup, human.min(1), 2)
			),
		]
	}

	/// The log-file line upstream writes at exit: `sent X bytes  received Y bytes  total size Z`.
	pub(crate) fn log_exit_line(&self) -> String {
		format!(
			"sent {} bytes  received {} bytes  total size {}\n",
			big_num(self.total_written, 0),
			big_num(self.total_read, 0),
			big_num(self.total_size, 0)
		)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn levels(stats: u8) -> OutLevels {
		let mut levels = OutLevels::default();
		levels.set_info(Info::Stats, stats);
		levels
	}

	/// `rsync -aH --stats src/ dst/` (3.5.1, protocol 33, default -h level 1), minus the
	/// leading blank lines.
	const STATS_DEFAULT: &str = "\
Number of files: 8 (reg: 5, dir: 2, link: 1)
Number of created files: 8 (reg: 5, dir: 2, link: 1)
Number of deleted files: 0
Number of regular files transferred: 4
Total file size: 1,239,606 bytes
Total transferred file size: 1,239,586 bytes
Literal data: 1,239,586 bytes
Number of 4 KiB logical blocks touched: 306
Matched data: 0 bytes
File list size: 0
File list generation time: 0.006 seconds
File list transfer time: 0.000 seconds
Total bytes sent: 1,240,263
Total bytes received: 120
";

	const SUMMARY_DEFAULT: &str = "\
sent 1,240,263 bytes  received 120 bytes  2,480,766.00 bytes/sec
total size is 1,239,606  speedup is 1.00
";

	fn known_transfer() -> Stats {
		Stats {
			total_size: 1_239_606,
			total_transferred_size: 1_239_586,
			total_written: 1_240_263,
			total_read: 120,
			literal_data: 1_239_586,
			touched_blocks_4k: 306,
			flist_buildtime: 6,
			num_files: 8,
			num_dirs: 2,
			num_symlinks: 1,
			created_files: 8,
			created_dirs: 2,
			created_symlinks: 1,
			xferred_files: 4,
			..Stats::default()
		}
	}

	fn render(stats: &Stats, human: u8, proto: u32, levels: &OutLevels) -> String {
		stats.stats_lines(human, proto, levels).concat()
	}

	fn render_summary(stats: &Stats, human: u8, elapsed: Duration, dry_run: bool) -> String {
		let suffix = if dry_run { " (DRY RUN)" } else { "" };
		stats.summary_lines(human, Some(elapsed), suffix).concat()
	}

	#[test]
	fn stats_block_matches_reference() {
		let stats = known_transfer();
		assert_eq!(render(&stats, 1, 33, &levels(2)), STATS_DEFAULT);
		assert_eq!(render_summary(&stats, 1, Duration::from_millis(300), false), SUMMARY_DEFAULT);
		assert!(render(&stats, 1, 33, &levels(1)).is_empty());
	}

	/// `rsync -aH --stats -hh --protocol=31 -n src/ d10/` (minus the blank lines).
	const STATS_HH_P31_DRY: &str = "\
Number of files: 8 (reg: 5, dir: 2, link: 1)
Number of created files: 8 (reg: 5, dir: 2, link: 1)
Number of deleted files: 0
Number of regular files transferred: 4
Total file size: 1.18M bytes
Total transferred file size: 1.18M bytes
Literal data: 0 bytes
Matched data: 0 bytes
File list size: 0
File list generation time: 0.002 seconds
File list transfer time: 0.000 seconds
Total bytes sent: 229
Total bytes received: 48
sent 229 bytes  received 48 bytes  554.00 bytes/sec
total size is 1.18M  speedup is 4,475.16 (DRY RUN)
";

	#[test]
	fn protocol_31_dry_run_with_1024_units() {
		let stats = Stats {
			total_size: 1_239_620,
			total_transferred_size: 1_239_617,
			total_written: 229,
			total_read: 48,
			flist_buildtime: 2,
			num_files: 8,
			num_dirs: 2,
			num_symlinks: 1,
			created_files: 8,
			created_dirs: 2,
			created_symlinks: 1,
			xferred_files: 4,
			..Stats::default()
		};
		let mut text = render(&stats, 3, 31, &levels(3));
		text.push_str(&render_summary(&stats, 3, Duration::ZERO, true));
		assert_eq!(text, STATS_HH_P31_DRY);
	}

	#[test]
	fn summary_with_h_and_one_second() {
		// `rsync -aH --delete --stats -h` incremental run: 318 bytes over one second.
		let stats = Stats {
			total_size: 1_239_621,
			total_written: 270,
			total_read: 48,
			..Stats::default()
		};
		assert_eq!(
			render_summary(&stats, 2, Duration::from_millis(1400), false),
			"sent 270 bytes  received 48 bytes  212.00 bytes/sec\ntotal size is 1.24M  speedup is \
			 3,898.18\n"
		);
		assert_eq!(
			stats.summary_lines(0, None, " (BATCH ONLY)")[0],
			"sent 270 bytes  received 48 bytes  UNKNOWN bytes/sec\n"
		);
	}

	#[test]
	fn counts_without_breakdown_and_other_kinds() {
		assert_eq!(itemized_counts("Number of deleted files", [0; 5], 1), "Number of deleted files: 0\n");
		assert_eq!(
			itemized_counts("Number of files", [1500, 0, 0, 2, 1], 1),
			"Number of files: 1,500 (reg: 1,497, dev: 2, special: 1)\n"
		);
		assert_eq!(
			itemized_counts("Number of files", [1500, 1500, 0, 0, 0], 0),
			"Number of files: 1500 (dir: 1500)\n"
		);
	}

	#[test]
	fn log_file_exit_line() {
		let stats = Stats { total_written: 1_240_347, total_read: 142, total_size: 1_239_620, ..Stats::default() };
		assert_eq!(
			stats.log_exit_line(),
			"sent 1240347 bytes  received 142 bytes  total size 1239620\n"
		);
	}
}
