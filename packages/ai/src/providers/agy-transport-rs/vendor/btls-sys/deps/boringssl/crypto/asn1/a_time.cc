// Copyright 1999-2016 The OpenSSL Project Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include <openssl/asn1.h>
#include <openssl/posix_time.h>

#include <string.h>
#include <time.h>

#include <openssl/asn1t.h>
#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/mem.h>

#include "internal.h"

// This is an implementation of the ASN1 Time structure which is: Time ::=
// CHOICE { utcTime UTCTime, generalTime GeneralizedTime } written by Steve
// Henson.

IMPLEMENT_ASN1_MSTRING(ASN1_TIME, B_ASN1_TIME)

IMPLEMENT_ASN1_FUNCTIONS_const(ASN1_TIME)

ASN1_TIME *ASN1_TIME_set_posix(ASN1_TIME *s, int64_t posix_time) {
  return ASN1_TIME_adj(s, posix_time, 0, 0);
}

ASN1_TIME *ASN1_TIME_set(ASN1_TIME *s, time_t time) {
  return ASN1_TIME_adj(s, time, 0, 0);
}

static int fits_in_utc_time(const struct tm *tm) {
  return 50 <= tm->tm_year && tm->tm_year < 150;
}

ASN1_TIME *ASN1_TIME_adj(ASN1_TIME *s, int64_t posix_time, int offset_day,
                         long offset_sec) {
  struct tm tm;

  if (!OPENSSL_posix_to_tm(posix_time, &tm)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_ERROR_GETTING_TIME);
    return nullptr;
  }
  if (offset_day || offset_sec) {
    if (!OPENSSL_gmtime_adj(&tm, offset_day, offset_sec)) {
      return nullptr;
    }
  }
  if (fits_in_utc_time(&tm)) {
    return ASN1_UTCTIME_adj(s, posix_time, offset_day, offset_sec);
  }
  return ASN1_GENERALIZEDTIME_adj(s, posix_time, offset_day, offset_sec);
}

int ASN1_TIME_check(const ASN1_TIME *t) {
  if (t->type == V_ASN1_GENERALIZEDTIME) {
    return ASN1_GENERALIZEDTIME_check(t);
  } else if (t->type == V_ASN1_UTCTIME) {
    return ASN1_UTCTIME_check(t);
  }
  return 0;
}

// Convert an ASN1_TIME structure to GeneralizedTime
ASN1_GENERALIZEDTIME *ASN1_TIME_to_generalizedtime(const ASN1_TIME *in,
                                                   ASN1_GENERALIZEDTIME **out) {
  if (!ASN1_TIME_check(in)) {
    return nullptr;
  }

  ASN1_GENERALIZEDTIME *ret = nullptr;
  if (!out || !*out) {
    if (!(ret = ASN1_GENERALIZEDTIME_new())) {
      goto err;
    }
  } else {
    ret = *out;
  }

  // If already GeneralizedTime just copy across
  if (in->type == V_ASN1_GENERALIZEDTIME) {
    if (!ASN1_STRING_set(ret, in->data, in->length)) {
      goto err;
    }
    goto done;
  }

  // Grow the string to accommodate the two-digit century.
  if (!ASN1_STRING_set(ret, nullptr, in->length + 2)) {
    goto err;
  }

  {
    char *const out_str = (char *)ret->data;
    // |ASN1_STRING_set| also allocates an additional byte for a trailing NUL.
    const size_t out_str_capacity = in->length + 2 + 1;
    // Work out the century and prepend
    if (in->data[0] >= '5') {
      OPENSSL_strlcpy(out_str, "19", out_str_capacity);
    } else {
      OPENSSL_strlcpy(out_str, "20", out_str_capacity);
    }
    OPENSSL_strlcat(out_str, (const char *)in->data, out_str_capacity);
  }

done:
  if (out != nullptr && *out == nullptr) {
    *out = ret;
  }
  return ret;

err:
  if (out == nullptr || *out != ret) {
    ASN1_GENERALIZEDTIME_free(ret);
  }
  return nullptr;
}

int ASN1_TIME_set_string(ASN1_TIME *s, const char *str) {
  return ASN1_UTCTIME_set_string(s, str) ||
         ASN1_GENERALIZEDTIME_set_string(s, str);
}

