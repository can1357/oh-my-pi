//! Pipe, signal, CPU-feature, and timestamp support used by system-facing
//! builtins.

/// Linux zero-copy pipe helpers.
pub(crate) mod pipes {
	#[cfg(any(target_os = "linux", target_os = "android"))]
	use std::{
		fs::{self, File, OpenOptions},
		io,
		os::fd::AsFd,
	};

	#[cfg(any(target_os = "linux", target_os = "android"))]
	use rustix::pipe::SpliceFlags;

	/// Largest pipe capacity an unprivileged Linux process may normally request.
	#[cfg(any(target_os = "linux", target_os = "android"))]
	pub(crate) const MAX_ROOTLESS_PIPE_SIZE: usize = 1024 * 1024;

	/// Creates a read/write pipe pair and opportunistically enlarges its
	/// capacity.
	#[cfg(any(target_os = "linux", target_os = "android"))]
	pub(crate) fn pipe() -> io::Result<(File, File)> {
		let (read, write) = rustix::pipe::pipe().map_err(io::Error::from)?;
		let _ = rustix::pipe::fcntl_setpipe_size(&read, MAX_ROOTLESS_PIPE_SIZE);
		Ok((File::from(read), File::from(write)))
	}

	/// Moves up to `length` bytes between descriptors, one of which must be a
	/// pipe.
	#[cfg(any(target_os = "linux", target_os = "android"))]
	pub(crate) fn splice(
		source: &impl AsFd,
		target: &impl AsFd,
		length: usize,
	) -> io::Result<usize> {
		rustix::pipe::splice(source, None, target, None, length, SpliceFlags::empty())
			.map_err(io::Error::from)
	}

	/// Moves exactly `length` bytes or reports unexpected end of input.
	#[cfg(any(target_os = "linux", target_os = "android"))]
	pub(crate) fn splice_exact(
		source: &impl AsFd,
		target: &impl AsFd,
		length: usize,
	) -> io::Result<()> {
		let mut remaining = length;
		while remaining != 0 {
			let moved = splice(source, target, remaining)?;
			if moved == 0 {
				return Err(io::Error::new(
					io::ErrorKind::UnexpectedEof,
					"splice source ended before requested length",
				));
			}
			remaining -= moved;
		}
		Ok(())
	}

	/// Opens `/dev/null` only when it has the expected Linux device number.
	#[cfg(any(target_os = "linux", target_os = "android"))]
	pub(crate) fn dev_null() -> Option<File> {
		let null = OpenOptions::new().write(true).open("/dev/null").ok()?;
		let stat = rustix::fs::fstat(&null).ok()?;
		(rustix::fs::major(stat.st_rdev) == 1 && rustix::fs::minor(stat.st_rdev) == 3).then_some(null)
	}
}

/// Signal-adjacent stdout health probes.
pub(crate) mod signals {
	#[cfg(any(target_os = "linux", target_os = "android"))]
	use std::{io, mem};
	/// Returns whether stdout is not a FIFO with a broken or hung-up reader.
	#[cfg(any(target_os = "linux", target_os = "android"))]
	pub(crate) fn ensure_stdout_not_broken() -> io::Result<bool> {
		use std::os::fd::AsRawFd;
		let fd = io::stdout().as_raw_fd();
		let mut stat = mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: `fd` is live and `stat` points to writable storage.
		if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: successful `fstat` initialized the structure.
		let stat = unsafe { stat.assume_init() };
		if stat.st_mode & libc::S_IFMT != libc::S_IFIFO {
			return Ok(true);
		}
		let mut poll_fd =
			libc::pollfd { fd, events: (libc::POLLERR | libc::POLLHUP) as libc::c_short, revents: 0 };
		// SAFETY: `poll_fd` is one initialized element and the zero timeout is
		// nonblocking.
		let result = unsafe { libc::poll(&raw mut poll_fd, 1, 0) };
		if result < 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(poll_fd.revents & (libc::POLLERR | libc::POLLHUP) as libc::c_short == 0)
		}
	}
}

/// Runtime CPU feature detection and environment policy.
pub(crate) mod hardware {
	use std::{arch, collections::BTreeSet, env, sync::LazyLock};

	use strum::EnumString;

	/// Hardware features queried by checksum and word-count acceleration.
	#[derive(Clone, Copy, Debug, EnumString, Eq, Ord, PartialEq, PartialOrd)]
	pub(crate) enum HardwareFeature {
		/// AVX-512F and AVX-512BW.
		#[strum(serialize = "AVX512", serialize = "AVX512F")]
		Avx512,
		/// AVX2.
		#[strum(serialize = "AVX2")]
		Avx2,
		/// PCLMULQDQ polynomial multiplication.
		#[strum(serialize = "PCLMUL", serialize = "PMULL")]
		PclMul,
		/// ARM VMULL polynomial multiplication.
		#[strum(serialize = "VMULL")]
		Vmull,
		/// SSE2.
		#[strum(serialize = "SSE2")]
		Sse2,
		/// ARM ASIMD/NEON.
		#[strum(serialize = "ASIMD")]
		Asimd,
	}

