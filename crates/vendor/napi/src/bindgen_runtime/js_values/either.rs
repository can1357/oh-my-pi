use super::{FromNapiValue, ToNapiValue, TypeName, ValidateNapiValue};
use crate::{
  bindgen_runtime::{Null, Undefined, Unknown},
  check_status, sys, Error, JsValue, Status, ValueType,
};

impl<T> From<Option<T>> for Either<T, Undefined> {
  fn from(value: Option<T>) -> Self {
    match value {
      Some(v) => Either::A(v),
      None => Either::B(()),
    }
  }
}

impl<T> From<Either<T, Null>> for Option<T> {
  fn from(value: Either<T, Null>) -> Option<T> {
    match value {
      Either::A(v) => Some(v),
      Either::B(_) => None,
    }
  }
}

macro_rules! either_n {
  ( $either_name:ident, $( $parameter:ident ),+ $( , )* ) => {
    #[derive(Debug, Clone, Copy)]
    pub enum $either_name< $( $parameter ),+ > {
      $( $parameter ( $parameter ) ),+
    }

    impl< $( $parameter ),+ > TypeName for $either_name < $( $parameter ),+ >
      where $( $parameter: TypeName ),+
    {
      fn type_name() -> &'static str {
        stringify!( $either_name )
      }

      fn value_type() -> ValueType {
        ValueType::Unknown
      }
    }

    impl< $( $parameter ),+ > FromNapiValue for $either_name < $( $parameter ),+ >
      where $( $parameter: TypeName + FromNapiValue + ValidateNapiValue ),+
    {
      unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> crate::Result<Self> {
        #[allow(unused_assignments)]
        let mut ret = Err(Error::new(Status::InvalidArg, "Invalid value".to_owned()));
        $(
          if unsafe {
            match $parameter::validate(env, napi_val) {
              Ok(maybe_rejected_promise) => {
                if maybe_rejected_promise.is_null() {
                  true
                } else {
                  silence_rejected_promise(env, maybe_rejected_promise)?;
                  false
                }
              },
              Err(_) => false
            }
          } && unsafe { { ret = $parameter ::from_napi_value(env, napi_val).map(Self:: $parameter ); ret.is_ok() } } {
            ret
          } else
        )+
        {
          Err(crate::Error::new(
            Status::InvalidArg,
            format!(
              concat!("Value is none of these types ", $( "`{", stringify!( $parameter ), "}`, " ),+ ),
              $( $parameter = $parameter::type_name(), )+
            ),
          ))
        }
      }
    }

    impl< $( $parameter ),+ > ToNapiValue for $either_name < $( $parameter ),+ >
      where $( $parameter: ToNapiValue ),+
    {
      unsafe fn to_napi_value(
        env: sys::napi_env,
        value: Self
      ) -> crate::Result<crate::sys::napi_value> {
        match value {
          $( Self:: $parameter (v) => unsafe { $parameter ::to_napi_value(env, v) } ),+
        }
      }
    }

    impl< $( $parameter ),+ > ValidateNapiValue for $either_name < $( $parameter ),+ >
      where $( $parameter: ValidateNapiValue ),+
    {
      unsafe fn validate(
        env: sys::napi_env,
        napi_val: sys::napi_value,
      ) -> crate::Result<sys::napi_value> {
        let mut ret: crate::Result<sys::napi_value>;
        $(
          if unsafe {
            ret = $parameter::validate(env, napi_val);
            if let Ok(maybe_rejected_promise) = ret.as_ref() {
              if maybe_rejected_promise.is_null() {
                true
              } else {
                silence_rejected_promise(env, *maybe_rejected_promise)?;
                false
              }
            } else {
              false
            }
          } {
            ret
          } else
        )+
        {
          ret
        }
      }
    }

    impl<Data, $( $parameter: AsRef<Data> ),+ > AsRef<Data> for $either_name < $( $parameter ),+ >
      where Data: ?Sized,
    {
      fn as_ref(&self) -> &Data {
        match &self {
          $( Self:: $parameter (v) => v.as_ref() ),+
        }
      }
    }

    impl<'env, $( $parameter ),+ > $either_name < $( $parameter ),+ >
      where $( $parameter: JsValue<'env> ),+
    {
      pub fn as_unknown(&self) -> Unknown<'env> {
        match &self {
          $( Self:: $parameter (v) => v.to_unknown() ),+
        }
      }
    }

    #[cfg(feature = "serde-json")]
    impl< $( $parameter: serde::Serialize ),+ > serde::Serialize for $either_name< $( $parameter ),+ > {
      fn serialize<Ser>(&self, serializer: Ser) -> Result<Ser::Ok, Ser::Error>
      where
        Ser: serde::Serializer
      {
        match &self {
          $( Self:: $parameter (v) => serializer.serialize_some(v) ),+
        }
      }
    }
  };
}

either_n!(Either, A, B);
either_n!(Either3, A, B, C);
either_n!(Either4, A, B, C, D);
either_n!(Either5, A, B, C, D, E);
either_n!(Either6, A, B, C, D, E, F);
either_n!(Either7, A, B, C, D, E, F, G);
either_n!(Either8, A, B, C, D, E, F, G, H);
either_n!(Either9, A, B, C, D, E, F, G, H, I);
either_n!(Either10, A, B, C, D, E, F, G, H, I, J);
either_n!(Either11, A, B, C, D, E, F, G, H, I, J, K);
either_n!(Either12, A, B, C, D, E, F, G, H, I, J, K, L);
either_n!(Either13, A, B, C, D, E, F, G, H, I, J, K, L, M);
either_n!(Either14, A, B, C, D, E, F, G, H, I, J, K, L, M, N);
either_n!(Either15, A, B, C, D, E, F, G, H, I, J, K, L, M, N, O);
either_n!(Either16, A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P);
either_n!(Either17, A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q);
either_n!(Either18, A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R);
either_n!(Either19, A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S);
either_n!(Either20, A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T);
either_n!(Either21, A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U);
either_n!(Either22, A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V);
either_n!(Either23, A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W);
either_n!(Either24, A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W, X);
either_n!(Either25, A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W, X, Y);
either_n!(Either26, A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W, X, Y, Z);

fn silence_rejected_promise(env: sys::napi_env, promise: sys::napi_value) -> crate::Result<()> {
  let mut catch_method = std::ptr::null_mut();
  check_status!(unsafe {
    sys::napi_get_named_property(env, promise, c"catch".as_ptr().cast(), &mut catch_method)
  })?;
  let mut catch_noop_callback = std::ptr::null_mut();
  check_status!(unsafe {
    sys::napi_create_function(
      env,
      c"catch".as_ptr().cast(),
      5,
      Some(noop),
      std::ptr::null_mut(),
      &mut catch_noop_callback,
    )
  })?;
  check_status!(unsafe {
    sys::napi_call_function(
      env,
      promise,
      catch_method,
      1,
      vec![catch_noop_callback].as_ptr().cast(),
      std::ptr::null_mut(),
    )
  })?;
  Ok(())
}

unsafe extern "C" fn noop(_env: sys::napi_env, _info: sys::napi_callback_info) -> sys::napi_value {
  std::ptr::null_mut()
}
