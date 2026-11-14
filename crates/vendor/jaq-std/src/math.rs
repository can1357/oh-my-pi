//! jq's math builtins (`src/libm.h`, `LIBM_DD`, `LIBM_DDD`, `LIBM_DDDD`, `LIBM_DA`).
//!
//! Every argument must be a number (`<value> number required`), and every
//! result is a floating-point number. jq's reference build is macOS, where
//! `gamma` is `tgamma`, `drem` is `remainder` and `significand(x)` is
//! `2*frexp(x)`. The functions jq takes from the C library come from `libm`,
//! which may differ from a platform's C library in the last digit.
use crate::{ValT, ValTx};
use alloc::boxed::Box;
use jaq_core::native::{bome, v, Filter};
use jaq_core::{DataT, RunPtr};

mod c {
    pub use libm::{
        acosh, asinh, atanh, cbrt, erf, erfc, exp10, expm1, fdim, fma, fmax, fmin, fmod, frexp,
        j0, j1, jn, ldexp, lgamma, lgamma_r, log1p, modf, nextafter, remainder, rint, scalbn,
        tgamma, y0, y1, yn,
    };
    pub use libm::rint as nearbyint;

    pub fn logb(x: f64) -> f64 {
        if x == 0.0 {
            f64::NEG_INFINITY
        } else if x.is_infinite() {
            f64::INFINITY
        } else if x.is_nan() {
            x
        } else {
            libm::ilogb(x) as f64
        }
    }
}

/// A 0-ary filter from a function on its input.
macro_rules! dd {
    ($name: literal, $f: expr) => {
        ($name, v(0), |cv| bome(cv.1.num().map(|x| D::V::from($f(x)))))
    };
}

/// A 2-ary filter that ignores its input.
macro_rules! ddd {
    ($name: literal, $f: expr) => {
        ($name, v(2), |mut cv| {
            let b = cv.0.pop_var();
            let a = cv.0.pop_var();
            bome(a.num().and_then(|a| Ok(D::V::from($f(a, b.num()?)))))
        })
    };
}

/// A 0-ary filter returning a pair.
macro_rules! da {
    ($name: literal, $f: expr) => {
        ($name, v(0), |cv| {
            bome(cv.1.num().map(|x| {
                let (a, b) = $f(x);
                [D::V::from(a), D::V::from(b as f64)].into_iter().collect()
            }))
        })
    };
}

/// C's conversion of a double to an int argument (saturating where C is undefined).
fn int(x: f64) -> i32 {
    x as i32
}

fn significand(x: f64) -> f64 {
    2.0 * c::frexp(x).0
}

pub fn funs<D: DataT>() -> Box<[Filter<RunPtr<D>>]>
where
    for<'a> D::V<'a>: ValT,
{
    Box::new([
        dd!("acos", f64::acos),
        dd!("acosh", c::acosh),
        dd!("asin", f64::asin),
        dd!("asinh", c::asinh),
        dd!("atan", f64::atan),
        dd!("atanh", c::atanh),
        dd!("cbrt", c::cbrt),
        dd!("ceil", f64::ceil),
        dd!("cos", f64::cos),
        dd!("cosh", f64::cosh),
        dd!("erf", c::erf),
        dd!("erfc", c::erfc),
        dd!("exp", f64::exp),
        dd!("exp10", c::exp10),
        dd!("exp2", f64::exp2),
        dd!("expm1", c::expm1),
        dd!("fabs", f64::abs),
        dd!("floor", f64::floor),
        dd!("gamma", c::tgamma),
        dd!("j0", c::j0),
        dd!("j1", c::j1),
        dd!("lgamma", c::lgamma),
        dd!("log", f64::ln),
        dd!("log10", f64::log10),
        dd!("log1p", c::log1p),
        dd!("log2", f64::log2),
        dd!("logb", c::logb),
        dd!("nearbyint", c::nearbyint),
        dd!("rint", c::rint),
        dd!("round", f64::round),
        dd!("significand", significand),
        dd!("sin", f64::sin),
        dd!("sinh", f64::sinh),
        dd!("sqrt", f64::sqrt),
        dd!("tan", f64::tan),
        dd!("tanh", f64::tanh),
        dd!("tgamma", c::tgamma),
        dd!("trunc", f64::trunc),
        dd!("y0", c::y0),
        dd!("y1", c::y1),
        ddd!("atan2", f64::atan2),
        ddd!("copysign", f64::copysign),
        ddd!("drem", c::remainder),
        ddd!("fdim", c::fdim),
        ddd!("fmax", c::fmax),
        ddd!("fmin", c::fmin),
        ddd!("fmod", c::fmod),
        ddd!("hypot", f64::hypot),
        ddd!("jn", |a, b| c::jn(int(a), b)),
        ddd!("ldexp", |a, b| c::ldexp(a, int(b))),
        ddd!("nextafter", c::nextafter),
        ddd!("nexttoward", c::nextafter),
        ddd!("pow", f64::powf),
        ddd!("remainder", c::remainder),
        ddd!("scalb", |a, b| c::scalbn(a, int(b))),
        ddd!("scalbln", |a, b| c::scalbn(a, int(b))),
        ddd!("yn", |a, b| c::yn(int(a), b)),
        ("fma", v(3), |mut cv| {
            let z = cv.0.pop_var();
            let b = cv.0.pop_var();
            let a = cv.0.pop_var();
            bome((|| Ok(D::V::from(c::fma(a.num()?, b.num()?, z.num()?))))())
        }),
        da!("frexp", c::frexp),
        da!("modf", c::modf),
        da!("lgamma_r", c::lgamma_r),
    ])
}
