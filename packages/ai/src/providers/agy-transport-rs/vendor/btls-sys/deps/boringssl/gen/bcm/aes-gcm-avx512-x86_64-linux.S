// This file is generated from a similarly-named Perl script in the BoringSSL
// source tree. Do not edit by hand.

#include <openssl/asm_base.h>

#if !defined(OPENSSL_NO_ASM) && defined(OPENSSL_X86_64) && defined(__ELF__)
.section	.rodata
.align	64


.Lbswap_mask:
.quad	0x08090a0b0c0d0e0f, 0x0001020304050607








.Lgfpoly:
.quad	1, 0xc200000000000000


.Lgfpoly_and_internal_carrybit:
.quad	1, 0xc200000000000001


.Lctr_pattern:
.quad	0, 0
.quad	1, 0
.quad	2, 0
.quad	3, 0


.Linc_4blocks:
.quad	4, 0

.text	
.globl	gcm_init_vpclmulqdq_avx512
.hidden gcm_init_vpclmulqdq_avx512
.type	gcm_init_vpclmulqdq_avx512,@function
.align	32
gcm_init_vpclmulqdq_avx512:
.cfi_startproc	

_CET_ENDBR

	leaq	256-64(%rdi),%r8



	vpshufd	$0x4e,(%rsi),%xmm3
















	vpshufd	$0xd3,%xmm3,%xmm0
	vpsrad	$31,%xmm0,%xmm0
	vpaddq	%xmm3,%xmm3,%xmm3

	vpternlogd	$0x78,.Lgfpoly_and_internal_carrybit(%rip),%xmm0,%xmm3


	vbroadcasti32x4	.Lgfpoly(%rip),%zmm5








	vpclmulqdq	$0x00,%xmm3,%xmm3,%xmm0
	vpclmulqdq	$0x11,%xmm3,%xmm3,%xmm4
	vpclmulqdq	$0x01,%xmm0,%xmm5,%xmm1
	vpshufd	$0x4e,%xmm0,%xmm0
	vpxor	%xmm0,%xmm1,%xmm1
	vpclmulqdq	$0x01,%xmm1,%xmm5,%xmm0
	vpshufd	$0x4e,%xmm1,%xmm1
	vpternlogd	$0x96,%xmm0,%xmm1,%xmm4



	vinserti128	$1,%xmm3,%ymm4,%ymm3
	vinserti128	$1,%xmm4,%ymm4,%ymm4


	vpclmulqdq	$0x00,%ymm4,%ymm3,%ymm0
	vpclmulqdq	$0x01,%ymm4,%ymm3,%ymm1
	vpclmulqdq	$0x10,%ymm4,%ymm3,%ymm2
	vpxord	%ymm2,%ymm1,%ymm1
	vpclmulqdq	$0x01,%ymm0,%ymm5,%ymm2
	vpshufd	$0x4e,%ymm0,%ymm0
	vpternlogd	$0x96,%ymm2,%ymm0,%ymm1
	vpclmulqdq	$0x11,%ymm4,%ymm3,%ymm4
	vpclmulqdq	$0x01,%ymm1,%ymm5,%ymm0
	vpshufd	$0x4e,%ymm1,%ymm1
	vpternlogd	$0x96,%ymm0,%ymm1,%ymm4

	vinserti64x4	$1,%ymm3,%zmm4,%zmm3
	vshufi64x2	$0,%zmm4,%zmm4,%zmm4


	vmovdqu8	%zmm3,(%r8)




	movl	$3,%eax
.Lprecompute_next:
	subq	$64,%r8
	vpclmulqdq	$0x00,%zmm4,%zmm3,%zmm0
	vpclmulqdq	$0x01,%zmm4,%zmm3,%zmm1
	vpclmulqdq	$0x10,%zmm4,%zmm3,%zmm2
	vpxord	%zmm2,%zmm1,%zmm1
	vpclmulqdq	$0x01,%zmm0,%zmm5,%zmm2
	vpshufd	$0x4e,%zmm0,%zmm0
	vpternlogd	$0x96,%zmm2,%zmm0,%zmm1
	vpclmulqdq	$0x11,%zmm4,%zmm3,%zmm3
	vpclmulqdq	$0x01,%zmm1,%zmm5,%zmm0
	vpshufd	$0x4e,%zmm1,%zmm1
	vpternlogd	$0x96,%zmm0,%zmm1,%zmm3

	vmovdqu8	%zmm3,(%r8)
	decl	%eax
	jnz	.Lprecompute_next

	vzeroupper
	ret

.cfi_endproc	
.size	gcm_init_vpclmulqdq_avx512, . - gcm_init_vpclmulqdq_avx512
.globl	gcm_gmult_vpclmulqdq_avx512
.hidden gcm_gmult_vpclmulqdq_avx512
.type	gcm_gmult_vpclmulqdq_avx512,@function
.align	32
gcm_gmult_vpclmulqdq_avx512:
.cfi_startproc	

_CET_ENDBR



	vmovdqu	(%rdi),%xmm0
	vmovdqu	.Lbswap_mask(%rip),%xmm1
	vmovdqu	256-16(%rsi),%xmm2
	vmovdqu	.Lgfpoly(%rip),%xmm3
	vpshufb	%xmm1,%xmm0,%xmm0

	vpclmulqdq	$0x00,%xmm2,%xmm0,%xmm4
	vpclmulqdq	$0x01,%xmm2,%xmm0,%xmm5
	vpclmulqdq	$0x10,%xmm2,%xmm0,%xmm6
	vpxord	%xmm6,%xmm5,%xmm5
	vpclmulqdq	$0x01,%xmm4,%xmm3,%xmm6
	vpshufd	$0x4e,%xmm4,%xmm4
	vpternlogd	$0x96,%xmm6,%xmm4,%xmm5
	vpclmulqdq	$0x11,%xmm2,%xmm0,%xmm0
	vpclmulqdq	$0x01,%xmm5,%xmm3,%xmm4
	vpshufd	$0x4e,%xmm5,%xmm5
	vpternlogd	$0x96,%xmm4,%xmm5,%xmm0


	vpshufb	%xmm1,%xmm0,%xmm0
	vmovdqu	%xmm0,(%rdi)


	ret

.cfi_endproc	
.size	gcm_gmult_vpclmulqdq_avx512, . - gcm_gmult_vpclmulqdq_avx512
.globl	gcm_ghash_vpclmulqdq_avx512
.hidden gcm_ghash_vpclmulqdq_avx512
.type	gcm_ghash_vpclmulqdq_avx512,@function
.align	32
gcm_ghash_vpclmulqdq_avx512:
.cfi_startproc	

