//! zsh/nearcolor: map `#RRGGBB` prompt colours to the nearest colour of a
//! 256- or 88-colour terminal (the `get_color_attr` hook).
//!
//! Ported from zsh 5.9 `Src/Modules/nearcolor.c` (MIT-style licence,
//! Copyright (c) 1992-1997 Paul Falstad and the zsh development group).

/// A colour in CIE L\*a\*b\* space.
#[derive(Clone, Copy)]
struct Cielab {
	l: f64,
	a: f64,
	b: f64,
}

/// zsh `deltae`: the squared distance between two colours (the square
/// root is unnecessary for comparisons).
fn deltae(x: Cielab, y: Cielab) -> f64 {
	let (dl, da, db) = (x.l - y.l, x.a - y.a, x.b - y.b);
	f64::mul_add(db, db, f64::mul_add(da, da, dl * dl))
}

/// zsh `RGBtoLAB` (observer 2°, illuminant D65).
fn rgb_to_lab(red: i32, green: i32, blue: i32) -> Cielab {
	let lin = |c: i32| {
		let c = f64::from(c) / 255.0;
		100.0
			* if c > 0.04045 {
				((c + 0.055) / 1.055).powf(2.4)
			} else {
				c / 12.92
			}
	};
	let (r, g, b) = (lin(red), lin(green), lin(blue));
	let f = |t: f64| {
		if t > 0.008856 {
			t.cbrt()
		} else {
			7.787f64.mul_add(t, 16.0 / 116.0)
		}
	};
	let x = f(f64::mul_add(b, 0.1805, f64::mul_add(g, 0.3576, r * 0.4124)) / 95.047);
	let y = f(f64::mul_add(b, 0.0722, f64::mul_add(g, 0.7152, r * 0.2126)) / 100.0);
	let z = f(f64::mul_add(b, 0.9505, f64::mul_add(g, 0.1192, r * 0.0193)) / 108.883);
	Cielab { l: 116.0f64.mul_add(y, -16.0), a: 500.0 * (x - y), b: 200.0 * (y - z) }
}

/// The nearest of a terminal's colour cube plus grey ramp: `component`
/// holds the cube's `cube` levels followed by the greys. Returns the
/// winning `(r, g, b)` component indices (a grey has all three equal and
/// `>= cube`).
fn nearest(
	component: &[i32],
	cube: usize,
	red: i32,
	green: i32,
	blue: i32,
) -> (usize, usize, usize) {
	let orig = rgb_to_lab(red, green, blue);
	let mut best = -1.0;
	let mut win = (0, 0, 0);
	let mut consider = |r: usize, g: usize, b: usize| {
		let d = deltae(orig, rgb_to_lab(component[r], component[g], component[b]));
		if d < best || best < 0.0 {
			best = d;
			win = (r, g, b);
		}
	};
	for r in 0..component.len() {
		if r >= cube {
			// zsh advances the inner loops to the block of greys
			// (`g = b = r`): one candidate per grey.
			consider(r, r, r);
			continue;
		}
		for g in 0..cube {
			for b in 0..cube {
				consider(r, g, b);
			}
		}
	}
	win
}

/// zsh `mapRGBto88`.
fn map_rgb_to_88(red: i32, green: i32, blue: i32) -> i32 {
	const COMPONENT: [i32; 11] = [0, 0x8b, 0xcd, 0xff, 0x2e, 0x5c, 0x8b, 0xa2, 0xb9, 0xd0, 0xe7];
	let (r, g, b) = nearest(&COMPONENT, 4, red, green, blue);
	if r > 3 {
		77 + r as i32
	} else {
		16 + (r as i32 * 16) + (g as i32 * 4) + b as i32
	}
}

/// zsh `mapRGBto256`.
fn map_rgb_to_256(red: i32, green: i32, blue: i32) -> i32 {
	const COMPONENT: [i32; 30] = [
		0, 0x5f, 0x87, 0xaf, 0xd7, 0xff, 0x8, 0x12, 0x1c, 0x26, 0x30, 0x3a, 0x44, 0x4e, 0x58, 0x62,
		0x6c, 0x76, 0x80, 0x8a, 0x94, 0x9e, 0xa8, 0xb2, 0xbc, 0xc6, 0xd0, 0xda, 0xe4, 0xee,
	];
	let (r, g, b) = nearest(&COMPONENT, 6, red, green, blue);
	if r > 5 {
		226 + r as i32
	} else {
		16 + (r as i32 * 36) + (g as i32 * 6) + b as i32
	}
}

/// zsh/nearcolor's `get_color_attr` hook (`getnearestcolor`): for a
/// terminal of `tccolours` colours, the nearest palette index **plus one**
/// (so black, 0, differs from "no hook"), or -1 when the terminal has
/// neither 256 nor 88 colours (the caller then uses the true colour).
pub fn getnearestcolor(tccolours: i32, red: u32, green: u32, blue: u32) -> i32 {
	let c = |v: u32| i32::try_from(v).unwrap_or(i32::MAX);
	match tccolours {
		256 => map_rgb_to_256(c(red), c(green), c(blue)) + 1,
		88 => map_rgb_to_88(c(red), c(green), c(blue)) + 1,
		_ => -1,
	}
}

#[cfg(test)]
mod tests {
	//! Expected indices come from `TERM=xterm-256color` / `xterm-88color`
	//! `/bin/zsh -f -c 'zmodload zsh/nearcolor; print -P "%F{#RRGGBB}x"'`
	//! 5.9 (which prints the hook's value minus one).

	use super::getnearestcolor;

	#[test]
	fn nearest_colours_match_zsh() {
		for (rgb, c256, c88) in [
			(0xff8000, 208, 68),
			(0x000000, 16, 16),
			(0xffffff, 231, 79),
			(0x123456, 24, 81),
			(0x808080, 244, 37),
			(0xabcdef, 153, 43),
			(0x5f87af, 67, 22),
			(0xe4e4e4, 254, 87),
			(0x010203, 16, 16),
			(0xff0000, 196, 64),
		] {
			let (r, g, b) = (rgb >> 16, (rgb >> 8) & 0xff, rgb & 0xff);
			assert_eq!(getnearestcolor(256, r, g, b), c256 + 1, "{rgb:06x} in 256 colours");
			assert_eq!(getnearestcolor(88, r, g, b), c88 + 1, "{rgb:06x} in 88 colours");
		}
		assert_eq!(getnearestcolor(8, 255, 0, 0), -1);
		assert_eq!(getnearestcolor(16_777_216, 255, 0, 0), -1);
	}
}
