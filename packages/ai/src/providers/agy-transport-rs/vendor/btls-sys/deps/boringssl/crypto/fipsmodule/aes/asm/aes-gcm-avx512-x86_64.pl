#!/usr/bin/env perl
# Copyright 2024 The BoringSSL Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
#------------------------------------------------------------------------------
#
# This is an AES-GCM implementation for x86_64 CPUs that support the following
# CPU features: VAES && VPCLMULQDQ && AVX512BW && AVX512VL && BMI2.
#
# This file is based on aes-gcm-avx10-x86_64.S from the Linux kernel
# (https://git.kernel.org/linus/b06affb1cb580e13).  The following notable
# changes have been made:
#
# - Relicensed under BoringSSL's preferred license.
#
# - Converted from GNU assembler to "perlasm".  This was necessary for
#   compatibility with BoringSSL's Windows builds which use NASM instead of the
#   GNU assembler.  It was also necessary for compatibility with the 'delocate'
#   tool used in BoringSSL's FIPS builds.
#
# - Added support for the Windows ABI.
#
# - Changed function prototypes to be compatible with what BoringSSL wants.
#
# - Removed the optimized finalization function, as BoringSSL doesn't want it.
#
# - Added a single-block GHASH multiplication function, as BoringSSL needs this.
#
# - Added optimization for large amounts of AAD.
#
# - Removed support for maximum vector lengths other than 512 bits.

use strict;

my $flavour = shift;
my $output  = shift;
if ( $flavour =~ /\./ ) { $output = $flavour; undef $flavour; }

my $win64;
my @argregs;
if ( $flavour =~ /[nm]asm|mingw64/ || $output =~ /\.asm$/ ) {
    $win64   = 1;
    @argregs = ( "%rcx", "%rdx", "%r8", "%r9" );
}
else {
    $win64   = 0;
    @argregs = ( "%rdi", "%rsi", "%rdx", "%rcx", "%r8", "%r9" );
}

$0 =~ m/(.*[\/\\])[^\/\\]+$/;
my $dir = $1;
my $xlate;
( $xlate = "${dir}x86_64-xlate.pl" and -f $xlate )
  or ( $xlate = "${dir}../../../perlasm/x86_64-xlate.pl" and -f $xlate )
  or die "can't locate x86_64-xlate.pl";

open OUT, "| \"$^X\" \"$xlate\" $flavour \"$output\"";
*STDOUT = *OUT;

my $g_cur_func_name;
my $g_cur_func_uses_seh;
my @g_cur_func_saved_gpregs;
my @g_cur_func_saved_xmmregs;

sub _begin_func {
    my ( $funcname, $uses_seh ) = @_;
    $g_cur_func_name          = $funcname;
    $g_cur_func_uses_seh      = $uses_seh;
    @g_cur_func_saved_gpregs  = ();
    @g_cur_func_saved_xmmregs = ();
    return <<___;
.globl $funcname
.type $funcname,\@abi-omnipotent
.align 32
$funcname:
    .cfi_startproc
    @{[ $uses_seh ? ".seh_startproc" : "" ]}
    _CET_ENDBR
___
}

# Push a list of general purpose registers onto the stack.
sub _save_gpregs {
    my @gpregs = @_;
    my $code   = "";
    die "_save_gpregs requires uses_seh" unless $g_cur_func_uses_seh;
    die "_save_gpregs can only be called once per function"
      if @g_cur_func_saved_gpregs;
    die "Order must be _save_gpregs, then _save_xmmregs"
      if @g_cur_func_saved_xmmregs;
    @g_cur_func_saved_gpregs = @gpregs;
    for my $reg (@gpregs) {
        $code .= "push $reg\n";
        if ($win64) {
            $code .= ".seh_pushreg $reg\n";
        }
        else {
            $code .= ".cfi_push $reg\n";
        }
    }
    return $code;
}

# Push a list of xmm registers onto the stack if the target is Windows.
sub _save_xmmregs {
    my @xmmregs     = @_;
    my $num_xmmregs = scalar @xmmregs;
    my $code        = "";
    die "_save_xmmregs requires uses_seh" unless $g_cur_func_uses_seh;
    die "_save_xmmregs can only be called once per function"
      if @g_cur_func_saved_xmmregs;
    if ( $win64 and $num_xmmregs > 0 ) {
        @g_cur_func_saved_xmmregs = @xmmregs;
        my $is_misaligned = ( scalar @g_cur_func_saved_gpregs ) % 2 == 0;
        my $alloc_size    = 16 * $num_xmmregs + ( $is_misaligned ? 8 : 0 );
        $code .= "sub \$$alloc_size, %rsp\n";
        $code .= ".seh_stackalloc $alloc_size\n";
        for my $i ( 0 .. $num_xmmregs - 1 ) {
            my $reg_num = $xmmregs[$i];
            my $pos     = 16 * $i;
            $code .= "vmovdqa %xmm$reg_num, $pos(%rsp)\n";
            $code .= ".seh_savexmm %xmm$reg_num, $pos\n";
        }
    }
    return $code;
}

sub _end_func {
    my $code = "";

    # Restore any xmm registers that were saved earlier.
    my $num_xmmregs = scalar @g_cur_func_saved_xmmregs;
    if ( $win64 and $num_xmmregs > 0 ) {
        my $need_alignment = ( scalar @g_cur_func_saved_gpregs ) % 2 == 0;
        my $alloc_size     = 16 * $num_xmmregs + ( $need_alignment ? 8 : 0 );
        for my $i ( 0 .. $num_xmmregs - 1 ) {
            my $reg_num = $g_cur_func_saved_xmmregs[$i];
            my $pos     = 16 * $i;
            $code .= "vmovdqa $pos(%rsp), %xmm$reg_num\n";
        }
        $code .= "add \$$alloc_size, %rsp\n";
    }

    # Restore any general purpose registers that were saved earlier.
    for my $reg ( reverse @g_cur_func_saved_gpregs ) {
        $code .= "pop $reg\n";
        if ( !$win64 ) {
            $code .= ".cfi_pop $reg\n";
        }
    }

    $code .= <<___;
    ret
    @{[ $g_cur_func_uses_seh ? ".seh_endproc" : "" ]}
    .cfi_endproc
    .size   $g_cur_func_name, . - $g_cur_func_name
___
    return $code;
}

my $code = <<___;
.section .rodata
.align 64

    # A shuffle mask that reflects the bytes of 16-byte blocks
.Lbswap_mask:
    .quad   0x08090a0b0c0d0e0f, 0x0001020304050607

    # This is the GHASH reducing polynomial without its constant term, i.e.
    # x^128 + x^7 + x^2 + x, represented using the backwards mapping
    # between bits and polynomial coefficients.
    #
    # Alternatively, it can be interpreted as the naturally-ordered
    # representation of the polynomial x^127 + x^126 + x^121 + 1, i.e. the
    # "reversed" GHASH reducing polynomial without its x^128 term.
.Lgfpoly:
    .quad   1, 0xc200000000000000

    # Same as above, but with the (1 << 64) bit set.
.Lgfpoly_and_internal_carrybit:
    .quad   1, 0xc200000000000001

    # Values needed to prepare the initial vector of counter blocks.
.Lctr_pattern:
    .quad   0, 0
    .quad   1, 0
    .quad   2, 0
    .quad   3, 0

    # The number of AES blocks per vector, as a 128-bit value.
.Linc_4blocks:
    .quad   4, 0

.text
___

# Number of powers of the hash key stored in the key struct.  The powers are
# stored from highest (H^NUM_H_POWERS) to lowest (H^1).
my $NUM_H_POWERS = 16;

my $OFFSETOFEND_H_POWERS = $NUM_H_POWERS * 16;

# Offset to 'rounds' in AES_KEY struct
my $OFFSETOF_AES_ROUNDS = 240;