_CET_ENDBR






	vmovdqu	.Lbswap_mask(%rip),%xmm4
	vmovdqu	.Lgfpoly(%rip),%xmm10


	vmovdqu	(%rdi),%xmm5
	vpshufb	%xmm4,%xmm5,%xmm5


	cmpq	$64,%rcx
	jb	.Laad_blockbyblock



	vshufi64x2	$0,%zmm4,%zmm4,%zmm4
	vshufi64x2	$0,%zmm10,%zmm10,%zmm10


	vmovdqu8	256-64(%rsi),%zmm9

	cmpq	$256,%rcx
	jb	.Laad_loop_1x


	vmovdqu8	256-256(%rsi),%zmm6
	vmovdqu8	256-192(%rsi),%zmm7
	vmovdqu8	256-128(%rsi),%zmm8


.Laad_loop_4x:
	vmovdqu8	0(%rdx),%zmm0
	vmovdqu8	64(%rdx),%zmm1
	vmovdqu8	128(%rdx),%zmm2
	vmovdqu8	192(%rdx),%zmm3
	vpshufb	%zmm4,%zmm0,%zmm0
	vpxord	%zmm5,%zmm0,%zmm0
	vpshufb	%zmm4,%zmm1,%zmm1
	vpshufb	%zmm4,%zmm2,%zmm2
	vpshufb	%zmm4,%zmm3,%zmm3
	vpclmulqdq	$0x00,%zmm6,%zmm0,%zmm5
	vpclmulqdq	$0x00,%zmm7,%zmm1,%zmm11
	vpclmulqdq	$0x00,%zmm8,%zmm2,%zmm12
	vpxord	%zmm11,%zmm5,%zmm5
	vpclmulqdq	$0x00,%zmm9,%zmm3,%zmm13
	vpternlogd	$0x96,%zmm13,%zmm12,%zmm5
	vpclmulqdq	$0x01,%zmm6,%zmm0,%zmm11
	vpclmulqdq	$0x01,%zmm7,%zmm1,%zmm12
	vpclmulqdq	$0x01,%zmm8,%zmm2,%zmm13
	vpternlogd	$0x96,%zmm13,%zmm12,%zmm11
	vpclmulqdq	$0x01,%zmm9,%zmm3,%zmm12
	vpclmulqdq	$0x10,%zmm6,%zmm0,%zmm13
	vpternlogd	$0x96,%zmm13,%zmm12,%zmm11
	vpclmulqdq	$0x10,%zmm7,%zmm1,%zmm12
	vpclmulqdq	$0x10,%zmm8,%zmm2,%zmm13
	vpternlogd	$0x96,%zmm13,%zmm12,%zmm11
	vpclmulqdq	$0x01,%zmm5,%zmm10,%zmm13
	vpclmulqdq	$0x10,%zmm9,%zmm3,%zmm12
	vpxord	%zmm12,%zmm11,%zmm11
	vpshufd	$0x4e,%zmm5,%zmm5
	vpclmulqdq	$0x11,%zmm6,%zmm0,%zmm0
	vpclmulqdq	$0x11,%zmm7,%zmm1,%zmm1
	vpclmulqdq	$0x11,%zmm8,%zmm2,%zmm2
	vpternlogd	$0x96,%zmm13,%zmm5,%zmm11
	vpclmulqdq	$0x11,%zmm9,%zmm3,%zmm3
	vpternlogd	$0x96,%zmm2,%zmm1,%zmm0
	vpclmulqdq	$0x01,%zmm11,%zmm10,%zmm12
	vpxord	%zmm3,%zmm0,%zmm5
	vpshufd	$0x4e,%zmm11,%zmm11
	vpternlogd	$0x96,%zmm12,%zmm11,%zmm5
	vextracti32x4	$1,%zmm5,%xmm0
	vextracti32x4	$2,%zmm5,%xmm1
	vextracti32x4	$3,%zmm5,%xmm2
	vpxord	%xmm0,%xmm5,%xmm5
	vpternlogd	$0x96,%xmm1,%xmm2,%xmm5

	addq	$256,%rdx
	subq	$256,%rcx
	cmpq	$256,%rcx
	jae	.Laad_loop_4x


	cmpq	$64,%rcx
	jb	.Laad_large_done
.Laad_loop_1x:
	vmovdqu8	(%rdx),%zmm0
	vpshufb	%zmm4,%zmm0,%zmm0
	vpxord	%zmm0,%zmm5,%zmm5
	vpclmulqdq	$0x00,%zmm9,%zmm5,%zmm0
	vpclmulqdq	$0x01,%zmm9,%zmm5,%zmm1
	vpclmulqdq	$0x10,%zmm9,%zmm5,%zmm2
	vpxord	%zmm2,%zmm1,%zmm1
	vpclmulqdq	$0x01,%zmm0,%zmm10,%zmm2
	vpshufd	$0x4e,%zmm0,%zmm0
	vpternlogd	$0x96,%zmm2,%zmm0,%zmm1
	vpclmulqdq	$0x11,%zmm9,%zmm5,%zmm5
	vpclmulqdq	$0x01,%zmm1,%zmm10,%zmm0
	vpshufd	$0x4e,%zmm1,%zmm1
	vpternlogd	$0x96,%zmm0,%zmm1,%zmm5

	vextracti32x4	$1,%zmm5,%xmm0
	vextracti32x4	$2,%zmm5,%xmm1
	vextracti32x4	$3,%zmm5,%xmm2
	vpxord	%xmm0,%xmm5,%xmm5
	vpternlogd	$0x96,%xmm1,%xmm2,%xmm5

	addq	$64,%rdx
	subq	$64,%rcx
	cmpq	$64,%rcx
	jae	.Laad_loop_1x

.Laad_large_done:


.Laad_blockbyblock:
	testq	%rcx,%rcx
	jz	.Laad_done
	vmovdqu	256-16(%rsi),%xmm9