	/// Common queries over detected or policy-enabled hardware features.
	pub(crate) trait HasHardwareFeatures {
		/// Returns whether one feature is enabled.
		fn has_feature(&self, feature: HardwareFeature) -> bool;
		/// Iterates enabled features in stable order.
		fn iter_features(&self) -> impl Iterator<Item = HardwareFeature>;
		/// Returns whether AVX-512 is enabled.
		fn has_avx512(&self) -> bool {
			self.has_feature(HardwareFeature::Avx512)
		}
		/// Returns whether AVX2 is enabled.
		fn has_avx2(&self) -> bool {
			self.has_feature(HardwareFeature::Avx2)
		}
		/// Returns whether PCLMULQDQ is enabled.
		fn has_pclmul(&self) -> bool {
			self.has_feature(HardwareFeature::PclMul)
		}
		/// Returns whether VMULL is enabled.
		fn has_vmull(&self) -> bool {
			self.has_feature(HardwareFeature::Vmull)
		}
	}

	/// CPU features physically available to the process.
	#[derive(Clone, Debug, Eq, PartialEq)]
	pub(crate) struct CpuFeatures {
		features: BTreeSet<HardwareFeature>,
	}

	impl CpuFeatures {
		/// Detects and caches CPU features.
		pub(crate) fn detect() -> &'static Self {
			static FEATURES: LazyLock<CpuFeatures> = LazyLock::new(|| {
				let features = [
					(HardwareFeature::Avx512, detect_avx512()),
					(HardwareFeature::Avx2, detect_avx2()),
					(HardwareFeature::PclMul, detect_pclmul()),
					(HardwareFeature::Vmull, detect_vmull()),
					(HardwareFeature::Sse2, detect_sse2()),
					(HardwareFeature::Asimd, detect_asimd()),
				]
				.into_iter()
				.filter_map(|(feature, available)| available.then_some(feature))
				.collect();
				CpuFeatures { features }
			});
			&FEATURES
		}
	}

	impl HasHardwareFeatures for CpuFeatures {
		fn has_feature(&self, feature: HardwareFeature) -> bool {
			self.features.contains(&feature)
		}

		fn iter_features(&self) -> impl Iterator<Item = HardwareFeature> {
			self.features.iter().copied()
		}
	}

	/// Detected features after applying `GLIBC_TUNABLES` disablements.
	#[derive(Clone, Debug)]
	pub(crate) struct SimdPolicy {
		disabled: BTreeSet<HardwareFeature>,
		hardware: &'static CpuFeatures,
	}

	impl SimdPolicy {
		/// Detects and caches the process-wide SIMD policy.
		pub(crate) fn detect() -> &'static Self {
			static POLICY: LazyLock<SimdPolicy> = LazyLock::new(|| SimdPolicy {
				disabled: parse_disabled_features(&env::var("GLIBC_TUNABLES").unwrap_or_default()),
				hardware: CpuFeatures::detect(),
			});
			&POLICY
		}

		/// Returns features explicitly disabled by `GLIBC_TUNABLES`.
		pub(crate) fn disabled_features(&self) -> Vec<HardwareFeature> {
			self.disabled.iter().copied().collect()
		}
	}

	impl HasHardwareFeatures for SimdPolicy {
		fn has_feature(&self, feature: HardwareFeature) -> bool {
			self.hardware.has_feature(feature) && !self.disabled.contains(&feature)
		}

		fn iter_features(&self) -> impl Iterator<Item = HardwareFeature> {
			self.hardware.features.difference(&self.disabled).copied()
		}
	}

	fn parse_disabled_features(tunables: &str) -> BTreeSet<HardwareFeature> {
		tunables
			.split(':')
			.filter_map(|entry| entry.split_once('='))
			.filter(|(name, _)| name.trim() == "glibc.cpu.hwcaps")
			.flat_map(|(_, value)| value.split(','))
			.filter_map(|token| token.trim().strip_prefix('-'))
			.filter_map(|name| name.to_ascii_uppercase().as_str().try_into().ok())
			.collect()
	}

	#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
	fn detect_avx512() -> bool {
		!cfg!(target_os = "android")
			&& arch::is_x86_feature_detected!("avx512f")
			&& arch::is_x86_feature_detected!("avx512bw")
	}
	#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
	const fn detect_avx512() -> bool {
		false
	}
	#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
	fn detect_avx2() -> bool {
		!cfg!(target_os = "android") && arch::is_x86_feature_detected!("avx2")
	}
	#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
	const fn detect_avx2() -> bool {
		false
	}
	#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
	fn detect_pclmul() -> bool {
		!cfg!(target_os = "android") && arch::is_x86_feature_detected!("pclmulqdq")
	}
	#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
	const fn detect_pclmul() -> bool {
		false
	}
	#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
	fn detect_sse2() -> bool {
		!cfg!(target_os = "android") && arch::is_x86_feature_detected!("sse2")
	}
	#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
	const fn detect_sse2() -> bool {
		false
	}
	#[cfg(all(target_arch = "aarch64", target_endian = "little"))]
	fn detect_asimd() -> bool {
		!cfg!(target_os = "android") && arch::is_aarch64_feature_detected!("asimd")
	}
	#[cfg(not(all(target_arch = "aarch64", target_endian = "little")))]
	const fn detect_asimd() -> bool {
		false
	}
	#[cfg(target_arch = "aarch64")]
	fn detect_vmull() -> bool {
		detect_asimd()
	}
	#[cfg(not(target_arch = "aarch64"))]
	const fn detect_vmull() -> bool {
		false
	}
}

