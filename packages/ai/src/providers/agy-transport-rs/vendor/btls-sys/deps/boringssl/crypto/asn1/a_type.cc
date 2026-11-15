// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/obj.h>

#include "internal.h"


int ASN1_TYPE_get(const ASN1_TYPE *a) {
  switch (a->type) {
    case V_ASN1_NULL:
    case V_ASN1_BOOLEAN:
      return a->type;
    case V_ASN1_OBJECT:
      return a->value.object != nullptr ? a->type : 0;
    default:
      return a->value.asn1_string != nullptr ? a->type : 0;
  }
}

const void *asn1_type_value_as_pointer(const ASN1_TYPE *a) {
  switch (a->type) {
    case V_ASN1_NULL:
      return nullptr;
    case V_ASN1_BOOLEAN:
      return a->value.boolean ? (void *)0xff : nullptr;
    case V_ASN1_OBJECT:
      return a->value.object;
    default:
      return a->value.asn1_string;
  }
}

void asn1_type_set0_string(ASN1_TYPE *a, ASN1_STRING *str) {
  // |ASN1_STRING| types are almost the same as |ASN1_TYPE| types, except that
  // the negative flag is not reflected into |ASN1_TYPE|.
  int type = str->type;
  if (type == V_ASN1_NEG_INTEGER) {
    type = V_ASN1_INTEGER;
  } else if (type == V_ASN1_NEG_ENUMERATED) {
    type = V_ASN1_ENUMERATED;
  }

  // These types are not |ASN1_STRING| types and use a different
  // representation when stored in |ASN1_TYPE|.
  assert(type != V_ASN1_NULL && type != V_ASN1_OBJECT &&
         type != V_ASN1_BOOLEAN);
  ASN1_TYPE_set(a, type, str);
}

void asn1_type_cleanup(ASN1_TYPE *a) {
  switch (a->type) {
    case V_ASN1_NULL:
      a->value.ptr = nullptr;
      break;
    case V_ASN1_BOOLEAN:
      a->value.boolean = ASN1_BOOLEAN_NONE;
      break;
    case V_ASN1_OBJECT:
      ASN1_OBJECT_free(a->value.object);
      a->value.object = nullptr;
      break;
    default:
      ASN1_STRING_free(a->value.asn1_string);
      a->value.asn1_string = nullptr;
      break;
  }
}

void ASN1_TYPE_set(ASN1_TYPE *a, int type, void *value) {
  asn1_type_cleanup(a);
  a->type = type;
  switch (type) {
    case V_ASN1_NULL:
      a->value.ptr = nullptr;
      break;
    case V_ASN1_BOOLEAN:
      a->value.boolean = value ? ASN1_BOOLEAN_TRUE : ASN1_BOOLEAN_FALSE;
      break;
    case V_ASN1_OBJECT:
      a->value.object = reinterpret_cast<ASN1_OBJECT *>(value);
      break;
    default:
      a->value.asn1_string = reinterpret_cast<ASN1_STRING *>(value);
      break;
  }
}

int ASN1_TYPE_set1(ASN1_TYPE *a, int type, const void *value) {
  if (!value || (type == V_ASN1_BOOLEAN)) {
    void *p = (void *)value;
    ASN1_TYPE_set(a, type, p);
  } else if (type == V_ASN1_OBJECT) {
    ASN1_OBJECT *odup;
    odup = OBJ_dup(reinterpret_cast<const ASN1_OBJECT *>(value));
    if (!odup) {
      return 0;
    }
    ASN1_TYPE_set(a, type, odup);
  } else {
    ASN1_STRING *sdup;
    sdup = ASN1_STRING_dup(reinterpret_cast<const ASN1_STRING *>(value));
    if (!sdup) {
      return 0;
    }
    ASN1_TYPE_set(a, type, sdup);
  }
  return 1;
}