.Laad_loop_blockbyblock:
	vmovdqu	(%rdx),%xmm0
	vpshufb	%xmm4,%xmm0,%xmm0
	vpxor	%xmm0,%xmm5,%xmm5
	vpclmulqdq	$0x00,%xmm9,%xmm5,%xmm0
	vpclmulqdq	$0x01,%xmm9,%xmm5,%xmm1
	vpclmulqdq	$0x10,%xmm9,%xmm5,%xmm2
	vpxord	%xmm2,%xmm1,%xmm1
	vpclmulqdq	$0x01,%xmm0,%xmm10,%xmm2
	vpshufd	$0x4e,%xmm0,%xmm0
	vpternlogd	$0x96,%xmm2,%xmm0,%xmm1
	vpclmulqdq	$0x11,%xmm9,%xmm5,%xmm5
	vpclmulqdq	$0x01,%xmm1,%xmm10,%xmm0
	vpshufd	$0x4e,%xmm1,%xmm1
	vpternlogd	$0x96,%xmm0,%xmm1,%xmm5

	addq	$16,%rdx
	subq	$16,%rcx
	jnz	.Laad_loop_blockbyblock

.Laad_done:

	vpshufb	%xmm4,%xmm5,%xmm5
	vmovdqu	%xmm5,(%rdi)

	vzeroupper
	ret

.cfi_endproc	
.size	gcm_ghash_vpclmulqdq_avx512, . - gcm_ghash_vpclmulqdq_avx512
.globl	aes_gcm_enc_update_vaes_avx512
.hidden aes_gcm_enc_update_vaes_avx512
.type	aes_gcm_enc_update_vaes_avx512,@function
.align	32
aes_gcm_enc_update_vaes_avx512:
.cfi_startproc	

_CET_ENDBR
	pushq	%r12
.cfi_adjust_cfa_offset	8
.cfi_offset	%r12,-16

	movq	16(%rsp),%r12
#ifdef BORINGSSL_DISPATCH_TEST
.extern	BORINGSSL_function_hit
.hidden BORINGSSL_function_hit
	movb	$1,BORINGSSL_function_hit+7(%rip)
#endif

	vbroadcasti32x4	.Lbswap_mask(%rip),%zmm8
	vbroadcasti32x4	.Lgfpoly(%rip),%zmm31



	vmovdqu	(%r12),%xmm10
	vpshufb	%xmm8,%xmm10,%xmm10
	vbroadcasti32x4	(%r8),%zmm12
	vpshufb	%zmm8,%zmm12,%zmm12



	movl	240(%rcx),%r10d
	leal	-20(,%r10,4),%r10d




	leaq	96(%rcx,%r10,4),%r11
	vbroadcasti32x4	(%rcx),%zmm13
	vbroadcasti32x4	(%r11),%zmm14


	vpaddd	.Lctr_pattern(%rip),%zmm12,%zmm12


	vbroadcasti32x4	.Linc_4blocks(%rip),%zmm11



	cmpq	$256,%rdx
	jb	.Lcrypt_loop_4x_done__func1


	vmovdqu8	256-256(%r9),%zmm27
	vmovdqu8	256-192(%r9),%zmm28
	vmovdqu8	256-128(%r9),%zmm29
	vmovdqu8	256-64(%r9),%zmm30




	vpshufb	%zmm8,%zmm12,%zmm0
	vpaddd	%zmm11,%zmm12,%zmm12
	vpshufb	%zmm8,%zmm12,%zmm1
	vpaddd	%zmm11,%zmm12,%zmm12
	vpshufb	%zmm8,%zmm12,%zmm2
	vpaddd	%zmm11,%zmm12,%zmm12
	vpshufb	%zmm8,%zmm12,%zmm3
	vpaddd	%zmm11,%zmm12,%zmm12


	vpxord	%zmm13,%zmm0,%zmm0
	vpxord	%zmm13,%zmm1,%zmm1
	vpxord	%zmm13,%zmm2,%zmm2
	vpxord	%zmm13,%zmm3,%zmm3

	leaq	16(%rcx),%rax
.Lvaesenc_loop_first_4_vecs__func1:
	vbroadcasti32x4	(%rax),%zmm9
	vaesenc	%zmm9,%zmm0,%zmm0
	vaesenc	%zmm9,%zmm1,%zmm1
	vaesenc	%zmm9,%zmm2,%zmm2
	vaesenc	%zmm9,%zmm3,%zmm3

	addq	$16,%rax
	cmpq	%rax,%r11
	jne	.Lvaesenc_loop_first_4_vecs__func1
	vpxord	0(%rdi),%zmm14,%zmm4
	vpxord	64(%rdi),%zmm14,%zmm5
	vpxord	128(%rdi),%zmm14,%zmm6
	vpxord	192(%rdi),%zmm14,%zmm7
	vaesenclast	%zmm4,%zmm0,%zmm4
	vaesenclast	%zmm5,%zmm1,%zmm5
	vaesenclast	%zmm6,%zmm2,%zmm6
	vaesenclast	%zmm7,%zmm3,%zmm7
	vmovdqu8	%zmm4,0(%rsi)
	vmovdqu8	%zmm5,64(%rsi)
	vmovdqu8	%zmm6,128(%rsi)
	vmovdqu8	%zmm7,192(%rsi)

	addq	$256,%rdi
	addq	$256,%rsi
	subq	$256,%rdx
	cmpq	$256,%rdx
	jb	.Lghash_last_ciphertext_4x__func1

	vbroadcasti32x4	-144(%r11),%zmm15
	vbroadcasti32x4	-128(%r11),%zmm16
	vbroadcasti32x4	-112(%r11),%zmm17
	vbroadcasti32x4	-96(%r11),%zmm18
	vbroadcasti32x4	-80(%r11),%zmm19
	vbroadcasti32x4	-64(%r11),%zmm20
	vbroadcasti32x4	-48(%r11),%zmm21
	vbroadcasti32x4	-32(%r11),%zmm22
	vbroadcasti32x4	-16(%r11),%zmm23

.Lcrypt_loop_4x__func1:



	vpshufb	%zmm8,%zmm12,%zmm0
	vpaddd	%zmm11,%zmm12,%zmm12
	vpshufb	%zmm8,%zmm12,%zmm1
	vpaddd	%zmm11,%zmm12,%zmm12
	vpshufb	%zmm8,%zmm12,%zmm2
	vpaddd	%zmm11,%zmm12,%zmm12
	vpshufb	%zmm8,%zmm12,%zmm3
	vpaddd	%zmm11,%zmm12,%zmm12


	vpxord	%zmm13,%zmm0,%zmm0
	vpxord	%zmm13,%zmm1,%zmm1
	vpxord	%zmm13,%zmm2,%zmm2
	vpxord	%zmm13,%zmm3,%zmm3

	cmpl	$24,%r10d
	jl	.Laes128__func1
	je	.Laes192__func1

	vbroadcasti32x4	-208(%r11),%zmm9
	vaesenc	%zmm9,%zmm0,%zmm0
	vaesenc	%zmm9,%zmm1,%zmm1
	vaesenc	%zmm9,%zmm2,%zmm2
	vaesenc	%zmm9,%zmm3,%zmm3

	vbroadcasti32x4	-192(%r11),%zmm9
	vaesenc	%zmm9,%zmm0,%zmm0
	vaesenc	%zmm9,%zmm1,%zmm1
	vaesenc	%zmm9,%zmm2,%zmm2
	vaesenc	%zmm9,%zmm3,%zmm3

