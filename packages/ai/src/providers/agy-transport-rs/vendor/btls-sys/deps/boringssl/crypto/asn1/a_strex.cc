// Copyright 2000-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <assert.h>
#include <ctype.h>
#include <inttypes.h>
#include <limits.h>
#include <string.h>
#include <time.h>

#include <openssl/bio.h>
#include <openssl/bytestring.h>
#include <openssl/mem.h>

#include "../bytestring/internal.h"
#include "../internal.h"
#include "internal.h"


#define ESC_FLAGS                                                           \
  (ASN1_STRFLGS_ESC_2253 | ASN1_STRFLGS_ESC_QUOTE | ASN1_STRFLGS_ESC_CTRL | \
   ASN1_STRFLGS_ESC_MSB)

static int maybe_write(BIO *out, const void *buf, int len) {
  // If |out| is NULL, ignore the output but report the length.
  return out == nullptr || BIO_write(out, buf, len) == len;
}

static int is_control_character(unsigned char c) { return c < 32 || c == 127; }

static int do_esc_char(uint32_t c, unsigned long flags, char *do_quotes,
                       BIO *out, int is_first, int is_last) {
  // |c| is a |uint32_t| because, depending on |ASN1_STRFLGS_UTF8_CONVERT|,
  // we may be escaping bytes or Unicode codepoints.
  char buf[16];  // Large enough for "\\W01234567".
  unsigned char u8 = (unsigned char)c;
  if (c > 0xffff) {
    snprintf(buf, sizeof(buf), "\\W%08" PRIX32, c);
  } else if (c > 0xff) {
    snprintf(buf, sizeof(buf), "\\U%04" PRIX32, c);
  } else if ((flags & ASN1_STRFLGS_ESC_MSB) && c > 0x7f) {
    snprintf(buf, sizeof(buf), "\\%02X", c);
  } else if ((flags & ASN1_STRFLGS_ESC_CTRL) && is_control_character(c)) {
    snprintf(buf, sizeof(buf), "\\%02X", c);
  } else if (flags & ASN1_STRFLGS_ESC_2253) {
    // See RFC 2253, sections 2.4 and 4.
    if (c == '\\' || c == '"') {
      // Quotes and backslashes are always escaped, quoted or not.
      snprintf(buf, sizeof(buf), "\\%c", (int)c);
    } else if (c == ',' || c == '+' || c == '<' || c == '>' || c == ';' ||
               (is_first && (c == ' ' || c == '#')) ||
               (is_last && (c == ' '))) {
      if (flags & ASN1_STRFLGS_ESC_QUOTE) {
        // No need to escape, just tell the caller to quote.
        if (do_quotes != nullptr) {
          *do_quotes = 1;
        }
        return maybe_write(out, &u8, 1) ? 1 : -1;
      }
      snprintf(buf, sizeof(buf), "\\%c", (int)c);
    } else {
      return maybe_write(out, &u8, 1) ? 1 : -1;
    }
  } else if ((flags & ESC_FLAGS) && c == '\\') {
    // If any escape flags are set, also escape backslashes.
    snprintf(buf, sizeof(buf), "\\%c", (int)c);
  } else {
    return maybe_write(out, &u8, 1) ? 1 : -1;
  }

  static_assert(sizeof(buf) < INT_MAX, "len may not fit in int");
  int len = (int)strlen(buf);
  return maybe_write(out, buf, len) ? len : -1;
}

// This function sends each character in a buffer to do_esc_char(). It
// interprets the content formats and converts to or from UTF8 as
// appropriate.

static int do_buf(const unsigned char *buf, int buflen, int encoding,
                  unsigned long flags, char *quotes, BIO *out) {
  int (*get_char)(CBS *cbs, uint32_t *out);
  int get_char_error;
  switch (encoding) {
    case MBSTRING_UNIV:
      get_char = CBS_get_utf32_be;
      get_char_error = ASN1_R_INVALID_UNIVERSALSTRING;
      break;
    case MBSTRING_BMP:
      get_char = CBS_get_ucs2_be;
      get_char_error = ASN1_R_INVALID_BMPSTRING;
      break;
    case MBSTRING_ASC:
      get_char = CBS_get_latin1;
      get_char_error = ERR_R_INTERNAL_ERROR;  // Should not be possible.
      break;
    case MBSTRING_UTF8:
      get_char = CBS_get_utf8;
      get_char_error = ASN1_R_INVALID_UTF8STRING;
      break;
    default:
      assert(0);
      return -1;
  }

  CBS cbs;
  CBS_init(&cbs, buf, buflen);
  int outlen = 0;
  while (CBS_len(&cbs) != 0) {
    const int is_first = CBS_data(&cbs) == buf;
    uint32_t c;
    if (!get_char(&cbs, &c)) {
      OPENSSL_PUT_ERROR(ASN1, get_char_error);
      return -1;
    }
    const int is_last = CBS_len(&cbs) == 0;
    if (flags & ASN1_STRFLGS_UTF8_CONVERT) {
      uint8_t utf8_buf[6];
      CBB utf8_cbb;
      CBB_init_fixed(&utf8_cbb, utf8_buf, sizeof(utf8_buf));
      if (!CBB_add_utf8(&utf8_cbb, c)) {
        OPENSSL_PUT_ERROR(ASN1, ERR_R_INTERNAL_ERROR);
        return 1;
      }
      size_t utf8_len = CBB_len(&utf8_cbb);
      for (size_t i = 0; i < utf8_len; i++) {
        int len = do_esc_char(utf8_buf[i], flags, quotes, out,
                              is_first && i == 0, is_last && i == utf8_len - 1);
        if (len < 0) {
          return -1;
        }
        outlen += len;
      }
    } else {
      int len = do_esc_char(c, flags, quotes, out, is_first, is_last);
      if (len < 0) {
        return -1;
      }
      outlen += len;
    }
  }
  return outlen;
}

