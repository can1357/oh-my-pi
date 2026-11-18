//! Local SIXEL palette quantization, band encoding, and bounded RGBA decoding.

use std::{collections::HashMap, fmt::Write};

use image::{Rgba, RgbaImage};
use napi::{Error, Result};

use super::{decimal, guard_dimensions};

const TRANSPARENT: u16 = 256;

/// Encode RGBA pixels using at most 256 registers and transparent background
/// mode.
pub(super) fn encode(rgba: &[u8], width: usize, height: usize) -> String {
	let mut exact = HashMap::with_capacity(256);
	let mut palette = Vec::with_capacity(256);
	for pixel in rgba
		.as_chunks::<4>()
		.0
		.iter()
		.filter(|pixel| pixel[3] >= 128)
	{
		let color = [pixel[0], pixel[1], pixel[2]];
		if !exact.contains_key(&color) {
			if palette.len() == 256 {
				palette = median_cut(rgba);
				exact.clear();
				break;
			}
			exact.insert(color, palette.len() as u16);
			palette.push(color);
		}
	}
	let indices = if exact.is_empty() && !palette.is_empty() {
		dither(rgba, width, &palette)
	} else {
		rgba
			.as_chunks::<4>()
			.0
			.iter()
			.map(|pixel| {
				if pixel[3] < 128 {
					TRANSPARENT
				} else {
					exact[&[pixel[0], pixel[1], pixel[2]]]
				}
			})
			.collect()
	};
	let mut output = String::new();
	write!(output, "\x1bP9;1;0q\"1;1;{width};{height}").unwrap();
	for (index, color) in palette.iter().enumerate() {
		let [r, g, b] = color.map(|channel| (u32::from(channel) * 100 + 127) / 255);
		write!(output, "#{index};2;{r};{g};{b}").unwrap();
	}
	let mut sixels = vec![0_u8; palette.len() * width];
	let mut used = [false; 256];
	for y0 in (0..height).step_by(6) {
		for (color, used) in used.iter_mut().enumerate().take(palette.len()) {
			if *used {
				sixels[color * width..(color + 1) * width].fill(0);
				*used = false;
			}
		}
		for y in y0..(y0 + 6).min(height) {
			for x in 0..width {
				let color = indices[y * width + x];
				if color != TRANSPARENT {
					let color = usize::from(color);
					used[color] = true;
					sixels[color * width + x] |= 1 << (y - y0);
				}
			}
		}
		for (color, &used) in used.iter().enumerate().take(palette.len()) {
			if !used {
				continue;
			}
			write!(output, "#{color}").unwrap();
			let row = &sixels[color * width..(color + 1) * width];
			let mut x = 0;
			while x < width {
				let value = row[x];
				let start = x;
				while x < width && x - start < 65535 && row[x] == value {
					x += 1;
				}
				let count = x - start;
				let character = char::from(b'?' + value);
				if count >= 4 {
					write!(output, "!{count}{character}").unwrap();
				} else {
					for _ in 0..count {
						output.push(character);
					}
				}
			}
			output.push('$');
		}
		output.push('-');
	}
	output.push_str("\x1b\\");
	output
}

#[derive(Clone, Copy, Default)]
struct Bin {
	sums:  [u64; 3],
	count: u64,
}