.Laes192__func1:
	vbroadcasti32x4	-176(%r11),%zmm9
	vaesenc	%zmm9,%zmm0,%zmm0
	vaesenc	%zmm9,%zmm1,%zmm1
	vaesenc	%zmm9,%zmm2,%zmm2
	vaesenc	%zmm9,%zmm3,%zmm3

	vbroadcasti32x4	-160(%r11),%zmm9
	vaesenc	%zmm9,%zmm0,%zmm0
	vaesenc	%zmm9,%zmm1,%zmm1
	vaesenc	%zmm9,%zmm2,%zmm2
	vaesenc	%zmm9,%zmm3,%zmm3

.Laes128__func1:




	prefetcht0	512+0(%rdi)
	prefetcht0	512+64(%rdi)
	prefetcht0	512+128(%rdi)
	prefetcht0	512+192(%rdi)




	vpshufb	%zmm8,%zmm4,%zmm4
	vpxord	%zmm10,%zmm4,%zmm4
	vpshufb	%zmm8,%zmm5,%zmm5
	vpshufb	%zmm8,%zmm6,%zmm6

	vaesenc	%zmm15,%zmm0,%zmm0
	vaesenc	%zmm15,%zmm1,%zmm1
	vaesenc	%zmm15,%zmm2,%zmm2
	vaesenc	%zmm15,%zmm3,%zmm3

	vpshufb	%zmm8,%zmm7,%zmm7
	vpclmulqdq	$0x00,%zmm27,%zmm4,%zmm10
	vpclmulqdq	$0x00,%zmm28,%zmm5,%zmm24
	vpclmulqdq	$0x00,%zmm29,%zmm6,%zmm25

	vaesenc	%zmm16,%zmm0,%zmm0
	vaesenc	%zmm16,%zmm1,%zmm1
	vaesenc	%zmm16,%zmm2,%zmm2
	vaesenc	%zmm16,%zmm3,%zmm3

	vpxord	%zmm24,%zmm10,%zmm10
	vpclmulqdq	$0x00,%zmm30,%zmm7,%zmm26
	vpternlogd	$0x96,%zmm26,%zmm25,%zmm10
	vpclmulqdq	$0x01,%zmm27,%zmm4,%zmm24

	vaesenc	%zmm17,%zmm0,%zmm0
	vaesenc	%zmm17,%zmm1,%zmm1
	vaesenc	%zmm17,%zmm2,%zmm2
	vaesenc	%zmm17,%zmm3,%zmm3

	vpclmulqdq	$0x01,%zmm28,%zmm5,%zmm25
	vpclmulqdq	$0x01,%zmm29,%zmm6,%zmm26
	vpternlogd	$0x96,%zmm26,%zmm25,%zmm24
	vpclmulqdq	$0x01,%zmm30,%zmm7,%zmm25

	vaesenc	%zmm18,%zmm0,%zmm0
	vaesenc	%zmm18,%zmm1,%zmm1
	vaesenc	%zmm18,%zmm2,%zmm2
	vaesenc	%zmm18,%zmm3,%zmm3

	vpclmulqdq	$0x10,%zmm27,%zmm4,%zmm26
	vpternlogd	$0x96,%zmm26,%zmm25,%zmm24
	vpclmulqdq	$0x10,%zmm28,%zmm5,%zmm25
	vpclmulqdq	$0x10,%zmm29,%zmm6,%zmm26

	vaesenc	%zmm19,%zmm0,%zmm0
	vaesenc	%zmm19,%zmm1,%zmm1
	vaesenc	%zmm19,%zmm2,%zmm2
	vaesenc	%zmm19,%zmm3,%zmm3

	vpternlogd	$0x96,%zmm26,%zmm25,%zmm24
	vpclmulqdq	$0x01,%zmm10,%zmm31,%zmm26
	vpclmulqdq	$0x10,%zmm30,%zmm7,%zmm25
	vpxord	%zmm25,%zmm24,%zmm24

	vaesenc	%zmm20,%zmm0,%zmm0
	vaesenc	%zmm20,%zmm1,%zmm1
	vaesenc	%zmm20,%zmm2,%zmm2
	vaesenc	%zmm20,%zmm3,%zmm3

	vpshufd	$0x4e,%zmm10,%zmm10
	vpclmulqdq	$0x11,%zmm27,%zmm4,%zmm4
	vpclmulqdq	$0x11,%zmm28,%zmm5,%zmm5
	vpclmulqdq	$0x11,%zmm29,%zmm6,%zmm6

	vaesenc	%zmm21,%zmm0,%zmm0
	vaesenc	%zmm21,%zmm1,%zmm1
	vaesenc	%zmm21,%zmm2,%zmm2
	vaesenc	%zmm21,%zmm3,%zmm3

	vpternlogd	$0x96,%zmm26,%zmm10,%zmm24
	vpclmulqdq	$0x11,%zmm30,%zmm7,%zmm7
	vpternlogd	$0x96,%zmm6,%zmm5,%zmm4
	vpclmulqdq	$0x01,%zmm24,%zmm31,%zmm25

	vaesenc	%zmm22,%zmm0,%zmm0
	vaesenc	%zmm22,%zmm1,%zmm1
	vaesenc	%zmm22,%zmm2,%zmm2
	vaesenc	%zmm22,%zmm3,%zmm3

	vpxord	%zmm7,%zmm4,%zmm10
	vpshufd	$0x4e,%zmm24,%zmm24
	vpternlogd	$0x96,%zmm25,%zmm24,%zmm10

	vaesenc	%zmm23,%zmm0,%zmm0
	vaesenc	%zmm23,%zmm1,%zmm1
	vaesenc	%zmm23,%zmm2,%zmm2
	vaesenc	%zmm23,%zmm3,%zmm3


	vextracti32x4	$1,%zmm10,%xmm4
	vextracti32x4	$2,%zmm10,%xmm5
	vextracti32x4	$3,%zmm10,%xmm6
	vpxord	%xmm4,%xmm10,%xmm10
	vpternlogd	$0x96,%xmm5,%xmm6,%xmm10

	vpxord	0(%rdi),%zmm14,%zmm4
	vpxord	64(%rdi),%zmm14,%zmm5
	vpxord	128(%rdi),%zmm14,%zmm6
	vpxord	192(%rdi),%zmm14,%zmm7
	vaesenclast	%zmm4,%zmm0,%zmm4
	vaesenclast	%zmm5,%zmm1,%zmm5
	vaesenclast	%zmm6,%zmm2,%zmm6
	vaesenclast	%zmm7,%zmm3,%zmm7
	vmovdqu8	%zmm4,0(%rsi)
	vmovdqu8	%zmm5,64(%rsi)
	vmovdqu8	%zmm6,128(%rsi)
	vmovdqu8	%zmm7,192(%rsi)

	addq	$256,%rdi
	addq	$256,%rsi
	subq	$256,%rdx
	cmpq	$256,%rdx
	jae	.Lcrypt_loop_4x__func1
