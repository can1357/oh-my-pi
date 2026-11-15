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

#include <ctype.h>
#include <limits.h>
#include <string.h>

#include <utility>

#include <openssl/asn1.h>
#include <openssl/asn1t.h>
#include <openssl/bytestring.h>
#include <openssl/buf.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/stack.h>
#include <openssl/x509.h>

#include "../asn1/internal.h"
#include "../bytestring/internal.h"
#include "../internal.h"
#include "../mem_internal.h"
#include "internal.h"


// X509_NAME_MAX is the length of the maximum encoded |X509_NAME| we accept.
#define X509_NAME_MAX (1024 * 1024)

static int asn1_marshal_string_canon(CBB *cbb, const ASN1_STRING *in);

X509_NAME_ENTRY *X509_NAME_ENTRY_new(void) {
  bssl::UniquePtr<X509_NAME_ENTRY> ret = bssl::MakeUnique<X509_NAME_ENTRY>();
  if (ret == nullptr) {
    return nullptr;
  }
  ret->object = const_cast<ASN1_OBJECT *>(OBJ_get_undef());
  asn1_string_init(&ret->value, -1);
  ret->set = 0;
  return ret.release();
}

void X509_NAME_ENTRY_free(X509_NAME_ENTRY *entry) {
  if (entry != nullptr) {
    ASN1_OBJECT_free(entry->object);
    asn1_string_cleanup(&entry->value);
    OPENSSL_free(entry);
  }
}

static int x509_parse_name_entry(CBS *cbs, X509_NAME_ENTRY *out) {
  CBS seq;
  if (!CBS_get_asn1(cbs, &seq, CBS_ASN1_SEQUENCE)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }
  ASN1_OBJECT_free(out->object);
  out->object = asn1_parse_object(&seq, /*tag=*/0);
  if (out->object == nullptr ||                        //
      !asn1_parse_any_as_string(&seq, &out->value) ||  //
      CBS_len(&seq) != 0) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }
  return 1;
}

static int x509_marshal_name_entry(CBB *cbb, const X509_NAME_ENTRY *entry,
                                   int canonicalize) {
  CBB seq;
  if (!CBB_add_asn1(cbb, &seq, CBS_ASN1_SEQUENCE) ||
      !asn1_marshal_object(&seq, entry->object, /*tag=*/0)) {
    return 0;
  }
  int ok = canonicalize ? asn1_marshal_string_canon(&seq, &entry->value)
                        : asn1_marshal_any_string(&seq, &entry->value);
  if (!ok) {
    return 0;
  }
  return CBB_flush(cbb);
}

static int i2d_x509_name_entry(const X509_NAME_ENTRY *entry, uint8_t **out) {
  return bssl::I2DFromCBB(/*initial_capacity=*/16, out, [&](CBB *cbb) -> bool {
    return x509_marshal_name_entry(cbb, entry, /*canonicalize=*/0);
  });
}

IMPLEMENT_EXTERN_ASN1_SIMPLE(X509_NAME_ENTRY, X509_NAME_ENTRY_new,
                             X509_NAME_ENTRY_free, CBS_ASN1_SEQUENCE,
                             x509_parse_name_entry, i2d_x509_name_entry)

X509_NAME_ENTRY *X509_NAME_ENTRY_dup(const X509_NAME_ENTRY *entry) {
  bssl::ScopedCBB cbb;
  if (!CBB_init(cbb.get(), 16) ||
      !x509_marshal_name_entry(cbb.get(), entry, /*canonicalize=*/0)) {
    return nullptr;
  }
  CBS cbs;
  CBS_init(&cbs, CBB_data(cbb.get()), CBB_len(cbb.get()));
  bssl::UniquePtr<X509_NAME_ENTRY> copy(X509_NAME_ENTRY_new());
  if (copy == nullptr || !x509_parse_name_entry(&cbs, copy.get())) {
    return nullptr;
  }
  return copy.release();
}

static void x509_name_cache_free(X509_NAME_CACHE *cache) {
  if (cache != nullptr) {
    OPENSSL_free(cache->canon);
    OPENSSL_free(cache->der);
    OPENSSL_free(cache);
  }
}

void x509_name_init(X509_NAME *name) {
  OPENSSL_memset(name, 0, sizeof(X509_NAME));
}

void x509_name_cleanup(X509_NAME *name) {
  sk_X509_NAME_ENTRY_pop_free(name->entries, X509_NAME_ENTRY_free);
  x509_name_cache_free(name->cache.exchange(nullptr));
}

X509_NAME *X509_NAME_new(void) {
  return static_cast<X509_NAME *>(OPENSSL_zalloc(sizeof(X509_NAME)));
}

void X509_NAME_free(X509_NAME *name) {
  if (name != nullptr) {
    x509_name_cleanup(name);
    OPENSSL_free(name);
  }
}

