// Copyright 2002-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/ec.h>

#include <limits.h>
#include <string.h>

#include <algorithm>
#include <array>

#include <openssl/bn.h>
#include <openssl/bytestring.h>
#include <openssl/ec_key.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/nid.h>

#include "../bytestring/internal.h"
#include "../fipsmodule/ec/internal.h"
#include "../internal.h"
#include "internal.h"


static const CBS_ASN1_TAG kParametersTag =
    CBS_ASN1_CONSTRUCTED | CBS_ASN1_CONTEXT_SPECIFIC | 0;
static const CBS_ASN1_TAG kPublicKeyTag =
    CBS_ASN1_CONSTRUCTED | CBS_ASN1_CONTEXT_SPECIFIC | 1;

static auto get_all_groups() {
  return std::array{
      EC_group_p224(),
      EC_group_p256(),
      EC_group_p384(),
      EC_group_p521(),
  };
}

EC_KEY *ec_key_parse_private_key(
    CBS *cbs, const EC_GROUP *group,
    bssl::Span<const EC_GROUP *const> allowed_groups) {
  // If a group was supplied externally, no other groups can be parsed.
  if (group != nullptr) {
    allowed_groups = bssl::Span(&group, 1);
  }

  CBS ec_private_key, private_key;
  uint64_t version;
  if (!CBS_get_asn1(cbs, &ec_private_key, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1_uint64(&ec_private_key, &version) ||  //
      version != 1 ||
      !CBS_get_asn1(&ec_private_key, &private_key, CBS_ASN1_OCTETSTRING)) {
    OPENSSL_PUT_ERROR(EC, EC_R_DECODE_ERROR);
    return nullptr;
  }

  // Parse the optional parameters field.
  if (CBS_peek_asn1_tag(&ec_private_key, kParametersTag)) {
    // Per SEC 1, as an alternative to omitting it, one is allowed to specify
    // this field and put in a NULL to mean inheriting this value. This was
    // omitted in a previous version of this logic without problems, so leave it
    // unimplemented.
    CBS child;
    if (!CBS_get_asn1(&ec_private_key, &child, kParametersTag)) {
      OPENSSL_PUT_ERROR(EC, EC_R_DECODE_ERROR);
      return nullptr;
    }
    const EC_GROUP *inner_group =
        ec_key_parse_parameters(&child, allowed_groups);
    if (inner_group == nullptr) {
      // If the caller already supplied a group, any explicit group is required
      // to match. On mismatch, |ec_key_parse_parameters| will fail to recognize
      // any other groups, so remap the error.
      if (group != nullptr &&
          ERR_equals(ERR_peek_last_error(), ERR_LIB_EC, EC_R_UNKNOWN_GROUP)) {
        ERR_clear_error();
        OPENSSL_PUT_ERROR(EC, EC_R_GROUP_MISMATCH);
      }
      return nullptr;
    }
    // Overriding |allowed_groups| above ensures the only returned group will be
    // the matching one.
    assert(group == nullptr || inner_group == group);
    group = inner_group;
    if (CBS_len(&child) != 0) {
      OPENSSL_PUT_ERROR(EC, EC_R_DECODE_ERROR);
      return nullptr;
    }
  }

  // The group must have been specified either externally, or explicitly in the
  // structure.
  if (group == nullptr) {
    OPENSSL_PUT_ERROR(EC, EC_R_MISSING_PARAMETERS);
    return nullptr;
  }

  bssl::UniquePtr<EC_KEY> ret(EC_KEY_new());
  if (ret == nullptr || !EC_KEY_set_group(ret.get(), group)) {
    return nullptr;
  }

  // Although RFC 5915 specifies the length of the key, OpenSSL historically
  // got this wrong, so accept any length. See upstream's
  // 30cd4ff294252c4b6a4b69cbef6a5b4117705d22.
  bssl::UniquePtr<BIGNUM> priv_key(
      BN_bin2bn(CBS_data(&private_key), CBS_len(&private_key), nullptr));
  ret->pub_key = EC_POINT_new(group);
  if (priv_key == nullptr || ret->pub_key == nullptr ||
      !EC_KEY_set_private_key(ret.get(), priv_key.get())) {
    return nullptr;
  }

  if (CBS_peek_asn1_tag(&ec_private_key, kPublicKeyTag)) {
    CBS child, public_key;
    uint8_t padding;
    if (!CBS_get_asn1(&ec_private_key, &child, kPublicKeyTag) ||
        !CBS_get_asn1(&child, &public_key, CBS_ASN1_BITSTRING) ||
        // As in a SubjectPublicKeyInfo, the byte-encoded public key is then
        // encoded as a BIT STRING with bits ordered as in the DER encoding.
        !CBS_get_u8(&public_key, &padding) ||  //
        padding != 0 ||
        // Explicitly check |public_key| is non-empty to save the conversion
        // form later.
        CBS_len(&public_key) == 0 ||
        !EC_POINT_oct2point(group, ret->pub_key, CBS_data(&public_key),
                            CBS_len(&public_key), nullptr) ||
        CBS_len(&child) != 0) {
      OPENSSL_PUT_ERROR(EC, EC_R_DECODE_ERROR);
      return nullptr;
    }

    // Save the point conversion form.
    // TODO(davidben): Consider removing this.
    ret->conv_form =
        (point_conversion_form_t)(CBS_data(&public_key)[0] & ~0x01);
  } else {
    // Compute the public key instead.
    if (!ec_point_mul_scalar_base(group, &ret->pub_key->raw,
                                  &ret->priv_key->scalar)) {
      return nullptr;
    }
    // Remember the original private-key-only encoding.
    // TODO(davidben): Consider removing this.
    ret->enc_flag |= EC_PKEY_NO_PUBKEY;
  }

  if (CBS_len(&ec_private_key) != 0) {
    OPENSSL_PUT_ERROR(EC, EC_R_DECODE_ERROR);
    return nullptr;
  }

  // Ensure the resulting key is valid.
  if (!EC_KEY_check_key(ret.get())) {
    return nullptr;
  }

  return ret.release();
}

EC_KEY *EC_KEY_parse_private_key(CBS *cbs, const EC_GROUP *group) {
  return ec_key_parse_private_key(cbs, group, get_all_groups());
}

int EC_KEY_marshal_private_key(CBB *cbb, const EC_KEY *key,
                               unsigned enc_flags) {
  if (key == nullptr || key->group == nullptr || key->priv_key == nullptr) {
    OPENSSL_PUT_ERROR(EC, ERR_R_PASSED_NULL_PARAMETER);
    return 0;
  }

  CBB ec_private_key, private_key;
  if (!CBB_add_asn1(cbb, &ec_private_key, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_uint64(&ec_private_key, 1 /* version */) ||
      !CBB_add_asn1(&ec_private_key, &private_key, CBS_ASN1_OCTETSTRING) ||
      !BN_bn2cbb_padded(&private_key,
                        BN_num_bytes(EC_GROUP_get0_order(key->group)),
                        EC_KEY_get0_private_key(key))) {
    OPENSSL_PUT_ERROR(EC, EC_R_ENCODE_ERROR);
    return 0;
  }

  if (!(enc_flags & EC_PKEY_NO_PARAMETERS)) {
    CBB child;
    if (!CBB_add_asn1(&ec_private_key, &child, kParametersTag) ||
        !EC_KEY_marshal_curve_name(&child, key->group) ||
        !CBB_flush(&ec_private_key)) {
      OPENSSL_PUT_ERROR(EC, EC_R_ENCODE_ERROR);
      return 0;
    }
  }

  // TODO(fork): replace this flexibility with sensible default?
  if (!(enc_flags & EC_PKEY_NO_PUBKEY) && key->pub_key != nullptr) {
    CBB child, public_key;
    if (!CBB_add_asn1(&ec_private_key, &child, kPublicKeyTag) ||
        !CBB_add_asn1(&child, &public_key, CBS_ASN1_BITSTRING) ||
        // As in a SubjectPublicKeyInfo, the byte-encoded public key is then
        // encoded as a BIT STRING with bits ordered as in the DER encoding.
        !CBB_add_u8(&public_key, 0 /* padding */) ||
        !EC_POINT_point2cbb(&public_key, key->group, key->pub_key,
                            key->conv_form, nullptr) ||
        !CBB_flush(&ec_private_key)) {
      OPENSSL_PUT_ERROR(EC, EC_R_ENCODE_ERROR);
      return 0;
    }
  }

  if (!CBB_flush(cbb)) {
    OPENSSL_PUT_ERROR(EC, EC_R_ENCODE_ERROR);
    return 0;
  }

  return 1;
}

// kPrimeFieldOID is the encoding of 1.2.840.10045.1.1.
static const uint8_t kPrimeField[] = {0x2a, 0x86, 0x48, 0xce, 0x3d, 0x01, 0x01};

namespace {
struct explicit_prime_curve {
  CBS prime, a, b, base_x, base_y, order;
};
}  // namespace

static int parse_explicit_prime_curve(CBS *in,
                                      struct explicit_prime_curve *out) {
  // See RFC 3279, section 2.3.5. Note that RFC 3279 calls this structure an
  // ECParameters while RFC 5480 calls it a SpecifiedECDomain.
  CBS params, field_id, field_type, curve, base, cofactor;
  int has_cofactor;
  uint64_t version;
  if (!CBS_get_asn1(in, &params, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1_uint64(&params, &version) ||  //
      version != 1 ||                             //
      !CBS_get_asn1(&params, &field_id, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1(&field_id, &field_type, CBS_ASN1_OBJECT) ||
      CBS_len(&field_type) != sizeof(kPrimeField) ||
      OPENSSL_memcmp(CBS_data(&field_type), kPrimeField, sizeof(kPrimeField)) !=
          0 ||
      !CBS_get_asn1(&field_id, &out->prime, CBS_ASN1_INTEGER) ||
      !CBS_is_unsigned_asn1_integer(&out->prime) ||  //
      CBS_len(&field_id) != 0 ||
      !CBS_get_asn1(&params, &curve, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1(&curve, &out->a, CBS_ASN1_OCTETSTRING) ||
      !CBS_get_asn1(&curve, &out->b, CBS_ASN1_OCTETSTRING) ||
      // |curve| has an optional BIT STRING seed which we ignore.
      !CBS_get_optional_asn1(&curve, nullptr, nullptr, CBS_ASN1_BITSTRING) ||
      CBS_len(&curve) != 0 ||
      !CBS_get_asn1(&params, &base, CBS_ASN1_OCTETSTRING) ||
      !CBS_get_asn1(&params, &out->order, CBS_ASN1_INTEGER) ||
      !CBS_is_unsigned_asn1_integer(&out->order) ||
      !CBS_get_optional_asn1(&params, &cofactor, &has_cofactor,
                             CBS_ASN1_INTEGER) ||
      CBS_len(&params) != 0) {
    OPENSSL_PUT_ERROR(EC, EC_R_DECODE_ERROR);
    return 0;
  }

  if (has_cofactor) {
    // We only support prime-order curves so the cofactor must be one.
    if (CBS_len(&cofactor) != 1 ||  //
        CBS_data(&cofactor)[0] != 1) {
      OPENSSL_PUT_ERROR(EC, EC_R_UNKNOWN_GROUP);
      return 0;
    }
  }

  // Require that the base point use uncompressed form.
  uint8_t form;
  if (!CBS_get_u8(&base, &form) || form != POINT_CONVERSION_UNCOMPRESSED) {
    OPENSSL_PUT_ERROR(EC, EC_R_INVALID_FORM);
    return 0;
  }

  if (CBS_len(&base) % 2 != 0) {
    OPENSSL_PUT_ERROR(EC, EC_R_DECODE_ERROR);
    return 0;
  }
  size_t field_len = CBS_len(&base) / 2;
  CBS_init(&out->base_x, CBS_data(&base), field_len);
  CBS_init(&out->base_y, CBS_data(&base) + field_len, field_len);

  return 1;
}

// integers_equal returns one if |bytes| is a big-endian encoding of |bn|, and
// zero otherwise.
static int integers_equal(const CBS *bytes, const BIGNUM *bn) {
  // Although, in SEC 1, Field-Element-to-Octet-String has a fixed width,
  // OpenSSL mis-encodes the |a| and |b|, so we tolerate any number of leading
  // zeros. (This matters for P-521 whose |b| has a leading 0.)
  CBS copy = *bytes;
  while (CBS_len(&copy) > 0 && CBS_data(&copy)[0] == 0) {
    CBS_skip(&copy, 1);
  }

  if (CBS_len(&copy) > EC_MAX_BYTES) {
    return 0;
  }
  uint8_t buf[EC_MAX_BYTES];
  if (!BN_bn2bin_padded(buf, CBS_len(&copy), bn)) {
    ERR_clear_error();
    return 0;
  }

  return CBS_mem_equal(&copy, buf, CBS_len(&copy));
}

const EC_GROUP *ec_key_parse_curve_name(
    CBS *cbs, bssl::Span<const EC_GROUP *const> allowed_groups) {
  CBS named_curve;
  if (!CBS_get_asn1(cbs, &named_curve, CBS_ASN1_OBJECT)) {
    OPENSSL_PUT_ERROR(EC, EC_R_DECODE_ERROR);
    return nullptr;
  }

  // Look for a matching curve.
  for (const EC_GROUP *group : allowed_groups) {
    if (named_curve == bssl::Span(group->oid, group->oid_len)) {
      return group;
    }
  }

  OPENSSL_PUT_ERROR(EC, EC_R_UNKNOWN_GROUP);
  return nullptr;
}

EC_GROUP *EC_KEY_parse_curve_name(CBS *cbs) {
  // This function only ever returns a static |EC_GROUP|, but currently returns
  // a non-const pointer for historical reasons.
  return const_cast<EC_GROUP *>(ec_key_parse_curve_name(cbs, get_all_groups()));
}

int EC_KEY_marshal_curve_name(CBB *cbb, const EC_GROUP *group) {
  if (group->oid_len == 0) {
    OPENSSL_PUT_ERROR(EC, EC_R_UNKNOWN_GROUP);
    return 0;
  }

  return CBB_add_asn1_element(cbb, CBS_ASN1_OBJECT, group->oid, group->oid_len);
}

const EC_GROUP *ec_key_parse_parameters(
    CBS *cbs, bssl::Span<const EC_GROUP *const> allowed_groups) {
  if (!CBS_peek_asn1_tag(cbs, CBS_ASN1_SEQUENCE)) {
    return ec_key_parse_curve_name(cbs, allowed_groups);
  }

  // OpenSSL sometimes produces ECPrivateKeys with explicitly-encoded versions
  // of named curves.
  //
  // TODO(davidben): Remove support for this.
  struct explicit_prime_curve curve;
  if (!parse_explicit_prime_curve(cbs, &curve)) {
    return nullptr;
  }

  bssl::UniquePtr<BIGNUM> p(BN_new());
  bssl::UniquePtr<BIGNUM> a(BN_new());
  bssl::UniquePtr<BIGNUM> b(BN_new());
  bssl::UniquePtr<BIGNUM> x(BN_new());
  bssl::UniquePtr<BIGNUM> y(BN_new());
  if (p == nullptr || a == nullptr || b == nullptr || x == nullptr ||
      y == nullptr) {
    return nullptr;
  }

  for (const EC_GROUP *group : allowed_groups) {
    if (!integers_equal(&curve.order, EC_GROUP_get0_order(group))) {
      continue;
    }

    // The order alone uniquely identifies the group, but we check the other
    // parameters to avoid misinterpreting the group.
    if (!EC_GROUP_get_curve_GFp(group, p.get(), a.get(), b.get(), nullptr)) {
      return nullptr;
    }
    if (!integers_equal(&curve.prime, p.get()) ||
        !integers_equal(&curve.a, a.get()) ||
        !integers_equal(&curve.b, b.get())) {
      break;
    }
    if (!EC_POINT_get_affine_coordinates_GFp(
            group, EC_GROUP_get0_generator(group), x.get(), y.get(), nullptr)) {
      return nullptr;
    }
    if (!integers_equal(&curve.base_x, x.get()) ||
        !integers_equal(&curve.base_y, y.get())) {
      break;
    }
    return group;
  }

  OPENSSL_PUT_ERROR(EC, EC_R_UNKNOWN_GROUP);
  return nullptr;
}

EC_GROUP *EC_KEY_parse_parameters(CBS *cbs) {
  // This function only ever returns a static |EC_GROUP|, but currently returns
  // a non-const pointer for historical reasons.
  return const_cast<EC_GROUP *>(ec_key_parse_parameters(cbs, get_all_groups()));
}

int EC_POINT_point2cbb(CBB *out, const EC_GROUP *group, const EC_POINT *point,
                       point_conversion_form_t form, BN_CTX *ctx) {
  size_t len = EC_POINT_point2oct(group, point, form, nullptr, 0, ctx);
  if (len == 0) {
    return 0;
  }
  uint8_t *p;
  return CBB_add_space(out, &p, len) &&
         EC_POINT_point2oct(group, point, form, p, len, ctx) == len;
}

EC_KEY *d2i_ECPrivateKey(EC_KEY **out, const uint8_t **inp, long len) {
  // This function treats its |out| parameter differently from other |d2i|
  // functions. If supplied, take the group from |*out|.
  const EC_GROUP *group = nullptr;
  if (out != nullptr && *out != nullptr) {
    group = EC_KEY_get0_group(*out);
  }

  return bssl::D2IFromCBS(out, inp, len, [&](CBS *cbs) {
    return EC_KEY_parse_private_key(cbs, group);
  });
}

int i2d_ECPrivateKey(const EC_KEY *key, uint8_t **outp) {
  return bssl::I2DFromCBB(
      /*initial_capacity=*/64, outp, [&](CBB *cbb) -> bool {
        return EC_KEY_marshal_private_key(cbb, key, EC_KEY_get_enc_flags(key));
      });
}

EC_GROUP *d2i_ECPKParameters(EC_GROUP **out, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(out, inp, len, EC_KEY_parse_parameters);
}

int i2d_ECPKParameters(const EC_GROUP *group, uint8_t **outp) {
  if (group == nullptr) {
    OPENSSL_PUT_ERROR(EC, ERR_R_PASSED_NULL_PARAMETER);
    return -1;
  }
  return bssl::I2DFromCBB(
      /*initial_capacity=*/16, outp,
      [&](CBB *cbb) -> bool { return EC_KEY_marshal_curve_name(cbb, group); });
}

EC_KEY *d2i_ECParameters(EC_KEY **out_key, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(
      out_key, inp, len, [](CBS *cbs) -> bssl::UniquePtr<EC_KEY> {
        const EC_GROUP *group = EC_KEY_parse_parameters(cbs);
        if (group == nullptr) {
          return nullptr;
        }
        bssl::UniquePtr<EC_KEY> ret(EC_KEY_new());
        if (ret == nullptr || !EC_KEY_set_group(ret.get(), group)) {
          return nullptr;
        }
        return ret;
      });
}

int i2d_ECParameters(const EC_KEY *key, uint8_t **outp) {
  if (key == nullptr || key->group == nullptr) {
    OPENSSL_PUT_ERROR(EC, ERR_R_PASSED_NULL_PARAMETER);
    return -1;
  }
  return bssl::I2DFromCBB(
      /*initial_capacity=*/16, outp, [&](CBB *cbb) -> bool {
        return EC_KEY_marshal_curve_name(cbb, key->group);
      });
}

EC_KEY *o2i_ECPublicKey(EC_KEY **keyp, const uint8_t **inp, long len) {
  EC_KEY *ret = nullptr;

  if (keyp == nullptr || *keyp == nullptr || (*keyp)->group == nullptr) {
    OPENSSL_PUT_ERROR(EC, ERR_R_PASSED_NULL_PARAMETER);
    return nullptr;
  }
  ret = *keyp;
  if (ret->pub_key == nullptr &&
      (ret->pub_key = EC_POINT_new(ret->group)) == nullptr) {
    return nullptr;
  }
  if (!EC_POINT_oct2point(ret->group, ret->pub_key, *inp, len, nullptr)) {
    OPENSSL_PUT_ERROR(EC, ERR_R_EC_LIB);
    return nullptr;
  }
  // save the point conversion form
  ret->conv_form = (point_conversion_form_t)(*inp[0] & ~0x01);
  *inp += len;
  return ret;
}

int i2o_ECPublicKey(const EC_KEY *key, uint8_t **outp) {
  if (key == nullptr) {
    OPENSSL_PUT_ERROR(EC, ERR_R_PASSED_NULL_PARAMETER);
    return 0;
  }
  // No initial capacity because |EC_POINT_point2cbb| will internally reserve
  // the right size in one shot, so it's best to leave this at zero.
  int ret = bssl::I2DFromCBB(
      /*initial_capacity=*/0, outp, [&](CBB *cbb) -> bool {
        return EC_POINT_point2cbb(cbb, key->group, key->pub_key, key->conv_form,
                                  nullptr);
      });
  // Historically, this function used the wrong return value on error.
  return ret > 0 ? ret : 0;
}

size_t EC_get_builtin_curves(EC_builtin_curve *out_curves,
                             size_t max_num_curves) {
  auto all = get_all_groups();
  max_num_curves = std::min(all.size(), max_num_curves);
  for (size_t i = 0; i < max_num_curves; i++) {
    const EC_GROUP *group = all[i];
    out_curves[i].nid = group->curve_name;
    out_curves[i].comment = group->comment;
  }
  return all.size();
}