.Lghash_last_ciphertext_4x__func1:
	vpshufb	%zmm8,%zmm4,%zmm4
	vpxord	%zmm10,%zmm4,%zmm4
	vpshufb	%zmm8,%zmm5,%zmm5
	vpshufb	%zmm8,%zmm6,%zmm6
	vpshufb	%zmm8,%zmm7,%zmm7
	vpclmulqdq	$0x00,%zmm27,%zmm4,%zmm10
	vpclmulqdq	$0x00,%zmm28,%zmm5,%zmm24
	vpclmulqdq	$0x00,%zmm29,%zmm6,%zmm25
	vpxord	%zmm24,%zmm10,%zmm10
	vpclmulqdq	$0x00,%zmm30,%zmm7,%zmm26
	vpternlogd	$0x96,%zmm26,%zmm25,%zmm10
	vpclmulqdq	$0x01,%zmm27,%zmm4,%zmm24
	vpclmulqdq	$0x01,%zmm28,%zmm5,%zmm25
	vpclmulqdq	$0x01,%zmm29,%zmm6,%zmm26
	vpternlogd	$0x96,%zmm26,%zmm25,%zmm24
	vpclmulqdq	$0x01,%zmm30,%zmm7,%zmm25
	vpclmulqdq	$0x10,%zmm27,%zmm4,%zmm26
	vpternlogd	$0x96,%zmm26,%zmm25,%zmm24
	vpclmulqdq	$0x10,%zmm28,%zmm5,%zmm25
	vpclmulqdq	$0x10,%zmm29,%zmm6,%zmm26
	vpternlogd	$0x96,%zmm26,%zmm25,%zmm24
	vpclmulqdq	$0x01,%zmm10,%zmm31,%zmm26
	vpclmulqdq	$0x10,%zmm30,%zmm7,%zmm25
	vpxord	%zmm25,%zmm24,%zmm24
	vpshufd	$0x4e,%zmm10,%zmm10
	vpclmulqdq	$0x11,%zmm27,%zmm4,%zmm4
	vpclmulqdq	$0x11,%zmm28,%zmm5,%zmm5
	vpclmulqdq	$0x11,%zmm29,%zmm6,%zmm6
	vpternlogd	$0x96,%zmm26,%zmm10,%zmm24
	vpclmulqdq	$0x11,%zmm30,%zmm7,%zmm7
	vpternlogd	$0x96,%zmm6,%zmm5,%zmm4
	vpclmulqdq	$0x01,%zmm24,%zmm31,%zmm25
	vpxord	%zmm7,%zmm4,%zmm10
	vpshufd	$0x4e,%zmm24,%zmm24
	vpternlogd	$0x96,%zmm25,%zmm24,%zmm10
	vextracti32x4	$1,%zmm10,%xmm4
	vextracti32x4	$2,%zmm10,%xmm5
	vextracti32x4	$3,%zmm10,%xmm6
	vpxord	%xmm4,%xmm10,%xmm10
	vpternlogd	$0x96,%xmm5,%xmm6,%xmm10

.Lcrypt_loop_4x_done__func1:

	testq	%rdx,%rdx
	jz	.Ldone__func1




















	movq	%rdx,%rax
	negq	%rax
	andq	$-16,%rax
	leaq	256(%r9,%rax,1),%r8
	vpxor	%xmm4,%xmm4,%xmm4
	vpxor	%xmm5,%xmm5,%xmm5
	vpxor	%xmm6,%xmm6,%xmm6

	cmpq	$64,%rdx
	jb	.Lpartial_vec__func1

.Lcrypt_loop_1x__func1:



	vpshufb	%zmm8,%zmm12,%zmm0
	vpaddd	%zmm11,%zmm12,%zmm12
	vpxord	%zmm13,%zmm0,%zmm0
	leaq	16(%rcx),%rax
.Lvaesenc_loop_tail_full_vec__func1:
	vbroadcasti32x4	(%rax),%zmm9
	vaesenc	%zmm9,%zmm0,%zmm0
	addq	$16,%rax
	cmpq	%rax,%r11
	jne	.Lvaesenc_loop_tail_full_vec__func1
	vaesenclast	%zmm14,%zmm0,%zmm0


	vmovdqu8	(%rdi),%zmm1
	vpxord	%zmm1,%zmm0,%zmm0
	vmovdqu8	%zmm0,(%rsi)


	vmovdqu8	(%r8),%zmm30
	vpshufb	%zmm8,%zmm0,%zmm0
	vpxord	%zmm10,%zmm0,%zmm0
	vpclmulqdq	$0x00,%zmm30,%zmm0,%zmm7
	vpclmulqdq	$0x01,%zmm30,%zmm0,%zmm1
	vpclmulqdq	$0x10,%zmm30,%zmm0,%zmm2
	vpclmulqdq	$0x11,%zmm30,%zmm0,%zmm3
	vpxord	%zmm7,%zmm4,%zmm4
	vpternlogd	$0x96,%zmm2,%zmm1,%zmm5
	vpxord	%zmm3,%zmm6,%zmm6

	vpxor	%xmm10,%xmm10,%xmm10

	addq	$64,%r8
	addq	$64,%rdi
	addq	$64,%rsi
	subq	$64,%rdx
	cmpq	$64,%rdx
	jae	.Lcrypt_loop_1x__func1

	testq	%rdx,%rdx
	jz	.Lreduce__func1

