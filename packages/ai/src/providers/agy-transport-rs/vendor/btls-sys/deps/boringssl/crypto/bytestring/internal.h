// Copyright 2014 The BoringSSL Authors
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

#ifndef OPENSSL_HEADER_CRYPTO_BYTESTRING_INTERNAL_H
#define OPENSSL_HEADER_CRYPTO_BYTESTRING_INTERNAL_H

#include <openssl/asn1.h>
#include <openssl/bytestring.h>
#include <openssl/err.h>

#include <type_traits>


extern "C" {

// CBS_asn1_ber_to_der reads a BER element from |in|. If it finds
// indefinite-length elements or constructed strings then it converts the BER
// data to DER, sets |out| to the converted contents and |*out_storage| to a
// buffer which the caller must release with |OPENSSL_free|. Otherwise, it sets
// |out| to the original BER element in |in| and |*out_storage| to NULL.
// Additionally, |*in| will be advanced over the BER element.
//
// This function should successfully process any valid BER input, however it
// will not convert all of BER's deviations from DER. BER is ambiguous between
// implicitly-tagged SEQUENCEs of strings and implicitly-tagged constructed
// strings. Implicitly-tagged strings must be parsed with
// |CBS_get_ber_implicitly_tagged_string| instead of |CBS_get_asn1|. The caller
// must also account for BER variations in the contents of a primitive.
//
// It returns one on success and zero otherwise.
OPENSSL_EXPORT int CBS_asn1_ber_to_der(CBS *in, CBS *out,
                                       uint8_t **out_storage);

// CBS_get_asn1_implicit_string parses a BER string of primitive type
// |inner_tag| implicitly-tagged with |outer_tag|. It sets |out| to the
// contents. If concatenation was needed, it sets |*out_storage| to a buffer
// which the caller must release with |OPENSSL_free|. Otherwise, it sets
// |*out_storage| to NULL.
//
// This function does not parse all of BER. It requires the string be
// definite-length. Constructed strings are allowed, but all children of the
// outermost element must be primitive. The caller should use
// |CBS_asn1_ber_to_der| before running this function.
//
// It returns one on success and zero otherwise.
OPENSSL_EXPORT int CBS_get_asn1_implicit_string(CBS *in, CBS *out,
                                                uint8_t **out_storage,
                                                CBS_ASN1_TAG outer_tag,
                                                CBS_ASN1_TAG inner_tag);

// CBB_finish_i2d calls |CBB_finish| on |cbb| which must have been initialized
// with |CBB_init|. If |outp| is not NULL then the result is written to |*outp|
// and |*outp| is advanced just past the output. It returns the number of bytes
// in the result, whether written or not, or a negative value on error. On
// error, it calls |CBB_cleanup| on |cbb|.
//
// This function may be used to help implement legacy i2d ASN.1 functions.
int CBB_finish_i2d(CBB *cbb, uint8_t **outp);

}  // extern C

BSSL_NAMESPACE_BEGIN

// D2IFromCBS takes a functor of type |Unique<T>(CBS*)| and implements the d2i
// calling convention. For compatibility with functions that don't tag their
// return value (e.g. public APIs), |T*(CBS)| is also accepted. The callback can
// assume that the |CBS|'s length fits in |long|. The callback should not access
// |out|, |inp|, or |len| directly.
template <typename T, typename CBSFunc>
inline T *D2IFromCBS(T **out, const uint8_t **inp, long len, CBSFunc func) {
  static_assert(std::is_invocable_v<CBSFunc, CBS *>);
  static_assert(
      std::is_same_v<std::invoke_result_t<CBSFunc, CBS *>, UniquePtr<T>> ||
      std::is_same_v<std::invoke_result_t<CBSFunc, CBS *>, T *>);
  if (len < 0) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_BUFFER_TOO_SMALL);
    return nullptr;
  }
  CBS cbs;
  CBS_init(&cbs, *inp, len);
  UniquePtr<T> ret(func(&cbs));
  if (ret == nullptr) {
    return nullptr;
  }
  if (out != nullptr) {
    UniquePtr<T> free_out(*out);
    *out = ret.get();
  }
  *inp = CBS_data(&cbs);
  return ret.release();
}

// I2DFromCBB takes a functor of type |bool(CBB*)| and implements the i2d
// calling convention. It internally makes a |CBB| with the specified initial
// capacity. The callback should not access |outp| directly.
template <typename CBBFunc>
inline int I2DFromCBB(size_t initial_capacity, uint8_t **outp, CBBFunc func) {
  static_assert(std::is_invocable_v<CBBFunc, CBB *>);
  static_assert(std::is_same_v<std::invoke_result_t<CBBFunc, CBB *>, bool>);
  ScopedCBB cbb;
  if (!CBB_init(cbb.get(), initial_capacity) || !func(cbb.get())) {
    return -1;
  }
  return CBB_finish_i2d(cbb.get(), outp);
}

BSSL_NAMESPACE_END

#endif  // OPENSSL_HEADER_CRYPTO_BYTESTRING_INTERNAL_H