# The _ghash_mul macro multiplies the 128-bit lanes of \a by the corresponding
# 128-bit lanes of \b and stores the reduced products in \dst.  \t0, \t1, and
# \t2 are temporary registers of the same size as \a and \b.
#
# The multiplications are done in GHASH's representation of the finite field
# GF(2^128).  Elements of GF(2^128) are represented as binary polynomials
# (i.e. polynomials whose coefficients are bits) modulo a reducing polynomial
# G.  The GCM specification uses G = x^128 + x^7 + x^2 + x + 1.  Addition is
# just XOR, while multiplication is more complex and has two parts: (a) do
# carryless multiplication of two 128-bit input polynomials to get a 256-bit
# intermediate product polynomial, and (b) reduce the intermediate product to
# 128 bits by adding multiples of G that cancel out terms in it.  (Adding
# multiples of G doesn't change which field element the polynomial represents.)
#
# Unfortunately, the GCM specification maps bits to/from polynomial
# coefficients backwards from the natural order.  In each byte it specifies the
# highest bit to be the lowest order polynomial coefficient, *not* the highest!
# This makes it nontrivial to work with the GHASH polynomials.  We could
# reflect the bits, but x86 doesn't have an instruction that does that.
#
# Instead, we operate on the values without bit-reflecting them.  This *mostly*
# just works, since XOR and carryless multiplication are symmetric with respect
# to bit order, but it has some consequences.  First, due to GHASH's byte
# order, by skipping bit reflection, *byte* reflection becomes necessary to
# give the polynomial terms a consistent order.  E.g., considering an N-bit
# value interpreted using the G = x^128 + x^7 + x^2 + x + 1 convention, bits 0
# through N-1 of the byte-reflected value represent the coefficients of x^(N-1)
# through x^0, whereas bits 0 through N-1 of the non-byte-reflected value
# represent x^7...x^0, x^15...x^8, ..., x^(N-1)...x^(N-8) which can't be worked
# with.  Fortunately, x86's vpshufb instruction can do byte reflection.
#
# Second, forgoing the bit reflection causes an extra multiple of x (still
# using the G = x^128 + x^7 + x^2 + x + 1 convention) to be introduced by each
# multiplication.  This is because an M-bit by N-bit carryless multiplication
# really produces a (M+N-1)-bit product, but in practice it's zero-extended to
# M+N bits.  In the G = x^128 + x^7 + x^2 + x + 1 convention, which maps bits
# to polynomial coefficients backwards, this zero-extension actually changes
# the product by introducing an extra factor of x.  Therefore, users of this
# macro must ensure that one of the inputs has an extra factor of x^-1, i.e.
# the multiplicative inverse of x, to cancel out the extra x.
#
# Third, the backwards coefficients convention is just confusing to work with,
# since it makes "low" and "high" in the polynomial math mean the opposite of
# their normal meaning in computer programming.  This can be solved by using an
# alternative interpretation: the polynomial coefficients are understood to be
# in the natural order, and the multiplication is actually \a * \b * x^-128 mod
# x^128 + x^127 + x^126 + x^121 + 1.  This doesn't change the inputs, outputs,
# or the implementation at all; it just changes the mathematical interpretation
# of what each instruction is doing.  Starting from here, we'll use this
# alternative interpretation, as it's easier to understand the code that way.
#
# Moving onto the implementation, the vpclmulqdq instruction does 64 x 64 =>
# 128-bit carryless multiplication, so we break the 128 x 128 multiplication
# into parts as follows (the _L and _H suffixes denote low and high 64 bits):
#
#     LO = a_L * b_L
#     MI = (a_L * b_H) + (a_H * b_L)
#     HI = a_H * b_H
#
# The 256-bit product is x^128*HI + x^64*MI + LO.  LO, MI, and HI are 128-bit.
# Note that MI "overlaps" with LO and HI.  We don't consolidate MI into LO and
# HI right away, since the way the reduction works makes that unnecessary.
#
# For the reduction, we cancel out the low 128 bits by adding multiples of G =
# x^128 + x^127 + x^126 + x^121 + 1.  This is done by two iterations, each of
# which cancels out the next lowest 64 bits.  Consider a value x^64*A + B,
# where A and B are 128-bit.  Adding B_L*G to that value gives:
#
#       x^64*A + B + B_L*G
#     = x^64*A + x^64*B_H + B_L + B_L*(x^128 + x^127 + x^126 + x^121 + 1)
#     = x^64*A + x^64*B_H + B_L + x^128*B_L + x^64*B_L*(x^63 + x^62 + x^57) + B_L
#     = x^64*A + x^64*B_H + x^128*B_L + x^64*B_L*(x^63 + x^62 + x^57) + B_L + B_L
#     = x^64*(A + B_H + x^64*B_L + B_L*(x^63 + x^62 + x^57))
#
# So: if we sum A, B with its halves swapped, and the low half of B times x^63
# + x^62 + x^57, we get a 128-bit value C where x^64*C is congruent to the
# original value x^64*A + B.  I.e., the low 64 bits got canceled out.
#
# We just need to apply this twice: first to fold LO into MI, and second to
# fold the updated MI into HI.
#
# The needed three-argument XORs are done using the vpternlogd instruction with
# immediate 0x96, since this is faster than two vpxord instructions.
#
# A potential optimization, assuming that b is fixed per-key (if a is fixed
# per-key it would work the other way around), is to use one iteration of the
# reduction described above to precompute a value c such that x^64*c = b mod G,
# and then multiply a_L by c (and implicitly by x^64) instead of by b:
#
#     MI = (a_L * c_L) + (a_H * b_L)
#     HI = (a_L * c_H) + (a_H * b_H)
#
# This would eliminate the LO part of the intermediate product, which would
# eliminate the need to fold LO into MI.  This would save two instructions,
# including a vpclmulqdq.  However, we currently don't use this optimization
# because it would require twice as many per-key precomputed values.
#
# Using Karatsuba multiplication instead of "schoolbook" multiplication
# similarly would save a vpclmulqdq but does not seem to be worth it.
sub _ghash_mul {
    my ( $a, $b, $dst, $gfpoly, $t0, $t1, $t2 ) = @_;
    return <<___;
    vpclmulqdq      \$0x00, $a, $b, $t0        # LO = a_L * b_L
    vpclmulqdq      \$0x01, $a, $b, $t1        # MI_0 = a_L * b_H
    vpclmulqdq      \$0x10, $a, $b, $t2        # MI_1 = a_H * b_L
    vpxord          $t2, $t1, $t1              # MI = MI_0 + MI_1
    vpclmulqdq      \$0x01, $t0, $gfpoly, $t2  # LO_L*(x^63 + x^62 + x^57)
    vpshufd         \$0x4e, $t0, $t0           # Swap halves of LO
    vpternlogd      \$0x96, $t2, $t0, $t1      # Fold LO into MI
    vpclmulqdq      \$0x11, $a, $b, $dst       # HI = a_H * b_H
    vpclmulqdq      \$0x01, $t1, $gfpoly, $t0  # MI_L*(x^63 + x^62 + x^57)
    vpshufd         \$0x4e, $t1, $t1           # Swap halves of MI
    vpternlogd      \$0x96, $t0, $t1, $dst     # Fold MI into HI
___
}

# GHASH-multiply the 128-bit lanes of \a by the 128-bit lanes of \b and add the
# *unreduced* products to \lo, \mi, and \hi.
sub _ghash_mul_noreduce {
    my ( $a, $b, $lo, $mi, $hi, $t0, $t1, $t2, $t3 ) = @_;
    return <<___;
    vpclmulqdq      \$0x00, $a, $b, $t0      # a_L * b_L
    vpclmulqdq      \$0x01, $a, $b, $t1      # a_L * b_H
    vpclmulqdq      \$0x10, $a, $b, $t2      # a_H * b_L
    vpclmulqdq      \$0x11, $a, $b, $t3      # a_H * b_H
    vpxord          $t0, $lo, $lo
    vpternlogd      \$0x96, $t2, $t1, $mi
    vpxord          $t3, $hi, $hi
___
}

# Reduce the unreduced products from \lo, \mi, and \hi and store the 128-bit
# reduced products in \hi.  See _ghash_mul for explanation of reduction.
sub _ghash_reduce {
    my ( $lo, $mi, $hi, $gfpoly, $t0 ) = @_;
    return <<___;
    vpclmulqdq      \$0x01, $lo, $gfpoly, $t0
    vpshufd         \$0x4e, $lo, $lo
    vpternlogd      \$0x96, $t0, $lo, $mi
    vpclmulqdq      \$0x01, $mi, $gfpoly, $t0
    vpshufd         \$0x4e, $mi, $mi
    vpternlogd      \$0x96, $t0, $mi, $hi
___
}

# This is a specialized version of _ghash_mul that computes \a * \a, i.e. it
# squares \a.  It skips computing MI = (a_L * a_H) + (a_H * a_L) = 0.
sub _ghash_square {
    my ( $a, $dst, $gfpoly, $t0, $t1 ) = @_;
    return <<___;
    vpclmulqdq      \$0x00, $a, $a, $t0        # LO = a_L * a_L
    vpclmulqdq      \$0x11, $a, $a, $dst       # HI = a_H * a_H
    vpclmulqdq      \$0x01, $t0, $gfpoly, $t1  # LO_L*(x^63 + x^62 + x^57)
    vpshufd         \$0x4e, $t0, $t0           # Swap halves of LO
    vpxor           $t0, $t1, $t1              # Fold LO into MI
    vpclmulqdq      \$0x01, $t1, $gfpoly, $t0  # MI_L*(x^63 + x^62 + x^57)
    vpshufd         \$0x4e, $t1, $t1           # Swap halves of MI
    vpternlogd      \$0x96, $t0, $t1, $dst     # Fold MI into HI
___
}