fn median_cut(rgba: &[u8]) -> Vec<[u8; 3]> {
	// Five bits per channel bound histogram memory independently of image size.
	let mut histogram = vec![Bin::default(); 32 * 32 * 32];
	for pixel in rgba
		.as_chunks::<4>()
		.0
		.iter()
		.filter(|pixel| pixel[3] >= 128)
	{
		let index = (usize::from(pixel[0] >> 3) << 10)
			| (usize::from(pixel[1] >> 3) << 5)
			| usize::from(pixel[2] >> 3);
		let bin = &mut histogram[index];
		bin.count += 1;
		for (sum, &channel) in bin.sums.iter_mut().zip(pixel) {
			*sum += u64::from(channel);
		}
	}
	histogram.retain(|bin| bin.count != 0);
	let mut bins = histogram;
	let mut boxes = Vec::with_capacity(256);
	boxes.push((0, bins.len()));
	while boxes.len() < 256 {
		let mut choice = None;
		let mut best_score = 0_u64;
		for (index, &(start, end)) in boxes.iter().enumerate() {
			if end - start < 2 {
				continue;
			}
			let mut low = [255; 3];
			let mut high = [0; 3];
			let mut count = 0;
			for bin in &bins[start..end] {
				count += bin.count;
				for channel in 0..3 {
					let mean = bin.sums[channel] / bin.count;
					low[channel] = low[channel].min(mean);
					high[channel] = high[channel].max(mean);
				}
			}
			let axis = (0..3).max_by_key(|&axis| high[axis] - low[axis]).unwrap();
			let range = high[axis] - low[axis];
			let score = count.saturating_mul(range * range);
			if score > best_score {
				best_score = score;
				choice = Some((index, axis, count));
			}
		}
		let Some((index, axis, count)) = choice else {
			break;
		};
		let (start, end) = boxes[index];
		bins[start..end].sort_unstable_by_key(|bin| bin.sums[axis] / bin.count);
		let mut weight = 0;
		let mut middle = start;
		while middle < end - 1 {
			weight += bins[middle].count;
			middle += 1;
			if weight >= count.div_ceil(2) {
				break;
			}
		}
		boxes[index] = (start, middle);
		boxes.push((middle, end));
	}
	boxes
		.into_iter()
		.map(|(start, end)| {
			let mut total = Bin::default();
			for bin in &bins[start..end] {
				total.count += bin.count;
				for (sum, value) in total.sums.iter_mut().zip(bin.sums) {
					*sum += value;
				}
			}
			total
				.sums
				.map(|sum| ((sum + total.count / 2) / total.count) as u8)
		})
		.collect()
}

struct ColorNode {
	color: usize,
	axis:  usize,
	left:  Option<usize>,
	right: Option<usize>,
}

fn color_tree(
	indices: &mut [usize],
	palette: &[[u8; 3]],
	depth: usize,
	nodes: &mut Vec<ColorNode>,
) -> Option<usize> {
	if indices.is_empty() {
		return None;
	}
	let axis = depth % 3;
	let middle = indices.len() / 2;
	indices.select_nth_unstable_by_key(middle, |&index| palette[index][axis]);
	let (left, rest) = indices.split_at_mut(middle);
	let (color, right) = rest.split_first_mut().unwrap();
	let index = nodes.len();
	nodes.push(ColorNode { color: *color, axis, left: None, right: None });
	let left = color_tree(left, palette, depth + 1, nodes);
	let right = color_tree(right, palette, depth + 1, nodes);
	nodes[index].left = left;
	nodes[index].right = right;
	Some(index)
}

fn nearest_color(
	nodes: &[ColorNode],
	index: usize,
	color: [f32; 3],
	palette: &[[u8; 3]],
	best: &mut (usize, f32),
) {
	let node = &nodes[index];
	let candidate = palette[node.color].map(f32::from);
	let distance: f32 = color
		.iter()
		.zip(candidate)
		.map(|(a, b)| (a - b).powi(2))
		.sum();
	if distance < best.1 {
		*best = (node.color, distance);
	}
	let delta = color[node.axis] - candidate[node.axis];
	let (near, far) = if delta < 0.0 {
		(node.left, node.right)
	} else {
		(node.right, node.left)
	};
	if let Some(near) = near {
		nearest_color(nodes, near, color, palette, best);
	}
	if delta * delta < best.1
		&& let Some(far) = far
	{
		nearest_color(nodes, far, color, palette, best);
	}
}