int x509_parse_name(CBS *cbs, X509_NAME *out) {
  // Reset the old state.
  x509_name_cleanup(out);
  x509_name_init(out);

  out->entries = sk_X509_NAME_ENTRY_new_null();
  if (out->entries == nullptr) {
    return 0;
  }
  CBS seq, rdn;
  if (!CBS_get_asn1(cbs, &seq, CBS_ASN1_SEQUENCE) ||
      // Bound the size of an X509_NAME we are willing to parse.
      CBS_len(&seq) > X509_NAME_MAX) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }
  static_assert(X509_NAME_MAX <= INT_MAX, "set may overflow");
  for (int set = 0; CBS_len(&seq) > 0; set++) {
    if (!CBS_get_asn1(&seq, &rdn, CBS_ASN1_SET) ||  //
        CBS_len(&rdn) == 0) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
      return 0;
    }
    while (CBS_len(&rdn) != 0) {
      bssl::UniquePtr<X509_NAME_ENTRY> entry(X509_NAME_ENTRY_new());
      if (entry == nullptr || !x509_parse_name_entry(&rdn, entry.get())) {
        return 0;
      }
      entry->set = set;
      if (!bssl::PushToStack(out->entries, std::move(entry))) {
        return 0;
      }
    }
  }

  // While we are single-threaded, also fill in the cached state.
  return x509_name_get_cache(out) != nullptr;
}

static int x509_marshal_name_entries(CBB *out, const X509_NAME *name,
                                     int canonicalize) {
  if (sk_X509_NAME_ENTRY_num(name->entries) == 0) {
    return 1;
  }

  // Bootstrap the first RDN.
  int set = sk_X509_NAME_ENTRY_value(name->entries, 0)->set;
  CBB rdn;
  if (!CBB_add_asn1(out, &rdn, CBS_ASN1_SET)) {
    return 0;
  }

  for (const X509_NAME_ENTRY *entry : name->entries) {
    if (entry->set != set) {
      // Flush the previous RDN and start a new one.
      if (!CBB_flush_asn1_set_of(&rdn) ||
          !CBB_add_asn1(out, &rdn, CBS_ASN1_SET)) {
        return 0;
      }
      set = entry->set;
    }
    if (!x509_marshal_name_entry(&rdn, entry, canonicalize)) {
      return 0;
    }
  }

  return CBB_flush_asn1_set_of(&rdn) && CBB_flush(out);
}

const X509_NAME_CACHE *x509_name_get_cache(const X509_NAME *name) {
  const X509_NAME_CACHE *cache = name->cache.load();
  if (cache != nullptr) {
    return cache;
  }

  X509_NAME_CACHE *new_cache =
      static_cast<X509_NAME_CACHE *>(OPENSSL_zalloc(sizeof(X509_NAME_CACHE)));
  // Cache the DER encoding, including the outer TLV.
  bssl::ScopedCBB cbb;
  CBB seq;
  if (!CBB_init(cbb.get(), 16) ||
      !CBB_add_asn1(cbb.get(), &seq, CBS_ASN1_SEQUENCE) ||
      !x509_marshal_name_entries(&seq, name, /*canonicalize=*/0) ||
      !CBB_finish(cbb.get(), &new_cache->der, &new_cache->der_len)) {
    x509_name_cache_free(new_cache);
    return nullptr;
  }
  // Cache the canonicalized form, without the outer TLV.
  if (!CBB_init(cbb.get(), 16) ||
      !x509_marshal_name_entries(cbb.get(), name, /*canonicalize=*/1) ||
      !CBB_finish(cbb.get(), &new_cache->canon, &new_cache->canon_len)) {
    x509_name_cache_free(new_cache);
    return nullptr;
  }

  X509_NAME_CACHE *expected = nullptr;
  if (name->cache.compare_exchange_strong(expected, new_cache)) {
    // We won the race. |name| now owns |new_cache|.
    return new_cache;
  }

  // Some other thread installed a (presumably identical) cache. Release the one
  // we made and return the winning one.
  assert(expected != nullptr);
  x509_name_cache_free(new_cache);
  return expected;
}

void x509_name_invalidate_cache(X509_NAME *name) {
  x509_name_cache_free(name->cache.exchange(nullptr));
}

int x509_marshal_name(CBB *out, const X509_NAME *in) {
  const X509_NAME_CACHE *cache = x509_name_get_cache(in);
  if (cache == nullptr) {
    return 0;
  }
  return CBB_add_bytes(out, cache->der, cache->der_len);
}

int x509_name_copy(X509_NAME *dst, const X509_NAME *src) {
  const X509_NAME_CACHE *cache = x509_name_get_cache(src);
  if (cache == nullptr) {
    return 0;
  }
  // Callers sometimes try to set a name back to itself. We check this after
  // |x509_name_get_cache| because, if |src| was so broken that it could not be
  // serialized, we used to return an error. (It's not clear if this codepath is
  // even possible.)
  if (dst == src) {
    return 1;
  }
  CBS cbs;
  CBS_init(&cbs, cache->der, cache->der_len);
  if (!x509_parse_name(&cbs, dst)) {
    return 0;
  }
  assert(CBS_len(&cbs) == 0);
  return 1;
}