# void gcm_init_vpclmulqdq_avx512(u128 Htable[16], const uint64_t H[2]);
#
# Initialize |Htable| with powers of the GHASH subkey |H|.
#
# The powers are stored in the order H^NUM_H_POWERS to H^1.
$code .= _begin_func "gcm_init_vpclmulqdq_avx512", 0;
{
    # Function arguments
    my ( $HTABLE, $H_PTR ) = @argregs[ 0 .. 1 ];

    # Additional local variables.  %rax is used as a temporary register.
    my ( $TMP0, $TMP0_YMM, $TMP0_XMM ) = ( "%zmm0", "%ymm0", "%xmm0" );
    my ( $TMP1, $TMP1_YMM, $TMP1_XMM ) = ( "%zmm1", "%ymm1", "%xmm1" );
    my ( $TMP2, $TMP2_YMM, $TMP2_XMM ) = ( "%zmm2", "%ymm2", "%xmm2" );
    my $POWERS_PTR     = "%r8";
    my $RNDKEYLAST_PTR = "%r9";
    my ( $H_CUR, $H_CUR_YMM, $H_CUR_XMM )    = ( "%zmm3", "%ymm3", "%xmm3" );
    my ( $H_INC, $H_INC_YMM, $H_INC_XMM )    = ( "%zmm4", "%ymm4", "%xmm4" );
    my ( $GFPOLY, $GFPOLY_YMM, $GFPOLY_XMM ) = ( "%zmm5", "%ymm5", "%xmm5" );

    $code .= <<___;
    # Get pointer to lowest set of key powers (located at end of array).
    lea             $OFFSETOFEND_H_POWERS-64($HTABLE), $POWERS_PTR

    # Load the byte-reflected hash subkey.  BoringSSL provides it in
    # byte-reflected form except the two halves are in the wrong order.
    vpshufd         \$0x4e, ($H_PTR), $H_CUR_XMM

    # Finish preprocessing the first key power, H^1.  Since this GHASH
    # implementation operates directly on values with the backwards bit
    # order specified by the GCM standard, it's necessary to preprocess the
    # raw key as follows.  First, reflect its bytes.  Second, multiply it
    # by x^-1 mod x^128 + x^7 + x^2 + x + 1 (if using the backwards
    # interpretation of polynomial coefficients), which can also be
    # interpreted as multiplication by x mod x^128 + x^127 + x^126 + x^121
    # + 1 using the alternative, natural interpretation of polynomial
    # coefficients.  For details, see the comment above _ghash_mul.
    #
    # Either way, for the multiplication the concrete operation performed
    # is a left shift of the 128-bit value by 1 bit, then an XOR with (0xc2
    # << 120) | 1 if a 1 bit was carried out.  However, there's no 128-bit
    # wide shift instruction, so instead double each of the two 64-bit
    # halves and incorporate the internal carry bit into the value XOR'd.
    vpshufd         \$0xd3, $H_CUR_XMM, $TMP0_XMM
    vpsrad          \$31, $TMP0_XMM, $TMP0_XMM
    vpaddq          $H_CUR_XMM, $H_CUR_XMM, $H_CUR_XMM
    # H_CUR_XMM ^= TMP0_XMM & gfpoly_and_internal_carrybit
    vpternlogd      \$0x78, .Lgfpoly_and_internal_carrybit(%rip), $TMP0_XMM, $H_CUR_XMM

    # Load the gfpoly constant.
    vbroadcasti32x4 .Lgfpoly(%rip), $GFPOLY

    # Square H^1 to get H^2.
    #
    # Note that as with H^1, all higher key powers also need an extra
    # factor of x^-1 (or x using the natural interpretation).  Nothing
    # special needs to be done to make this happen, though: H^1 * H^1 would
    # end up with two factors of x^-1, but the multiplication consumes one.
    # So the product H^2 ends up with the desired one factor of x^-1.
    @{[ _ghash_square  $H_CUR_XMM, $H_INC_XMM, $GFPOLY_XMM,
                       $TMP0_XMM, $TMP1_XMM ]}

    # Create H_CUR_YMM = [H^2, H^1] and H_INC_YMM = [H^2, H^2].
    vinserti128     \$1, $H_CUR_XMM, $H_INC_YMM, $H_CUR_YMM
    vinserti128     \$1, $H_INC_XMM, $H_INC_YMM, $H_INC_YMM

    # Create H_CUR = [H^4, H^3, H^2, H^1] and H_INC = [H^4, H^4, H^4, H^4].
    @{[ _ghash_mul  $H_INC_YMM, $H_CUR_YMM, $H_INC_YMM, $GFPOLY_YMM,
                    $TMP0_YMM, $TMP1_YMM, $TMP2_YMM ]}
    vinserti64x4    \$1, $H_CUR_YMM, $H_INC, $H_CUR
    vshufi64x2      \$0, $H_INC, $H_INC, $H_INC

    # Store the lowest set of key powers.
    vmovdqu8        $H_CUR, ($POWERS_PTR)

    # Compute and store the remaining key powers.
    # Repeatedly multiply [H^(i+3), H^(i+2), H^(i+1), H^i] by
    # [H^4, H^4, H^4, H^4] to get [H^(i+7), H^(i+6), H^(i+5), H^(i+4)].
    mov             \$3, %eax
.Lprecompute_next:
    sub             \$64, $POWERS_PTR
    @{[ _ghash_mul  $H_INC, $H_CUR, $H_CUR, $GFPOLY, $TMP0, $TMP1, $TMP2 ]}
    vmovdqu8        $H_CUR, ($POWERS_PTR)
    dec             %eax
    jnz             .Lprecompute_next

    vzeroupper      # This is needed after using ymm or zmm registers.
___
}
$code .= _end_func;

# XOR together the 128-bit lanes of \src (whose low lane is \src_xmm) and store
# the result in \dst_xmm.  This implicitly zeroizes the other lanes of dst.
sub _horizontal_xor {
    my ( $src, $src_xmm, $dst_xmm, $t0_xmm, $t1_xmm, $t2_xmm ) = @_;
    return <<___;
    vextracti32x4   \$1, $src, $t0_xmm
    vextracti32x4   \$2, $src, $t1_xmm
    vextracti32x4   \$3, $src, $t2_xmm
    vpxord          $t0_xmm, $src_xmm, $dst_xmm
    vpternlogd      \$0x96, $t1_xmm, $t2_xmm, $dst_xmm
___
}

