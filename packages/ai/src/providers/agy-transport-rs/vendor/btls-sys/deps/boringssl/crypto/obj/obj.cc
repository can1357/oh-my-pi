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

#include <openssl/obj.h>

#include <inttypes.h>
#include <limits.h>
#include <string.h>

#include <iterator>

#include <openssl/asn1.h>
#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/mem.h>

#include "../asn1/internal.h"
#include "../internal.h"
#include "../lhash/internal.h"

// obj_data.h must be included after the definition of |ASN1_OBJECT|.
#include "obj_dat.h"


DEFINE_LHASH_OF(ASN1_OBJECT)

static CRYPTO_MUTEX global_added_lock = CRYPTO_MUTEX_INIT;
// These globals are protected by |global_added_lock|.
static LHASH_OF(ASN1_OBJECT) *global_added_by_data = nullptr;
static LHASH_OF(ASN1_OBJECT) *global_added_by_nid = nullptr;
static LHASH_OF(ASN1_OBJECT) *global_added_by_short_name = nullptr;
static LHASH_OF(ASN1_OBJECT) *global_added_by_long_name = nullptr;

static CRYPTO_MUTEX global_next_nid_lock = CRYPTO_MUTEX_INIT;
static unsigned global_next_nid = NUM_NID;

static int obj_next_nid(void) {
  CRYPTO_MUTEX_lock_write(&global_next_nid_lock);
  int ret = global_next_nid++;
  CRYPTO_MUTEX_unlock_write(&global_next_nid_lock);
  return ret;
}

ASN1_OBJECT *OBJ_dup(const ASN1_OBJECT *o) {
  ASN1_OBJECT *r;
  unsigned char *data = nullptr;
  char *sn = nullptr, *ln = nullptr;

  if (o == nullptr) {
    return nullptr;
  }

  if (!(o->flags & ASN1_OBJECT_FLAG_DYNAMIC)) {
    // TODO(fork): this is a little dangerous.
    return (ASN1_OBJECT *)o;
  }

  r = ASN1_OBJECT_new();
  if (r == nullptr) {
    OPENSSL_PUT_ERROR(OBJ, ERR_R_ASN1_LIB);
    return nullptr;
  }
  r->ln = r->sn = nullptr;

  // once data is attached to an object, it remains const
  r->data = reinterpret_cast<uint8_t *>(OPENSSL_memdup(o->data, o->length));
  if (o->length != 0 && r->data == nullptr) {
    goto err;
  }

  r->length = o->length;
  r->nid = o->nid;

  if (o->ln != nullptr) {
    ln = OPENSSL_strdup(o->ln);
    if (ln == nullptr) {
      goto err;
    }
  }

  if (o->sn != nullptr) {
    sn = OPENSSL_strdup(o->sn);
    if (sn == nullptr) {
      goto err;
    }
  }

  r->sn = sn;
  r->ln = ln;

  r->flags =
      o->flags | (ASN1_OBJECT_FLAG_DYNAMIC | ASN1_OBJECT_FLAG_DYNAMIC_STRINGS |
                  ASN1_OBJECT_FLAG_DYNAMIC_DATA);
  return r;

err:
  OPENSSL_free(ln);
  OPENSSL_free(sn);
  OPENSSL_free(data);
  OPENSSL_free(r);
  return nullptr;
}

int OBJ_cmp(const ASN1_OBJECT *a, const ASN1_OBJECT *b) {
  if (a->length < b->length) {
    return -1;
  } else if (a->length > b->length) {
    return 1;
  }
  return OPENSSL_memcmp(a->data, b->data, a->length);
}

const uint8_t *OBJ_get0_data(const ASN1_OBJECT *obj) {
  if (obj == nullptr) {
    return nullptr;
  }

  return obj->data;
}

size_t OBJ_length(const ASN1_OBJECT *obj) {
  if (obj == nullptr || obj->length < 0) {
    return 0;
  }

  return (size_t)obj->length;
}

static const ASN1_OBJECT *get_builtin_object(int nid) {
  // |NID_undef| is stored separately, so all the indices are off by one. The
  // caller of this function must have a valid built-in, non-undef NID.
  BSSL_CHECK(nid > 0 && nid < NUM_NID);
  return &kObjects[nid - 1];
}

