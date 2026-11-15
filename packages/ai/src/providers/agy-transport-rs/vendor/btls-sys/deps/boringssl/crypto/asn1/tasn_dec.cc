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
#include <openssl/asn1t.h>
#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/pool.h>

#include <assert.h>
#include <limits.h>
#include <string.h>

#include "../bytestring/internal.h"
#include "../internal.h"
#include "internal.h"

// Constructed types with a recursive definition (such as can be found in PKCS7)
// could eventually exceed the stack given malicious input with excessive
// recursion. Therefore we limit the stack depth. This is the maximum number of
// recursive invocations of asn1_item_embed_d2i().
#define ASN1_MAX_CONSTRUCTED_NEST 30

static int asn1_check_tlen(long *olen, int *otag, unsigned char *oclass,
                           char *cst, const unsigned char **in, long len,
                           int exptag, int expclass, char opt);

static int asn1_template_ex_d2i(ASN1_VALUE **pval, const unsigned char **in,
                                long len, const ASN1_TEMPLATE *tt, char opt,
                                int depth);
static int asn1_template_noexp_d2i(ASN1_VALUE **val, const unsigned char **in,
                                   long len, const ASN1_TEMPLATE *tt, char opt,
                                   int depth);
static int asn1_d2i_ex_primitive(ASN1_VALUE **pval, const unsigned char **in,
                                 long len, const ASN1_ITEM *it, int tag,
                                 int aclass, char opt);
static int asn1_item_ex_d2i(ASN1_VALUE **pval, const unsigned char **in,
                            long len, const ASN1_ITEM *it, int tag, int aclass,
                            char opt, int depth);

unsigned long ASN1_tag2bit(int tag) {
  switch (tag) {
    case V_ASN1_BIT_STRING:
      return B_ASN1_BIT_STRING;
    case V_ASN1_OCTET_STRING:
      return B_ASN1_OCTET_STRING;
    case V_ASN1_UTF8STRING:
      return B_ASN1_UTF8STRING;
    case V_ASN1_SEQUENCE:
      return B_ASN1_SEQUENCE;
    case V_ASN1_NUMERICSTRING:
      return B_ASN1_NUMERICSTRING;
    case V_ASN1_PRINTABLESTRING:
      return B_ASN1_PRINTABLESTRING;
    case V_ASN1_T61STRING:
      return B_ASN1_T61STRING;
    case V_ASN1_VIDEOTEXSTRING:
      return B_ASN1_VIDEOTEXSTRING;
    case V_ASN1_IA5STRING:
      return B_ASN1_IA5STRING;
    case V_ASN1_UTCTIME:
      return B_ASN1_UTCTIME;
    case V_ASN1_GENERALIZEDTIME:
      return B_ASN1_GENERALIZEDTIME;
    case V_ASN1_GRAPHICSTRING:
      return B_ASN1_GRAPHICSTRING;
    case V_ASN1_ISO64STRING:
      return B_ASN1_ISO64STRING;
    case V_ASN1_GENERALSTRING:
      return B_ASN1_GENERALSTRING;
    case V_ASN1_UNIVERSALSTRING:
      return B_ASN1_UNIVERSALSTRING;
    case V_ASN1_BMPSTRING:
      return B_ASN1_BMPSTRING;
    default:
      return 0;
  }
}

// Decode an ASN1 item, this currently behaves just like a standard 'd2i'
// function. 'in' points to a buffer to read the data from, in future we
// will have more advanced versions that can input data a piece at a time and
// this will simply be a special case.

ASN1_VALUE *ASN1_item_d2i(ASN1_VALUE **pval, const unsigned char **in, long len,
                          const ASN1_ITEM *it) {
  ASN1_VALUE *ret = nullptr;
  if (asn1_item_ex_d2i(&ret, in, len, it, /*tag=*/-1, /*aclass=*/0, /*opt=*/0,
                       /*depth=*/0) <= 0) {
    // Clean up, in case the caller left a partial object.
    //
    // TODO(davidben): I don't think it can leave one, but the codepaths below
    // are a bit inconsistent. Revisit this when rewriting this function.
    ASN1_item_ex_free(&ret, it);
  }

  // If the caller supplied an output pointer, free the old one and replace it
  // with |ret|. This differs from OpenSSL slightly in that we don't support
  // object reuse. We run this on both success and failure. On failure, even
  // with object reuse, OpenSSL destroys the previous object.
  if (pval != nullptr) {
    ASN1_item_ex_free(pval, it);
    *pval = ret;
  }
  return ret;
}