# Do one step of the GHASH update of the data blocks given in the vector
# registers GHASHDATA[0-3].  \i specifies the step to do, 0 through 9.  The
# division into steps allows users of this macro to optionally interleave the
# computation with other instructions.  This macro uses the vector register
# GHASH_ACC as input/output; GHASHDATA[0-3] as inputs that are clobbered;
# H_POW[4-1], GFPOLY, and BSWAP_MASK as inputs that aren't clobbered; and
# GHASHTMP[0-2] as temporaries.  This macro handles the byte-reflection of the
# data blocks.  The parameter registers must be preserved across steps.
#
# The GHASH update does: GHASH_ACC = H_POW4*(GHASHDATA0 + GHASH_ACC) +
# H_POW3*GHASHDATA1 + H_POW2*GHASHDATA2 + H_POW1*GHASHDATA3, where the
# operations are vectorized operations on 512-bit vectors of 128-bit blocks.
# The vectorized terms correspond to the following non-vectorized terms:
#
#       H_POW4*(GHASHDATA0 + GHASH_ACC) => H^16*(blk0 + GHASH_ACC_XMM),
#              H^15*(blk1 + 0), H^14*(blk2 + 0), and H^13*(blk3 + 0)
#       H_POW3*GHASHDATA1 => H^12*blk4, H^11*blk5, H^10*blk6, and H^9*blk7
#       H_POW2*GHASHDATA2 => H^8*blk8,  H^7*blk9,  H^6*blk10, and H^5*blk11
#       H_POW1*GHASHDATA3 => H^4*blk12, H^3*blk13, H^2*blk14, and H^1*blk15
#
# More concretely, this code does:
#   - Do vectorized "schoolbook" multiplications to compute the intermediate
#     256-bit product of each block and its corresponding hash key power.
#   - Sum (XOR) the intermediate 256-bit products across vectors.
#   - Do a vectorized reduction of these 256-bit intermediate values to 128-bits
#     each.
#   - Sum (XOR) these values and store the 128-bit result in GHASH_ACC_XMM.
#
# See _ghash_mul for the full explanation of the operations performed for each
# individual finite field multiplication and reduction.
sub _ghash_step_4x {
    my (
        $i,              $BSWAP_MASK,     $GHASHDATA0,     $GHASHDATA1,
        $GHASHDATA2,     $GHASHDATA3,     $GHASHDATA0_XMM, $GHASHDATA1_XMM,
        $GHASHDATA2_XMM, $GHASHDATA3_XMM, $H_POW4,         $H_POW3,
        $H_POW2,         $H_POW1,         $GFPOLY,         $GHASHTMP0,
        $GHASHTMP1,      $GHASHTMP2,      $GHASH_ACC,      $GHASH_ACC_XMM
    ) = @_;
    if ( $i == 0 ) {
        return <<___;
        vpshufb         $BSWAP_MASK, $GHASHDATA0, $GHASHDATA0
        vpxord          $GHASH_ACC, $GHASHDATA0, $GHASHDATA0
        vpshufb         $BSWAP_MASK, $GHASHDATA1, $GHASHDATA1
        vpshufb         $BSWAP_MASK, $GHASHDATA2, $GHASHDATA2
___
    }
    elsif ( $i == 1 ) {
        return <<___;
        vpshufb         $BSWAP_MASK, $GHASHDATA3, $GHASHDATA3
        vpclmulqdq      \$0x00, $H_POW4, $GHASHDATA0, $GHASH_ACC    # LO_0
        vpclmulqdq      \$0x00, $H_POW3, $GHASHDATA1, $GHASHTMP0    # LO_1
        vpclmulqdq      \$0x00, $H_POW2, $GHASHDATA2, $GHASHTMP1    # LO_2
___
    }
    elsif ( $i == 2 ) {
        return <<___;
        vpxord          $GHASHTMP0, $GHASH_ACC, $GHASH_ACC          # sum(LO_{1,0})
        vpclmulqdq      \$0x00, $H_POW1, $GHASHDATA3, $GHASHTMP2    # LO_3
        vpternlogd      \$0x96, $GHASHTMP2, $GHASHTMP1, $GHASH_ACC  # LO = sum(LO_{3,2,1,0})
        vpclmulqdq      \$0x01, $H_POW4, $GHASHDATA0, $GHASHTMP0    # MI_0
___
    }
    elsif ( $i == 3 ) {
        return <<___;
        vpclmulqdq      \$0x01, $H_POW3, $GHASHDATA1, $GHASHTMP1    # MI_1
        vpclmulqdq      \$0x01, $H_POW2, $GHASHDATA2, $GHASHTMP2    # MI_2
        vpternlogd      \$0x96, $GHASHTMP2, $GHASHTMP1, $GHASHTMP0  # sum(MI_{2,1,0})
        vpclmulqdq      \$0x01, $H_POW1, $GHASHDATA3, $GHASHTMP1    # MI_3
___
    }
    elsif ( $i == 4 ) {
        return <<___;
        vpclmulqdq      \$0x10, $H_POW4, $GHASHDATA0, $GHASHTMP2    # MI_4
        vpternlogd      \$0x96, $GHASHTMP2, $GHASHTMP1, $GHASHTMP0  # sum(MI_{4,3,2,1,0})
        vpclmulqdq      \$0x10, $H_POW3, $GHASHDATA1, $GHASHTMP1    # MI_5
        vpclmulqdq      \$0x10, $H_POW2, $GHASHDATA2, $GHASHTMP2    # MI_6
___
    }
    elsif ( $i == 5 ) {
        return <<___;
        vpternlogd      \$0x96, $GHASHTMP2, $GHASHTMP1, $GHASHTMP0  # sum(MI_{6,5,4,3,2,1,0})
        vpclmulqdq      \$0x01, $GHASH_ACC, $GFPOLY, $GHASHTMP2     # LO_L*(x^63 + x^62 + x^57)
        vpclmulqdq      \$0x10, $H_POW1, $GHASHDATA3, $GHASHTMP1    # MI_7
        vpxord          $GHASHTMP1, $GHASHTMP0, $GHASHTMP0          # MI = sum(MI_{7,6,5,4,3,2,1,0})
___
    }
    elsif ( $i == 6 ) {
        return <<___;
        vpshufd         \$0x4e, $GHASH_ACC, $GHASH_ACC              # Swap halves of LO
        vpclmulqdq      \$0x11, $H_POW4, $GHASHDATA0, $GHASHDATA0   # HI_0
        vpclmulqdq      \$0x11, $H_POW3, $GHASHDATA1, $GHASHDATA1   # HI_1
        vpclmulqdq      \$0x11, $H_POW2, $GHASHDATA2, $GHASHDATA2   # HI_2
___
    }
    elsif ( $i == 7 ) {
        return <<___;
        vpternlogd      \$0x96, $GHASHTMP2, $GHASH_ACC, $GHASHTMP0  # Fold LO into MI
        vpclmulqdq      \$0x11, $H_POW1, $GHASHDATA3, $GHASHDATA3   # HI_3
        vpternlogd      \$0x96, $GHASHDATA2, $GHASHDATA1, $GHASHDATA0 # sum(HI_{2,1,0})
        vpclmulqdq      \$0x01, $GHASHTMP0, $GFPOLY, $GHASHTMP1     # MI_L*(x^63 + x^62 + x^57)
___
    }
    elsif ( $i == 8 ) {
        return <<___;
        vpxord          $GHASHDATA3, $GHASHDATA0, $GHASH_ACC        # HI = sum(HI_{3,2,1,0})
        vpshufd         \$0x4e, $GHASHTMP0, $GHASHTMP0              # Swap halves of MI
        vpternlogd      \$0x96, $GHASHTMP1, $GHASHTMP0, $GHASH_ACC  # Fold MI into HI
___
    }
    elsif ( $i == 9 ) {
        return _horizontal_xor $GHASH_ACC, $GHASH_ACC_XMM, $GHASH_ACC_XMM,
          $GHASHDATA0_XMM, $GHASHDATA1_XMM, $GHASHDATA2_XMM;
    }
}

# Update GHASH with four vectors of data blocks.  See _ghash_step_4x for full
# explanation.
sub _ghash_4x {
    my $code = "";
    for my $i ( 0 .. 9 ) {
        $code .= _ghash_step_4x $i, @_;
    }
    return $code;
}

# void gcm_gmult_vpclmulqdq_avx512(uint8_t Xi[16], const u128 Htable[16]);
$code .= _begin_func "gcm_gmult_vpclmulqdq_avx512", 1;
{
    my ( $GHASH_ACC_PTR, $HTABLE ) = @argregs[ 0 .. 1 ];
    my ( $GHASH_ACC, $BSWAP_MASK, $H_POW1, $GFPOLY, $T0, $T1, $T2 ) =
      map( "%xmm$_", ( 0 .. 6 ) );

    $code .= <<___;
    @{[ _save_xmmregs (6) ]}
    .seh_endprologue

    vmovdqu         ($GHASH_ACC_PTR), $GHASH_ACC
    vmovdqu         .Lbswap_mask(%rip), $BSWAP_MASK
    vmovdqu         $OFFSETOFEND_H_POWERS-16($HTABLE), $H_POW1
    vmovdqu         .Lgfpoly(%rip), $GFPOLY
    vpshufb         $BSWAP_MASK, $GHASH_ACC, $GHASH_ACC

    @{[ _ghash_mul  $H_POW1, $GHASH_ACC, $GHASH_ACC, $GFPOLY, $T0, $T1, $T2 ]}

    vpshufb         $BSWAP_MASK, $GHASH_ACC, $GHASH_ACC
    vmovdqu         $GHASH_ACC, ($GHASH_ACC_PTR)

    # No need for vzeroupper, since only xmm registers were used.
___
}
$code .= _end_func;