#[allow(
	clippy::suboptimal_flops,
	reason = "per-pixel hot loop: mul_add is a libm call on the x86-64 baseline target (no FMA), \
	          and fusing would change the dithered output"
)]
fn dither(rgba: &[u8], width: usize, palette: &[[u8; 3]]) -> Vec<u16> {
	let mut colors: [usize; 256] = std::array::from_fn(|index| index);
	let mut nodes = Vec::with_capacity(palette.len());
	let root = color_tree(&mut colors[..palette.len()], palette, 0, &mut nodes).unwrap();
	let mut indices = vec![TRANSPARENT; rgba.len() / 4];
	let mut current = vec![[0.0_f32; 3]; width + 2];
	let mut next = vec![[0.0_f32; 3]; width + 2];
	for (y, row) in rgba.chunks_exact(width * 4).enumerate() {
		let forward = y % 2 == 0;
		for step in 0..width {
			let x = if forward { step } else { width - step - 1 };
			let pixel = &row[x * 4..x * 4 + 4];
			// Transparent pixels discard incoming error and never train the
			// palette.
			if pixel[3] < 128 {
				continue;
			}
			let color =
				std::array::from_fn(|channel| f32::from(pixel[channel]) + current[x + 1][channel]);
			let mut nearest = (0, f32::INFINITY);
			nearest_color(&nodes, root, color, palette, &mut nearest);
			indices[y * width + x] = nearest.0 as u16;
			let (ahead, behind) = if forward { (x + 2, x) } else { (x, x + 2) };
			for channel in 0..3 {
				// Match the previous encoder's default 7/8 diffusion strength.
				let error = (color[channel] - f32::from(palette[nearest.0][channel])) * 0.875 / 16.0;
				current[ahead][channel] += error * 7.0;
				next[behind][channel] += error * 3.0;
				next[x + 1][channel] += error * 5.0;
				next[ahead][channel] += error;
			}
		}
		std::mem::swap(&mut current, &mut next);
		next.fill([0.0; 3]);
	}
	indices
}

#[derive(Clone)]
struct Commands<'a> {
	bytes: &'a [u8],
	index: usize,
}

enum Command {
	Sixel(u8, usize),
	Color([usize; 5], usize),
	Raster([usize; 4]),
	CarriageReturn,
	Newline,
}

impl Commands<'_> {
	fn parameters<const N: usize>(&mut self) -> ([usize; N], usize) {
		let mut values = [0; N];
		let mut count = 0;
		loop {
			let (value, end) = decimal(self.bytes, self.index);
			if count < N {
				values[count] = value;
			}
			count += 1;
			self.index = end;
			if self.bytes.get(self.index) != Some(&b';') {
				break;
			}
			self.index += 1;
		}
		(values, count)
	}
}

impl Iterator for Commands<'_> {
	type Item = Command;

	fn next(&mut self) -> Option<Self::Item> {
		while let Some(&byte) = self.bytes.get(self.index) {
			self.index += 1;
			match byte {
				b'?'..=b'~' => return Some(Command::Sixel(byte - b'?', 1)),
				b'!' => {
					let (repeat, end) = decimal(self.bytes, self.index);
					self.index = end;
					if let Some(&value @ b'?'..=b'~') = self.bytes.get(end) {
						self.index += 1;
						return Some(Command::Sixel(value - b'?', repeat.max(1)));
					}
				},
				b'#' => {
					let (values, count) = self.parameters();
					return Some(Command::Color(values, count));
				},
				b'"' => return Some(Command::Raster(self.parameters().0)),
				b'$' => return Some(Command::CarriageReturn),
				b'-' => return Some(Command::Newline),
				0x18 | 0x1a | 0x1b | 0x80..=0x9f => {
					self.index = self.bytes.len();
					return None;
				},
				_ => {},
			}
		}
		None
	}
}