// obj_cmp is called to search the kNIDsInOIDOrder array. The |key| argument is
// an |ASN1_OBJECT|* that we're looking for and |element| is a pointer to an
// unsigned int in the array.
static int obj_cmp(const void *key, const void *element) {
  uint16_t nid = *((const uint16_t *)element);
  return OBJ_cmp(reinterpret_cast<const ASN1_OBJECT *>(key),
                 get_builtin_object(nid));
}

int OBJ_obj2nid(const ASN1_OBJECT *obj) {
  if (obj == nullptr) {
    return NID_undef;
  }

  if (obj->nid != 0) {
    return obj->nid;
  }

  CRYPTO_MUTEX_lock_read(&global_added_lock);
  if (global_added_by_data != nullptr) {
    ASN1_OBJECT *match;

    match = lh_ASN1_OBJECT_retrieve(global_added_by_data, obj);
    if (match != nullptr) {
      CRYPTO_MUTEX_unlock_read(&global_added_lock);
      return match->nid;
    }
  }
  CRYPTO_MUTEX_unlock_read(&global_added_lock);

  const uint16_t *nid_ptr = reinterpret_cast<const uint16_t *>(
      bsearch(obj, kNIDsInOIDOrder, std::size(kNIDsInOIDOrder),
              sizeof(kNIDsInOIDOrder[0]), obj_cmp));
  if (nid_ptr == nullptr) {
    return NID_undef;
  }

  return get_builtin_object(*nid_ptr)->nid;
}

int OBJ_cbs2nid(const CBS *cbs) {
  if (CBS_len(cbs) > INT_MAX) {
    return NID_undef;
  }

  ASN1_OBJECT obj;
  OPENSSL_memset(&obj, 0, sizeof(obj));
  obj.data = CBS_data(cbs);
  obj.length = (int)CBS_len(cbs);

  return OBJ_obj2nid(&obj);
}

// short_name_cmp is called to search the kNIDsInShortNameOrder array. The
// |key| argument is name that we're looking for and |element| is a pointer to
// an unsigned int in the array.
static int short_name_cmp(const void *key, const void *element) {
  const char *name = (const char *)key;
  uint16_t nid = *((const uint16_t *)element);

  return strcmp(name, get_builtin_object(nid)->sn);
}

int OBJ_sn2nid(const char *short_name) {
  CRYPTO_MUTEX_lock_read(&global_added_lock);
  if (global_added_by_short_name != nullptr) {
    ASN1_OBJECT *match, templ;

    templ.sn = short_name;
    match = lh_ASN1_OBJECT_retrieve(global_added_by_short_name, &templ);
    if (match != nullptr) {
      CRYPTO_MUTEX_unlock_read(&global_added_lock);
      return match->nid;
    }
  }
  CRYPTO_MUTEX_unlock_read(&global_added_lock);

  const uint16_t *nid_ptr = reinterpret_cast<const uint16_t *>(bsearch(
      short_name, kNIDsInShortNameOrder, std::size(kNIDsInShortNameOrder),
      sizeof(kNIDsInShortNameOrder[0]), short_name_cmp));
  if (nid_ptr == nullptr) {
    return NID_undef;
  }

  return get_builtin_object(*nid_ptr)->nid;
}

// long_name_cmp is called to search the kNIDsInLongNameOrder array. The
// |key| argument is name that we're looking for and |element| is a pointer to
// an unsigned int in the array.
static int long_name_cmp(const void *key, const void *element) {
  const char *name = (const char *)key;
  uint16_t nid = *((const uint16_t *)element);

  return strcmp(name, get_builtin_object(nid)->ln);
}

int OBJ_ln2nid(const char *long_name) {
  CRYPTO_MUTEX_lock_read(&global_added_lock);
  if (global_added_by_long_name != nullptr) {
    ASN1_OBJECT *match, templ;

    templ.ln = long_name;
    match = lh_ASN1_OBJECT_retrieve(global_added_by_long_name, &templ);
    if (match != nullptr) {
      CRYPTO_MUTEX_unlock_read(&global_added_lock);
      return match->nid;
    }
  }
  CRYPTO_MUTEX_unlock_read(&global_added_lock);

  const uint16_t *nid_ptr = reinterpret_cast<const uint16_t *>(
      bsearch(long_name, kNIDsInLongNameOrder, std::size(kNIDsInLongNameOrder),
              sizeof(kNIDsInLongNameOrder[0]), long_name_cmp));
  if (nid_ptr == nullptr) {
    return NID_undef;
  }

  return get_builtin_object(*nid_ptr)->nid;
}