# void gcm_ghash_vpclmulqdq_avx512(uint8_t Xi[16], const u128 Htable[16],
#                                  const uint8_t *in, size_t len);
#
# Using the key |Htable|, update the GHASH accumulator |Xi| with the data given
# by |in| and |len|.  |len| must be a multiple of 16.
#
# This function handles large amounts of AAD efficiently, while also keeping the
# overhead low for small amounts of AAD which is the common case.  TLS uses less
# than one block of AAD, but (uncommonly) other use cases may use much more.
$code .= _begin_func "gcm_ghash_vpclmulqdq_avx512", 1;
{
    # Function arguments
    my ( $GHASH_ACC_PTR, $HTABLE, $AAD, $AADLEN ) = @argregs[ 0 .. 3 ];

    # Additional local variables
    my ( $GHASHDATA0, $GHASHDATA0_XMM ) = ( "%zmm0", "%xmm0" );
    my ( $GHASHDATA1, $GHASHDATA1_XMM ) = ( "%zmm1", "%xmm1" );
    my ( $GHASHDATA2, $GHASHDATA2_XMM ) = ( "%zmm2", "%xmm2" );
    my ( $GHASHDATA3, $GHASHDATA3_XMM ) = ( "%zmm3", "%xmm3" );
    my @GHASHDATA = ( $GHASHDATA0, $GHASHDATA1, $GHASHDATA2, $GHASHDATA3 );
    my @GHASHDATA_XMM =
      ( $GHASHDATA0_XMM, $GHASHDATA1_XMM, $GHASHDATA2_XMM, $GHASHDATA3_XMM );
    my ( $BSWAP_MASK, $BSWAP_MASK_XMM ) = ( "%zmm4", "%xmm4" );
    my ( $GHASH_ACC, $GHASH_ACC_XMM )   = ( "%zmm5", "%xmm5" );
    my ( $H_POW4, $H_POW3, $H_POW2 )    = ( "%zmm6", "%zmm7", "%zmm8" );
    my ( $H_POW1, $H_POW1_XMM )         = ( "%zmm9", "%xmm9" );
    my ( $GFPOLY, $GFPOLY_XMM )         = ( "%zmm10", "%xmm10" );
    my ( $GHASHTMP0, $GHASHTMP1, $GHASHTMP2 ) =
      ( "%zmm11", "%zmm12", "%zmm13" );

    $code .= <<___;
    @{[ _save_xmmregs (6 .. 13) ]}
    .seh_endprologue

    # Load the bswap_mask and gfpoly constants.  Since AADLEN is usually small,
    # usually only 128-bit vectors will be used.  So as an optimization, don't
    # broadcast these constants to all 128-bit lanes quite yet.
    vmovdqu         .Lbswap_mask(%rip), $BSWAP_MASK_XMM
    vmovdqu         .Lgfpoly(%rip), $GFPOLY_XMM

    # Load the GHASH accumulator.
    vmovdqu         ($GHASH_ACC_PTR), $GHASH_ACC_XMM
    vpshufb         $BSWAP_MASK_XMM, $GHASH_ACC_XMM, $GHASH_ACC_XMM

    # Optimize for AADLEN < 64 by checking for AADLEN < 64 before AADLEN < 256.
    cmp             \$64, $AADLEN
    jb              .Laad_blockbyblock

    # AADLEN >= 64, so we'll operate on full vectors.  Broadcast bswap_mask and
    # gfpoly to all 128-bit lanes.
    vshufi64x2      \$0, $BSWAP_MASK, $BSWAP_MASK, $BSWAP_MASK
    vshufi64x2      \$0, $GFPOLY, $GFPOLY, $GFPOLY

    # Load the lowest set of key powers.
    vmovdqu8        $OFFSETOFEND_H_POWERS-1*64($HTABLE), $H_POW1

    cmp             \$256, $AADLEN
    jb              .Laad_loop_1x

    # AADLEN >= 256.  Load the higher key powers.
    vmovdqu8        $OFFSETOFEND_H_POWERS-4*64($HTABLE), $H_POW4
    vmovdqu8        $OFFSETOFEND_H_POWERS-3*64($HTABLE), $H_POW3
    vmovdqu8        $OFFSETOFEND_H_POWERS-2*64($HTABLE), $H_POW2

    # Update GHASH with 256 bytes of AAD at a time.
.Laad_loop_4x:
    vmovdqu8        0*64($AAD), $GHASHDATA0
    vmovdqu8        1*64($AAD), $GHASHDATA1
    vmovdqu8        2*64($AAD), $GHASHDATA2
    vmovdqu8        3*64($AAD), $GHASHDATA3
    @{[ _ghash_4x   $BSWAP_MASK, @GHASHDATA, @GHASHDATA_XMM, $H_POW4, $H_POW3,
                    $H_POW2, $H_POW1, $GFPOLY, $GHASHTMP0, $GHASHTMP1,
                    $GHASHTMP2, $GHASH_ACC, $GHASH_ACC_XMM ]}
    add             \$256, $AAD
    sub             \$256, $AADLEN
    cmp             \$256, $AADLEN
    jae             .Laad_loop_4x

    # Update GHASH with 64 bytes of AAD at a time.
    cmp             \$64, $AADLEN
    jb              .Laad_large_done
.Laad_loop_1x:
    vmovdqu8        ($AAD), $GHASHDATA0
    vpshufb         $BSWAP_MASK, $GHASHDATA0, $GHASHDATA0
    vpxord          $GHASHDATA0, $GHASH_ACC, $GHASH_ACC
    @{[ _ghash_mul  $H_POW1, $GHASH_ACC, $GHASH_ACC, $GFPOLY,
                    $GHASHDATA0, $GHASHDATA1, $GHASHDATA2 ]}
    @{[ _horizontal_xor $GHASH_ACC, $GHASH_ACC_XMM, $GHASH_ACC_XMM,
                        $GHASHDATA0_XMM, $GHASHDATA1_XMM, $GHASHDATA2_XMM ]}
    add             \$64, $AAD
    sub             \$64, $AADLEN
    cmp             \$64, $AADLEN
    jae             .Laad_loop_1x

.Laad_large_done:

    # GHASH the remaining data 16 bytes at a time, using xmm registers only.
.Laad_blockbyblock:
    test            $AADLEN, $AADLEN
    jz              .Laad_done
    vmovdqu         $OFFSETOFEND_H_POWERS-16($HTABLE), $H_POW1_XMM
.Laad_loop_blockbyblock:
    vmovdqu         ($AAD), $GHASHDATA0_XMM
    vpshufb         $BSWAP_MASK_XMM, $GHASHDATA0_XMM, $GHASHDATA0_XMM
    vpxor           $GHASHDATA0_XMM, $GHASH_ACC_XMM, $GHASH_ACC_XMM
    @{[ _ghash_mul  $H_POW1_XMM, $GHASH_ACC_XMM, $GHASH_ACC_XMM, $GFPOLY_XMM,
                    $GHASHDATA0_XMM, $GHASHDATA1_XMM, $GHASHDATA2_XMM ]}
    add             \$16, $AAD
    sub             \$16, $AADLEN
    jnz             .Laad_loop_blockbyblock

.Laad_done:
    # Store the updated GHASH accumulator back to memory.
    vpshufb         $BSWAP_MASK_XMM, $GHASH_ACC_XMM, $GHASH_ACC_XMM
    vmovdqu         $GHASH_ACC_XMM, ($GHASH_ACC_PTR)

    vzeroupper      # This is needed after using ymm or zmm registers.
___
}
$code .= _end_func;

# Do one non-last round of AES encryption on the counter blocks in aesdata[0-3]
# using the round key that has been broadcast to all 128-bit lanes of round_key.
sub _vaesenc_4x {
    my ( $round_key, $aesdata0, $aesdata1, $aesdata2, $aesdata3 ) = @_;
    return <<___;
    vaesenc         $round_key, $aesdata0, $aesdata0
    vaesenc         $round_key, $aesdata1, $aesdata1
    vaesenc         $round_key, $aesdata2, $aesdata2
    vaesenc         $round_key, $aesdata3, $aesdata3
___
}

# Start the AES encryption of four vectors of counter blocks.
sub _ctr_begin_4x {
    my (
        $le_ctr,   $le_ctr_inc, $bswap_mask, $rndkey0,
        $aesdata0, $aesdata1,   $aesdata2,   $aesdata3
    ) = @_;
    return <<___;
    # Increment le_ctr four times to generate four vectors of little-endian
    # counter blocks, swap each to big-endian, and store them in aesdata[0-3].
    vpshufb         $bswap_mask, $le_ctr, $aesdata0
    vpaddd          $le_ctr_inc, $le_ctr, $le_ctr
    vpshufb         $bswap_mask, $le_ctr, $aesdata1
    vpaddd          $le_ctr_inc, $le_ctr, $le_ctr
    vpshufb         $bswap_mask, $le_ctr, $aesdata2
    vpaddd          $le_ctr_inc, $le_ctr, $le_ctr
    vpshufb         $bswap_mask, $le_ctr, $aesdata3
    vpaddd          $le_ctr_inc, $le_ctr, $le_ctr

    # AES "round zero": XOR in the zero-th round key.
    vpxord          $rndkey0, $aesdata0, $aesdata0
    vpxord          $rndkey0, $aesdata1, $aesdata1
    vpxord          $rndkey0, $aesdata2, $aesdata2
    vpxord          $rndkey0, $aesdata3, $aesdata3
___
}

# Do the last AES round for four vectors of counter blocks, XOR four vectors of
# source data with the resulting keystream blocks, and write the result to the
# destination buffer and ghashdata[0-3].  The implementation differs slightly as
# it takes advantage of the property vaesenclast(key, a) ^ b ==
# vaesenclast(key ^ b, a) to reduce latency, but it has the same effect.
sub _aesenclast_and_xor_4x {
    my (
        $src,        $dst,        $rndkeylast, $aesdata0,
        $aesdata1,   $aesdata2,   $aesdata3,   $ghashdata0,
        $ghashdata1, $ghashdata2, $ghashdata3
    ) = @_;
    return <<___;
    vpxord          0*64($src), $rndkeylast, $ghashdata0
    vpxord          1*64($src), $rndkeylast, $ghashdata1
    vpxord          2*64($src), $rndkeylast, $ghashdata2
    vpxord          3*64($src), $rndkeylast, $ghashdata3
    vaesenclast     $ghashdata0, $aesdata0, $ghashdata0
    vaesenclast     $ghashdata1, $aesdata1, $ghashdata1
    vaesenclast     $ghashdata2, $aesdata2, $ghashdata2
    vaesenclast     $ghashdata3, $aesdata3, $ghashdata3
    vmovdqu8        $ghashdata0, 0*64($dst)
    vmovdqu8        $ghashdata1, 1*64($dst)
    vmovdqu8        $ghashdata2, 2*64($dst)
    vmovdqu8        $ghashdata3, 3*64($dst)
___
}

