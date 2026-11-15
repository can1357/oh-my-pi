; This file is generated from a similarly-named Perl script in the BoringSSL
; source tree. Do not edit by hand.

%ifidn __OUTPUT_FORMAT__, win64
default	rel
%define XMMWORD
%define YMMWORD
%define ZMMWORD
%define _CET_ENDBR

%ifdef BORINGSSL_PREFIX
%include "boringssl_prefix_symbols_nasm.inc"
%endif
section	.rdata rdata align=8
ALIGN	16


$L$bswap_mask:
	DQ	0x08090a0b0c0d0e0f,0x0001020304050607








$L$gfpoly:
	DQ	1,0xc200000000000000


$L$gfpoly_and_internal_carrybit:
	DQ	1,0xc200000000000001

ALIGN	32

$L$ctr_pattern:
	DQ	0,0
	DQ	1,0
$L$inc_2blocks:
	DQ	2,0
	DQ	2,0

section	.text code align=64

global	gcm_init_vpclmulqdq_avx2

ALIGN	32
gcm_init_vpclmulqdq_avx2:

$L$SEH_begin_gcm_init_vpclmulqdq_avx2_1:
_CET_ENDBR
	sub	rsp,24
$L$SEH_prologue_gcm_init_vpclmulqdq_avx2_2:
	vmovdqa	XMMWORD[rsp],xmm6
$L$SEH_prologue_gcm_init_vpclmulqdq_avx2_3:

$L$SEH_endprologue_gcm_init_vpclmulqdq_avx2_4:



	vpshufd	xmm3,XMMWORD[rdx],0x4e





	vpshufd	xmm0,xmm3,0xd3
	vpsrad	xmm0,xmm0,31
	vpaddq	xmm3,xmm3,xmm3
	vpand	xmm0,xmm0,XMMWORD[$L$gfpoly_and_internal_carrybit]
	vpxor	xmm3,xmm3,xmm0

	vbroadcasti128	ymm6,XMMWORD[$L$gfpoly]


	vpclmulqdq	xmm0,xmm3,xmm3,0x00
	vpclmulqdq	xmm5,xmm3,xmm3,0x11
	vpclmulqdq	xmm1,xmm6,xmm0,0x01
	vpshufd	xmm0,xmm0,0x4e
	vpxor	xmm1,xmm1,xmm0
	vpclmulqdq	xmm0,xmm6,xmm1,0x01
	vpshufd	xmm1,xmm1,0x4e
	vpxor	xmm5,xmm5,xmm1
	vpxor	xmm5,xmm5,xmm0



	vinserti128	ymm3,ymm5,xmm3,1
	vinserti128	ymm5,ymm5,xmm5,1


	vpclmulqdq	ymm0,ymm3,ymm5,0x00
	vpclmulqdq	ymm1,ymm3,ymm5,0x01
	vpclmulqdq	ymm2,ymm3,ymm5,0x10
	vpxor	ymm1,ymm1,ymm2
	vpclmulqdq	ymm2,ymm6,ymm0,0x01
	vpshufd	ymm0,ymm0,0x4e
	vpxor	ymm1,ymm1,ymm0
	vpxor	ymm1,ymm1,ymm2
	vpclmulqdq	ymm4,ymm3,ymm5,0x11
	vpclmulqdq	ymm0,ymm6,ymm1,0x01
	vpshufd	ymm1,ymm1,0x4e
	vpxor	ymm4,ymm4,ymm1
	vpxor	ymm4,ymm4,ymm0



	vmovdqu	YMMWORD[96+rcx],ymm3
	vmovdqu	YMMWORD[64+rcx],ymm4



	vpunpcklqdq	ymm0,ymm4,ymm3
	vpunpckhqdq	ymm1,ymm4,ymm3
	vpxor	ymm0,ymm0,ymm1
	vmovdqu	YMMWORD[(128+32)+rcx],ymm0


	vpclmulqdq	ymm0,ymm4,ymm5,0x00
	vpclmulqdq	ymm1,ymm4,ymm5,0x01
	vpclmulqdq	ymm2,ymm4,ymm5,0x10
	vpxor	ymm1,ymm1,ymm2
	vpclmulqdq	ymm2,ymm6,ymm0,0x01
	vpshufd	ymm0,ymm0,0x4e
	vpxor	ymm1,ymm1,ymm0
	vpxor	ymm1,ymm1,ymm2
	vpclmulqdq	ymm3,ymm4,ymm5,0x11
	vpclmulqdq	ymm0,ymm6,ymm1,0x01
	vpshufd	ymm1,ymm1,0x4e
	vpxor	ymm3,ymm3,ymm1
	vpxor	ymm3,ymm3,ymm0

	vpclmulqdq	ymm0,ymm3,ymm5,0x00
	vpclmulqdq	ymm1,ymm3,ymm5,0x01
	vpclmulqdq	ymm2,ymm3,ymm5,0x10
	vpxor	ymm1,ymm1,ymm2
	vpclmulqdq	ymm2,ymm6,ymm0,0x01
	vpshufd	ymm0,ymm0,0x4e
	vpxor	ymm1,ymm1,ymm0
	vpxor	ymm1,ymm1,ymm2
	vpclmulqdq	ymm4,ymm3,ymm5,0x11
	vpclmulqdq	ymm0,ymm6,ymm1,0x01
	vpshufd	ymm1,ymm1,0x4e
	vpxor	ymm4,ymm4,ymm1
	vpxor	ymm4,ymm4,ymm0

	vmovdqu	YMMWORD[32+rcx],ymm3
	vmovdqu	YMMWORD[rcx],ymm4



	vpunpcklqdq	ymm0,ymm4,ymm3
	vpunpckhqdq	ymm1,ymm4,ymm3
	vpxor	ymm0,ymm0,ymm1
	vmovdqu	YMMWORD[128+rcx],ymm0

	vzeroupper
	vmovdqa	xmm6,XMMWORD[rsp]
	add	rsp,24
	ret
$L$SEH_end_gcm_init_vpclmulqdq_avx2_5:


global	gcm_gmult_vpclmulqdq_avx2

ALIGN	32
gcm_gmult_vpclmulqdq_avx2:

$L$SEH_begin_gcm_gmult_vpclmulqdq_avx2_1:
_CET_ENDBR
	sub	rsp,24
$L$SEH_prologue_gcm_gmult_vpclmulqdq_avx2_2:
	vmovdqa	XMMWORD[rsp],xmm6
$L$SEH_prologue_gcm_gmult_vpclmulqdq_avx2_3:

$L$SEH_endprologue_gcm_gmult_vpclmulqdq_avx2_4:

	vmovdqu	xmm0,XMMWORD[rcx]
	vmovdqu	xmm1,XMMWORD[$L$bswap_mask]
	vmovdqu	xmm2,XMMWORD[((128-16))+rdx]
	vmovdqu	xmm3,XMMWORD[$L$gfpoly]
	vpshufb	xmm0,xmm0,xmm1

	vpclmulqdq	xmm4,xmm0,xmm2,0x00
	vpclmulqdq	xmm5,xmm0,xmm2,0x01
	vpclmulqdq	xmm6,xmm0,xmm2,0x10
	vpxor	xmm5,xmm5,xmm6
	vpclmulqdq	xmm6,xmm3,xmm4,0x01
	vpshufd	xmm4,xmm4,0x4e
	vpxor	xmm5,xmm5,xmm4
	vpxor	xmm5,xmm5,xmm6
	vpclmulqdq	xmm0,xmm0,xmm2,0x11
	vpclmulqdq	xmm4,xmm3,xmm5,0x01
	vpshufd	xmm5,xmm5,0x4e
	vpxor	xmm0,xmm0,xmm5
	vpxor	xmm0,xmm0,xmm4


	vpshufb	xmm0,xmm0,xmm1
	vmovdqu	XMMWORD[rcx],xmm0


	vmovdqa	xmm6,XMMWORD[rsp]
	add	rsp,24
	ret
