// Copyright 2005-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#ifndef OPENSSL_HEADER_CRYPTO_ASN1_INTERNAL_H
#define OPENSSL_HEADER_CRYPTO_ASN1_INTERNAL_H

#include <time.h>

#include <openssl/asn1.h>
#include <openssl/asn1t.h>

#if defined(__cplusplus)
extern "C" {
#endif


// Wrapper functions for time functions.

// OPENSSL_gmtime converts a time_t value in |time| which must be in the range
// of year 0000 to 9999 to a broken out time value in |tm|. On success |tm| is
// returned. On failure NULL is returned.
OPENSSL_EXPORT struct tm *OPENSSL_gmtime(const time_t *time, struct tm *result);

// OPENSSL_gmtime_adj returns one on success, and updates |tm| by adding
// |offset_day| days and |offset_sec| seconds. It returns zero on failure. |tm|
// must be in the range of year 0000 to 9999 both before and after the update or
// a failure will be returned.
OPENSSL_EXPORT int OPENSSL_gmtime_adj(struct tm *tm, int offset_day,
                                      int64_t offset_sec);

// OPENSSL_gmtime_diff calculates the difference between |from| and |to|. It
// returns one, and outputs the difference as a number of days and seconds in
// |*out_days| and |*out_secs| on success. It returns zero on failure.  Both
// |from| and |to| must be in the range of year 0000 to 9999 or a failure will
// be returned.
OPENSSL_EXPORT int OPENSSL_gmtime_diff(int *out_days, int *out_secs,
                                       const struct tm *from,
                                       const struct tm *to);


// Object identifiers.

// These are used internally in the ASN1_OBJECT to keep track of
// whether the names and data need to be free()ed
#define ASN1_OBJECT_FLAG_DYNAMIC 0x01          // internal use
#define ASN1_OBJECT_FLAG_DYNAMIC_STRINGS 0x04  // internal use
#define ASN1_OBJECT_FLAG_DYNAMIC_DATA 0x08     // internal use

// An asn1_object_st (aka |ASN1_OBJECT|) represents an ASN.1 OBJECT IDENTIFIER.
// Note: Mutating an |ASN1_OBJECT| is only permitted when initializing it. The
// library maintains a table of static |ASN1_OBJECT|s, which may be referenced
// by non-const |ASN1_OBJECT| pointers. Code which receives an |ASN1_OBJECT|
// pointer externally must assume it is immutable, even if the pointer is not
// const.
struct asn1_object_st {
  const char *sn, *ln;
  int nid;
  int length;
  const unsigned char *data;  // data remains const after init
  int flags;                  // Should we free this one
};

ASN1_OBJECT *ASN1_OBJECT_new(void);

// asn1_parse_object parses a DER-encoded ASN.1 OBJECT IDENTIFIER from |cbs| and
// write the result to |out|. If |tag| is non-zero, the value is implicitly
// tagged with |tag|. On success, it returns a newly-allocated |ASN1_OBJECT|
// with the result and advances |cbs| past the parsed element.
//
// TODO(crbug.com/boringssl/414361735): This should return a bssl::UniquePtr,
// but cannot until it is made C++ linkage.
ASN1_OBJECT *asn1_parse_object(CBS *cbs, CBS_ASN1_TAG tag);

// asn1_marshal_object marshals |in| as a DER-encoded, ASN.1 OBJECT IDENTIFIER
// and writes the result to |out|. It returns one on success and zero on error.
// If |tag| is non-zero, the tag is replaced with |tag|.
int asn1_marshal_object(CBB *out, const ASN1_OBJECT *in, CBS_ASN1_TAG tag);


// Strings.

// asn1_is_printable returns one if |value| is a valid Unicode codepoint for an
// ASN.1 PrintableString, and zero otherwise.
int asn1_is_printable(uint32_t value);

// asn1_string_init initializes |str|, which may be uninitialized, with type
// |type|.
void asn1_string_init(ASN1_STRING *str, int type);

// asn1_string_cleanup releases memory associated with |str|'s value, without
// freeing |str| itself.
void asn1_string_cleanup(ASN1_STRING *str);

// asn1_bit_string_length returns the number of bytes in |str| and sets
// |*out_padding_bits| to the number of padding bits.
//
// This function should be used instead of |ASN1_STRING_length| to correctly
// handle the non-|ASN1_STRING_FLAG_BITS_LEFT| case.
int asn1_bit_string_length(const ASN1_BIT_STRING *str,
                           uint8_t *out_padding_bits);

// The following functions parse a DER-encoded ASN.1 value of the specified
// type from |cbs| and write the result to |*out|. If |tag| is non-zero, the
// value is implicitly tagged with |tag|. On success, they return one and
// advance |cbs| past the parsed element. On entry, |*out| must contain an
// |ASN1_STRING| in some valid state.
int asn1_parse_bit_string(CBS *cbs, ASN1_BIT_STRING *out, CBS_ASN1_TAG tag);
int asn1_parse_integer(CBS *cbs, ASN1_INTEGER *out, CBS_ASN1_TAG tag);
int asn1_parse_enumerated(CBS *cbs, ASN1_ENUMERATED *out, CBS_ASN1_TAG tag);
int asn1_parse_octet_string(CBS *cbs, ASN1_STRING *out, CBS_ASN1_TAG tag);
int asn1_parse_bmp_string(CBS *cbs, ASN1_BMPSTRING *out, CBS_ASN1_TAG tag);
int asn1_parse_universal_string(CBS *cbs, ASN1_UNIVERSALSTRING *out,
                                CBS_ASN1_TAG tag);
int asn1_parse_utf8_string(CBS *cbs, ASN1_UNIVERSALSTRING *out,
                           CBS_ASN1_TAG tag);
int asn1_parse_generalized_time(CBS *cbs, ASN1_GENERALIZEDTIME *out,
                                CBS_ASN1_TAG tag);
int asn1_parse_utc_time(CBS *cbs, ASN1_UTCTIME *out, CBS_ASN1_TAG tag,
                        int allow_timezone_offset);

// asn1_parse_bit_string_with_bad_length behaves like |asn1_parse_bit_string|
// but tolerates BER non-minimal, definite lengths.
int asn1_parse_bit_string_with_bad_length(CBS *cbs, ASN1_BIT_STRING *out);

// asn1_marshal_bit_string marshals |in| as a DER-encoded, ASN.1 BIT STRING and
// writes the result to |out|. It returns one on success and zero on error. If
// |tag| is non-zero, the tag is replaced with |tag|.
int asn1_marshal_bit_string(CBB *out, const ASN1_BIT_STRING *in,
                            CBS_ASN1_TAG tag);

// asn1_marshal_integer marshals |in| as a DER-encoded, ASN.1 INTEGER and writes
// the result to |out|. It returns one on success and zero on error. If |tag| is
// non-zero, the tag is replaced with |tag|. This can also be used to marshal an
// ASN.1 ENUMERATED value by overriding the tag.
int asn1_marshal_integer(CBB *out, const ASN1_INTEGER *in, CBS_ASN1_TAG tag);

// asn1_marshal_octet_string marshals |in| as a DER-encoded, ASN.1 OCTET STRING
// and writes the result to |out|. It returns one on success and zero on error.
// If |tag| is non-zero, the tag is replaced with |tag|.
//
// This function may be used to marshal other string-based universal types whose
// encoding is that of an implicitly-tagged OCTET STRING, e.g. UTF8String.
int asn1_marshal_octet_string(CBB *out, const ASN1_STRING *in,
                              CBS_ASN1_TAG tag);

OPENSSL_EXPORT int asn1_utctime_to_tm(struct tm *tm, const ASN1_UTCTIME *d,
                                      int allow_timezone_offset);
OPENSSL_EXPORT int asn1_generalizedtime_to_tm(struct tm *tm,
                                              const ASN1_GENERALIZEDTIME *d);

int asn1_parse_time(CBS *cbs, ASN1_TIME *out, int allow_utc_timezone_offset);
int asn1_marshal_time(CBB *cbb, const ASN1_TIME *in);


// The ASN.1 ANY type.

// asn1_type_value_as_pointer returns |a|'s value in pointer form. This is
// usually the value object but, for BOOLEAN values, is 0 or 0xff cast to
// a pointer.
const void *asn1_type_value_as_pointer(const ASN1_TYPE *a);

// asn1_type_set0_string sets |a|'s value to the object represented by |str| and
// takes ownership of |str|.
void asn1_type_set0_string(ASN1_TYPE *a, ASN1_STRING *str);

// asn1_type_cleanup releases memory associated with |a|'s value, without
// freeing |a| itself.
void asn1_type_cleanup(ASN1_TYPE *a);

// asn1_parse_any parses a DER-encoded ASN.1 value of any type from |cbs| and
// writes the result to |*out|. On success, it advances |cbs| past the parsed
// element and returns one. On entry, |*out| must contain an |ASN1_TYPE| in some
// valid state.
int asn1_parse_any(CBS *cbs, ASN1_TYPE *out);

// asn1_parse_any_as_string behaves like |asn1_parse_any| but represents the
// value as an |ASN1_STRING|. Types which are not represented with
// |ASN1_STRING|, such as |ASN1_OBJECT|, are represented with type
// |V_ASN1_OTHER|.
int asn1_parse_any_as_string(CBS *cbs, ASN1_STRING *out);

// asn1_marshal_any marshals |in| as a DER-encoded ASN.1 value and writes the
// result to |out|. It returns one on success and zeron on error.
int asn1_marshal_any(CBB *out, const ASN1_TYPE *in);

// asn1_marshal_any_string marshals |in| as a DER-encoded ASN.1 value and writes
// the result to |out|. It returns one on success and zeron on error.
int asn1_marshal_any_string(CBB *out, const ASN1_STRING *in);


// Support structures for the template-based encoder.

// ASN1_ENCODING is used to save the received encoding of an ASN.1 type. This
// avoids problems with invalid encodings that break signatures.
typedef struct ASN1_ENCODING_st {
  // enc is the saved DER encoding. Its ownership is determined by |buf|.
  uint8_t *enc;
  // len is the length of |enc|. If zero, there is no saved encoding.
  size_t len;
} ASN1_ENCODING;

int ASN1_item_ex_new(ASN1_VALUE **pval, const ASN1_ITEM *it);
void ASN1_item_ex_free(ASN1_VALUE **pval, const ASN1_ITEM *it);

void ASN1_template_free(ASN1_VALUE **pval, const ASN1_TEMPLATE *tt);

// ASN1_item_ex_d2i parses |len| bytes from |*in| as a structure of type |it|
// and writes the result to |*pval|. If |tag| is non-negative, |it| is
// implicitly tagged with the tag specified by |tag| and |aclass|. If |opt| is
// non-zero, the value is optional.
//
// This function returns one and advances |*in| if an object was successfully
// parsed, -1 if an optional value was successfully skipped, and zero on error.
int ASN1_item_ex_d2i(ASN1_VALUE **pval, const unsigned char **in, long len,
                     const ASN1_ITEM *it, int tag, int aclass, char opt);

// ASN1_item_ex_i2d encodes |*pval| as a value of type |it| to |out| under the
// i2d output convention. It returns a non-zero length on success and -1 on
// error. If |tag| is -1. the tag and class come from |it|. Otherwise, the tag
// number is |tag| and the class is |aclass|. This is used for implicit tagging.
// This function treats a missing value as an error, not an optional field.
int ASN1_item_ex_i2d(ASN1_VALUE **pval, unsigned char **out,
                     const ASN1_ITEM *it, int tag, int aclass);

void ASN1_primitive_free(ASN1_VALUE **pval, const ASN1_ITEM *it);

// asn1_get_choice_selector returns the CHOICE selector value for |*pval|, which
// must of type |it|.
int asn1_get_choice_selector(ASN1_VALUE **pval, const ASN1_ITEM *it);

int asn1_set_choice_selector(ASN1_VALUE **pval, int value, const ASN1_ITEM *it);

// asn1_get_field_ptr returns a pointer to the field in |*pval| corresponding to
// |tt|.
ASN1_VALUE **asn1_get_field_ptr(ASN1_VALUE **pval, const ASN1_TEMPLATE *tt);

// asn1_do_adb returns the |ASN1_TEMPLATE| for the ANY DEFINED BY field |tt|,
// based on the selector INTEGER or OID in |*pval|. If |tt| is not an ADB field,
// it returns |tt|. If the selector does not match any value, it returns NULL.
// If |nullerr| is non-zero, it will additionally push an error to the error
// queue when there is no match.
const ASN1_TEMPLATE *asn1_do_adb(ASN1_VALUE **pval, const ASN1_TEMPLATE *tt,
                                 int nullerr);

void asn1_refcount_set_one(ASN1_VALUE **pval, const ASN1_ITEM *it);
int asn1_refcount_dec_and_test_zero(ASN1_VALUE **pval, const ASN1_ITEM *it);

void asn1_enc_init(ASN1_VALUE **pval, const ASN1_ITEM *it);
void asn1_enc_free(ASN1_VALUE **pval, const ASN1_ITEM *it);

// asn1_enc_restore, if |*pval| has a saved encoding, writes it to |out| under
// the i2d output convention, sets |*len| to the length, and returns one. If it
// has no saved encoding, it returns zero.
int asn1_enc_restore(int *len, unsigned char **out, ASN1_VALUE **pval,
                     const ASN1_ITEM *it);

// asn1_enc_save saves |inlen| bytes from |in| as |*pval|'s saved encoding. It
// returns one on success and zero on error. If |buf| is non-NULL, |in| must
// point into |buf|.
int asn1_enc_save(ASN1_VALUE **pval, const uint8_t *in, size_t inlen,
                  const ASN1_ITEM *it);

// asn1_encoding_clear clears the cached encoding in |enc|.
void asn1_encoding_clear(ASN1_ENCODING *enc);

typedef struct {
  int nid;
  long minsize;
  long maxsize;
  unsigned long mask;
  unsigned long flags;
} ASN1_STRING_TABLE;

// asn1_get_string_table_for_testing sets |*out_ptr| and |*out_len| to the table
// of built-in |ASN1_STRING_TABLE| values. It is exported for testing.
OPENSSL_EXPORT void asn1_get_string_table_for_testing(
    const ASN1_STRING_TABLE **out_ptr, size_t *out_len);

typedef ASN1_VALUE *ASN1_new_func(void);
typedef void ASN1_free_func(ASN1_VALUE *a);
typedef ASN1_VALUE *ASN1_d2i_func(ASN1_VALUE **a, const unsigned char **in,
                                  long length);
typedef int ASN1_i2d_func(ASN1_VALUE *a, unsigned char **in);

// An ASN1_ex_parse function should parse a value from |cbs| and set |*pval| to
// the result. It should return one on success and zero on failure. If |opt| is
// non-zero, the field may be optional. If an optional element is missing, the
// function should return one and consume zero bytes from |cbs|.
//
// If |opt| is non-zero, the function can assume that |*pval| is nullptr on
// entry. Otherwise, |*pval| may either be nullptr, or the result of
// |ASN1_ex_new_func|. The function may either write into the existing object,
// if any, or unconditionally make a new one. (The existing object comes from
// tasn_new.cc recursively filling in objects before parsing into them.)
typedef int ASN1_ex_parse(ASN1_VALUE **pval, CBS *cbs, const ASN1_ITEM *it,
                          int opt);

typedef int ASN1_ex_i2d(ASN1_VALUE **pval, unsigned char **out,
                        const ASN1_ITEM *it);
typedef int ASN1_ex_new_func(ASN1_VALUE **pval, const ASN1_ITEM *it);
typedef void ASN1_ex_free_func(ASN1_VALUE **pval, const ASN1_ITEM *it);

typedef struct ASN1_EXTERN_FUNCS_st {
  ASN1_ex_new_func *asn1_ex_new;
  ASN1_ex_free_func *asn1_ex_free;
  ASN1_ex_parse *asn1_ex_parse;
  ASN1_ex_i2d *asn1_ex_i2d;
} ASN1_EXTERN_FUNCS;

#define IMPLEMENT_EXTERN_ASN1_SIMPLE(name, new_func, free_func, tag,           \
                                     parse_func, i2d_func)                     \
  static int name##_new_cb(ASN1_VALUE **pval, const ASN1_ITEM *it) {           \
    *pval = (ASN1_VALUE *)new_func();                                          \
    return *pval != nullptr;                                                   \
  }                                                                            \
                                                                               \
  static void name##_free_cb(ASN1_VALUE **pval, const ASN1_ITEM *it) {         \
    free_func((name *)*pval);                                                  \
    *pval = nullptr;                                                           \
  }                                                                            \
                                                                               \
  static int name##_parse_cb(ASN1_VALUE **pval, CBS *cbs, const ASN1_ITEM *it, \
                             int opt) {                                        \
    if (opt && !CBS_peek_asn1_tag(cbs, (tag))) {                               \
      return 1;                                                                \
    }                                                                          \
                                                                               \
    if ((*pval == nullptr && !name##_new_cb(pval, it)) ||                      \
        !parse_func(cbs, (name *)*pval)) {                                     \
      return 0;                                                                \
    }                                                                          \
    return 1;                                                                  \
  }                                                                            \
                                                                               \
  static int name##_i2d_cb(ASN1_VALUE **pval, unsigned char **out,             \
                           const ASN1_ITEM *it) {                              \
    return i2d_func((name *)*pval, out);                                       \
  }                                                                            \
                                                                               \
  static const ASN1_EXTERN_FUNCS name##_extern_funcs = {                       \
      name##_new_cb, name##_free_cb, name##_parse_cb, name##_i2d_cb};          \
                                                                               \
  IMPLEMENT_EXTERN_ASN1(name, name##_extern_funcs)

// ASN1_TIME is an |ASN1_ITEM| whose ASN.1 type is X.509 Time (RFC 5280) and C
// type is |ASN1_TIME*|.
DECLARE_ASN1_ITEM(ASN1_TIME)

// DIRECTORYSTRING is an |ASN1_ITEM| whose ASN.1 type is X.509 DirectoryString
// (RFC 5280) and C type is |ASN1_STRING*|.
DECLARE_ASN1_ITEM(DIRECTORYSTRING)

// DISPLAYTEXT is an |ASN1_ITEM| whose ASN.1 type is X.509 DisplayText (RFC
// 5280) and C type is |ASN1_STRING*|.
DECLARE_ASN1_ITEM(DISPLAYTEXT)


#if defined(__cplusplus)
}  // extern C
#endif

#endif  // OPENSSL_HEADER_CRYPTO_ASN1_INTERNAL_H