// Returns 0 if they are equal, != 0 otherwise.
int ASN1_TYPE_cmp(const ASN1_TYPE *a, const ASN1_TYPE *b) {
  int result = -1;

  if (!a || !b || a->type != b->type) {
    return -1;
  }

  switch (a->type) {
    case V_ASN1_OBJECT:
      result = OBJ_cmp(a->value.object, b->value.object);
      break;
    case V_ASN1_NULL:
      result = 0;  // They do not have content.
      break;
    case V_ASN1_BOOLEAN:
      result = a->value.boolean - b->value.boolean;
      break;
    case V_ASN1_INTEGER:
    case V_ASN1_ENUMERATED:
    case V_ASN1_BIT_STRING:
    case V_ASN1_OCTET_STRING:
    case V_ASN1_SEQUENCE:
    case V_ASN1_SET:
    case V_ASN1_NUMERICSTRING:
    case V_ASN1_PRINTABLESTRING:
    case V_ASN1_T61STRING:
    case V_ASN1_VIDEOTEXSTRING:
    case V_ASN1_IA5STRING:
    case V_ASN1_UTCTIME:
    case V_ASN1_GENERALIZEDTIME:
    case V_ASN1_GRAPHICSTRING:
    case V_ASN1_VISIBLESTRING:
    case V_ASN1_GENERALSTRING:
    case V_ASN1_UNIVERSALSTRING:
    case V_ASN1_BMPSTRING:
    case V_ASN1_UTF8STRING:
    case V_ASN1_OTHER:
    default:
      result = ASN1_STRING_cmp(a->value.asn1_string, b->value.asn1_string);
      break;
  }

  return result;
}

int asn1_parse_any(CBS *cbs, ASN1_TYPE *out) {
  CBS_ASN1_TAG tag;
  CBS elem;
  size_t header_len;
  if (!CBS_get_any_asn1_element(cbs, &elem, &tag, &header_len)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }

  // Handle the non-string types.
  if (tag == CBS_ASN1_OBJECT) {
    bssl::UniquePtr<ASN1_OBJECT> obj(asn1_parse_object(&elem, /*tag=*/0));
    if (obj == nullptr) {
      return 0;
    }
    ASN1_TYPE_set(out, V_ASN1_OBJECT, obj.release());
    return 1;
  }
  if (tag == CBS_ASN1_NULL) {
    if (CBS_len(&elem) != header_len) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
      return 0;
    }
    ASN1_TYPE_set(out, V_ASN1_NULL, nullptr);
    return 1;
  }
  if (tag == CBS_ASN1_BOOLEAN) {
    int b;
    if (!CBS_get_asn1_bool(&elem, &b)) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
      return 0;
    }
    // V_ASN1_BOOLEAN will interpret the pointer as null for false and any
    // arbitrary non-null pointer for true.
    ASN1_TYPE_set(out, V_ASN1_BOOLEAN, b ? out : nullptr);
    return 1;
  }

  // All other cases are handled identically to the string-based ANY parser.
  bssl::UniquePtr<ASN1_STRING> str(ASN1_STRING_new());
  if (str == nullptr || !asn1_parse_any_as_string(&elem, str.get())) {
    return 0;
  }
  asn1_type_set0_string(out, str.release());
  return 1;
}