$L$SEH_end_gcm_gmult_vpclmulqdq_avx2_5:


global	gcm_ghash_vpclmulqdq_avx2

ALIGN	32
gcm_ghash_vpclmulqdq_avx2:

$L$SEH_begin_gcm_ghash_vpclmulqdq_avx2_1:
_CET_ENDBR
	sub	rsp,72
$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx2_2:
	vmovdqa	XMMWORD[rsp],xmm6
$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx2_3:
	vmovdqa	XMMWORD[16+rsp],xmm7
$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx2_4:
	vmovdqa	XMMWORD[32+rsp],xmm8
$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx2_5:
	vmovdqa	XMMWORD[48+rsp],xmm9
$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx2_6:

$L$SEH_endprologue_gcm_ghash_vpclmulqdq_avx2_7:




	vmovdqu	xmm6,XMMWORD[$L$bswap_mask]
	vmovdqu	xmm7,XMMWORD[$L$gfpoly]


	vmovdqu	xmm5,XMMWORD[rcx]
	vpshufb	xmm5,xmm5,xmm6


	cmp	r9,32
	jb	NEAR $L$ghash_lastblock



	vinserti128	ymm6,ymm6,xmm6,1
	vinserti128	ymm7,ymm7,xmm7,1

	cmp	r9,127
	jbe	NEAR $L$ghash_loop_1x


	vmovdqu	ymm8,YMMWORD[128+rdx]
	vmovdqu	ymm9,YMMWORD[((128+32))+rdx]
$L$ghash_loop_4x:

	vmovdqu	ymm1,YMMWORD[r8]
	vpshufb	ymm1,ymm1,ymm6
	vmovdqu	ymm2,YMMWORD[rdx]
	vpxor	ymm1,ymm1,ymm5
	vpclmulqdq	ymm3,ymm1,ymm2,0x00
	vpclmulqdq	ymm5,ymm1,ymm2,0x11
	vpunpckhqdq	ymm0,ymm1,ymm1
	vpxor	ymm0,ymm0,ymm1
	vpclmulqdq	ymm4,ymm0,ymm8,0x00

	vmovdqu	ymm1,YMMWORD[32+r8]
	vpshufb	ymm1,ymm1,ymm6
	vmovdqu	ymm2,YMMWORD[32+rdx]
	vpclmulqdq	ymm0,ymm1,ymm2,0x00
	vpxor	ymm3,ymm3,ymm0
	vpclmulqdq	ymm0,ymm1,ymm2,0x11
	vpxor	ymm5,ymm5,ymm0
	vpunpckhqdq	ymm0,ymm1,ymm1
	vpxor	ymm0,ymm0,ymm1
	vpclmulqdq	ymm0,ymm0,ymm8,0x10
	vpxor	ymm4,ymm4,ymm0

	vmovdqu	ymm1,YMMWORD[64+r8]
	vpshufb	ymm1,ymm1,ymm6
	vmovdqu	ymm2,YMMWORD[64+rdx]
	vpclmulqdq	ymm0,ymm1,ymm2,0x00
	vpxor	ymm3,ymm3,ymm0
	vpclmulqdq	ymm0,ymm1,ymm2,0x11
	vpxor	ymm5,ymm5,ymm0
	vpunpckhqdq	ymm0,ymm1,ymm1
	vpxor	ymm0,ymm0,ymm1
	vpclmulqdq	ymm0,ymm0,ymm9,0x00
	vpxor	ymm4,ymm4,ymm0


	vmovdqu	ymm1,YMMWORD[96+r8]
	vpshufb	ymm1,ymm1,ymm6
	vmovdqu	ymm2,YMMWORD[96+rdx]
	vpclmulqdq	ymm0,ymm1,ymm2,0x00
	vpxor	ymm3,ymm3,ymm0
	vpclmulqdq	ymm0,ymm1,ymm2,0x11
	vpxor	ymm5,ymm5,ymm0
	vpunpckhqdq	ymm0,ymm1,ymm1
	vpxor	ymm0,ymm0,ymm1
	vpclmulqdq	ymm0,ymm0,ymm9,0x10
	vpxor	ymm4,ymm4,ymm0

	vpxor	ymm4,ymm4,ymm3
	vpxor	ymm4,ymm4,ymm5


	vbroadcasti128	ymm2,XMMWORD[$L$gfpoly]
	vpclmulqdq	ymm0,ymm2,ymm3,0x01
	vpshufd	ymm3,ymm3,0x4e
	vpxor	ymm4,ymm4,ymm3
	vpxor	ymm4,ymm4,ymm0

	vpclmulqdq	ymm0,ymm2,ymm4,0x01
	vpshufd	ymm4,ymm4,0x4e
	vpxor	ymm5,ymm5,ymm4
	vpxor	ymm5,ymm5,ymm0
	vextracti128	xmm0,ymm5,1
	vpxor	xmm5,xmm5,xmm0

	sub	r8,-128
	add	r9,-128
	cmp	r9,127
	ja	NEAR $L$ghash_loop_4x


	cmp	r9,32
	jb	NEAR $L$ghash_loop_1x_done
$L$ghash_loop_1x:
	vmovdqu	ymm0,YMMWORD[r8]
	vpshufb	ymm0,ymm0,ymm6
	vpxor	ymm5,ymm5,ymm0
	vmovdqu	ymm0,YMMWORD[((128-32))+rdx]
	vpclmulqdq	ymm1,ymm5,ymm0,0x00
	vpclmulqdq	ymm2,ymm5,ymm0,0x01
	vpclmulqdq	ymm3,ymm5,ymm0,0x10
	vpxor	ymm2,ymm2,ymm3
	vpclmulqdq	ymm3,ymm7,ymm1,0x01
	vpshufd	ymm1,ymm1,0x4e
	vpxor	ymm2,ymm2,ymm1
	vpxor	ymm2,ymm2,ymm3
	vpclmulqdq	ymm5,ymm5,ymm0,0x11
	vpclmulqdq	ymm1,ymm7,ymm2,0x01
	vpshufd	ymm2,ymm2,0x4e
	vpxor	ymm5,ymm5,ymm2
	vpxor	ymm5,ymm5,ymm1

	vextracti128	xmm0,ymm5,1
	vpxor	xmm5,xmm5,xmm0
	add	r8,32
	sub	r9,32
	cmp	r9,32
	jae	NEAR $L$ghash_loop_1x
$L$ghash_loop_1x_done:


$L$ghash_lastblock:
	test	r9,r9
	jz	NEAR $L$ghash_done
	vmovdqu	xmm0,XMMWORD[r8]
	vpshufb	xmm0,xmm0,xmm6
	vpxor	xmm5,xmm5,xmm0
	vmovdqu	xmm0,XMMWORD[((128-16))+rdx]
	vpclmulqdq	xmm1,xmm5,xmm0,0x00
	vpclmulqdq	xmm2,xmm5,xmm0,0x01
	vpclmulqdq	xmm3,xmm5,xmm0,0x10
	vpxor	xmm2,xmm2,xmm3
	vpclmulqdq	xmm3,xmm7,xmm1,0x01
	vpshufd	xmm1,xmm1,0x4e
	vpxor	xmm2,xmm2,xmm1
	vpxor	xmm2,xmm2,xmm3
	vpclmulqdq	xmm5,xmm5,xmm0,0x11
	vpclmulqdq	xmm1,xmm7,xmm2,0x01
	vpshufd	xmm2,xmm2,0x4e
	vpxor	xmm5,xmm5,xmm2
	vpxor	xmm5,xmm5,xmm1