int OBJ_txt2nid(const char *s) {
  ASN1_OBJECT *obj;
  int nid;

  obj = OBJ_txt2obj(s, 0 /* search names */);
  nid = OBJ_obj2nid(obj);
  ASN1_OBJECT_free(obj);
  return nid;
}

OPENSSL_EXPORT int OBJ_nid2cbb(CBB *out, int nid) {
  const ASN1_OBJECT *obj = OBJ_nid2obj(nid);
  return obj != nullptr &&
         CBB_add_asn1_element(out, CBS_ASN1_OBJECT, obj->data, obj->length);
}

const ASN1_OBJECT *OBJ_get_undef(void) {
  static const ASN1_OBJECT kUndef = {
      /*sn=*/SN_undef,
      /*ln=*/LN_undef,
      /*nid=*/NID_undef,
      /*length=*/0,
      /*data=*/nullptr,
      /*flags=*/0,
  };
  return &kUndef;
}

ASN1_OBJECT *OBJ_nid2obj(int nid) {
  if (nid == NID_undef) {
    return (ASN1_OBJECT *)OBJ_get_undef();
  }

  if (nid > 0 && nid < NUM_NID) {
    const ASN1_OBJECT *obj = get_builtin_object(nid);
    if (nid != NID_undef && obj->nid == NID_undef) {
      goto err;
    }
    return (ASN1_OBJECT *)obj;
  }

  CRYPTO_MUTEX_lock_read(&global_added_lock);
  if (global_added_by_nid != nullptr) {
    ASN1_OBJECT *match, templ;

    templ.nid = nid;
    match = lh_ASN1_OBJECT_retrieve(global_added_by_nid, &templ);
    if (match != nullptr) {
      CRYPTO_MUTEX_unlock_read(&global_added_lock);
      return match;
    }
  }
  CRYPTO_MUTEX_unlock_read(&global_added_lock);

err:
  OPENSSL_PUT_ERROR(OBJ, OBJ_R_UNKNOWN_NID);
  return nullptr;
}

const char *OBJ_nid2sn(int nid) {
  const ASN1_OBJECT *obj = OBJ_nid2obj(nid);
  if (obj == nullptr) {
    return nullptr;
  }

  return obj->sn;
}

const char *OBJ_nid2ln(int nid) {
  const ASN1_OBJECT *obj = OBJ_nid2obj(nid);
  if (obj == nullptr) {
    return nullptr;
  }

  return obj->ln;
}

static ASN1_OBJECT *create_object_with_text_oid(int (*get_nid)(void),
                                                const char *oid,
                                                const char *short_name,
                                                const char *long_name) {
  uint8_t *buf;
  size_t len;
  CBB cbb;
  if (!CBB_init(&cbb, 32) ||
      !CBB_add_asn1_oid_from_text(&cbb, oid, strlen(oid)) ||
      !CBB_finish(&cbb, &buf, &len)) {
    OPENSSL_PUT_ERROR(OBJ, OBJ_R_INVALID_OID_STRING);
    CBB_cleanup(&cbb);
    return nullptr;
  }

  ASN1_OBJECT *ret = ASN1_OBJECT_create(get_nid ? get_nid() : NID_undef, buf,
                                        len, short_name, long_name);
  OPENSSL_free(buf);
  return ret;
}

ASN1_OBJECT *OBJ_txt2obj(const char *s, int dont_search_names) {
  if (!dont_search_names) {
    int nid = OBJ_sn2nid(s);
    if (nid == NID_undef) {
      nid = OBJ_ln2nid(s);
    }

    if (nid != NID_undef) {
      return OBJ_nid2obj(nid);
    }
  }

  return create_object_with_text_oid(nullptr, s, nullptr, nullptr);
}

static int strlcpy_int(char *dst, const char *src, int dst_size) {
  size_t ret = OPENSSL_strlcpy(dst, src, dst_size < 0 ? 0 : (size_t)dst_size);
  if (ret > INT_MAX) {
    OPENSSL_PUT_ERROR(OBJ, ERR_R_OVERFLOW);
    return -1;
  }
  return (int)ret;
}