int asn1_parse_any_as_string(CBS *cbs, ASN1_STRING *out) {
  CBS_ASN1_TAG tag;
  CBS elem;
  size_t header_len;
  if (!CBS_get_any_asn1_element(cbs, &elem, &tag, &header_len)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }

  // Reject unexpectedly constructed or primitive universal types, rather than
  // encoding them as an opaque |V_ASN1_OTHER|. As of X.680 (02/2021), tag
  // numbers 0-36 have been allocated, except 15. Of these, only 8 (EXTERNAL),
  // 11 (EMBEDDED PDV), 16 (SEQUENCE), 17 (SET), and 29 (CHARACTER STRING) are
  // constructed.
  const CBS_ASN1_TAG tag_class = (tag & CBS_ASN1_CLASS_MASK);
  const CBS_ASN1_TAG number = tag & CBS_ASN1_TAG_NUMBER_MASK;
  if (tag_class == CBS_ASN1_UNIVERSAL && number <= 36 && number != 15) {
    const bool is_constructed = (tag & CBS_ASN1_CONSTRUCTED) != 0;
    if (number == V_ASN1_EXTERNAL || number == 11 /* EMBEDDED PDV */ ||
        number == V_ASN1_SEQUENCE || number == V_ASN1_SET ||
        number == 29 /* CHARACTER STRING*/) {
      if (!is_constructed) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_TYPE_NOT_CONSTRUCTED);
        return 0;
      }
    } else {
      if (is_constructed) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_TYPE_NOT_PRIMITIVE);
        return 0;
      }
    }
  }

  // Historically, parsing high universal tag numbers made OpenSSL's
  // |ASN1_STRING| representation ambiguous. We've since fixed this with
  // |V_ASN1_OTHER| but, for now, continue to enforce the limit.
  if (tag_class == CBS_ASN1_UNIVERSAL && number > V_ASN1_MAX_UNIVERSAL) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }

  // These types are just parsed as |V_ASN1_OTHER| here. Check the contents
  // before the generic |V_ASN1_OTHER| path.
  CBS body = elem;
  BSSL_CHECK(CBS_skip(&body, header_len));
  switch (tag) {
    case CBS_ASN1_OBJECT:
      if (!CBS_is_valid_asn1_oid(&body)) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_INVALID_OBJECT_ENCODING);
        return 0;
      }
      break;
    case CBS_ASN1_NULL:
      if (CBS_len(&body) != 0) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_NULL_IS_WRONG_LENGTH);
        return 0;
      }
      break;
    case CBS_ASN1_BOOLEAN: {
      uint8_t v;
      if (!CBS_get_u8(&body, &v) || CBS_len(&body) != 0) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_BOOLEAN_IS_WRONG_LENGTH);
        return 0;
      }
      if (v != 0 && v != 0xff) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
        return 0;
      }
      break;
    }
  }

  switch (tag) {
    case CBS_ASN1_INTEGER:
      return asn1_parse_integer(&elem, out, tag);
    case CBS_ASN1_ENUMERATED:
      return asn1_parse_enumerated(&elem, out, tag);
    case CBS_ASN1_BITSTRING:
      return asn1_parse_bit_string(&elem, out, tag);
    case CBS_ASN1_UNIVERSALSTRING:
      return asn1_parse_universal_string(&elem, out, tag);
    case CBS_ASN1_BMPSTRING:
      return asn1_parse_bmp_string(&elem, out, tag);
    case CBS_ASN1_UTF8STRING:
      return asn1_parse_utf8_string(&elem, out, tag);
    case CBS_ASN1_UTCTIME:
      // TODO(crbug.com/42290221): Reject timezone offsets here. We have no
      // known cases where UTCTime inside ANY needs accept invalid timezones.
      return asn1_parse_utc_time(&elem, out, tag, /*allow_timezone_offset=*/1);
    case CBS_ASN1_GENERALIZEDTIME:
      return asn1_parse_generalized_time(&elem, out, tag);
    case CBS_ASN1_OCTETSTRING:
    case CBS_ASN1_T61STRING:
    case CBS_ASN1_IA5STRING:
    case CBS_ASN1_NUMERICSTRING:
    case CBS_ASN1_PRINTABLESTRING:
    case CBS_ASN1_VIDEOTEXSTRING:
    case CBS_ASN1_GRAPHICSTRING:
    case CBS_ASN1_VISIBLESTRING:
    case CBS_ASN1_GENERALSTRING:
      // T61String is parsed as Latin-1, so all byte strings are valid. The
      // others we currently do not enforce.
      //
      // TODO(crbug.com/42290290): Enforce the encoding of the other string
      // types.
      if (!asn1_parse_octet_string(&elem, out, tag)) {
        return 0;
      }
      out->type = static_cast<int>(tag);
      return 1;
    default:
      // All unrecognized types, or types that cannot be represented as
      // |ASN1_STRING|, are represented as the whole element.
      if (!ASN1_STRING_set(out, CBS_data(&elem), CBS_len(&elem))) {
        return 0;
      }
      if (tag == CBS_ASN1_SEQUENCE) {
        out->type = V_ASN1_SEQUENCE;
      } else if (tag == CBS_ASN1_SET) {
        out->type = V_ASN1_SET;
      } else {
        out->type = V_ASN1_OTHER;
      }
      return 1;
  }
}