$L$ghash_done:

	vpshufb	xmm5,xmm5,xmm6
	vmovdqu	XMMWORD[rcx],xmm5

	vzeroupper
	vmovdqa	xmm6,XMMWORD[rsp]
	vmovdqa	xmm7,XMMWORD[16+rsp]
	vmovdqa	xmm8,XMMWORD[32+rsp]
	vmovdqa	xmm9,XMMWORD[48+rsp]
	add	rsp,72
	ret
$L$SEH_end_gcm_ghash_vpclmulqdq_avx2_8:


global	aes_gcm_enc_update_vaes_avx2

ALIGN	32
aes_gcm_enc_update_vaes_avx2:

$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1:
_CET_ENDBR
	push	rsi
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_2:
	push	rdi
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_3:
	push	r12
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_4:

	mov	rsi,QWORD[64+rsp]
	mov	rdi,QWORD[72+rsp]
	mov	r12,QWORD[80+rsp]
	sub	rsp,160
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_5:
	vmovdqa	XMMWORD[rsp],xmm6
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_6:
	vmovdqa	XMMWORD[16+rsp],xmm7
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_7:
	vmovdqa	XMMWORD[32+rsp],xmm8
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_8:
	vmovdqa	XMMWORD[48+rsp],xmm9
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_9:
	vmovdqa	XMMWORD[64+rsp],xmm10
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_10:
	vmovdqa	XMMWORD[80+rsp],xmm11
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_11:
	vmovdqa	XMMWORD[96+rsp],xmm12
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_12:
	vmovdqa	XMMWORD[112+rsp],xmm13
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_13:
	vmovdqa	XMMWORD[128+rsp],xmm14
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_14:
	vmovdqa	XMMWORD[144+rsp],xmm15
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_15:

$L$SEH_endprologue_aes_gcm_enc_update_vaes_avx2_16:
%ifdef BORINGSSL_DISPATCH_TEST
EXTERN	BORINGSSL_function_hit
	mov	BYTE[((BORINGSSL_function_hit+6))],1
%endif
	vbroadcasti128	ymm0,XMMWORD[$L$bswap_mask]



	vmovdqu	xmm1,XMMWORD[r12]
	vpshufb	xmm1,xmm1,xmm0
	vbroadcasti128	ymm11,XMMWORD[rsi]
	vpshufb	ymm11,ymm11,ymm0



	mov	r10d,DWORD[240+r9]
	lea	r10d,[((-20))+r10*4]




	lea	r11,[96+r10*4+r9]
	vbroadcasti128	ymm9,XMMWORD[r9]
	vbroadcasti128	ymm10,XMMWORD[r11]


	vpaddd	ymm11,ymm11,YMMWORD[$L$ctr_pattern]



	cmp	r8,127
	jbe	NEAR $L$crypt_loop_4x_done__func1

	vmovdqu	ymm7,YMMWORD[128+rdi]
	vmovdqu	ymm8,YMMWORD[((128+32))+rdi]



	vmovdqu	ymm2,YMMWORD[$L$inc_2blocks]
	vpshufb	ymm12,ymm11,ymm0
	vpaddd	ymm11,ymm11,ymm2
	vpshufb	ymm13,ymm11,ymm0
	vpaddd	ymm11,ymm11,ymm2
	vpshufb	ymm14,ymm11,ymm0
	vpaddd	ymm11,ymm11,ymm2
	vpshufb	ymm15,ymm11,ymm0
	vpaddd	ymm11,ymm11,ymm2


	vpxor	ymm12,ymm12,ymm9
	vpxor	ymm13,ymm13,ymm9
	vpxor	ymm14,ymm14,ymm9
	vpxor	ymm15,ymm15,ymm9

	lea	rax,[16+r9]
$L$vaesenc_loop_first_4_vecs__func1:
	vbroadcasti128	ymm2,XMMWORD[rax]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

	add	rax,16
	cmp	r11,rax
	jne	NEAR $L$vaesenc_loop_first_4_vecs__func1
	vpxor	ymm2,ymm10,YMMWORD[rcx]
	vpxor	ymm3,ymm10,YMMWORD[32+rcx]
	vpxor	ymm5,ymm10,YMMWORD[64+rcx]
	vpxor	ymm6,ymm10,YMMWORD[96+rcx]
	vaesenclast	ymm12,ymm12,ymm2
	vaesenclast	ymm13,ymm13,ymm3
	vaesenclast	ymm14,ymm14,ymm5
	vaesenclast	ymm15,ymm15,ymm6
	vmovdqu	YMMWORD[rdx],ymm12
	vmovdqu	YMMWORD[32+rdx],ymm13
	vmovdqu	YMMWORD[64+rdx],ymm14
	vmovdqu	YMMWORD[96+rdx],ymm15

	sub	rcx,-128
	add	r8,-128
	cmp	r8,127
	jbe	NEAR $L$ghash_last_ciphertext_4x__func1