int OBJ_obj2txt(char *out, int out_len, const ASN1_OBJECT *obj,
                int always_return_oid) {
  // Python depends on the empty OID successfully encoding as the empty
  // string.
  if (obj == nullptr || obj->length == 0) {
    return strlcpy_int(out, "", out_len);
  }

  if (!always_return_oid) {
    int nid = OBJ_obj2nid(obj);
    if (nid != NID_undef) {
      const char *name = OBJ_nid2ln(nid);
      if (name == nullptr) {
        name = OBJ_nid2sn(nid);
      }
      if (name != nullptr) {
        return strlcpy_int(out, name, out_len);
      }
    }
  }

  CBS cbs;
  CBS_init(&cbs, obj->data, obj->length);
  char *txt = CBS_asn1_oid_to_text(&cbs);
  if (txt == nullptr) {
    if (out_len > 0) {
      out[0] = '\0';
    }
    return -1;
  }

  int ret = strlcpy_int(out, txt, out_len);
  OPENSSL_free(txt);
  return ret;
}

static uint32_t hash_nid(const ASN1_OBJECT *obj) { return obj->nid; }

static int cmp_nid(const ASN1_OBJECT *a, const ASN1_OBJECT *b) {
  return a->nid - b->nid;
}

static uint32_t hash_data(const ASN1_OBJECT *obj) {
  return OPENSSL_hash32(obj->data, obj->length);
}

static uint32_t hash_short_name(const ASN1_OBJECT *obj) {
  return OPENSSL_strhash(obj->sn);
}

static int cmp_short_name(const ASN1_OBJECT *a, const ASN1_OBJECT *b) {
  return strcmp(a->sn, b->sn);
}

static uint32_t hash_long_name(const ASN1_OBJECT *obj) {
  return OPENSSL_strhash(obj->ln);
}

static int cmp_long_name(const ASN1_OBJECT *a, const ASN1_OBJECT *b) {
  return strcmp(a->ln, b->ln);
}

// obj_add_object inserts |obj| into the various global hashes for run-time
// added objects. It returns one on success or zero otherwise.
static int obj_add_object(ASN1_OBJECT *obj) {
  obj->flags &= ~(ASN1_OBJECT_FLAG_DYNAMIC | ASN1_OBJECT_FLAG_DYNAMIC_STRINGS |
                  ASN1_OBJECT_FLAG_DYNAMIC_DATA);

  CRYPTO_MUTEX_lock_write(&global_added_lock);
  if (global_added_by_nid == nullptr) {
    global_added_by_nid = lh_ASN1_OBJECT_new(hash_nid, cmp_nid);
  }
  if (global_added_by_data == nullptr) {
    global_added_by_data = lh_ASN1_OBJECT_new(hash_data, OBJ_cmp);
  }
  if (global_added_by_short_name == nullptr) {
    global_added_by_short_name =
        lh_ASN1_OBJECT_new(hash_short_name, cmp_short_name);
  }
  if (global_added_by_long_name == nullptr) {
    global_added_by_long_name =
        lh_ASN1_OBJECT_new(hash_long_name, cmp_long_name);
  }

  int ok = 0;
  if (global_added_by_nid == nullptr ||         //
      global_added_by_data == nullptr ||        //
      global_added_by_short_name == nullptr ||  //
      global_added_by_long_name == nullptr) {
    goto err;
  }

  // We don't pay attention to |old_object| (which contains any previous object
  // that was evicted from the hashes) because we don't have a reference count
  // on ASN1_OBJECT values. Also, we should never have duplicates nids and so
  // should always have objects in |global_added_by_nid|.
  ASN1_OBJECT *old_object;
  ok = lh_ASN1_OBJECT_insert(global_added_by_nid, &old_object, obj);
  if (obj->length != 0 && obj->data != nullptr) {
    ok &= lh_ASN1_OBJECT_insert(global_added_by_data, &old_object, obj);
  }
  if (obj->sn != nullptr) {
    ok &= lh_ASN1_OBJECT_insert(global_added_by_short_name, &old_object, obj);
  }
  if (obj->ln != nullptr) {
    ok &= lh_ASN1_OBJECT_insert(global_added_by_long_name, &old_object, obj);
  }

err:
  CRYPTO_MUTEX_unlock_write(&global_added_lock);
  return ok;
}

int OBJ_create(const char *oid, const char *short_name, const char *long_name) {
  ASN1_OBJECT *op =
      create_object_with_text_oid(obj_next_nid, oid, short_name, long_name);
  if (op == nullptr || !obj_add_object(op)) {
    return NID_undef;
  }
  return op->nid;
}

void OBJ_cleanup(void) {}