// Decode an item, taking care of IMPLICIT tagging, if any. If 'opt' set and
// tag mismatch return -1 to handle OPTIONAL
//
// TODO(davidben): Historically, all functions in this file had to account for
// |*pval| containing an arbitrary existing value. This is no longer the case
// because |ASN1_item_d2i| now always starts from NULL. As part of rewriting
// this function, take the simplified assumptions into account. Though we must
// still account for the internal calls to |ASN1_item_ex_new|.

static int asn1_item_ex_d2i(ASN1_VALUE **pval, const unsigned char **in,
                            long len, const ASN1_ITEM *it, int tag, int aclass,
                            char opt, int depth) {
  const ASN1_TEMPLATE *tt, *errtt = nullptr;
  const unsigned char *p = nullptr, *q;
  unsigned char oclass;
  char cst, isopt;
  int i;
  int otag;
  int ret = 0;
  ASN1_VALUE **pchptr;
  if (!pval) {
    return 0;
  }
  if (len < 0) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_BUFFER_TOO_SMALL);
    goto err;
  }

  // Bound |len| to comfortably fit in an int. Lengths in this module often
  // switch between int and long without overflow checks.
  if (len > INT_MAX / 2) {
    len = INT_MAX / 2;
  }

  if (++depth > ASN1_MAX_CONSTRUCTED_NEST) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_NESTED_TOO_DEEP);
    goto err;
  }

  switch (it->itype) {
    case ASN1_ITYPE_PRIMITIVE:
      if (it->templates) {
        // tagging or OPTIONAL is currently illegal on an item template
        // because the flags can't get passed down. In practice this
        // isn't a problem: we include the relevant flags from the item
        // template in the template itself.
        if ((tag != -1) || opt) {
          OPENSSL_PUT_ERROR(ASN1, ASN1_R_ILLEGAL_OPTIONS_ON_ITEM_TEMPLATE);
          goto err;
        }
        return asn1_template_ex_d2i(pval, in, len, it->templates, opt, depth);
      }
      return asn1_d2i_ex_primitive(pval, in, len, it, tag, aclass, opt);

    case ASN1_ITYPE_MSTRING:
      // It never makes sense for multi-strings to have implicit tagging, so
      // if tag != -1, then this looks like an error in the template.
      if (tag != -1) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_BAD_TEMPLATE);
        goto err;
      }

      p = *in;
      // Just read in tag and class
      ret =
          asn1_check_tlen(nullptr, &otag, &oclass, nullptr, &p, len, -1, 0, 1);
      if (!ret) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_NESTED_ASN1_ERROR);
        goto err;
      }

      // Must be UNIVERSAL class
      if (oclass != V_ASN1_UNIVERSAL) {
        // If OPTIONAL, assume this is OK
        if (opt) {
          return -1;
        }
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_MSTRING_NOT_UNIVERSAL);
        goto err;
      }
      // Check tag matches bit map
      if (!(ASN1_tag2bit(otag) & it->utype)) {
        // If OPTIONAL, assume this is OK
        if (opt) {
          return -1;
        }
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_MSTRING_WRONG_TAG);
        goto err;
      }
      return asn1_d2i_ex_primitive(pval, in, len, it, otag, 0, 0);

    case ASN1_ITYPE_EXTERN: {
      // We don't support implicit tagging with external types.
      if (tag != -1) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_BAD_TEMPLATE);
        goto err;
      }
      const ASN1_EXTERN_FUNCS *ef =
          reinterpret_cast<const ASN1_EXTERN_FUNCS *>(it->funcs);
      CBS cbs;
      CBS_init(&cbs, *in, len);
      CBS copy = cbs;
      if (!ef->asn1_ex_parse(pval, &cbs, it, opt)) {
        goto err;
      }
      *in = CBS_data(&cbs);
      // Check whether the function skipped an optional element.
      //
      // TODO(crbug.com/42290418): Switch the rest of this function to
      // |asn1_ex_parse|'s calling convention.
      return CBS_len(&cbs) == CBS_len(&copy) ? -1 : 1;
    }

    case ASN1_ITYPE_CHOICE: {
      // It never makes sense for CHOICE types to have implicit tagging, so if
      // tag != -1, then this looks like an error in the template.
      if (tag != -1) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_BAD_TEMPLATE);
        goto err;
      }

      const ASN1_AUX *aux = reinterpret_cast<const ASN1_AUX *>(it->funcs);
      ASN1_aux_cb *asn1_cb = aux != nullptr ? aux->asn1_cb : nullptr;
      if (asn1_cb && !asn1_cb(ASN1_OP_D2I_PRE, pval, it, nullptr)) {
        goto auxerr;
      }

      if (*pval) {
        // Free up and zero CHOICE value if initialised
        i = asn1_get_choice_selector(pval, it);
        if ((i >= 0) && (i < it->tcount)) {
          tt = it->templates + i;
          pchptr = asn1_get_field_ptr(pval, tt);
          ASN1_template_free(pchptr, tt);
          asn1_set_choice_selector(pval, -1, it);
        }
      } else if (!ASN1_item_ex_new(pval, it)) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_NESTED_ASN1_ERROR);
        goto err;
      }
      // CHOICE type, try each possibility in turn
      p = *in;
      for (i = 0, tt = it->templates; i < it->tcount; i++, tt++) {
        pchptr = asn1_get_field_ptr(pval, tt);
        // We mark field as OPTIONAL so its absence can be recognised.
        ret = asn1_template_ex_d2i(pchptr, &p, len, tt, 1, depth);
        // If field not present, try the next one
        if (ret == -1) {
          continue;
        }
        // If positive return, read OK, break loop
        if (ret > 0) {
          break;
        }
        // Otherwise must be an ASN1 parsing error
        errtt = tt;
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_NESTED_ASN1_ERROR);
        goto err;
      }

      // Did we fall off the end without reading anything?
      if (i == it->tcount) {
        // If OPTIONAL, this is OK
        if (opt) {
          // Free and zero it
          ASN1_item_ex_free(pval, it);
          return -1;
        }
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_NO_MATCHING_CHOICE_TYPE);
        goto err;
      }

      asn1_set_choice_selector(pval, i, it);
      if (asn1_cb && !asn1_cb(ASN1_OP_D2I_POST, pval, it, nullptr)) {
        goto auxerr;
      }
      *in = p;
      return 1;
    }

    case ASN1_ITYPE_SEQUENCE: {
      p = *in;

      // If no IMPLICIT tagging set to SEQUENCE, UNIVERSAL
      if (tag == -1) {
        tag = V_ASN1_SEQUENCE;
        aclass = V_ASN1_UNIVERSAL;
      }
      // Get SEQUENCE length and update len, p
      ret = asn1_check_tlen(&len, nullptr, nullptr, &cst, &p, len, tag, aclass,
                            opt);
      if (!ret) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_NESTED_ASN1_ERROR);
        goto err;
      } else if (ret == -1) {
        return -1;
      }
      if (!cst) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_SEQUENCE_NOT_CONSTRUCTED);
        goto err;
      }

      if (!*pval && !ASN1_item_ex_new(pval, it)) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_NESTED_ASN1_ERROR);
        goto err;
      }

      const ASN1_AUX *aux = reinterpret_cast<const ASN1_AUX *>(it->funcs);
      ASN1_aux_cb *asn1_cb = aux != nullptr ? aux->asn1_cb : nullptr;
      if (asn1_cb && !asn1_cb(ASN1_OP_D2I_PRE, pval, it, nullptr)) {
        goto auxerr;
      }

      // Free up and zero any ADB found
      for (i = 0, tt = it->templates; i < it->tcount; i++, tt++) {
        if (tt->flags & ASN1_TFLG_ADB_MASK) {
          const ASN1_TEMPLATE *seqtt;
          ASN1_VALUE **pseqval;
          seqtt = asn1_do_adb(pval, tt, 0);
          if (seqtt == nullptr) {
            continue;
          }
          pseqval = asn1_get_field_ptr(pval, seqtt);
          ASN1_template_free(pseqval, seqtt);
        }
      }

      // Get each field entry
      for (i = 0, tt = it->templates; i < it->tcount; i++, tt++) {
        const ASN1_TEMPLATE *seqtt;
        ASN1_VALUE **pseqval;
        seqtt = asn1_do_adb(pval, tt, 1);
        if (seqtt == nullptr) {
          goto err;
        }
        pseqval = asn1_get_field_ptr(pval, seqtt);
        // Have we ran out of data?
        if (!len) {
          break;
        }
        q = p;
        // This determines the OPTIONAL flag value. The field cannot be
        // omitted if it is the last of a SEQUENCE and there is still
        // data to be read. This isn't strictly necessary but it
        // increases efficiency in some cases.
        if (i == (it->tcount - 1)) {
          isopt = 0;
        } else {
          isopt = (seqtt->flags & ASN1_TFLG_OPTIONAL) != 0;
        }
        // attempt to read in field, allowing each to be OPTIONAL

        ret = asn1_template_ex_d2i(pseqval, &p, len, seqtt, isopt, depth);
        if (!ret) {
          errtt = seqtt;
          goto err;
        } else if (ret == -1) {
          // OPTIONAL component absent. Free and zero the field.
          ASN1_template_free(pseqval, seqtt);
          continue;
        }
        // Update length
        len -= p - q;
      }

      // Check all data read
      if (len) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_SEQUENCE_LENGTH_MISMATCH);
        goto err;
      }

      // If we get here we've got no more data in the SEQUENCE, however we
      // may not have read all fields so check all remaining are OPTIONAL
      // and clear any that are.
      for (; i < it->tcount; tt++, i++) {
        const ASN1_TEMPLATE *seqtt;
        seqtt = asn1_do_adb(pval, tt, 1);
        if (seqtt == nullptr) {
          goto err;
        }
        if (seqtt->flags & ASN1_TFLG_OPTIONAL) {
          ASN1_VALUE **pseqval;
          pseqval = asn1_get_field_ptr(pval, seqtt);
          ASN1_template_free(pseqval, seqtt);
        } else {
          errtt = seqtt;
          OPENSSL_PUT_ERROR(ASN1, ASN1_R_FIELD_MISSING);
          goto err;
        }
      }
      // Save encoding
      if (!asn1_enc_save(pval, *in, p - *in, it)) {
        goto auxerr;
      }
      if (asn1_cb && !asn1_cb(ASN1_OP_D2I_POST, pval, it, nullptr)) {
        goto auxerr;
      }
      *in = p;
      return 1;
    }

    default:
      return 0;
  }