static int asn1_marshal_string_with_type(CBB *out, const ASN1_STRING *in,
                                         int type);

int asn1_marshal_any(CBB *out, const ASN1_TYPE *in) {
  switch (in->type) {
    case V_ASN1_OBJECT:
      return asn1_marshal_object(out, in->value.object, /*tag=*/0);
    case V_ASN1_NULL:
      return CBB_add_asn1_element(out, CBS_ASN1_NULL, nullptr, 0);
    case V_ASN1_BOOLEAN:
      return CBB_add_asn1_bool(out, in->value.boolean != ASN1_BOOLEAN_FALSE);
    case V_ASN1_INTEGER:
    case V_ASN1_ENUMERATED:
    case V_ASN1_BIT_STRING:
    case V_ASN1_OCTET_STRING:
    case V_ASN1_NUMERICSTRING:
    case V_ASN1_PRINTABLESTRING:
    case V_ASN1_T61STRING:
    case V_ASN1_VIDEOTEXSTRING:
    case V_ASN1_IA5STRING:
    case V_ASN1_UTCTIME:
    case V_ASN1_GENERALIZEDTIME:
    case V_ASN1_GRAPHICSTRING:
    case V_ASN1_VISIBLESTRING:
    case V_ASN1_GENERALSTRING:
    case V_ASN1_UNIVERSALSTRING:
    case V_ASN1_BMPSTRING:
    case V_ASN1_UTF8STRING:
    case V_ASN1_SEQUENCE:
    case V_ASN1_SET:
    case V_ASN1_OTHER:
      // If |in->type| and the underlying |ASN1_STRING| type don't match, use
      // |in->type|. See b/446993031.
      return asn1_marshal_string_with_type(out, in->value.asn1_string,
                                           in->type);
    default:
      // |ASN1_TYPE|s can have type -1 when default-constructed.
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_WRONG_TYPE);
      return 0;
  }
}

static int asn1_marshal_string_with_type(CBB *out, const ASN1_STRING *in,
                                         int type) {
  switch (type) {
    case V_ASN1_INTEGER:
    case V_ASN1_NEG_INTEGER:
      return asn1_marshal_integer(out, in, CBS_ASN1_INTEGER);
    case V_ASN1_ENUMERATED:
    case V_ASN1_NEG_ENUMERATED:
      return asn1_marshal_integer(out, in, CBS_ASN1_ENUMERATED);
    case V_ASN1_BIT_STRING:
      return asn1_marshal_bit_string(out, in, /*tag=*/0);
    case V_ASN1_OCTET_STRING:
    case V_ASN1_NUMERICSTRING:
    case V_ASN1_PRINTABLESTRING:
    case V_ASN1_T61STRING:
    case V_ASN1_VIDEOTEXSTRING:
    case V_ASN1_IA5STRING:
    case V_ASN1_UTCTIME:
    case V_ASN1_GENERALIZEDTIME:
    case V_ASN1_GRAPHICSTRING:
    case V_ASN1_VISIBLESTRING:
    case V_ASN1_GENERALSTRING:
    case V_ASN1_UNIVERSALSTRING:
    case V_ASN1_BMPSTRING:
    case V_ASN1_UTF8STRING:
      return asn1_marshal_octet_string(out, in,
                                       static_cast<CBS_ASN1_TAG>(in->type));
    case V_ASN1_SEQUENCE:
    case V_ASN1_SET:
    case V_ASN1_OTHER:
      // These three types store the whole TLV as contents.
      return CBB_add_bytes(out, ASN1_STRING_get0_data(in),
                           ASN1_STRING_length(in));
    default:
      // |ASN1_TYPE|s can have type -1 when default-constructed.
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_WRONG_TYPE);
      return 0;
  }
}

int asn1_marshal_any_string(CBB *out, const ASN1_STRING *in) {
  return asn1_marshal_string_with_type(out, in, in->type);
}