X509_NAME *X509_NAME_dup(const X509_NAME *name) {
  bssl::UniquePtr<X509_NAME> copy(X509_NAME_new());
  if (copy == nullptr || !x509_name_copy(copy.get(), name)) {
    return nullptr;
  }
  return copy.release();
}

X509_NAME *d2i_X509_NAME(X509_NAME **out, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(
      out, inp, len, [](CBS *cbs) -> bssl::UniquePtr<X509_NAME> {
        bssl::UniquePtr<X509_NAME> name(X509_NAME_new());
        if (name == nullptr || !x509_parse_name(cbs, name.get())) {
          return nullptr;
        }
        return name;
      });
}

int i2d_X509_NAME(const X509_NAME *in, uint8_t **outp) {
  if (in == nullptr) {
    OPENSSL_PUT_ERROR(X509, ERR_R_PASSED_NULL_PARAMETER);
    return -1;
  }
  const X509_NAME_CACHE *cache = x509_name_get_cache(in);
  if (cache == nullptr) {
    return -1;
  }
  if (cache->der_len > INT_MAX) {
    OPENSSL_PUT_ERROR(X509, ERR_R_OVERFLOW);
    return -1;
  }
  int len = static_cast<int>(cache->der_len);
  if (outp == nullptr) {
    return len;
  }
  if (*outp == nullptr) {
    *outp = static_cast<uint8_t*>(OPENSSL_memdup(cache->der, cache->der_len));
    return *outp != nullptr ? len : -1;
  }
  OPENSSL_memcpy(*outp, cache->der, cache->der_len);
  *outp += cache->der_len;
  return len;
}

IMPLEMENT_EXTERN_ASN1_SIMPLE(X509_NAME, X509_NAME_new, X509_NAME_free,
                             CBS_ASN1_SEQUENCE, x509_parse_name, i2d_X509_NAME)

static int asn1_marshal_string_canon(CBB *cbb, const ASN1_STRING *in) {
  int (*decode_func)(CBS *, uint32_t *);
  int error;
  switch (in->type) {
    case V_ASN1_UTF8STRING:
      decode_func = CBS_get_utf8;
      error = ASN1_R_INVALID_UTF8STRING;
      break;
    case V_ASN1_BMPSTRING:
      decode_func = CBS_get_ucs2_be;
      error = ASN1_R_INVALID_BMPSTRING;
      break;
    case V_ASN1_UNIVERSALSTRING:
      decode_func = CBS_get_utf32_be;
      error = ASN1_R_INVALID_UNIVERSALSTRING;
      break;
    case V_ASN1_PRINTABLESTRING:
    case V_ASN1_T61STRING:
    case V_ASN1_IA5STRING:
    case V_ASN1_VISIBLESTRING:
      decode_func = CBS_get_latin1;
      error = ERR_R_INTERNAL_ERROR;  // Latin-1 inputs are never invalid.
      break;
    default:
      // Other string types are not canonicalized.
      return asn1_marshal_any_string(cbb, in);
  }

  CBB child;
  if (!CBB_add_asn1(cbb, &child, CBS_ASN1_UTF8STRING)) {
    return 0;
  }

  bool empty = true;
  bool in_whitespace = false;
  CBS cbs;
  CBS_init(&cbs, in->data, in->length);
  while (CBS_len(&cbs) != 0) {
    uint32_t c;
    if (!decode_func(&cbs, &c)) {
      OPENSSL_PUT_ERROR(ASN1, error);
      return 0;
    }
    if (OPENSSL_isspace(c)) {
      if (empty) {
        continue;  // Trim leading whitespace.
      }
      in_whitespace = true;
    } else {
      if (in_whitespace) {
        // Collapse the previous run of whitespace into one space.
        if (!CBB_add_u8(&child, ' ')) {
          return 0;
        }
      }
      in_whitespace = false;
      // Lowecase ASCII codepoints.
      if (c <= 0x7f) {
        c = OPENSSL_tolower(c);
      }
      if (!CBB_add_utf8(&child, c)) {
        return 0;
      }
      empty = false;
    }
  }

  return CBB_flush(cbb);
}

int X509_NAME_set(X509_NAME **xn, const X509_NAME *name) {
  bssl::UniquePtr<X509_NAME> copy(X509_NAME_dup(name));
  if (copy == nullptr) {
    return 0;
  }
  X509_NAME_free(*xn);
  *xn = copy.release();
  return 1;
}

int X509_NAME_ENTRY_set(const X509_NAME_ENTRY *ne) { return ne->set; }

int X509_NAME_get0_der(const X509_NAME *nm, const unsigned char **out_der,
                       size_t *out_der_len) {
  const X509_NAME_CACHE *cache = x509_name_get_cache(nm);
  if (cache == nullptr) {
    return 0;
  }
  if (out_der != nullptr) {
    *out_der = cache->der;
  }
  if (out_der_len != nullptr) {
    *out_der_len = cache->der_len;
  }
  return 1;
}