auxerr:
  OPENSSL_PUT_ERROR(ASN1, ASN1_R_AUX_ERROR);
err:
  ASN1_item_ex_free(pval, it);
  if (errtt) {
    ERR_add_error_data(4, "Field=", errtt->field_name, ", Type=", it->sname);
  } else {
    ERR_add_error_data(2, "Type=", it->sname);
  }
  return 0;
}

int ASN1_item_ex_d2i(ASN1_VALUE **pval, const unsigned char **in, long len,
                     const ASN1_ITEM *it, int tag, int aclass, char opt) {
  return asn1_item_ex_d2i(pval, in, len, it, tag, aclass, opt, /*depth=*/0);
}

// Templates are handled with two separate functions. One handles any
// EXPLICIT tag and the other handles the rest.

static int asn1_template_ex_d2i(ASN1_VALUE **val, const unsigned char **in,
                                long inlen, const ASN1_TEMPLATE *tt, char opt,
                                int depth) {
  int aclass;
  int ret;
  long len;
  const unsigned char *p, *q;
  if (!val) {
    return 0;
  }
  uint32_t flags = tt->flags;
  aclass = flags & ASN1_TFLG_TAG_CLASS;

  p = *in;

  // Check if EXPLICIT tag expected
  if (flags & ASN1_TFLG_EXPTAG) {
    char cst;
    // Need to work out amount of data available to the inner content and
    // where it starts: so read in EXPLICIT header to get the info.
    ret = asn1_check_tlen(&len, nullptr, nullptr, &cst, &p, inlen, tt->tag,
                          aclass, opt);
    q = p;
    if (!ret) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_NESTED_ASN1_ERROR);
      return 0;
    } else if (ret == -1) {
      return -1;
    }
    if (!cst) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_EXPLICIT_TAG_NOT_CONSTRUCTED);
      return 0;
    }
    // We've found the field so it can't be OPTIONAL now
    ret = asn1_template_noexp_d2i(val, &p, len, tt, /*opt=*/0, depth);
    if (!ret) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_NESTED_ASN1_ERROR);
      return 0;
    }
    // We read the field in OK so update length
    len -= p - q;
    // Check for trailing data.
    if (len) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_EXPLICIT_LENGTH_MISMATCH);
      goto err;
    }
  } else {
    return asn1_template_noexp_d2i(val, in, inlen, tt, opt, depth);
  }

  *in = p;
  return 1;