// This function hex dumps a buffer of characters

static int do_hex_dump(BIO *out, unsigned char *buf, int buflen) {
  static const char hexdig[] = "0123456789ABCDEF";
  unsigned char *p, *q;
  char hextmp[2];
  if (out) {
    p = buf;
    q = buf + buflen;
    while (p != q) {
      hextmp[0] = hexdig[*p >> 4];
      hextmp[1] = hexdig[*p & 0xf];
      if (!maybe_write(out, hextmp, 2)) {
        return -1;
      }
      p++;
    }
  }
  return buflen << 1;
}

// "dump" a string. This is done when the type is unknown, or the flags
// request it. We can either dump the content octets or the entire DER
// encoding. This uses the RFC 2253 #01234 format.

static int do_dump(unsigned long flags, BIO *out, const ASN1_STRING *str) {
  if (!maybe_write(out, "#", 1)) {
    return -1;
  }

  // If we don't dump DER encoding just dump content octets
  if (!(flags & ASN1_STRFLGS_DUMP_DER)) {
    int outlen = do_hex_dump(out, str->data, str->length);
    if (outlen < 0) {
      return -1;
    }
    return outlen + 1;
  }

  // Placing the ASN1_STRING in a temporary ASN1_TYPE allows the DER encoding
  // to readily obtained.
  ASN1_TYPE t;
  OPENSSL_memset(&t, 0, sizeof(ASN1_TYPE));
  asn1_type_set0_string(&t, (ASN1_STRING *)str);
  unsigned char *der_buf = nullptr;
  int der_len = i2d_ASN1_TYPE(&t, &der_buf);
  if (der_len < 0) {
    return -1;
  }
  int outlen = do_hex_dump(out, der_buf, der_len);
  OPENSSL_free(der_buf);
  if (outlen < 0) {
    return -1;
  }
  return outlen + 1;
}

// string_type_to_encoding returns the |MBSTRING_*| constant for the encoding
// used by the |ASN1_STRING| type |type|, or -1 if |tag| is not a string
// type.
static int string_type_to_encoding(int type) {
  // This function is sometimes passed ASN.1 universal types and sometimes
  // passed |ASN1_STRING| type values
  switch (type) {
    case V_ASN1_UTF8STRING:
      return MBSTRING_UTF8;
    case V_ASN1_NUMERICSTRING:
    case V_ASN1_PRINTABLESTRING:
    case V_ASN1_T61STRING:
    case V_ASN1_IA5STRING:
    case V_ASN1_UTCTIME:
    case V_ASN1_GENERALIZEDTIME:
    case V_ASN1_ISO64STRING:
      // |MBSTRING_ASC| refers to Latin-1, not ASCII.
      return MBSTRING_ASC;
    case V_ASN1_UNIVERSALSTRING:
      return MBSTRING_UNIV;
    case V_ASN1_BMPSTRING:
      return MBSTRING_BMP;
  }
  return -1;
}

// This is the main function, print out an ASN1_STRING taking note of various
// escape and display options. Returns number of characters written or -1 if
// an error occurred.