my $g_update_macro_expansion_count = 0;

# void aes_gcm_{enc,dec}_update_vaes_avx512(const uint8_t *in, uint8_t *out,
#                                           size_t len, const AES_KEY *key,
#                                           const uint8_t ivec[16],
#                                           const u128 Htable[16],
#                                           uint8_t Xi[16]);
#
# This macro generates a GCM encryption or decryption update function with the
# above prototype (with \enc selecting which one).  The function computes the
# next portion of the CTR keystream, XOR's it with |len| bytes from |in|, and
# writes the resulting encrypted or decrypted data to |out|.  It also updates
# the GHASH accumulator |Xi| using the next |len| ciphertext bytes.
#
# |len| must be a multiple of 16, except on the last call where it can be any
# length.  The caller must do any buffering needed to ensure this.  Both
# in-place and out-of-place en/decryption are supported.
#
# |ivec| must give the current counter in big-endian format.  This function
# loads the counter from |ivec| and increments the loaded counter as needed, but
# it does *not* store the updated counter back to |ivec|.  The caller must
# update |ivec| if any more data segments follow.  Internally, only the low
# 32-bit word of the counter is incremented, following the GCM standard.
sub _aes_gcm_update {
    my $local_label_suffix = "__func" . ++$g_update_macro_expansion_count;
    my ($enc)              = @_;
    my $code               = "";

    # Function arguments
    my ( $SRC, $DST, $DATALEN, $AESKEY, $BE_CTR_PTR, $HTABLE, $GHASH_ACC_PTR )
      = $win64
      ? ( @argregs[ 0 .. 3 ], "%rsi", "%rdi", "%r12" )
      : ( @argregs[ 0 .. 5 ], "%r12" );

    # Additional local variables.
    # %rax, %k1, and %k2 are used as temporary registers.  BE_CTR_PTR is
    # also available as a temporary register after the counter is loaded.

    # AES key length in bytes
    my ( $AESKEYLEN, $AESKEYLEN64 ) = ( "%r10d", "%r10" );

    # Pointer to the last AES round key for the chosen AES variant
    my $RNDKEYLAST_PTR = "%r11";

    # AESDATA[0-3] hold the counter blocks that are being encrypted by AES.
    my ( $AESDATA0, $AESDATA0_XMM ) = ( "%zmm0", "%xmm0" );
    my ( $AESDATA1, $AESDATA1_XMM ) = ( "%zmm1", "%xmm1" );
    my ( $AESDATA2, $AESDATA2_XMM ) = ( "%zmm2", "%xmm2" );
    my ( $AESDATA3, $AESDATA3_XMM ) = ( "%zmm3", "%xmm3" );
    my @AESDATA = ( $AESDATA0, $AESDATA1, $AESDATA2, $AESDATA3 );

    # GHASHDATA[0-3] hold the ciphertext blocks and GHASH input data.
    my ( $GHASHDATA0, $GHASHDATA0_XMM ) = ( "%zmm4", "%xmm4" );
    my ( $GHASHDATA1, $GHASHDATA1_XMM ) = ( "%zmm5", "%xmm5" );
    my ( $GHASHDATA2, $GHASHDATA2_XMM ) = ( "%zmm6", "%xmm6" );
    my ( $GHASHDATA3, $GHASHDATA3_XMM ) = ( "%zmm7", "%xmm7" );
    my @GHASHDATA = ( $GHASHDATA0, $GHASHDATA1, $GHASHDATA2, $GHASHDATA3 );
    my @GHASHDATA_XMM =
      ( $GHASHDATA0_XMM, $GHASHDATA1_XMM, $GHASHDATA2_XMM, $GHASHDATA3_XMM );

    # BSWAP_MASK is the shuffle mask for byte-reflecting 128-bit values
    # using vpshufb, copied to all 128-bit lanes.
    my ( $BSWAP_MASK, $BSWAP_MASK_XMM ) = ( "%zmm8", "%xmm8" );

    # RNDKEY temporarily holds the next AES round key.
    my $RNDKEY = "%zmm9";

    # GHASH_ACC is the accumulator variable for GHASH.  When fully reduced,
    # only the lowest 128-bit lane can be nonzero.  When not fully reduced,
    # more than one lane may be used, and they need to be XOR'd together.
    my ( $GHASH_ACC, $GHASH_ACC_XMM ) = ( "%zmm10", "%xmm10" );

    # LE_CTR_INC is the vector of 32-bit words that need to be added to a
    # vector of little-endian counter blocks to advance it forwards.
    my $LE_CTR_INC = "%zmm11";

    # LE_CTR contains the next set of little-endian counter blocks.
    my $LE_CTR = "%zmm12";

    # RNDKEY0, RNDKEYLAST, and RNDKEY_M[9-1] contain cached AES round keys,
    # copied to all 128-bit lanes.  RNDKEY0 is the zero-th round key,
    # RNDKEYLAST the last, and RNDKEY_M\i the one \i-th from the last.
    my (
        $RNDKEY0,   $RNDKEYLAST, $RNDKEY_M9, $RNDKEY_M8,
        $RNDKEY_M7, $RNDKEY_M6,  $RNDKEY_M5, $RNDKEY_M4,
        $RNDKEY_M3, $RNDKEY_M2,  $RNDKEY_M1
      )
      = (
        "%zmm13", "%zmm14", "%zmm15", "%zmm16", "%zmm17", "%zmm18",
        "%zmm19", "%zmm20", "%zmm21", "%zmm22", "%zmm23"
      );

    # GHASHTMP[0-2] are temporary variables used by _ghash_step_4x.  These
    # cannot coincide with anything used for AES encryption, since for
    # performance reasons GHASH and AES encryption are interleaved.
    my ( $GHASHTMP0, $GHASHTMP1, $GHASHTMP2 ) =
      ( "%zmm24", "%zmm25", "%zmm26" );

    # H_POW[4-1] contain the powers of the hash key H^16...H^1.  The descending
    # numbering reflects the order of the key powers.
    my ( $H_POW4, $H_POW3, $H_POW2, $H_POW1 ) =
      ( "%zmm27", "%zmm28", "%zmm29", "%zmm30" );

    # GFPOLY contains the .Lgfpoly constant, copied to all 128-bit lanes.
    my $GFPOLY = "%zmm31";

    my @ghash_4x_args = (
        $BSWAP_MASK, @GHASHDATA, @GHASHDATA_XMM, $H_POW4,
        $H_POW3,     $H_POW2,    $H_POW1,        $GFPOLY,
        $GHASHTMP0,  $GHASHTMP1, $GHASHTMP2,     $GHASH_ACC,
        $GHASH_ACC_XMM
    );

    if ($win64) {
        $code .= <<___;
        @{[ _save_gpregs $BE_CTR_PTR, $HTABLE, $GHASH_ACC_PTR ]}
        mov             64(%rsp), $BE_CTR_PTR     # arg5
        mov             72(%rsp), $HTABLE         # arg6
        mov             80(%rsp), $GHASH_ACC_PTR  # arg7
        @{[ _save_xmmregs (6 .. 15) ]}
        .seh_endprologue
___
    }
    else {
        $code .= <<___;
        @{[ _save_gpregs $GHASH_ACC_PTR ]}
        mov             16(%rsp), $GHASH_ACC_PTR  # arg7
___
    }

    if ($enc) {
        $code .= <<___;
#ifdef BORINGSSL_DISPATCH_TEST
        .extern BORINGSSL_function_hit
        movb \$1,BORINGSSL_function_hit+7(%rip)
#endif
___
    }
    $code .= <<___;
    # Load some constants.
    vbroadcasti32x4 .Lbswap_mask(%rip), $BSWAP_MASK
    vbroadcasti32x4 .Lgfpoly(%rip), $GFPOLY

    # Load the GHASH accumulator and the starting counter.
    # BoringSSL passes these values in big endian format.
    vmovdqu         ($GHASH_ACC_PTR), $GHASH_ACC_XMM
    vpshufb         $BSWAP_MASK_XMM, $GHASH_ACC_XMM, $GHASH_ACC_XMM
    vbroadcasti32x4 ($BE_CTR_PTR), $LE_CTR
    vpshufb         $BSWAP_MASK, $LE_CTR, $LE_CTR

    # Load the AES key length in bytes.  BoringSSL stores number of rounds
    # minus 1, so convert using: AESKEYLEN = 4 * aeskey->rounds - 20.
    movl            $OFFSETOF_AES_ROUNDS($AESKEY), $AESKEYLEN
    lea             -20(,$AESKEYLEN,4), $AESKEYLEN

    # Make RNDKEYLAST_PTR point to the last AES round key.  This is the
    # round key with index 10, 12, or 14 for AES-128, AES-192, or AES-256
    # respectively.  Then load the zero-th and last round keys.
    lea             6*16($AESKEY,$AESKEYLEN64,4), $RNDKEYLAST_PTR
    vbroadcasti32x4 ($AESKEY), $RNDKEY0
    vbroadcasti32x4 ($RNDKEYLAST_PTR), $RNDKEYLAST

    # Finish initializing LE_CTR by adding [0, 1, 2, 3] to its low words.
    vpaddd          .Lctr_pattern(%rip), $LE_CTR, $LE_CTR

    # Load 4 into all 128-bit lanes of LE_CTR_INC.
    vbroadcasti32x4 .Linc_4blocks(%rip), $LE_CTR_INC

    # If there are at least 256 bytes of data, then continue into the loop
    # that processes 256 bytes of data at a time.  Otherwise skip it.
    cmp             \$256, $DATALEN
    jb              .Lcrypt_loop_4x_done$local_label_suffix

    # Load powers of the hash key.
    vmovdqu8        $OFFSETOFEND_H_POWERS-4*64($HTABLE), $H_POW4
    vmovdqu8        $OFFSETOFEND_H_POWERS-3*64($HTABLE), $H_POW3
    vmovdqu8        $OFFSETOFEND_H_POWERS-2*64($HTABLE), $H_POW2
    vmovdqu8        $OFFSETOFEND_H_POWERS-1*64($HTABLE), $H_POW1
___

    # Main loop: en/decrypt and hash 4 vectors at a time.
    #
    # When possible, interleave the AES encryption of the counter blocks
    # with the GHASH update of the ciphertext blocks.  This improves
    # performance on many CPUs because the execution ports used by the VAES
    # instructions often differ from those used by vpclmulqdq and other
    # instructions used in GHASH.  For example, many Intel CPUs dispatch
    # vaesenc to ports 0 and 1 and vpclmulqdq to port 5.
    #
    # The interleaving is easiest to do during decryption, since during
    # decryption the ciphertext blocks are immediately available.  For
    # encryption, instead encrypt the first set of blocks, then hash those
    # blocks while encrypting the next set of blocks, repeat that as
    # needed, and finally hash the last set of blocks.

    if ($enc) {
        $code .= <<___;
        # Encrypt the first 4 vectors of plaintext blocks.  Leave the resulting
        # ciphertext in GHASHDATA[0-3] for GHASH.
        @{[ _ctr_begin_4x $LE_CTR, $LE_CTR_INC, $BSWAP_MASK, $RNDKEY0, @AESDATA ]}
        lea             16($AESKEY), %rax
.Lvaesenc_loop_first_4_vecs$local_label_suffix:
        vbroadcasti32x4 (%rax), $RNDKEY
        @{[ _vaesenc_4x $RNDKEY, @AESDATA ]}
        add             \$16, %rax
        cmp             %rax, $RNDKEYLAST_PTR
        jne             .Lvaesenc_loop_first_4_vecs$local_label_suffix
        @{[ _aesenclast_and_xor_4x $SRC, $DST, $RNDKEYLAST, @AESDATA, @GHASHDATA ]}
        add             \$256, $SRC
        add             \$256, $DST
        sub             \$256, $DATALEN
        cmp             \$256, $DATALEN
        jb              .Lghash_last_ciphertext_4x$local_label_suffix
___
    }

    $code .= <<___;
    # Cache as many additional AES round keys as possible.
    vbroadcasti32x4 -9*16($RNDKEYLAST_PTR), $RNDKEY_M9
    vbroadcasti32x4 -8*16($RNDKEYLAST_PTR), $RNDKEY_M8
    vbroadcasti32x4 -7*16($RNDKEYLAST_PTR), $RNDKEY_M7
    vbroadcasti32x4 -6*16($RNDKEYLAST_PTR), $RNDKEY_M6
    vbroadcasti32x4 -5*16($RNDKEYLAST_PTR), $RNDKEY_M5
    vbroadcasti32x4 -4*16($RNDKEYLAST_PTR), $RNDKEY_M4
    vbroadcasti32x4 -3*16($RNDKEYLAST_PTR), $RNDKEY_M3
    vbroadcasti32x4 -2*16($RNDKEYLAST_PTR), $RNDKEY_M2
    vbroadcasti32x4 -1*16($RNDKEYLAST_PTR), $RNDKEY_M1

.Lcrypt_loop_4x$local_label_suffix:
___

    # If decrypting, load more ciphertext blocks into GHASHDATA[0-3].  If
    # encrypting, GHASHDATA[0-3] already contain the previous ciphertext.
    if ( !$enc ) {
        $code .= <<___;
        vmovdqu8        0*64($SRC), $GHASHDATA0
        vmovdqu8        1*64($SRC), $GHASHDATA1
        vmovdqu8        2*64($SRC), $GHASHDATA2
        vmovdqu8        3*64($SRC), $GHASHDATA3
___
    }

    $code .= <<___;
    # Start the AES encryption of the counter blocks.
    @{[ _ctr_begin_4x $LE_CTR, $LE_CTR_INC, $BSWAP_MASK, $RNDKEY0, @AESDATA ]}
    cmp             \$24, $AESKEYLEN
    jl              .Laes128$local_label_suffix
    je              .Laes192$local_label_suffix
    # AES-256
    vbroadcasti32x4 -13*16($RNDKEYLAST_PTR), $RNDKEY
    @{[ _vaesenc_4x $RNDKEY, @AESDATA ]}
    vbroadcasti32x4 -12*16($RNDKEYLAST_PTR), $RNDKEY
    @{[ _vaesenc_4x $RNDKEY, @AESDATA ]}
.Laes192$local_label_suffix:
    vbroadcasti32x4 -11*16($RNDKEYLAST_PTR), $RNDKEY
    @{[ _vaesenc_4x $RNDKEY, @AESDATA ]}
    vbroadcasti32x4 -10*16($RNDKEYLAST_PTR), $RNDKEY
    @{[ _vaesenc_4x $RNDKEY, @AESDATA ]}
.Laes128$local_label_suffix:

    # Prefetch the source data 512 bytes ahead into the L1 data cache, to
    # improve performance when the hardware prefetcher is disabled.  Assumes the
    # L1 data cache line size is 64 bytes (de facto standard on x86_64).
    prefetcht0      512+0*64($SRC)
    prefetcht0      512+1*64($SRC)
    prefetcht0      512+2*64($SRC)
    prefetcht0      512+3*64($SRC)

    # Finish the AES encryption of the counter blocks in AESDATA[0-3],
    # interleaved with the GHASH update of the ciphertext blocks in
    # GHASHDATA[0-3].
    @{[ _ghash_step_4x  0, @ghash_4x_args ]}
    @{[ _vaesenc_4x     $RNDKEY_M9, @AESDATA ]}
    @{[ _ghash_step_4x  1, @ghash_4x_args ]}
    @{[ _vaesenc_4x     $RNDKEY_M8, @AESDATA ]}
    @{[ _ghash_step_4x  2, @ghash_4x_args ]}
    @{[ _vaesenc_4x     $RNDKEY_M7, @AESDATA ]}
    @{[ _ghash_step_4x  3, @ghash_4x_args ]}
    @{[ _vaesenc_4x     $RNDKEY_M6, @AESDATA ]}
    @{[ _ghash_step_4x  4, @ghash_4x_args ]}
    @{[ _vaesenc_4x     $RNDKEY_M5, @AESDATA ]}
    @{[ _ghash_step_4x  5, @ghash_4x_args ]}
    @{[ _vaesenc_4x     $RNDKEY_M4, @AESDATA ]}
    @{[ _ghash_step_4x  6, @ghash_4x_args ]}
    @{[ _vaesenc_4x     $RNDKEY_M3, @AESDATA ]}
    @{[ _ghash_step_4x  7, @ghash_4x_args ]}
    @{[ _vaesenc_4x     $RNDKEY_M2, @AESDATA ]}
    @{[ _ghash_step_4x  8, @ghash_4x_args ]}
    @{[ _vaesenc_4x     $RNDKEY_M1, @AESDATA ]}

    @{[ _ghash_step_4x  9, @ghash_4x_args ]}
    @{[ _aesenclast_and_xor_4x $SRC, $DST, $RNDKEYLAST, @AESDATA, @GHASHDATA ]}
    add             \$256, $SRC
    add             \$256, $DST
    sub             \$256, $DATALEN
    cmp             \$256, $DATALEN
    jae             .Lcrypt_loop_4x$local_label_suffix
___

    if ($enc) {

        # Update GHASH with the last set of ciphertext blocks.
        $code .= <<___;
.Lghash_last_ciphertext_4x$local_label_suffix:
        @{[ _ghash_4x @ghash_4x_args ]}
___
    }

    my $POWERS_PTR = $BE_CTR_PTR;    # BE_CTR_PTR is free to be reused.

    $code .= <<___;
.Lcrypt_loop_4x_done$local_label_suffix:
    # Check whether any data remains.
    test            $DATALEN, $DATALEN
    jz              .Ldone$local_label_suffix

    # The data length isn't a multiple of 256 bytes.  Process the remaining
    # data of length 1 <= DATALEN < 256, up to one 64-byte vector at a time.
    # Going one vector at a time may seem inefficient compared to having
    # separate code paths for each possible number of vectors remaining.
    # However, using a loop keeps the code size down, and it performs
    # surprising well; modern CPUs will start executing the next iteration
    # before the previous one finishes and also predict the number of loop
    # iterations.  For a similar reason, we roll up the AES rounds.
    #
    # On the last iteration, the remaining length may be less than 64 bytes.
    # Handle this using masking.
    #
    # Since there are enough key powers available for all remaining data,
    # there is no need to do a GHASH reduction after each iteration.
    # Instead, multiply each remaining block by its own key power, and only
    # do a GHASH reduction at the very end.

    # Make POWERS_PTR point to the key powers [H^N, H^(N-1), ...] where N
    # is the number of blocks that remain.
    mov             $DATALEN, %rax
    neg             %rax
    and             \$-16, %rax  # -round_up(DATALEN, 16)
    lea             $OFFSETOFEND_H_POWERS($HTABLE,%rax), $POWERS_PTR
___

    # Start collecting the unreduced GHASH intermediate value LO, MI, HI.
    my ( $LO, $LO_XMM ) = ( $GHASHDATA0, $GHASHDATA0_XMM );
    my ( $MI, $MI_XMM ) = ( $GHASHDATA1, $GHASHDATA1_XMM );
    my ( $HI, $HI_XMM ) = ( $GHASHDATA2, $GHASHDATA2_XMM );
    $code .= <<___;
    vpxor           $LO_XMM, $LO_XMM, $LO_XMM
    vpxor           $MI_XMM, $MI_XMM, $MI_XMM
    vpxor           $HI_XMM, $HI_XMM, $HI_XMM

    cmp             \$64, $DATALEN
    jb              .Lpartial_vec$local_label_suffix

.Lcrypt_loop_1x$local_label_suffix:
    # Process a full 64-byte vector.

    # Encrypt a vector of counter blocks.
    vpshufb         $BSWAP_MASK, $LE_CTR, $AESDATA0
    vpaddd          $LE_CTR_INC, $LE_CTR, $LE_CTR
    vpxord          $RNDKEY0, $AESDATA0, $AESDATA0
    lea             16($AESKEY), %rax
.Lvaesenc_loop_tail_full_vec$local_label_suffix:
    vbroadcasti32x4 (%rax), $RNDKEY
    vaesenc         $RNDKEY, $AESDATA0, $AESDATA0
    add             \$16, %rax
    cmp             %rax, $RNDKEYLAST_PTR
    jne             .Lvaesenc_loop_tail_full_vec$local_label_suffix
    vaesenclast     $RNDKEYLAST, $AESDATA0, $AESDATA0

    # XOR the data with the vector of keystream blocks.
    vmovdqu8        ($SRC), $AESDATA1
    vpxord          $AESDATA1, $AESDATA0, $AESDATA0
    vmovdqu8        $AESDATA0, ($DST)

    # Update GHASH with the ciphertext blocks, without reducing.
    vmovdqu8        ($POWERS_PTR), $H_POW1
    vpshufb         $BSWAP_MASK, @{[ $enc ? $AESDATA0 : $AESDATA1 ]}, $AESDATA0
    vpxord          $GHASH_ACC, $AESDATA0, $AESDATA0
    @{[ _ghash_mul_noreduce $H_POW1, $AESDATA0, $LO, $MI, $HI,
                            $GHASHDATA3, $AESDATA1, $AESDATA2, $AESDATA3 ]}
    vpxor           $GHASH_ACC_XMM, $GHASH_ACC_XMM, $GHASH_ACC_XMM

    add             \$64, $POWERS_PTR
    add             \$64, $SRC
    add             \$64, $DST
    sub             \$64, $DATALEN
    cmp             \$64, $DATALEN
    jae             .Lcrypt_loop_1x$local_label_suffix

    test            $DATALEN, $DATALEN
    jz              .Lreduce$local_label_suffix

.Lpartial_vec$local_label_suffix:
    # Process a partial vector of length 1 <= DATALEN < 64.

    # Set the data mask %k1 to DATALEN 1's.
    # Set the key powers mask %k2 to round_up(DATALEN, 16) 1's.
    mov             \$-1, %rax
    bzhi            $DATALEN, %rax, %rax
    kmovq           %rax, %k1
    add             \$15, $DATALEN
    and             \$-16, $DATALEN
    mov             \$-1, %rax
    bzhi            $DATALEN, %rax, %rax
    kmovq           %rax, %k2

    # Encrypt one last vector of counter blocks.  This does not need to be
    # masked.  The counter does not need to be incremented here.
    vpshufb         $BSWAP_MASK, $LE_CTR, $AESDATA0
    vpxord          $RNDKEY0, $AESDATA0, $AESDATA0
    lea             16($AESKEY), %rax
.Lvaesenc_loop_tail_partialvec$local_label_suffix:
    vbroadcasti32x4 (%rax), $RNDKEY
    vaesenc         $RNDKEY, $AESDATA0, $AESDATA0
    add             \$16, %rax
    cmp             %rax, $RNDKEYLAST_PTR
    jne             .Lvaesenc_loop_tail_partialvec$local_label_suffix
    vaesenclast     $RNDKEYLAST, $AESDATA0, $AESDATA0

    # XOR the data with the appropriate number of keystream bytes.
    vmovdqu8        ($SRC), $AESDATA1\{%k1}{z}
    vpxord          $AESDATA1, $AESDATA0, $AESDATA0
    vmovdqu8        $AESDATA0, ($DST){%k1}

    # Update GHASH with the ciphertext block(s), without reducing.
    #
    # In the case of DATALEN < 64, the ciphertext is zero-padded to 64
    # bytes.  (If decrypting, it's done by the above masked load.  If
    # encrypting, it's done by the below masked register-to-register move.)
    # Note that if DATALEN <= 48, there will be additional padding beyond
    # the padding of the last block specified by GHASH itself; i.e., there
    # may be whole block(s) that get processed by the GHASH multiplication
    # and reduction instructions but should not actually be included in the
    # GHASH.  However, any such blocks are all-zeroes, and the values that
    # they're multiplied with are also all-zeroes.  Therefore they just add
    # 0 * 0 = 0 to the final GHASH result, which makes no difference.
    vmovdqu8        ($POWERS_PTR), $H_POW1\{%k2}{z}
    @{[ $enc ? "vmovdqu8 $AESDATA0, $AESDATA1\{%k1}{z}" : "" ]}
    vpshufb         $BSWAP_MASK, $AESDATA1, $AESDATA0
    vpxord          $GHASH_ACC, $AESDATA0, $AESDATA0
    @{[ _ghash_mul_noreduce $H_POW1, $AESDATA0, $LO, $MI, $HI,
                            $GHASHDATA3, $AESDATA1, $AESDATA2, $AESDATA3 ]}

.Lreduce$local_label_suffix:
    # Finally, do the GHASH reduction.
    @{[ _ghash_reduce   $LO, $MI, $HI, $GFPOLY, $AESDATA0 ]}
    @{[ _horizontal_xor $HI, $HI_XMM, $GHASH_ACC_XMM,
                        $AESDATA0_XMM, $AESDATA1_XMM, $AESDATA2_XMM ]}

.Ldone$local_label_suffix:
    # Store the updated GHASH accumulator back to memory.
    vpshufb         $BSWAP_MASK_XMM, $GHASH_ACC_XMM, $GHASH_ACC_XMM
    vmovdqu         $GHASH_ACC_XMM, ($GHASH_ACC_PTR)

    vzeroupper      # This is needed after using ymm or zmm registers.
___
    return $code;
}

$code .= _begin_func "aes_gcm_enc_update_vaes_avx512", 1;
$code .= _aes_gcm_update 1;
$code .= _end_func;

$code .= _begin_func "aes_gcm_dec_update_vaes_avx512", 1;
$code .= _aes_gcm_update 0;
$code .= _end_func;

print $code;
close STDOUT or die "error closing STDOUT: $!";
exit 0;