err:
  ASN1_template_free(val, tt);
  return 0;
}

static int asn1_template_noexp_d2i(ASN1_VALUE **val, const unsigned char **in,
                                   long len, const ASN1_TEMPLATE *tt, char opt,
                                   int depth) {
  int aclass;
  int ret;
  const unsigned char *p;
  if (!val) {
    return 0;
  }
  uint32_t flags = tt->flags;
  aclass = flags & ASN1_TFLG_TAG_CLASS;

  p = *in;

  if (flags & ASN1_TFLG_SK_MASK) {
    // SET OF, SEQUENCE OF
    int sktag, skaclass;
    // First work out expected inner tag value
    if (flags & ASN1_TFLG_IMPTAG) {
      sktag = tt->tag;
      skaclass = aclass;
    } else {
      skaclass = V_ASN1_UNIVERSAL;
      if (flags & ASN1_TFLG_SET_OF) {
        sktag = V_ASN1_SET;
      } else {
        sktag = V_ASN1_SEQUENCE;
      }
    }
    // Get the tag
    ret = asn1_check_tlen(&len, nullptr, nullptr, nullptr, &p, len, sktag,
                          skaclass, opt);
    if (!ret) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_NESTED_ASN1_ERROR);
      return 0;
    } else if (ret == -1) {
      return -1;
    }
    if (!*val) {
      *val = (ASN1_VALUE *)sk_ASN1_VALUE_new_null();
    } else {
      // We've got a valid STACK: free up any items present
      STACK_OF(ASN1_VALUE) *sktmp = (STACK_OF(ASN1_VALUE) *)*val;
      ASN1_VALUE *vtmp;
      while (sk_ASN1_VALUE_num(sktmp) > 0) {
        vtmp = sk_ASN1_VALUE_pop(sktmp);
        ASN1_item_ex_free(&vtmp, ASN1_ITEM_ptr(tt->item));
      }
    }

    if (!*val) {
      goto err;
    }

    // Read as many items as we can
    while (len > 0) {
      ASN1_VALUE *skfield;
      const unsigned char *q = p;
      skfield = nullptr;
      if (!asn1_item_ex_d2i(&skfield, &p, len, ASN1_ITEM_ptr(tt->item),
                            /*tag=*/-1, /*aclass=*/0, /*opt=*/0, depth)) {
        ASN1_item_ex_free(&skfield, ASN1_ITEM_ptr(tt->item));
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_NESTED_ASN1_ERROR);
        goto err;
      }
      len -= p - q;
      if (!sk_ASN1_VALUE_push((STACK_OF(ASN1_VALUE) *)*val, skfield)) {
        ASN1_item_ex_free(&skfield, ASN1_ITEM_ptr(tt->item));
        goto err;
      }
    }
  } else if (flags & ASN1_TFLG_IMPTAG) {
    // IMPLICIT tagging
    ret = asn1_item_ex_d2i(val, &p, len, ASN1_ITEM_ptr(tt->item), tt->tag,
                           aclass, opt, depth);
    if (!ret) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_NESTED_ASN1_ERROR);
      goto err;
    } else if (ret == -1) {
      return -1;
    }
  } else {
    // Nothing special
    ret = asn1_item_ex_d2i(val, &p, len, ASN1_ITEM_ptr(tt->item), /*tag=*/-1,
                           /*aclass=*/0, opt, depth);
    if (!ret) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_NESTED_ASN1_ERROR);
      goto err;
    } else if (ret == -1) {
      return -1;
    }
  }

  *in = p;
  return 1;