int ASN1_STRING_print_ex(BIO *out, const ASN1_STRING *str,
                         unsigned long flags) {
  int type = str->type;
  int outlen = 0;
  if (flags & ASN1_STRFLGS_SHOW_TYPE) {
    const char *tagname = ASN1_tag2str(type);
    outlen += strlen(tagname);
    if (!maybe_write(out, tagname, outlen) || !maybe_write(out, ":", 1)) {
      return -1;
    }
    outlen++;
  }

  // Decide what to do with |str|, either dump the contents or display it.
  int encoding;
  if (flags & ASN1_STRFLGS_DUMP_ALL) {
    // Dump everything.
    encoding = -1;
  } else if (flags & ASN1_STRFLGS_IGNORE_TYPE) {
    // Ignore the string type and interpret the contents as Latin-1.
    encoding = MBSTRING_ASC;
  } else {
    encoding = string_type_to_encoding(type);
    if (encoding == -1 && (flags & ASN1_STRFLGS_DUMP_UNKNOWN) == 0) {
      encoding = MBSTRING_ASC;
    }
  }

  if (encoding == -1) {
    int len = do_dump(flags, out, str);
    if (len < 0) {
      return -1;
    }
    outlen += len;
    return outlen;
  }

  // Measure the length.
  char quotes = 0;
  int len = do_buf(str->data, str->length, encoding, flags, &quotes, nullptr);
  if (len < 0) {
    return -1;
  }
  outlen += len;
  if (quotes) {
    outlen += 2;
  }
  if (!out) {
    return outlen;
  }

  // Encode the value.
  if ((quotes && !maybe_write(out, "\"", 1)) ||
      do_buf(str->data, str->length, encoding, flags, nullptr, out) < 0 ||
      (quotes && !maybe_write(out, "\"", 1))) {
    return -1;
  }
  return outlen;
}

int ASN1_STRING_print_ex_fp(FILE *fp, const ASN1_STRING *str,
                            unsigned long flags) {
  BIO *bio = nullptr;
  if (fp != nullptr) {
    // If |fp| is NULL, this function returns the number of bytes without
    // writing.
    bio = BIO_new_fp(fp, BIO_NOCLOSE);
    if (bio == nullptr) {
      return -1;
    }
  }
  int ret = ASN1_STRING_print_ex(bio, str, flags);
  BIO_free(bio);
  return ret;
}

int ASN1_STRING_to_UTF8(unsigned char **out, const ASN1_STRING *in) {
  if (!in) {
    return -1;
  }
  int mbflag = string_type_to_encoding(in->type);
  if (mbflag == -1) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_UNKNOWN_TAG);
    return -1;
  }
  ASN1_STRING stmp, *str = &stmp;
  stmp.data = nullptr;
  stmp.length = 0;
  stmp.flags = 0;
  int ret =
      ASN1_mbstring_copy(&str, in->data, in->length, mbflag, B_ASN1_UTF8STRING);
  if (ret < 0) {
    return ret;
  }
  *out = stmp.data;
  return stmp.length;
}

int ASN1_STRING_print(BIO *bp, const ASN1_STRING *v) {
  int i, n;
  char buf[80];
  const char *p;

  if (v == nullptr) {
    return 0;
  }
  n = 0;
  p = (const char *)v->data;
  for (i = 0; i < v->length; i++) {
    if ((p[i] > '~') || ((p[i] < ' ') && (p[i] != '\n') && (p[i] != '\r'))) {
      buf[n] = '.';
    } else {
      buf[n] = p[i];
    }
    n++;
    if (n >= 80) {
      if (BIO_write(bp, buf, n) <= 0) {
        return 0;
      }
      n = 0;
    }
  }
  if (n > 0) {
    if (BIO_write(bp, buf, n) <= 0) {
      return 0;
    }
  }
  return 1;
}

int ASN1_TIME_print(BIO *bp, const ASN1_TIME *tm) {
  if (tm->type == V_ASN1_UTCTIME) {
    return ASN1_UTCTIME_print(bp, tm);
  }
  if (tm->type == V_ASN1_GENERALIZEDTIME) {
    return ASN1_GENERALIZEDTIME_print(bp, tm);
  }
  BIO_puts(bp, "Bad time value");
  return 0;
}

static const char *const mon[12] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};

int ASN1_GENERALIZEDTIME_print(BIO *bp, const ASN1_GENERALIZEDTIME *tm) {
  CBS cbs;
  CBS_init(&cbs, tm->data, tm->length);
  struct tm utc;
  if (!CBS_parse_generalized_time(&cbs, &utc, /*allow_timezone_offset=*/0)) {
    BIO_puts(bp, "Bad time value");
    return 0;
  }

  return BIO_printf(bp, "%s %2d %02d:%02d:%02d %d GMT", mon[utc.tm_mon],
                    utc.tm_mday, utc.tm_hour, utc.tm_min, utc.tm_sec,
                    utc.tm_year + 1900) > 0;
}

int ASN1_UTCTIME_print(BIO *bp, const ASN1_UTCTIME *tm) {
  CBS cbs;
  CBS_init(&cbs, tm->data, tm->length);
  struct tm utc;
  if (!CBS_parse_utc_time(&cbs, &utc, /*allow_timezone_offset=*/0)) {
    BIO_puts(bp, "Bad time value");
    return 0;
  }

  return BIO_printf(bp, "%s %2d %02d:%02d:%02d %d GMT", mon[utc.tm_mon],
                    utc.tm_mday, utc.tm_hour, utc.tm_min, utc.tm_sec,
                    utc.tm_year + 1900) > 0;
}