/// Decode one bounded SIXEL control string, including RGB and HLS registers.
pub(super) fn decode(bytes: &[u8]) -> Result<RgbaImage> {
	let start = bytes
		.array_windows()
		.position(|pair| pair == b"\x1bP")
		.map(|i| i + 2)
		.or_else(|| bytes.iter().position(|&byte| byte == 0x90).map(|i| i + 1))
		.ok_or_else(|| Error::from_reason("SIXEL data is missing a DCS introducer"))?;
	let q = bytes[start..]
		.iter()
		.position(|&byte| byte == b'q')
		.map(|i| start + i)
		.ok_or_else(|| Error::from_reason("SIXEL data is missing its q introducer"))?;
	let header = &bytes[start..q];
	let transparent = header
		.split(|&byte| byte == b';')
		.nth(1)
		.is_some_and(|parameter| decimal(parameter, 0).0 == 1);
	let commands = Commands { bytes, index: q + 1 };
	let (mut width, mut height, mut x, mut y) = (1_usize, 1_usize, 0_usize, 0_usize);
	for command in commands.clone() {
		match command {
			Command::Sixel(bits, repeat) => {
				x = x.saturating_add(repeat);
				guard_dimensions(x, y.saturating_add(6))?;
				if bits != 0 {
					width = width.max(x);
					height = height.max(y + 6);
				}
			},
			Command::Raster(values) => {
				width = width.max(values[2]);
				height = height.max(values[3]);
			},
			Command::CarriageReturn => x = 0,
			Command::Newline => {
				x = 0;
				y = y.saturating_add(6);
			},
			Command::Color(..) => {},
		}
		guard_dimensions(width, height)?;
	}
	let mut palette = default_palette();
	let background = if transparent {
		Rgba([0; 4])
	} else {
		palette[0]
	};
	let mut image = RgbaImage::from_pixel(width as u32, height as u32, background);
	let mut color = palette[0];
	x = 0;
	y = 0;
	for command in commands {
		match command {
			Command::Sixel(bits, repeat) => {
				for bit in 0..6 {
					if bits & (1 << bit) != 0 {
						for column in x..x + repeat {
							image.put_pixel(column as u32, (y + bit) as u32, color);
						}
					}
				}
				x += repeat;
			},
			Command::Color(values, count) => {
				let index = values[0].min(palette.len() - 1);
				if count >= 5 {
					match values[1] {
						1 => palette[index] = hls(values[2], values[3], values[4]),
						2 => {
							palette[index] =
								Rgba([percent(values[2]), percent(values[3]), percent(values[4]), 255]);
						},
						_ => {},
					}
				}
				color = palette[index];
			},
			Command::CarriageReturn => x = 0,
			Command::Newline => {
				x = 0;
				y += 6;
			},
			Command::Raster(_) => {},
		}
	}
	Ok(image)
}

fn percent(value: usize) -> u8 {
	((value.min(100) * 255 + 50) / 100) as u8
}

fn default_palette() -> [Rgba<u8>; 256] {
	let mut palette = [Rgba([255; 4]); 256];
	let base = [
		[0, 0, 0],
		[20, 20, 80],
		[80, 13, 13],
		[20, 80, 20],
		[80, 20, 80],
		[20, 80, 80],
		[80, 80, 20],
		[53, 53, 53],
		[26, 26, 26],
		[33, 33, 60],
		[60, 26, 26],
		[33, 60, 33],
		[60, 33, 60],
		[33, 60, 60],
		[60, 60, 33],
		[80, 80, 80],
	];
	for (entry, color) in palette.iter_mut().zip(base) {
		let [r, g, b] = color.map(percent);
		*entry = Rgba([r, g, b, 255]);
	}
	for index in 0..216 {
		palette[index + 16] = Rgba([
			percent(index / 36 * 20),
			percent(index / 6 % 6 * 20),
			percent(index % 6 * 20),
			255,
		]);
	}
	for level in 0..24 {
		let value = percent(level * 100 / 23);
		palette[232 + level] = Rgba([value, value, value, 255]);
	}
	palette
}

fn hls(hue: usize, lightness: usize, saturation: usize) -> Rgba<u8> {
	let hue = ((hue % 360 + 240) % 360) as f64 / 60.0;
	let lightness = lightness.min(100) as f64 / 100.0;
	let saturation = saturation.min(100) as f64 / 100.0;
	let chroma = (1.0 - (lightness + lightness - 1.0).abs()) * saturation;
	let secondary = chroma * (1.0 - (hue % 2.0 - 1.0).abs());
	let rgb = match hue as usize {
		0 => [chroma, secondary, 0.0],
		1 => [secondary, chroma, 0.0],
		2 => [0.0, chroma, secondary],
		3 => [0.0, secondary, chroma],
		4 => [secondary, 0.0, chroma],
		_ => [chroma, 0.0, secondary],
	};
	let [r, g, b] = rgb.map(|channel| ((channel + lightness - chroma / 2.0) * 255.0).round() as u8);
	Rgba([r, g, b, 255])
}