err:
  ASN1_template_free(val, tt);
  return 0;
}

// TODO(crbug.com/42290418): Switch the whole file to use a CBS-based calling
// convention.
static int asn1_d2i_ex_primitive_cbs(ASN1_VALUE **pval, CBS *cbs,
                                     const ASN1_ITEM *it, int tag, int aclass,
                                     char opt);

// asn1_d2i_ex_primitive returns one on success, zero on error, and -1 if an
// optional value was skipped.
static int asn1_d2i_ex_primitive(ASN1_VALUE **pval, const unsigned char **in,
                                 long inlen, const ASN1_ITEM *it, int tag,
                                 int aclass, char opt) {
  CBS cbs;
  CBS_init(&cbs, *in, inlen);
  int ret = asn1_d2i_ex_primitive_cbs(pval, &cbs, it, tag, aclass, opt);
  if (ret <= 0) {
    return ret;
  }
  *in = CBS_data(&cbs);
  return 1;
}

static ASN1_STRING *ensure_string(ASN1_VALUE **pval) {
  if (*pval) {
    return (ASN1_STRING *)*pval;
  }
  ASN1_STRING *str = ASN1_STRING_new();
  if (str == nullptr) {
    return nullptr;
  }
  *pval = (ASN1_VALUE *)str;
  return str;
}