/// System-time conversion and GNU formatting fallbacks.
pub(crate) mod time {
	use std::{
		io,
		io::Write,
		time::{SystemTime, UNIX_EPOCH},
	};

	use jiff::{
		Zoned,
		fmt::{
			StdIoWrite,
			strtime::{BrokenDownTime, Config},
		},
	};

	/// Common `ls` timestamp format strings.
	pub(crate) mod format {
		/// Full ISO timestamp including nanoseconds and numeric zone.
		pub(crate) static FULL_ISO: &str = "%Y-%m-%d %H:%M:%S.%N %z";
		/// Long ISO timestamp through minutes.
		pub(crate) static LONG_ISO: &str = "%Y-%m-%d %H:%M";
		/// Calendar-only ISO timestamp.
		pub(crate) static ISO: &str = "%Y-%m-%d";
	}

	/// Output used when a timestamp lies outside jiff's civil-time range.
	#[derive(Clone, Copy, Debug, Eq, PartialEq)]
	pub(crate) enum FormatSystemTimeFallback {
		/// Print normalized seconds and nine fractional digits.
		Float,
	}

	/// Splits a system time into signed epoch seconds and nanoseconds.
	pub(crate) fn system_time_to_sec(time: SystemTime) -> (i64, u32) {
		match time.duration_since(UNIX_EPOCH) {
			Ok(duration) => (duration.as_secs() as i64, duration.subsec_nanos()),
			Err(error) => {
				let duration = error.duration();
				(-(duration.as_secs() as i64), duration.subsec_nanos())
			},
		}
	}

	/// Formats `time` with a lenient strftime pattern and writes it to `output`.
	pub(crate) fn format_system_time<W: Write>(
		output: &mut W,
		time: SystemTime,
		format: &str,
		fallback: FormatSystemTimeFallback,
	) -> io::Result<()> {
		if let Ok(zoned) = Zoned::try_from(time) {
			let broken_down = BrokenDownTime::from(&zoned);
			let mut output = StdIoWrite(output);
			return broken_down
				.format_with_config(&Config::new().lenient(true), format, &mut output)
				.map_err(io::Error::other);
		}
		let (mut seconds, mut nanoseconds) = system_time_to_sec(time);
		match fallback {
			FormatSystemTimeFallback::Float => {
				if seconds < 0 && nanoseconds != 0 {
					seconds -= 1;
					nanoseconds = 1_000_000_000 - nanoseconds;
				}
				write!(output, "{seconds}.{nanoseconds:09}")
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use std::time::{Duration, UNIX_EPOCH};

	use super::{
		hardware::{HardwareFeature, HasHardwareFeatures as _, SimdPolicy},
		time::*,
	};

	#[test]
	fn epoch_seconds_preserve_pre_epoch_fraction() {
		assert_eq!(system_time_to_sec(UNIX_EPOCH + Duration::new(2, 3)), (2, 3));
		assert_eq!(system_time_to_sec(UNIX_EPOCH - Duration::new(2, 3)), (-2, 3));
	}

	#[test]
	fn hardware_names_parse_aliases() {
		assert_eq!(HardwareFeature::try_from("AVX512F").unwrap(), HardwareFeature::Avx512);
		let _ = SimdPolicy::detect().has_feature(HardwareFeature::Asimd);
	}
}
