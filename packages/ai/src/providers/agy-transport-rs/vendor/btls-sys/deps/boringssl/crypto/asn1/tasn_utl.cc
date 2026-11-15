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
#include <string.h>

#include <openssl/asn1t.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/pool.h>

#include "../internal.h"
#include "internal.h"


// Utility functions for manipulating fields and offsets

// Add 'offset' to 'addr'
#define offset2ptr(addr, offset) (void *)(((char *)(addr)) + (offset))

// Given an ASN1_ITEM CHOICE type return the selector value
int asn1_get_choice_selector(ASN1_VALUE **pval, const ASN1_ITEM *it) {
  int *sel = reinterpret_cast<int *>(offset2ptr(*pval, it->utype));
  return *sel;
}

// Given an ASN1_ITEM CHOICE type set the selector value, return old value.
int asn1_set_choice_selector(ASN1_VALUE **pval, int value,
                             const ASN1_ITEM *it) {
  int *sel, ret;
  sel = reinterpret_cast<int *>(offset2ptr(*pval, it->utype));
  ret = *sel;
  *sel = value;
  return ret;
}

static CRYPTO_refcount_t *asn1_get_references(ASN1_VALUE **pval,
                                              const ASN1_ITEM *it) {
  if (it->itype != ASN1_ITYPE_SEQUENCE) {
    return nullptr;
  }
  const ASN1_AUX *aux = reinterpret_cast<const ASN1_AUX *>(it->funcs);
  if (!aux || !(aux->flags & ASN1_AFLG_REFCOUNT)) {
    return nullptr;
  }
  return reinterpret_cast<CRYPTO_refcount_t *>(
      offset2ptr(*pval, aux->ref_offset));
}

void asn1_refcount_set_one(ASN1_VALUE **pval, const ASN1_ITEM *it) {
  CRYPTO_refcount_t *references = asn1_get_references(pval, it);
  if (references != nullptr) {
    *references = 1;
  }
}

int asn1_refcount_dec_and_test_zero(ASN1_VALUE **pval, const ASN1_ITEM *it) {
  CRYPTO_refcount_t *references = asn1_get_references(pval, it);
  if (references != nullptr) {
    return CRYPTO_refcount_dec_and_test_zero(references);
  }
  return 1;
}

static ASN1_ENCODING *asn1_get_enc_ptr(ASN1_VALUE **pval, const ASN1_ITEM *it) {
  assert(it->itype == ASN1_ITYPE_SEQUENCE);
  const ASN1_AUX *aux;
  if (!pval || !*pval) {
    return nullptr;
  }
  aux = reinterpret_cast<const ASN1_AUX *>(it->funcs);
  if (!aux || !(aux->flags & ASN1_AFLG_ENCODING)) {
    return nullptr;
  }
  return reinterpret_cast<ASN1_ENCODING *>(offset2ptr(*pval, aux->enc_offset));
}

void asn1_enc_init(ASN1_VALUE **pval, const ASN1_ITEM *it) {
  ASN1_ENCODING *enc = asn1_get_enc_ptr(pval, it);
  if (enc) {
    enc->enc = nullptr;
    enc->len = 0;
  }
}

void asn1_enc_free(ASN1_VALUE **pval, const ASN1_ITEM *it) {
  ASN1_ENCODING *enc = asn1_get_enc_ptr(pval, it);
  if (enc) {
    asn1_encoding_clear(enc);
  }
}

int asn1_enc_save(ASN1_VALUE **pval, const uint8_t *in, size_t in_len,
                  const ASN1_ITEM *it) {
  ASN1_ENCODING *enc;
  enc = asn1_get_enc_ptr(pval, it);
  if (!enc) {
    return 1;
  }

  asn1_encoding_clear(enc);
  enc->enc = reinterpret_cast<uint8_t *>(OPENSSL_memdup(in, in_len));
  if (!enc->enc) {
    return 0;
  }

  enc->len = in_len;
  return 1;
}

void asn1_encoding_clear(ASN1_ENCODING *enc) {
  OPENSSL_free(enc->enc);
  enc->enc = nullptr;
  enc->len = 0;
}

int asn1_enc_restore(int *len, unsigned char **out, ASN1_VALUE **pval,
                     const ASN1_ITEM *it) {
  ASN1_ENCODING *enc = asn1_get_enc_ptr(pval, it);
  if (!enc || enc->len == 0) {
    return 0;
  }
  if (out) {
    OPENSSL_memcpy(*out, enc->enc, enc->len);
    *out += enc->len;
  }
  if (len) {
    *len = enc->len;
  }
  return 1;
}

// Given an ASN1_TEMPLATE get a pointer to a field
ASN1_VALUE **asn1_get_field_ptr(ASN1_VALUE **pval, const ASN1_TEMPLATE *tt) {
  ASN1_VALUE **pvaltmp =
      reinterpret_cast<ASN1_VALUE **>(offset2ptr(*pval, tt->offset));
  // NOTE for BOOLEAN types the field is just a plain int so we can't return
  // int **, so settle for (int *).
  return pvaltmp;
}

// Handle ANY DEFINED BY template, find the selector, look up the relevant
// ASN1_TEMPLATE in the table and return it.
const ASN1_TEMPLATE *asn1_do_adb(ASN1_VALUE **pval, const ASN1_TEMPLATE *tt,
                                 int nullerr) {
  const ASN1_ADB *adb;
  const ASN1_ADB_TABLE *atbl;
  ASN1_VALUE **sfld;
  int i;
  if (!(tt->flags & ASN1_TFLG_ADB_MASK)) {
    return tt;
  }

  // Else ANY DEFINED BY ... get the table
  adb = ASN1_ADB_ptr(tt->item);

  // Get the selector field
  sfld = reinterpret_cast<ASN1_VALUE **>(offset2ptr(*pval, adb->offset));

  // Check if NULL
  int selector;
  if (*sfld == nullptr) {
    if (!adb->null_tt) {
      goto err;
    }
    return adb->null_tt;
  }

  // Convert type to a NID:
  // NB: don't check for NID_undef here because it
  // might be a legitimate value in the table
  assert(tt->flags & ASN1_TFLG_ADB_OID);
  selector = OBJ_obj2nid((ASN1_OBJECT *)*sfld);

  // Try to find matching entry in table Maybe should check application types
  // first to allow application override? Might also be useful to have a flag
  // which indicates table is sorted and we can do a binary search. For now
  // stick to a linear search.

  for (atbl = adb->tbl, i = 0; i < adb->tblcount; i++, atbl++) {
    if (atbl->value == selector) {
      return &atbl->tt;
    }
  }

  // FIXME: need to search application table too

  // No match, return default type
  if (!adb->default_tt) {
    goto err;
  }
  return adb->default_tt;

err:
  // FIXME: should log the value or OID of unsupported type
  if (nullerr) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_UNSUPPORTED_ANY_DEFINED_BY_TYPE);
  }
  return nullptr;
}