int ASN1_TIME_set_string_X509(ASN1_TIME *s, const char *str) {
  CBS cbs;
  CBS_init(&cbs, (const uint8_t *)str, strlen(str));
  int type;
  struct tm tm;
  if (CBS_parse_utc_time(&cbs, /*out_tm=*/nullptr,
                         /*allow_timezone_offset=*/0)) {
    type = V_ASN1_UTCTIME;
  } else if (CBS_parse_generalized_time(&cbs, &tm,
                                        /*allow_timezone_offset=*/0)) {
    type = V_ASN1_GENERALIZEDTIME;
    if (fits_in_utc_time(&tm)) {
      type = V_ASN1_UTCTIME;
      CBS_skip(&cbs, 2);
    }
  } else {
    return 0;
  }

  if (s != nullptr) {
    if (!ASN1_STRING_set(s, CBS_data(&cbs), CBS_len(&cbs))) {
      return 0;
    }
    s->type = type;
  }
  return 1;
}

static int asn1_time_to_tm(struct tm *tm, const ASN1_TIME *t,
                           int allow_timezone_offset) {
  if (t == nullptr) {
    if (OPENSSL_posix_to_tm(time(nullptr), tm)) {
      return 1;
    }
    return 0;
  }

  if (t->type == V_ASN1_UTCTIME) {
    return asn1_utctime_to_tm(tm, t, allow_timezone_offset);
  } else if (t->type == V_ASN1_GENERALIZEDTIME) {
    return asn1_generalizedtime_to_tm(tm, t);
  }

  return 0;
}

int ASN1_TIME_diff(int *out_days, int *out_seconds, const ASN1_TIME *from,
                   const ASN1_TIME *to) {
  struct tm tm_from, tm_to;
  if (!asn1_time_to_tm(&tm_from, from, /*allow_timezone_offset=*/1)) {
    return 0;
  }
  if (!asn1_time_to_tm(&tm_to, to, /*allow_timezone_offset=*/1)) {
    return 0;
  }
  return OPENSSL_gmtime_diff(out_days, out_seconds, &tm_from, &tm_to);
}

int ASN1_TIME_to_posix_nonstandard(const ASN1_TIME *t, int64_t *out_time) {
  struct tm tm;
  if (!asn1_time_to_tm(&tm, t, /*allow_timezone_offset=*/1)) {
    return 0;
  }
  return OPENSSL_tm_to_posix(&tm, out_time);
}

// The functions below do *not* permissively allow the use of four digit
// timezone offsets in UTC times, as is done elsewhere in the code. They are
// both new API, and used internally to X509_cmp_time. This is to discourage the
// use of nonstandard times in new code, and to ensure that this code behaves
// correctly in X509_cmp_time which historically did its own time validations
// slightly different than the many other copies of X.509 time validation
// sprinkled through the codebase. The custom checks in X509_cmp_time meant that
// it did not allow four digit timezone offsets in UTC times.
int ASN1_TIME_to_time_t(const ASN1_TIME *t, time_t *out_time) {
  struct tm tm;
  if (!asn1_time_to_tm(&tm, t, /*allow_timezone_offset=*/0)) {
    return 0;
  }
  return OPENSSL_timegm(&tm, out_time);
}

int ASN1_TIME_to_posix(const ASN1_TIME *t, int64_t *out_time) {
  struct tm tm;
  if (!asn1_time_to_tm(&tm, t, /*allow_timezone_offset=*/0)) {
    return 0;
  }
  return OPENSSL_tm_to_posix(&tm, out_time);
}

int asn1_parse_time(CBS *cbs, ASN1_TIME *out, int allow_utc_timezone_offset) {
  if (CBS_peek_asn1_tag(cbs, CBS_ASN1_UTCTIME)) {
    return asn1_parse_utc_time(cbs, out, /*tag=*/0, allow_utc_timezone_offset);
  }
  return asn1_parse_generalized_time(cbs, out, /*tag=*/0);
}

int asn1_marshal_time(CBB *cbb, const ASN1_TIME *in) {
  if (in->type != V_ASN1_UTCTIME && in->type != V_ASN1_GENERALIZEDTIME) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_WRONG_TYPE);
    return 0;
  }
  return asn1_marshal_octet_string(cbb, in,
                                   static_cast<CBS_ASN1_TAG>(in->type));
}