.Lpartial_vec__func1:




	movq	$-1,%rax
	bzhiq	%rdx,%rax,%rax
	kmovq	%rax,%k1
	addq	$15,%rdx
	andq	$-16,%rdx
	movq	$-1,%rax
	bzhiq	%rdx,%rax,%rax
	kmovq	%rax,%k2



	vpshufb	%zmm8,%zmm12,%zmm0
	vpxord	%zmm13,%zmm0,%zmm0
	leaq	16(%rcx),%rax
.Lvaesenc_loop_tail_partialvec__func1:
	vbroadcasti32x4	(%rax),%zmm9
	vaesenc	%zmm9,%zmm0,%zmm0
	addq	$16,%rax
	cmpq	%rax,%r11
	jne	.Lvaesenc_loop_tail_partialvec__func1
	vaesenclast	%zmm14,%zmm0,%zmm0


	vmovdqu8	(%rdi),%zmm1{%k1}{z}
	vpxord	%zmm1,%zmm0,%zmm0
	vmovdqu8	%zmm0,(%rsi){%k1}













	vmovdqu8	(%r8),%zmm30{%k2}{z}
	vmovdqu8	%zmm0,%zmm1{%k1}{z}
	vpshufb	%zmm8,%zmm1,%zmm0
	vpxord	%zmm10,%zmm0,%zmm0
	vpclmulqdq	$0x00,%zmm30,%zmm0,%zmm7
	vpclmulqdq	$0x01,%zmm30,%zmm0,%zmm1
	vpclmulqdq	$0x10,%zmm30,%zmm0,%zmm2
	vpclmulqdq	$0x11,%zmm30,%zmm0,%zmm3
	vpxord	%zmm7,%zmm4,%zmm4
	vpternlogd	$0x96,%zmm2,%zmm1,%zmm5
	vpxord	%zmm3,%zmm6,%zmm6


.Lreduce__func1:

	vpclmulqdq	$0x01,%zmm4,%zmm31,%zmm0
	vpshufd	$0x4e,%zmm4,%zmm4
	vpternlogd	$0x96,%zmm0,%zmm4,%zmm5
	vpclmulqdq	$0x01,%zmm5,%zmm31,%zmm0
	vpshufd	$0x4e,%zmm5,%zmm5
	vpternlogd	$0x96,%zmm0,%zmm5,%zmm6

	vextracti32x4	$1,%zmm6,%xmm0
	vextracti32x4	$2,%zmm6,%xmm1
	vextracti32x4	$3,%zmm6,%xmm2
	vpxord	%xmm0,%xmm6,%xmm10
	vpternlogd	$0x96,%xmm1,%xmm2,%xmm10


.Ldone__func1:

	vpshufb	%xmm8,%xmm10,%xmm10
	vmovdqu	%xmm10,(%r12)

	vzeroupper
	popq	%r12
.cfi_adjust_cfa_offset	-8
.cfi_restore	%r12
	ret

.cfi_endproc	
.size	aes_gcm_enc_update_vaes_avx512, . - aes_gcm_enc_update_vaes_avx512
.globl	aes_gcm_dec_update_vaes_avx512
.hidden aes_gcm_dec_update_vaes_avx512
.type	aes_gcm_dec_update_vaes_avx512,@function
.align	32
aes_gcm_dec_update_vaes_avx512:
.cfi_startproc	

_CET_ENDBR
	pushq	%r12
.cfi_adjust_cfa_offset	8
.cfi_offset	%r12,-16

	movq	16(%rsp),%r12

	vbroadcasti32x4	.Lbswap_mask(%rip),%zmm8
	vbroadcasti32x4	.Lgfpoly(%rip),%zmm31



	vmovdqu	(%r12),%xmm10
	vpshufb	%xmm8,%xmm10,%xmm10
	vbroadcasti32x4	(%r8),%zmm12
	vpshufb	%zmm8,%zmm12,%zmm12



	movl	240(%rcx),%r10d
	leal	-20(,%r10,4),%r10d




	leaq	96(%rcx,%r10,4),%r11
	vbroadcasti32x4	(%rcx),%zmm13
	vbroadcasti32x4	(%r11),%zmm14


	vpaddd	.Lctr_pattern(%rip),%zmm12,%zmm12


	vbroadcasti32x4	.Linc_4blocks(%rip),%zmm11



	cmpq	$256,%rdx
	jb	.Lcrypt_loop_4x_done__func2


	vmovdqu8	256-256(%r9),%zmm27
	vmovdqu8	256-192(%r9),%zmm28
	vmovdqu8	256-128(%r9),%zmm29
	vmovdqu8	256-64(%r9),%zmm30

	vbroadcasti32x4	-144(%r11),%zmm15
	vbroadcasti32x4	-128(%r11),%zmm16
	vbroadcasti32x4	-112(%r11),%zmm17
	vbroadcasti32x4	-96(%r11),%zmm18
	vbroadcasti32x4	-80(%r11),%zmm19
	vbroadcasti32x4	-64(%r11),%zmm20
	vbroadcasti32x4	-48(%r11),%zmm21
	vbroadcasti32x4	-32(%r11),%zmm22
	vbroadcasti32x4	-16(%r11),%zmm23

.Lcrypt_loop_4x__func2:
	vmovdqu8	0(%rdi),%zmm4
	vmovdqu8	64(%rdi),%zmm5
	vmovdqu8	128(%rdi),%zmm6
	vmovdqu8	192(%rdi),%zmm7



	vpshufb	%zmm8,%zmm12,%zmm0
	vpaddd	%zmm11,%zmm12,%zmm12
	vpshufb	%zmm8,%zmm12,%zmm1
	vpaddd	%zmm11,%zmm12,%zmm12
	vpshufb	%zmm8,%zmm12,%zmm2
	vpaddd	%zmm11,%zmm12,%zmm12
	vpshufb	%zmm8,%zmm12,%zmm3
	vpaddd	%zmm11,%zmm12,%zmm12


	vpxord	%zmm13,%zmm0,%zmm0
	vpxord	%zmm13,%zmm1,%zmm1
	vpxord	%zmm13,%zmm2,%zmm2
	vpxord	%zmm13,%zmm3,%zmm3

	cmpl	$24,%r10d
	jl	.Laes128__func2
	je	.Laes192__func2

	vbroadcasti32x4	-208(%r11),%zmm9
	vaesenc	%zmm9,%zmm0,%zmm0
	vaesenc	%zmm9,%zmm1,%zmm1
	vaesenc	%zmm9,%zmm2,%zmm2
	vaesenc	%zmm9,%zmm3,%zmm3

	vbroadcasti32x4	-192(%r11),%zmm9
	vaesenc	%zmm9,%zmm0,%zmm0
	vaesenc	%zmm9,%zmm1,%zmm1
	vaesenc	%zmm9,%zmm2,%zmm2
	vaesenc	%zmm9,%zmm3,%zmm3