static int asn1_d2i_ex_primitive_cbs(ASN1_VALUE **pval, CBS *cbs,
                                     const ASN1_ITEM *it, int tag, int aclass,
                                     char opt) {
  // Historically, |it->funcs| for primitive types contained an
  // |ASN1_PRIMITIVE_FUNCS| table of callbacks.
  assert(it->funcs == nullptr);

  int utype;
  assert(it->itype == ASN1_ITYPE_PRIMITIVE || it->itype == ASN1_ITYPE_MSTRING);
  if (it->itype == ASN1_ITYPE_MSTRING) {
    // MSTRING passes utype in |tag|, normally used for implicit tagging.
    utype = tag;
    tag = -1;
  } else {
    utype = it->utype;
  }

  // Handle ANY types.
  if (utype == V_ASN1_ANY) {
    if (tag >= 0) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_ILLEGAL_TAGGED_ANY);
      return 0;
    }
    if (opt && CBS_len(cbs) == 0) {
      return -1;  // Omitted OPTIONAL value.
    }
    ASN1_TYPE *typ;
    if (!*pval) {
      typ = ASN1_TYPE_new();
      if (typ == nullptr) {
        return 0;
      }
      *pval = (ASN1_VALUE *)typ;
    } else {
      typ = (ASN1_TYPE *)*pval;
    }
    return asn1_parse_any(cbs, typ);
  }

  // Convert the crypto/asn1 tag into a CBS one.
  if (tag == -1) {
    tag = utype;
    aclass = V_ASN1_UNIVERSAL;
  }

  // All edge cases of |utype| should have been handled already. |utype| is now
  // either a primitive |ASN1_ITEM|, handled by |DECLARE_ASN1_ITEM|, or a
  // multistring option with a corresponding |B_ASN1_*| constant.
  assert(utype >= 0 && utype <= V_ASN1_MAX_UNIVERSAL);
  CBS_ASN1_TAG cbs_tag =
      (static_cast<CBS_ASN1_TAG>(aclass) << CBS_ASN1_TAG_SHIFT) |
      static_cast<CBS_ASN1_TAG>(tag);
  if (utype == V_ASN1_SEQUENCE || utype == V_ASN1_SET) {
    cbs_tag |= CBS_ASN1_CONSTRUCTED;
  }

  if (opt && !CBS_peek_asn1_tag(cbs, cbs_tag)) {
    return -1;  // Omitted OPTIONAL value.
  }

  // Handle non-|ASN1_STRING| types.
  switch (utype) {
    case V_ASN1_OBJECT: {
      bssl::UniquePtr<ASN1_OBJECT> obj(asn1_parse_object(cbs, cbs_tag));
      if (obj == nullptr) {
        return 0;
      }
      ASN1_OBJECT_free((ASN1_OBJECT *)*pval);
      *pval = (ASN1_VALUE *)obj.release();
      return 1;
    }
    case V_ASN1_NULL: {
      CBS null;
      if (!CBS_get_asn1(cbs, &null, cbs_tag)) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
        return 0;
      }
      if (CBS_len(&null) != 0) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_NULL_IS_WRONG_LENGTH);
        return 0;
      }
      *pval = (ASN1_VALUE *)1;
      return 1;
    }
    case V_ASN1_BOOLEAN: {
      CBS child;
      if (!CBS_get_asn1(cbs, &child, cbs_tag)) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
        return 0;
      }
      // TODO(crbug.com/42290221): Reject invalid BOOLEAN encodings and just
      // call |CBS_get_asn1_bool|.
      if (CBS_len(&child) != 1) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_BOOLEAN_IS_WRONG_LENGTH);
        return 0;
      }
      ASN1_BOOLEAN *tbool;
      tbool = (ASN1_BOOLEAN *)pval;
      *tbool = CBS_data(&child)[0];
      return 1;
    }
  }

  // All other types as an |ASN1_STRING| representation.
  ASN1_STRING *str = ensure_string(pval);
  if (str == nullptr) {
    return 0;
  }

  switch (utype) {
    case V_ASN1_BIT_STRING:
      return asn1_parse_bit_string(cbs, str, cbs_tag);
    case V_ASN1_INTEGER:
      return asn1_parse_integer(cbs, str, cbs_tag);
    case V_ASN1_ENUMERATED:
      return asn1_parse_enumerated(cbs, str, cbs_tag);
    case V_ASN1_UNIVERSALSTRING:
      return asn1_parse_universal_string(cbs, str, cbs_tag);
    case V_ASN1_BMPSTRING:
      return asn1_parse_bmp_string(cbs, str, cbs_tag);
    case V_ASN1_UTF8STRING:
      return asn1_parse_utf8_string(cbs, str, cbs_tag);
    case V_ASN1_UTCTIME:
      // TODO(crbug.com/42290221): Reject timezone offsets. We need to parse
      // invalid timestamps in |X509| objects, but that parser no longer uses
      // this code.
      return asn1_parse_utc_time(cbs, str, cbs_tag,
                                 /*allow_timezone_offset=*/1);
    case V_ASN1_GENERALIZEDTIME:
      return asn1_parse_generalized_time(cbs, str, cbs_tag);
    case V_ASN1_OCTET_STRING:
    case V_ASN1_NUMERICSTRING:
    case V_ASN1_PRINTABLESTRING:
    case V_ASN1_T61STRING:
    case V_ASN1_VIDEOTEXSTRING:
    case V_ASN1_IA5STRING:
    case V_ASN1_GRAPHICSTRING:
    case V_ASN1_VISIBLESTRING:
    case V_ASN1_GENERALSTRING:
      // T61String is parsed as Latin-1, so all byte strings are valid. The
      // others we currently do not enforce.
      //
      // TODO(crbug.com/42290290): Enforce the encoding of the other string
      // types.
      if (!asn1_parse_octet_string(cbs, str, cbs_tag)) {
        return 0;
      }
      str->type = utype;
      return 1;
    case V_ASN1_SEQUENCE: {
      // Save the entire element in the string.
      CBS elem;
      if (!CBS_get_asn1_element(cbs, &elem, cbs_tag)) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
        return 0;
      }
      str->type = V_ASN1_SEQUENCE;
      return ASN1_STRING_set(str, CBS_data(&elem), CBS_len(&elem));
    }
    default:
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_BAD_TEMPLATE);
      return 0;
    }
}

// Check an ASN1 tag and length: a bit like ASN1_get_object but it
// checks the expected tag.

static int asn1_check_tlen(long *olen, int *otag, unsigned char *oclass,
                           char *cst, const unsigned char **in, long len,
                           int exptag, int expclass, char opt) {
  int i;
  int ptag, pclass;
  long plen;
  const unsigned char *p;
  p = *in;

  i = ASN1_get_object(&p, &plen, &ptag, &pclass, len);
  if (i & 0x80) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_BAD_OBJECT_HEADER);
    return 0;
  }
  if (exptag >= 0) {
    if ((exptag != ptag) || (expclass != pclass)) {
      // If type is OPTIONAL, not an error: indicate missing type.
      if (opt) {
        return -1;
      }
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_WRONG_TAG);
      return 0;
    }
  }

  if (cst) {
    *cst = i & V_ASN1_CONSTRUCTED;
  }

  if (olen) {
    *olen = plen;
  }

  if (oclass) {
    *oclass = pclass;
  }

  if (otag) {
    *otag = ptag;
  }

  *in = p;
  return 1;
}
