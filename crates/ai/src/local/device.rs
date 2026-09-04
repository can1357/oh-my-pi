//! Named tiny-inference device preference and safe fallback ordering.

use std::env;

use strum::{EnumString, IntoStaticStr};

use super::{LocalError, LocalErrorKind, LocalResult};

/// Stable device names accepted by `OMP_TINY_DEVICE` and settings surfaces.
#[derive(Clone, Copy, Debug, Default, EnumString, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum TinyDevice {
	/// Safe CPU-only default.
	#[default]
	Cpu,
	/// Compiled accelerator.
	Gpu,
	/// Runtime-selected accelerator.
	Auto,
	/// WebGPU (and the `metal` input alias).
	Webgpu,
	/// NVIDIA CUDA.
	Cuda,
	/// Windows `DirectML`.
	Dml,
	/// Apple `CoreML`.
	Coreml,
	/// WebAssembly CPU runtime.
	Wasm,
	/// `WebNN` default device.
	Webnn,
	/// `WebNN` GPU device.
	#[strum(serialize = "webnn-gpu")]
	WebnnGpu,
	/// `WebNN` CPU device.
	#[strum(serialize = "webnn-cpu")]
	WebnnCpu,
	/// `WebNN` NPU device.
	#[strum(serialize = "webnn-npu")]
	WebnnNpu,
}

impl TinyDevice {
	/// Parses one stable setting or environment value.
	pub fn parse(value: &str) -> LocalResult<Self> {
		if value.trim().eq_ignore_ascii_case("metal") {
			return Ok(Self::Webgpu);
		}
		value.trim().parse().map_err(|_| {
			LocalError::new(
				LocalErrorKind::InvalidInput,
				"OMP_TINY_DEVICE must be cpu, gpu, auto, metal, webgpu, cuda, dml, coreml, wasm, \
				 webnn, webnn-gpu, webnn-cpu, or webnn-npu",
			)
		})
	}

	/// Resolves `OMP_TINY_DEVICE`, defaulting to CPU-only inference.
	pub fn from_environment() -> LocalResult<Self> {
		match env::var_os("OMP_TINY_DEVICE") {
			None => Ok(Self::Cpu),
			Some(value) => Self::parse(value.to_str().ok_or_else(|| {
				LocalError::new(LocalErrorKind::InvalidInput, "OMP_TINY_DEVICE is not UTF-8")
			})?),
		}
	}

	/// Returns accelerator then CPU, except Darwin WebGPU-class preferences,
	/// which are mapped directly to CPU for process-safety parity.
	pub fn load_order(self) -> impl Iterator<Item = Self> {
		let first =
			if cfg!(target_os = "macos") && matches!(self, Self::Gpu | Self::Auto | Self::Webgpu) {
				Self::Cpu
			} else {
				self
			};
		[first, Self::Cpu]
			.into_iter()
			.take(if first == Self::Cpu { 1 } else { 2 })
	}

	/// Maps a named preference onto llama.cpp's compiled layer-offload control.
	pub const fn gpu_layers(self, configured: u32) -> u32 {
		if matches!(self, Self::Cpu | Self::Wasm | Self::WebnnCpu) {
			0
		} else if configured == 0 {
			1
		} else {
			configured
		}
	}
}
