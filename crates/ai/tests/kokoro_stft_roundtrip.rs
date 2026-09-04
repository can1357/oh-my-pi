//! Integration coverage for short-window STFT reconstruction.

#![cfg(feature = "local-tts")]

use std::f32::consts;

use candle_core::{DType, Device, Tensor};
use omp_ai::local::tts::kokoro::istftnet::TorchSTFT;

#[test]
fn stft_roundtrip() {
	let device = stft_test_device();

	// Simple 440Hz sine wave, 0.1 seconds at 24kHz
	let n = 2400;
	let samples: Vec<f32> = (0..n)
		.map(|i| (2.0 * consts::PI * 440.0 * i as f32 / 24000.0).sin())
		.collect();

	let x = Tensor::from_vec(samples.clone(), &[1, n], &device).unwrap();

	let stft = TorchSTFT::new(20, 5, 20, &device, DType::F32).unwrap();

	// Forward: [1, 2400] -> (mag: [1, 11, T], phase: [1, 11, T])
	let (mag, phase) = stft.transform(&x).unwrap();

	// Inverse: (mag, phase) -> [1, 1, L]
	let recon = stft.inverse(&mag, &phase).unwrap();

	let recon_samples = recon.flatten_all().unwrap().to_vec1::<f32>().unwrap();

	// MSE
	let len = samples.len().min(recon_samples.len());
	let mse: f32 = samples[..len]
		.iter()
		.zip(recon_samples[..len].iter())
		.map(|(a, b)| (a - b).powi(2))
		.sum::<f32>()
		/ len as f32;

	assert!(mse < 0.01, "STFT roundtrip MSE too high: {mse}");
}

fn stft_test_device() -> Device {
	#[cfg(target_os = "macos")]
	{
		Device::new_metal(0).unwrap_or(Device::Cpu)
	}

	#[cfg(not(target_os = "macos"))]
	{
		Device::Cpu
	}
}