.Laes192__func2:
	vbroadcasti32x4	-176(%r11),%zmm9
	vaesenc	%zmm9,%zmm0,%zmm0
	vaesenc	%zmm9,%zmm1,%zmm1
	vaesenc	%zmm9,%zmm2,%zmm2
	vaesenc	%zmm9,%zmm3,%zmm3

	vbroadcasti32x4	-160(%r11),%zmm9
	vaesenc	%zmm9,%zmm0,%zmm0
	vaesenc	%zmm9,%zmm1,%zmm1
	vaesenc	%zmm9,%zmm2,%zmm2
	vaesenc	%zmm9,%zmm3,%zmm3

.Laes128__func2:




	prefetcht0	512+0(%rdi)
	prefetcht0	512+64(%rdi)
	prefetcht0	512+128(%rdi)
	prefetcht0	512+192(%rdi)




	vpshufb	%zmm8,%zmm4,%zmm4
	vpxord	%zmm10,%zmm4,%zmm4
	vpshufb	%zmm8,%zmm5,%zmm5
	vpshufb	%zmm8,%zmm6,%zmm6

	vaesenc	%zmm15,%zmm0,%zmm0
	vaesenc	%zmm15,%zmm1,%zmm1
	vaesenc	%zmm15,%zmm2,%zmm2
	vaesenc	%zmm15,%zmm3,%zmm3

	vpshufb	%zmm8,%zmm7,%zmm7
	vpclmulqdq	$0x00,%zmm27,%zmm4,%zmm10
	vpclmulqdq	$0x00,%zmm28,%zmm5,%zmm24
	vpclmulqdq	$0x00,%zmm29,%zmm6,%zmm25

	vaesenc	%zmm16,%zmm0,%zmm0
	vaesenc	%zmm16,%zmm1,%zmm1
	vaesenc	%zmm16,%zmm2,%zmm2
	vaesenc	%zmm16,%zmm3,%zmm3

	vpxord	%zmm24,%zmm10,%zmm10
	vpclmulqdq	$0x00,%zmm30,%zmm7,%zmm26
	vpternlogd	$0x96,%zmm26,%zmm25,%zmm10
	vpclmulqdq	$0x01,%zmm27,%zmm4,%zmm24

	vaesenc	%zmm17,%zmm0,%zmm0
	vaesenc	%zmm17,%zmm1,%zmm1
	vaesenc	%zmm17,%zmm2,%zmm2
	vaesenc	%zmm17,%zmm3,%zmm3

	vpclmulqdq	$0x01,%zmm28,%zmm5,%zmm25
	vpclmulqdq	$0x01,%zmm29,%zmm6,%zmm26
	vpternlogd	$0x96,%zmm26,%zmm25,%zmm24
	vpclmulqdq	$0x01,%zmm30,%zmm7,%zmm25

	vaesenc	%zmm18,%zmm0,%zmm0
	vaesenc	%zmm18,%zmm1,%zmm1
	vaesenc	%zmm18,%zmm2,%zmm2
	vaesenc	%zmm18,%zmm3,%zmm3

	vpclmulqdq	$0x10,%zmm27,%zmm4,%zmm26
	vpternlogd	$0x96,%zmm26,%zmm25,%zmm24
	vpclmulqdq	$0x10,%zmm28,%zmm5,%zmm25
	vpclmulqdq	$0x10,%zmm29,%zmm6,%zmm26

	vaesenc	%zmm19,%zmm0,%zmm0
	vaesenc	%zmm19,%zmm1,%zmm1
	vaesenc	%zmm19,%zmm2,%zmm2
	vaesenc	%zmm19,%zmm3,%zmm3

	vpternlogd	$0x96,%zmm26,%zmm25,%zmm24
	vpclmulqdq	$0x01,%zmm10,%zmm31,%zmm26
	vpclmulqdq	$0x10,%zmm30,%zmm7,%zmm25
	vpxord	%zmm25,%zmm24,%zmm24

	vaesenc	%zmm20,%zmm0,%zmm0
	vaesenc	%zmm20,%zmm1,%zmm1
	vaesenc	%zmm20,%zmm2,%zmm2
	vaesenc	%zmm20,%zmm3,%zmm3

	vpshufd	$0x4e,%zmm10,%zmm10
	vpclmulqdq	$0x11,%zmm27,%zmm4,%zmm4
	vpclmulqdq	$0x11,%zmm28,%zmm5,%zmm5
	vpclmulqdq	$0x11,%zmm29,%zmm6,%zmm6

	vaesenc	%zmm21,%zmm0,%zmm0
	vaesenc	%zmm21,%zmm1,%zmm1
	vaesenc	%zmm21,%zmm2,%zmm2
	vaesenc	%zmm21,%zmm3,%zmm3

	vpternlogd	$0x96,%zmm26,%zmm10,%zmm24
	vpclmulqdq	$0x11,%zmm30,%zmm7,%zmm7
	vpternlogd	$0x96,%zmm6,%zmm5,%zmm4
	vpclmulqdq	$0x01,%zmm24,%zmm31,%zmm25

	vaesenc	%zmm22,%zmm0,%zmm0
	vaesenc	%zmm22,%zmm1,%zmm1
	vaesenc	%zmm22,%zmm2,%zmm2
	vaesenc	%zmm22,%zmm3,%zmm3

	vpxord	%zmm7,%zmm4,%zmm10
	vpshufd	$0x4e,%zmm24,%zmm24
	vpternlogd	$0x96,%zmm25,%zmm24,%zmm10

	vaesenc	%zmm23,%zmm0,%zmm0
	vaesenc	%zmm23,%zmm1,%zmm1
	vaesenc	%zmm23,%zmm2,%zmm2
	vaesenc	%zmm23,%zmm3,%zmm3


	vextracti32x4	$1,%zmm10,%xmm4
	vextracti32x4	$2,%zmm10,%xmm5
	vextracti32x4	$3,%zmm10,%xmm6
	vpxord	%xmm4,%xmm10,%xmm10
	vpternlogd	$0x96,%xmm5,%xmm6,%xmm10

	vpxord	0(%rdi),%zmm14,%zmm4
	vpxord	64(%rdi),%zmm14,%zmm5
	vpxord	128(%rdi),%zmm14,%zmm6
	vpxord	192(%rdi),%zmm14,%zmm7
	vaesenclast	%zmm4,%zmm0,%zmm4
	vaesenclast	%zmm5,%zmm1,%zmm5
	vaesenclast	%zmm6,%zmm2,%zmm6
	vaesenclast	%zmm7,%zmm3,%zmm7
	vmovdqu8	%zmm4,0(%rsi)
	vmovdqu8	%zmm5,64(%rsi)
	vmovdqu8	%zmm6,128(%rsi)
	vmovdqu8	%zmm7,192(%rsi)

	addq	$256,%rdi
	addq	$256,%rsi
	subq	$256,%rdx
	cmpq	$256,%rdx
	jae	.Lcrypt_loop_4x__func2