ALIGN	16
$L$crypt_loop_4x__func1:




	vmovdqu	ymm2,YMMWORD[$L$inc_2blocks]
	vpshufb	ymm12,ymm11,ymm0
	vpaddd	ymm11,ymm11,ymm2
	vpshufb	ymm13,ymm11,ymm0
	vpaddd	ymm11,ymm11,ymm2
	vpshufb	ymm14,ymm11,ymm0
	vpaddd	ymm11,ymm11,ymm2
	vpshufb	ymm15,ymm11,ymm0
	vpaddd	ymm11,ymm11,ymm2


	vpxor	ymm12,ymm12,ymm9
	vpxor	ymm13,ymm13,ymm9
	vpxor	ymm14,ymm14,ymm9
	vpxor	ymm15,ymm15,ymm9

	cmp	r10d,24
	jl	NEAR $L$aes128__func1
	je	NEAR $L$aes192__func1

	vbroadcasti128	ymm2,XMMWORD[((-208))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

	vbroadcasti128	ymm2,XMMWORD[((-192))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

$L$aes192__func1:
	vbroadcasti128	ymm2,XMMWORD[((-176))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

	vbroadcasti128	ymm2,XMMWORD[((-160))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

$L$aes128__func1:
	prefetcht0	[512+rcx]
	prefetcht0	[((512+64))+rcx]

	vmovdqu	ymm3,YMMWORD[rdx]
	vpshufb	ymm3,ymm3,ymm0
	vmovdqu	ymm4,YMMWORD[rdi]
	vpxor	ymm3,ymm3,ymm1
	vpclmulqdq	ymm5,ymm3,ymm4,0x00
	vpclmulqdq	ymm1,ymm3,ymm4,0x11
	vpunpckhqdq	ymm2,ymm3,ymm3
	vpxor	ymm2,ymm2,ymm3
	vpclmulqdq	ymm6,ymm2,ymm7,0x00

	vbroadcasti128	ymm2,XMMWORD[((-144))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2


	vbroadcasti128	ymm2,XMMWORD[((-128))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2


	vmovdqu	ymm3,YMMWORD[32+rdx]
	vpshufb	ymm3,ymm3,ymm0
	vmovdqu	ymm4,YMMWORD[32+rdi]
	vpclmulqdq	ymm2,ymm3,ymm4,0x00
	vpxor	ymm5,ymm5,ymm2
	vpclmulqdq	ymm2,ymm3,ymm4,0x11
	vpxor	ymm1,ymm1,ymm2
	vpunpckhqdq	ymm2,ymm3,ymm3
	vpxor	ymm2,ymm2,ymm3
	vpclmulqdq	ymm2,ymm2,ymm7,0x10
	vpxor	ymm6,ymm6,ymm2

	vbroadcasti128	ymm2,XMMWORD[((-112))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2


	vmovdqu	ymm3,YMMWORD[64+rdx]
	vpshufb	ymm3,ymm3,ymm0
	vmovdqu	ymm4,YMMWORD[64+rdi]

	vbroadcasti128	ymm2,XMMWORD[((-96))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

	vpclmulqdq	ymm2,ymm3,ymm4,0x00
	vpxor	ymm5,ymm5,ymm2
	vpclmulqdq	ymm2,ymm3,ymm4,0x11
	vpxor	ymm1,ymm1,ymm2

	vbroadcasti128	ymm2,XMMWORD[((-80))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

	vpunpckhqdq	ymm2,ymm3,ymm3
	vpxor	ymm2,ymm2,ymm3
	vpclmulqdq	ymm2,ymm2,ymm8,0x00
	vpxor	ymm6,ymm6,ymm2


	vmovdqu	ymm3,YMMWORD[96+rdx]
	vpshufb	ymm3,ymm3,ymm0

	vbroadcasti128	ymm2,XMMWORD[((-64))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

	vmovdqu	ymm4,YMMWORD[96+rdi]
	vpclmulqdq	ymm2,ymm3,ymm4,0x00
	vpxor	ymm5,ymm5,ymm2
	vpclmulqdq	ymm2,ymm3,ymm4,0x11
	vpxor	ymm1,ymm1,ymm2
	vpunpckhqdq	ymm2,ymm3,ymm3
	vpxor	ymm2,ymm2,ymm3
	vpclmulqdq	ymm2,ymm2,ymm8,0x10
	vpxor	ymm6,ymm6,ymm2

	vbroadcasti128	ymm2,XMMWORD[((-48))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2


	vpxor	ymm6,ymm6,ymm5
	vpxor	ymm6,ymm6,ymm1


	vbroadcasti128	ymm4,XMMWORD[$L$gfpoly]
	vpclmulqdq	ymm2,ymm4,ymm5,0x01
	vpshufd	ymm5,ymm5,0x4e
	vpxor	ymm6,ymm6,ymm5
	vpxor	ymm6,ymm6,ymm2

	vbroadcasti128	ymm2,XMMWORD[((-32))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2


	vpclmulqdq	ymm2,ymm4,ymm6,0x01
	vpshufd	ymm6,ymm6,0x4e
	vpxor	ymm1,ymm1,ymm6
	vpxor	ymm1,ymm1,ymm2

	vbroadcasti128	ymm2,XMMWORD[((-16))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

	vextracti128	xmm2,ymm1,1
	vpxor	xmm1,xmm1,xmm2


	sub	rdx,-128
	vpxor	ymm2,ymm10,YMMWORD[rcx]
	vpxor	ymm3,ymm10,YMMWORD[32+rcx]
	vpxor	ymm5,ymm10,YMMWORD[64+rcx]
	vpxor	ymm6,ymm10,YMMWORD[96+rcx]
	vaesenclast	ymm12,ymm12,ymm2
	vaesenclast	ymm13,ymm13,ymm3
	vaesenclast	ymm14,ymm14,ymm5
	vaesenclast	ymm15,ymm15,ymm6
	vmovdqu	YMMWORD[rdx],ymm12
	vmovdqu	YMMWORD[32+rdx],ymm13
	vmovdqu	YMMWORD[64+rdx],ymm14
	vmovdqu	YMMWORD[96+rdx],ymm15

	sub	rcx,-128

	add	r8,-128
	cmp	r8,127
	ja	NEAR $L$crypt_loop_4x__func1
$L$ghash_last_ciphertext_4x__func1:

	vmovdqu	ymm3,YMMWORD[rdx]
	vpshufb	ymm3,ymm3,ymm0
	vmovdqu	ymm4,YMMWORD[rdi]
	vpxor	ymm3,ymm3,ymm1
	vpclmulqdq	ymm5,ymm3,ymm4,0x00
	vpclmulqdq	ymm1,ymm3,ymm4,0x11
	vpunpckhqdq	ymm2,ymm3,ymm3
	vpxor	ymm2,ymm2,ymm3
	vpclmulqdq	ymm6,ymm2,ymm7,0x00

	vmovdqu	ymm3,YMMWORD[32+rdx]
	vpshufb	ymm3,ymm3,ymm0
	vmovdqu	ymm4,YMMWORD[32+rdi]
	vpclmulqdq	ymm2,ymm3,ymm4,0x00
	vpxor	ymm5,ymm5,ymm2
	vpclmulqdq	ymm2,ymm3,ymm4,0x11
	vpxor	ymm1,ymm1,ymm2
	vpunpckhqdq	ymm2,ymm3,ymm3
	vpxor	ymm2,ymm2,ymm3
	vpclmulqdq	ymm2,ymm2,ymm7,0x10
	vpxor	ymm6,ymm6,ymm2

	vmovdqu	ymm3,YMMWORD[64+rdx]
	vpshufb	ymm3,ymm3,ymm0
	vmovdqu	ymm4,YMMWORD[64+rdi]
	vpclmulqdq	ymm2,ymm3,ymm4,0x00
	vpxor	ymm5,ymm5,ymm2
	vpclmulqdq	ymm2,ymm3,ymm4,0x11
	vpxor	ymm1,ymm1,ymm2
	vpunpckhqdq	ymm2,ymm3,ymm3
	vpxor	ymm2,ymm2,ymm3
	vpclmulqdq	ymm2,ymm2,ymm8,0x00
	vpxor	ymm6,ymm6,ymm2


	vmovdqu	ymm3,YMMWORD[96+rdx]
	vpshufb	ymm3,ymm3,ymm0
	vmovdqu	ymm4,YMMWORD[96+rdi]
	vpclmulqdq	ymm2,ymm3,ymm4,0x00
	vpxor	ymm5,ymm5,ymm2
	vpclmulqdq	ymm2,ymm3,ymm4,0x11
	vpxor	ymm1,ymm1,ymm2
	vpunpckhqdq	ymm2,ymm3,ymm3
	vpxor	ymm2,ymm2,ymm3
	vpclmulqdq	ymm2,ymm2,ymm8,0x10
	vpxor	ymm6,ymm6,ymm2

	vpxor	ymm6,ymm6,ymm5
	vpxor	ymm6,ymm6,ymm1


	vbroadcasti128	ymm4,XMMWORD[$L$gfpoly]
	vpclmulqdq	ymm2,ymm4,ymm5,0x01
	vpshufd	ymm5,ymm5,0x4e
	vpxor	ymm6,ymm6,ymm5
	vpxor	ymm6,ymm6,ymm2

	vpclmulqdq	ymm2,ymm4,ymm6,0x01
	vpshufd	ymm6,ymm6,0x4e
	vpxor	ymm1,ymm1,ymm6
	vpxor	ymm1,ymm1,ymm2
	vextracti128	xmm2,ymm1,1
	vpxor	xmm1,xmm1,xmm2

	sub	rdx,-128
$L$crypt_loop_4x_done__func1:

	test	r8,r8
	jz	NEAR $L$done__func1





	lea	rsi,[128+rdi]
	sub	rsi,r8


	vpxor	xmm5,xmm5,xmm5
	vpxor	xmm6,xmm6,xmm6
	vpxor	xmm7,xmm7,xmm7

	cmp	r8,64
	jb	NEAR $L$lessthan64bytes__func1


	vpshufb	ymm12,ymm11,ymm0
	vpaddd	ymm11,ymm11,YMMWORD[$L$inc_2blocks]
	vpshufb	ymm13,ymm11,ymm0
	vpaddd	ymm11,ymm11,YMMWORD[$L$inc_2blocks]
	vpxor	ymm12,ymm12,ymm9
	vpxor	ymm13,ymm13,ymm9
	lea	rax,[16+r9]
$L$vaesenc_loop_tail_1__func1:
	vbroadcasti128	ymm2,XMMWORD[rax]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	add	rax,16
	cmp	r11,rax
	jne	NEAR $L$vaesenc_loop_tail_1__func1
	vaesenclast	ymm12,ymm12,ymm10
	vaesenclast	ymm13,ymm13,ymm10


	vmovdqu	ymm2,YMMWORD[rcx]
	vmovdqu	ymm3,YMMWORD[32+rcx]
	vpxor	ymm12,ymm12,ymm2
	vpxor	ymm13,ymm13,ymm3
	vmovdqu	YMMWORD[rdx],ymm12
	vmovdqu	YMMWORD[32+rdx],ymm13


	vpshufb	ymm12,ymm12,ymm0
	vpshufb	ymm13,ymm13,ymm0
	vpxor	ymm12,ymm12,ymm1
	vmovdqu	ymm2,YMMWORD[rsi]
	vmovdqu	ymm3,YMMWORD[32+rsi]
	vpclmulqdq	ymm5,ymm12,ymm2,0x00
	vpclmulqdq	ymm6,ymm12,ymm2,0x01
	vpclmulqdq	ymm4,ymm12,ymm2,0x10
	vpxor	ymm6,ymm6,ymm4
	vpclmulqdq	ymm7,ymm12,ymm2,0x11
	vpclmulqdq	ymm4,ymm13,ymm3,0x00
	vpxor	ymm5,ymm5,ymm4
	vpclmulqdq	ymm4,ymm13,ymm3,0x01
	vpxor	ymm6,ymm6,ymm4
	vpclmulqdq	ymm4,ymm13,ymm3,0x10
	vpxor	ymm6,ymm6,ymm4
	vpclmulqdq	ymm4,ymm13,ymm3,0x11
	vpxor	ymm7,ymm7,ymm4

	add	rsi,64
	add	rcx,64
	add	rdx,64
	sub	r8,64
	jz	NEAR $L$reduce__func1

	vpxor	xmm1,xmm1,xmm1


$L$lessthan64bytes__func1:
	vpshufb	ymm12,ymm11,ymm0
	vpaddd	ymm11,ymm11,YMMWORD[$L$inc_2blocks]
	vpshufb	ymm13,ymm11,ymm0
	vpxor	ymm12,ymm12,ymm9
	vpxor	ymm13,ymm13,ymm9
	lea	rax,[16+r9]
$L$vaesenc_loop_tail_2__func1:
	vbroadcasti128	ymm2,XMMWORD[rax]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	add	rax,16
	cmp	r11,rax
	jne	NEAR $L$vaesenc_loop_tail_2__func1
	vaesenclast	ymm12,ymm12,ymm10
	vaesenclast	ymm13,ymm13,ymm10




	cmp	r8,32
	jb	NEAR $L$xor_one_block__func1
	je	NEAR $L$xor_two_blocks__func1

$L$xor_three_blocks__func1:
	vmovdqu	ymm2,YMMWORD[rcx]
	vmovdqu	xmm3,XMMWORD[32+rcx]
	vpxor	ymm12,ymm12,ymm2
	vpxor	xmm13,xmm13,xmm3
	vmovdqu	YMMWORD[rdx],ymm12
	vmovdqu	XMMWORD[32+rdx],xmm13

	vpshufb	ymm12,ymm12,ymm0
	vpshufb	xmm13,xmm13,xmm0
	vpxor	ymm12,ymm12,ymm1
	vmovdqu	ymm2,YMMWORD[rsi]
	vmovdqu	xmm3,XMMWORD[32+rsi]
	vpclmulqdq	xmm4,xmm13,xmm3,0x00
	vpxor	ymm5,ymm5,ymm4
	vpclmulqdq	xmm4,xmm13,xmm3,0x01
	vpxor	ymm6,ymm6,ymm4
	vpclmulqdq	xmm4,xmm13,xmm3,0x10
	vpxor	ymm6,ymm6,ymm4
	vpclmulqdq	xmm4,xmm13,xmm3,0x11
	vpxor	ymm7,ymm7,ymm4
	jmp	NEAR $L$ghash_mul_one_vec_unreduced__func1

$L$xor_two_blocks__func1:
	vmovdqu	ymm2,YMMWORD[rcx]
	vpxor	ymm12,ymm12,ymm2
	vmovdqu	YMMWORD[rdx],ymm12
	vpshufb	ymm12,ymm12,ymm0
	vpxor	ymm12,ymm12,ymm1
	vmovdqu	ymm2,YMMWORD[rsi]
	jmp	NEAR $L$ghash_mul_one_vec_unreduced__func1

$L$xor_one_block__func1:
	vmovdqu	xmm2,XMMWORD[rcx]
	vpxor	xmm12,xmm12,xmm2
	vmovdqu	XMMWORD[rdx],xmm12
	vpshufb	xmm12,xmm12,xmm0
	vpxor	xmm12,xmm12,xmm1
	vmovdqu	xmm2,XMMWORD[rsi]

$L$ghash_mul_one_vec_unreduced__func1:
	vpclmulqdq	ymm4,ymm12,ymm2,0x00
	vpxor	ymm5,ymm5,ymm4
	vpclmulqdq	ymm4,ymm12,ymm2,0x01
	vpxor	ymm6,ymm6,ymm4
	vpclmulqdq	ymm4,ymm12,ymm2,0x10
	vpxor	ymm6,ymm6,ymm4
	vpclmulqdq	ymm4,ymm12,ymm2,0x11
	vpxor	ymm7,ymm7,ymm4

$L$reduce__func1:

	vbroadcasti128	ymm2,XMMWORD[$L$gfpoly]
	vpclmulqdq	ymm3,ymm2,ymm5,0x01
	vpshufd	ymm5,ymm5,0x4e
	vpxor	ymm6,ymm6,ymm5
	vpxor	ymm6,ymm6,ymm3
	vpclmulqdq	ymm3,ymm2,ymm6,0x01
	vpshufd	ymm6,ymm6,0x4e
	vpxor	ymm7,ymm7,ymm6
	vpxor	ymm7,ymm7,ymm3
	vextracti128	xmm1,ymm7,1
	vpxor	xmm1,xmm1,xmm7

$L$done__func1:

	vpshufb	xmm1,xmm1,xmm0
	vmovdqu	XMMWORD[r12],xmm1

	vzeroupper
	vmovdqa	xmm6,XMMWORD[rsp]
	vmovdqa	xmm7,XMMWORD[16+rsp]
	vmovdqa	xmm8,XMMWORD[32+rsp]
	vmovdqa	xmm9,XMMWORD[48+rsp]
	vmovdqa	xmm10,XMMWORD[64+rsp]
	vmovdqa	xmm11,XMMWORD[80+rsp]
	vmovdqa	xmm12,XMMWORD[96+rsp]
	vmovdqa	xmm13,XMMWORD[112+rsp]
	vmovdqa	xmm14,XMMWORD[128+rsp]
	vmovdqa	xmm15,XMMWORD[144+rsp]
	add	rsp,160
	pop	r12
	pop	rdi
	pop	rsi
	ret
$L$SEH_end_aes_gcm_enc_update_vaes_avx2_17:


global	aes_gcm_dec_update_vaes_avx2

ALIGN	32
aes_gcm_dec_update_vaes_avx2:

$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1:
_CET_ENDBR
	push	rsi
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_2:
	push	rdi
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_3:
	push	r12
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_4:

	mov	rsi,QWORD[64+rsp]
	mov	rdi,QWORD[72+rsp]
	mov	r12,QWORD[80+rsp]
	sub	rsp,160
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_5:
	vmovdqa	XMMWORD[rsp],xmm6
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_6:
	vmovdqa	XMMWORD[16+rsp],xmm7
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_7:
	vmovdqa	XMMWORD[32+rsp],xmm8
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_8:
	vmovdqa	XMMWORD[48+rsp],xmm9
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_9:
	vmovdqa	XMMWORD[64+rsp],xmm10
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_10:
	vmovdqa	XMMWORD[80+rsp],xmm11
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_11:
	vmovdqa	XMMWORD[96+rsp],xmm12
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_12:
	vmovdqa	XMMWORD[112+rsp],xmm13
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_13:
	vmovdqa	XMMWORD[128+rsp],xmm14
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_14:
	vmovdqa	XMMWORD[144+rsp],xmm15
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_15:

$L$SEH_endprologue_aes_gcm_dec_update_vaes_avx2_16:
	vbroadcasti128	ymm0,XMMWORD[$L$bswap_mask]



	vmovdqu	xmm1,XMMWORD[r12]
	vpshufb	xmm1,xmm1,xmm0
	vbroadcasti128	ymm11,XMMWORD[rsi]
	vpshufb	ymm11,ymm11,ymm0



	mov	r10d,DWORD[240+r9]
	lea	r10d,[((-20))+r10*4]




	lea	r11,[96+r10*4+r9]
	vbroadcasti128	ymm9,XMMWORD[r9]
	vbroadcasti128	ymm10,XMMWORD[r11]


	vpaddd	ymm11,ymm11,YMMWORD[$L$ctr_pattern]



	cmp	r8,127
	jbe	NEAR $L$crypt_loop_4x_done__func2

	vmovdqu	ymm7,YMMWORD[128+rdi]
	vmovdqu	ymm8,YMMWORD[((128+32))+rdi]
ALIGN	16
$L$crypt_loop_4x__func2:




	vmovdqu	ymm2,YMMWORD[$L$inc_2blocks]
	vpshufb	ymm12,ymm11,ymm0
	vpaddd	ymm11,ymm11,ymm2
	vpshufb	ymm13,ymm11,ymm0
	vpaddd	ymm11,ymm11,ymm2
	vpshufb	ymm14,ymm11,ymm0
	vpaddd	ymm11,ymm11,ymm2
	vpshufb	ymm15,ymm11,ymm0
	vpaddd	ymm11,ymm11,ymm2


	vpxor	ymm12,ymm12,ymm9
	vpxor	ymm13,ymm13,ymm9
	vpxor	ymm14,ymm14,ymm9
	vpxor	ymm15,ymm15,ymm9

	cmp	r10d,24
	jl	NEAR $L$aes128__func2
	je	NEAR $L$aes192__func2

	vbroadcasti128	ymm2,XMMWORD[((-208))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

	vbroadcasti128	ymm2,XMMWORD[((-192))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

$L$aes192__func2:
	vbroadcasti128	ymm2,XMMWORD[((-176))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

	vbroadcasti128	ymm2,XMMWORD[((-160))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

$L$aes128__func2:
	prefetcht0	[512+rcx]
	prefetcht0	[((512+64))+rcx]

	vmovdqu	ymm3,YMMWORD[rcx]
	vpshufb	ymm3,ymm3,ymm0
	vmovdqu	ymm4,YMMWORD[rdi]
	vpxor	ymm3,ymm3,ymm1
	vpclmulqdq	ymm5,ymm3,ymm4,0x00
	vpclmulqdq	ymm1,ymm3,ymm4,0x11
	vpunpckhqdq	ymm2,ymm3,ymm3
	vpxor	ymm2,ymm2,ymm3
	vpclmulqdq	ymm6,ymm2,ymm7,0x00

	vbroadcasti128	ymm2,XMMWORD[((-144))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2


	vbroadcasti128	ymm2,XMMWORD[((-128))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2


	vmovdqu	ymm3,YMMWORD[32+rcx]
	vpshufb	ymm3,ymm3,ymm0
	vmovdqu	ymm4,YMMWORD[32+rdi]
	vpclmulqdq	ymm2,ymm3,ymm4,0x00
	vpxor	ymm5,ymm5,ymm2
	vpclmulqdq	ymm2,ymm3,ymm4,0x11
	vpxor	ymm1,ymm1,ymm2
	vpunpckhqdq	ymm2,ymm3,ymm3
	vpxor	ymm2,ymm2,ymm3
	vpclmulqdq	ymm2,ymm2,ymm7,0x10
	vpxor	ymm6,ymm6,ymm2

	vbroadcasti128	ymm2,XMMWORD[((-112))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2


	vmovdqu	ymm3,YMMWORD[64+rcx]
	vpshufb	ymm3,ymm3,ymm0
	vmovdqu	ymm4,YMMWORD[64+rdi]

	vbroadcasti128	ymm2,XMMWORD[((-96))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

	vpclmulqdq	ymm2,ymm3,ymm4,0x00
	vpxor	ymm5,ymm5,ymm2
	vpclmulqdq	ymm2,ymm3,ymm4,0x11
	vpxor	ymm1,ymm1,ymm2

	vbroadcasti128	ymm2,XMMWORD[((-80))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

	vpunpckhqdq	ymm2,ymm3,ymm3
	vpxor	ymm2,ymm2,ymm3
	vpclmulqdq	ymm2,ymm2,ymm8,0x00
	vpxor	ymm6,ymm6,ymm2


	vmovdqu	ymm3,YMMWORD[96+rcx]
	vpshufb	ymm3,ymm3,ymm0

	vbroadcasti128	ymm2,XMMWORD[((-64))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

	vmovdqu	ymm4,YMMWORD[96+rdi]
	vpclmulqdq	ymm2,ymm3,ymm4,0x00
	vpxor	ymm5,ymm5,ymm2
	vpclmulqdq	ymm2,ymm3,ymm4,0x11
	vpxor	ymm1,ymm1,ymm2
	vpunpckhqdq	ymm2,ymm3,ymm3
	vpxor	ymm2,ymm2,ymm3
	vpclmulqdq	ymm2,ymm2,ymm8,0x10
	vpxor	ymm6,ymm6,ymm2

	vbroadcasti128	ymm2,XMMWORD[((-48))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2


	vpxor	ymm6,ymm6,ymm5
	vpxor	ymm6,ymm6,ymm1


	vbroadcasti128	ymm4,XMMWORD[$L$gfpoly]
	vpclmulqdq	ymm2,ymm4,ymm5,0x01
	vpshufd	ymm5,ymm5,0x4e
	vpxor	ymm6,ymm6,ymm5
	vpxor	ymm6,ymm6,ymm2

	vbroadcasti128	ymm2,XMMWORD[((-32))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2


	vpclmulqdq	ymm2,ymm4,ymm6,0x01
	vpshufd	ymm6,ymm6,0x4e
	vpxor	ymm1,ymm1,ymm6
	vpxor	ymm1,ymm1,ymm2

	vbroadcasti128	ymm2,XMMWORD[((-16))+r11]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	vaesenc	ymm14,ymm14,ymm2
	vaesenc	ymm15,ymm15,ymm2

	vextracti128	xmm2,ymm1,1
	vpxor	xmm1,xmm1,xmm2



	vpxor	ymm2,ymm10,YMMWORD[rcx]
	vpxor	ymm3,ymm10,YMMWORD[32+rcx]
	vpxor	ymm5,ymm10,YMMWORD[64+rcx]
	vpxor	ymm6,ymm10,YMMWORD[96+rcx]
	vaesenclast	ymm12,ymm12,ymm2
	vaesenclast	ymm13,ymm13,ymm3
	vaesenclast	ymm14,ymm14,ymm5
	vaesenclast	ymm15,ymm15,ymm6
	vmovdqu	YMMWORD[rdx],ymm12
	vmovdqu	YMMWORD[32+rdx],ymm13
	vmovdqu	YMMWORD[64+rdx],ymm14
	vmovdqu	YMMWORD[96+rdx],ymm15

	sub	rcx,-128
	sub	rdx,-128
	add	r8,-128
	cmp	r8,127
	ja	NEAR $L$crypt_loop_4x__func2
$L$crypt_loop_4x_done__func2:

	test	r8,r8
	jz	NEAR $L$done__func2





	lea	rsi,[128+rdi]
	sub	rsi,r8


	vpxor	xmm5,xmm5,xmm5
	vpxor	xmm6,xmm6,xmm6
	vpxor	xmm7,xmm7,xmm7

	cmp	r8,64
	jb	NEAR $L$lessthan64bytes__func2


	vpshufb	ymm12,ymm11,ymm0
	vpaddd	ymm11,ymm11,YMMWORD[$L$inc_2blocks]
	vpshufb	ymm13,ymm11,ymm0
	vpaddd	ymm11,ymm11,YMMWORD[$L$inc_2blocks]
	vpxor	ymm12,ymm12,ymm9
	vpxor	ymm13,ymm13,ymm9
	lea	rax,[16+r9]
$L$vaesenc_loop_tail_1__func2:
	vbroadcasti128	ymm2,XMMWORD[rax]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	add	rax,16
	cmp	r11,rax
	jne	NEAR $L$vaesenc_loop_tail_1__func2
	vaesenclast	ymm12,ymm12,ymm10
	vaesenclast	ymm13,ymm13,ymm10


	vmovdqu	ymm2,YMMWORD[rcx]
	vmovdqu	ymm3,YMMWORD[32+rcx]
	vpxor	ymm12,ymm12,ymm2
	vpxor	ymm13,ymm13,ymm3
	vmovdqu	YMMWORD[rdx],ymm12
	vmovdqu	YMMWORD[32+rdx],ymm13


	vpshufb	ymm12,ymm2,ymm0
	vpshufb	ymm13,ymm3,ymm0
	vpxor	ymm12,ymm12,ymm1
	vmovdqu	ymm2,YMMWORD[rsi]
	vmovdqu	ymm3,YMMWORD[32+rsi]
	vpclmulqdq	ymm5,ymm12,ymm2,0x00
	vpclmulqdq	ymm6,ymm12,ymm2,0x01
	vpclmulqdq	ymm4,ymm12,ymm2,0x10
	vpxor	ymm6,ymm6,ymm4
	vpclmulqdq	ymm7,ymm12,ymm2,0x11
	vpclmulqdq	ymm4,ymm13,ymm3,0x00
	vpxor	ymm5,ymm5,ymm4
	vpclmulqdq	ymm4,ymm13,ymm3,0x01
	vpxor	ymm6,ymm6,ymm4
	vpclmulqdq	ymm4,ymm13,ymm3,0x10
	vpxor	ymm6,ymm6,ymm4
	vpclmulqdq	ymm4,ymm13,ymm3,0x11
	vpxor	ymm7,ymm7,ymm4

	add	rsi,64
	add	rcx,64
	add	rdx,64
	sub	r8,64
	jz	NEAR $L$reduce__func2

	vpxor	xmm1,xmm1,xmm1


$L$lessthan64bytes__func2:
	vpshufb	ymm12,ymm11,ymm0
	vpaddd	ymm11,ymm11,YMMWORD[$L$inc_2blocks]
	vpshufb	ymm13,ymm11,ymm0
	vpxor	ymm12,ymm12,ymm9
	vpxor	ymm13,ymm13,ymm9
	lea	rax,[16+r9]
$L$vaesenc_loop_tail_2__func2:
	vbroadcasti128	ymm2,XMMWORD[rax]
	vaesenc	ymm12,ymm12,ymm2
	vaesenc	ymm13,ymm13,ymm2
	add	rax,16
	cmp	r11,rax
	jne	NEAR $L$vaesenc_loop_tail_2__func2
	vaesenclast	ymm12,ymm12,ymm10
	vaesenclast	ymm13,ymm13,ymm10




	cmp	r8,32
	jb	NEAR $L$xor_one_block__func2
	je	NEAR $L$xor_two_blocks__func2

$L$xor_three_blocks__func2:
	vmovdqu	ymm2,YMMWORD[rcx]
	vmovdqu	xmm3,XMMWORD[32+rcx]
	vpxor	ymm12,ymm12,ymm2
	vpxor	xmm13,xmm13,xmm3
	vmovdqu	YMMWORD[rdx],ymm12
	vmovdqu	XMMWORD[32+rdx],xmm13

	vpshufb	ymm12,ymm2,ymm0
	vpshufb	xmm13,xmm3,xmm0
	vpxor	ymm12,ymm12,ymm1
	vmovdqu	ymm2,YMMWORD[rsi]
	vmovdqu	xmm3,XMMWORD[32+rsi]
	vpclmulqdq	xmm4,xmm13,xmm3,0x00
	vpxor	ymm5,ymm5,ymm4
	vpclmulqdq	xmm4,xmm13,xmm3,0x01
	vpxor	ymm6,ymm6,ymm4
	vpclmulqdq	xmm4,xmm13,xmm3,0x10
	vpxor	ymm6,ymm6,ymm4
	vpclmulqdq	xmm4,xmm13,xmm3,0x11
	vpxor	ymm7,ymm7,ymm4
	jmp	NEAR $L$ghash_mul_one_vec_unreduced__func2

$L$xor_two_blocks__func2:
	vmovdqu	ymm2,YMMWORD[rcx]
	vpxor	ymm12,ymm12,ymm2
	vmovdqu	YMMWORD[rdx],ymm12
	vpshufb	ymm12,ymm2,ymm0
	vpxor	ymm12,ymm12,ymm1
	vmovdqu	ymm2,YMMWORD[rsi]
	jmp	NEAR $L$ghash_mul_one_vec_unreduced__func2

$L$xor_one_block__func2:
	vmovdqu	xmm2,XMMWORD[rcx]
	vpxor	xmm12,xmm12,xmm2
	vmovdqu	XMMWORD[rdx],xmm12
	vpshufb	xmm12,xmm2,xmm0
	vpxor	xmm12,xmm12,xmm1
	vmovdqu	xmm2,XMMWORD[rsi]

$L$ghash_mul_one_vec_unreduced__func2:
	vpclmulqdq	ymm4,ymm12,ymm2,0x00
	vpxor	ymm5,ymm5,ymm4
	vpclmulqdq	ymm4,ymm12,ymm2,0x01
	vpxor	ymm6,ymm6,ymm4
	vpclmulqdq	ymm4,ymm12,ymm2,0x10
	vpxor	ymm6,ymm6,ymm4
	vpclmulqdq	ymm4,ymm12,ymm2,0x11
	vpxor	ymm7,ymm7,ymm4

$L$reduce__func2:

	vbroadcasti128	ymm2,XMMWORD[$L$gfpoly]
	vpclmulqdq	ymm3,ymm2,ymm5,0x01
	vpshufd	ymm5,ymm5,0x4e
	vpxor	ymm6,ymm6,ymm5
	vpxor	ymm6,ymm6,ymm3
	vpclmulqdq	ymm3,ymm2,ymm6,0x01
	vpshufd	ymm6,ymm6,0x4e
	vpxor	ymm7,ymm7,ymm6
	vpxor	ymm7,ymm7,ymm3
	vextracti128	xmm1,ymm7,1
	vpxor	xmm1,xmm1,xmm7

$L$done__func2:

	vpshufb	xmm1,xmm1,xmm0
	vmovdqu	XMMWORD[r12],xmm1

	vzeroupper
	vmovdqa	xmm6,XMMWORD[rsp]
	vmovdqa	xmm7,XMMWORD[16+rsp]
	vmovdqa	xmm8,XMMWORD[32+rsp]
	vmovdqa	xmm9,XMMWORD[48+rsp]
	vmovdqa	xmm10,XMMWORD[64+rsp]
	vmovdqa	xmm11,XMMWORD[80+rsp]
	vmovdqa	xmm12,XMMWORD[96+rsp]
	vmovdqa	xmm13,XMMWORD[112+rsp]
	vmovdqa	xmm14,XMMWORD[128+rsp]
	vmovdqa	xmm15,XMMWORD[144+rsp]
	add	rsp,160
	pop	r12
	pop	rdi
	pop	rsi
	ret
$L$SEH_end_aes_gcm_dec_update_vaes_avx2_17:


section	.pdata rdata align=4
ALIGN	4
	DD	$L$SEH_begin_gcm_init_vpclmulqdq_avx2_1 wrt ..imagebase
	DD	$L$SEH_end_gcm_init_vpclmulqdq_avx2_5 wrt ..imagebase
	DD	$L$SEH_info_gcm_init_vpclmulqdq_avx2_0 wrt ..imagebase

	DD	$L$SEH_begin_gcm_gmult_vpclmulqdq_avx2_1 wrt ..imagebase
	DD	$L$SEH_end_gcm_gmult_vpclmulqdq_avx2_5 wrt ..imagebase
	DD	$L$SEH_info_gcm_gmult_vpclmulqdq_avx2_0 wrt ..imagebase

	DD	$L$SEH_begin_gcm_ghash_vpclmulqdq_avx2_1 wrt ..imagebase
	DD	$L$SEH_end_gcm_ghash_vpclmulqdq_avx2_8 wrt ..imagebase
	DD	$L$SEH_info_gcm_ghash_vpclmulqdq_avx2_0 wrt ..imagebase

	DD	$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1 wrt ..imagebase
	DD	$L$SEH_end_aes_gcm_enc_update_vaes_avx2_17 wrt ..imagebase
	DD	$L$SEH_info_aes_gcm_enc_update_vaes_avx2_0 wrt ..imagebase

	DD	$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1 wrt ..imagebase
	DD	$L$SEH_end_aes_gcm_dec_update_vaes_avx2_17 wrt ..imagebase
	DD	$L$SEH_info_aes_gcm_dec_update_vaes_avx2_0 wrt ..imagebase


section	.xdata rdata align=8
ALIGN	4
$L$SEH_info_gcm_init_vpclmulqdq_avx2_0:
	DB	1
	DB	$L$SEH_endprologue_gcm_init_vpclmulqdq_avx2_4-$L$SEH_begin_gcm_init_vpclmulqdq_avx2_1
	DB	3
	DB	0
	DB	$L$SEH_prologue_gcm_init_vpclmulqdq_avx2_3-$L$SEH_begin_gcm_init_vpclmulqdq_avx2_1
	DB	104
	DW	0
	DB	$L$SEH_prologue_gcm_init_vpclmulqdq_avx2_2-$L$SEH_begin_gcm_init_vpclmulqdq_avx2_1
	DB	34

	DW	0
$L$SEH_info_gcm_gmult_vpclmulqdq_avx2_0:
	DB	1
	DB	$L$SEH_endprologue_gcm_gmult_vpclmulqdq_avx2_4-$L$SEH_begin_gcm_gmult_vpclmulqdq_avx2_1
	DB	3
	DB	0
	DB	$L$SEH_prologue_gcm_gmult_vpclmulqdq_avx2_3-$L$SEH_begin_gcm_gmult_vpclmulqdq_avx2_1
	DB	104
	DW	0
	DB	$L$SEH_prologue_gcm_gmult_vpclmulqdq_avx2_2-$L$SEH_begin_gcm_gmult_vpclmulqdq_avx2_1
	DB	34

	DW	0
$L$SEH_info_gcm_ghash_vpclmulqdq_avx2_0:
	DB	1
	DB	$L$SEH_endprologue_gcm_ghash_vpclmulqdq_avx2_7-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx2_1
	DB	9
	DB	0
	DB	$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx2_6-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx2_1
	DB	152
	DW	3
	DB	$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx2_5-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx2_1
	DB	136
	DW	2
	DB	$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx2_4-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx2_1
	DB	120
	DW	1
	DB	$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx2_3-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx2_1
	DB	104
	DW	0
	DB	$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx2_2-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx2_1
	DB	130

	DW	0
$L$SEH_info_aes_gcm_enc_update_vaes_avx2_0:
	DB	1
	DB	$L$SEH_endprologue_aes_gcm_enc_update_vaes_avx2_16-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	25
	DB	0
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_15-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	248
	DW	9
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_14-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	232
	DW	8
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_13-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	216
	DW	7
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_12-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	200
	DW	6
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_11-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	184
	DW	5
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_10-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	168
	DW	4
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_9-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	152
	DW	3
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_8-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	136
	DW	2
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_7-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	120
	DW	1
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_6-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	104
	DW	0
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_5-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	1
	DW	20
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_4-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	192
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_3-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	112
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx2_2-$L$SEH_begin_aes_gcm_enc_update_vaes_avx2_1
	DB	96

	DW	0
$L$SEH_info_aes_gcm_dec_update_vaes_avx2_0:
	DB	1
	DB	$L$SEH_endprologue_aes_gcm_dec_update_vaes_avx2_16-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	25
	DB	0
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_15-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	248
	DW	9
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_14-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	232
	DW	8
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_13-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	216
	DW	7
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_12-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	200
	DW	6
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_11-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	184
	DW	5
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_10-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	168
	DW	4
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_9-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	152
	DW	3
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_8-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	136
	DW	2
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_7-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	120
	DW	1
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_6-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	104
	DW	0
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_5-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	1
	DW	20
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_4-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	192
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_3-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	112
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx2_2-$L$SEH_begin_aes_gcm_dec_update_vaes_avx2_1
	DB	96

	DW	0
%else
; Work around https://bugzilla.nasm.us/show_bug.cgi?id=3392738
ret
%endif
