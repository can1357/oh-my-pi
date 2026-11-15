macro_rules! set_bool {
    ($cfg:expr, $field:ident, $conn:expr, $setter:ident) => {
        if $cfg.$field {
            $conn.$setter();
        }
    };
    ($cfg:expr, !$field:ident, $conn:expr, $setter:ident, $arg:expr) => {
        if !$cfg.$field {
            $conn.$setter($arg);
        }
    };
}

macro_rules! set_option {
    ($cfg:expr, $field:ident, $conn:expr, $setter:ident) => {
        if let Some(val) = $cfg.$field {
            $conn.$setter(val);
        }
    };
}

macro_rules! set_option_ref_try {
    ($cfg:expr, $field:ident, $conn:expr, $setter:ident) => {
        if let Some(val) = $cfg.$field.as_ref() {
            $conn.$setter(val).map_err(Error::tls)?;
        }
    };
}

macro_rules! set_option_inner_try {
    ($field:ident, $conn:expr, $setter:ident) => {
        $conn.$setter($field.map(|v| v.0)).map_err(Error::tls)?;
    };
}