.Lcrypt_loop_4x_done__func2:

	testq	%rdx,%rdx
	jz	.Ldone__func2




















	movq	%rdx,%rax
	negq	%rax
	andq	$-16,%rax
	leaq	256(%r9,%rax,1),%r8
	vpxor	%xmm4,%xmm4,%xmm4
	vpxor	%xmm5,%xmm5,%xmm5
	vpxor	%xmm6,%xmm6,%xmm6

	cmpq	$64,%rdx
	jb	.Lpartial_vec__func2

.Lcrypt_loop_1x__func2:



	vpshufb	%zmm8,%zmm12,%zmm0
	vpaddd	%zmm11,%zmm12,%zmm12
	vpxord	%zmm13,%zmm0,%zmm0
	leaq	16(%rcx),%rax
.Lvaesenc_loop_tail_full_vec__func2:
	vbroadcasti32x4	(%rax),%zmm9
	vaesenc	%zmm9,%zmm0,%zmm0
	addq	$16,%rax
	cmpq	%rax,%r11
	jne	.Lvaesenc_loop_tail_full_vec__func2
	vaesenclast	%zmm14,%zmm0,%zmm0


	vmovdqu8	(%rdi),%zmm1
	vpxord	%zmm1,%zmm0,%zmm0
	vmovdqu8	%zmm0,(%rsi)


	vmovdqu8	(%r8),%zmm30
	vpshufb	%zmm8,%zmm1,%zmm0
	vpxord	%zmm10,%zmm0,%zmm0
	vpclmulqdq	$0x00,%zmm30,%zmm0,%zmm7
	vpclmulqdq	$0x01,%zmm30,%zmm0,%zmm1
	vpclmulqdq	$0x10,%zmm30,%zmm0,%zmm2
	vpclmulqdq	$0x11,%zmm30,%zmm0,%zmm3
	vpxord	%zmm7,%zmm4,%zmm4
	vpternlogd	$0x96,%zmm2,%zmm1,%zmm5
	vpxord	%zmm3,%zmm6,%zmm6

	vpxor	%xmm10,%xmm10,%xmm10

	addq	$64,%r8
	addq	$64,%rdi
	addq	$64,%rsi
	subq	$64,%rdx
	cmpq	$64,%rdx
	jae	.Lcrypt_loop_1x__func2

	testq	%rdx,%rdx
	jz	.Lreduce__func2

.Lpartial_vec__func2:




	movq	$-1,%rax
	bzhiq	%rdx,%rax,%rax
	kmovq	%rax,%k1
	addq	$15,%rdx
	andq	$-16,%rdx
	movq	$-1,%rax
	bzhiq	%rdx,%rax,%rax
	kmovq	%rax,%k2



	vpshufb	%zmm8,%zmm12,%zmm0
	vpxord	%zmm13,%zmm0,%zmm0
	leaq	16(%rcx),%rax
.Lvaesenc_loop_tail_partialvec__func2:
	vbroadcasti32x4	(%rax),%zmm9
	vaesenc	%zmm9,%zmm0,%zmm0
	addq	$16,%rax
	cmpq	%rax,%r11
	jne	.Lvaesenc_loop_tail_partialvec__func2
	vaesenclast	%zmm14,%zmm0,%zmm0


	vmovdqu8	(%rdi),%zmm1{%k1}{z}
	vpxord	%zmm1,%zmm0,%zmm0
	vmovdqu8	%zmm0,(%rsi){%k1}













	vmovdqu8	(%r8),%zmm30{%k2}{z}

	vpshufb	%zmm8,%zmm1,%zmm0
	vpxord	%zmm10,%zmm0,%zmm0
	vpclmulqdq	$0x00,%zmm30,%zmm0,%zmm7
	vpclmulqdq	$0x01,%zmm30,%zmm0,%zmm1
	vpclmulqdq	$0x10,%zmm30,%zmm0,%zmm2
	vpclmulqdq	$0x11,%zmm30,%zmm0,%zmm3
	vpxord	%zmm7,%zmm4,%zmm4
	vpternlogd	$0x96,%zmm2,%zmm1,%zmm5
	vpxord	%zmm3,%zmm6,%zmm6


.Lreduce__func2:

	vpclmulqdq	$0x01,%zmm4,%zmm31,%zmm0
	vpshufd	$0x4e,%zmm4,%zmm4
	vpternlogd	$0x96,%zmm0,%zmm4,%zmm5
	vpclmulqdq	$0x01,%zmm5,%zmm31,%zmm0
	vpshufd	$0x4e,%zmm5,%zmm5
	vpternlogd	$0x96,%zmm0,%zmm5,%zmm6

	vextracti32x4	$1,%zmm6,%xmm0
	vextracti32x4	$2,%zmm6,%xmm1
	vextracti32x4	$3,%zmm6,%xmm2
	vpxord	%xmm0,%xmm6,%xmm10
	vpternlogd	$0x96,%xmm1,%xmm2,%xmm10


.Ldone__func2:

	vpshufb	%xmm8,%xmm10,%xmm10
	vmovdqu	%xmm10,(%r12)

	vzeroupper
	popq	%r12
.cfi_adjust_cfa_offset	-8
.cfi_restore	%r12
	ret

.cfi_endproc	
.size	aes_gcm_dec_update_vaes_avx512, . - aes_gcm_dec_update_vaes_avx512
#endif
