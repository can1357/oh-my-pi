import { describe, expect, test } from "bun:test";
import { renderAmazonProduct } from "@oh-my-pi/pi-coding-agent/web/scrapers/amazon";

const PAGE_URL = "https://www.amazon.in/dp/B0GL2XD8V3";

const PRODUCT_PAGE = `<!doctype html>
<html>
<head><title>Zenvora Ergonomic Office Desk Chair, White and Grey</title></head>
<body>
<header id="nav-main"><div id="nav-belt"><a class="nav-a" href="/gp/goldbox?ref_=nav_cs_gb">NAV_MARKER_TODAYS_DEALS</a></div></header>
<script>window.SCRIPT_MARKER = "SCRIPT_MARKER_TEXT";</script>
<div id="dp-container">
	<div id="titleSection" class="a-section a-spacing-none">
		<h1 id="title" class="a-size-large a-spacing-none">
			<span id="productTitle" class="a-size-large product-title-word-break">        Zenvora Ergonomic Office Desk Chair, White and Grey       </span>
		</h1>
	</div>
	<div id="bylineInfo_feature_div" class="celwidget" data-feature-name="bylineInfo">
		<div class="a-section a-spacing-none"><a id="bylineInfo" class="a-link-normal" href="/stores/Zenvora/page/C6A82050?ref_=ast_bln">Visit the Zenvora Store</a></div>
	</div>
	<div id="corePriceDisplay_desktop_feature_div" class="celwidget" data-feature-name="corePriceDisplay_desktop" data-csa-c-asin="B0GL2XD8V3">
		<div class="a-section a-spacing-none">
			<span class="a-price aok-align-center apex-pricetopay-value" data-a-size="xl" data-a-color="base"><span class="a-offscreen">₹34,999.00</span><span aria-hidden="true"><span class="a-price-symbol">₹</span><span class="a-price-whole">34,999<span class="a-price-decimal">.</span></span><span class="a-price-fraction">00</span></span></span>
		</div>
	</div>
	<div class="celwidget" data-feature-name="availability">
		<div id="availability" class="a-section a-spacing-base a-spacing-top-micro">
			<span class="a-size-medium a-color-base primary-availability-message"> In stock </span>
		</div>
	</div>
	<div id="twister_feature_div" class="celwidget" data-feature-name="twister" data-csa-c-asin="B0GL2XD8V3">
		<div id="twister-plus-desktop-twister-container" data-csa-c-content-id="twister-plus-inline-twister-container" data-csa-c-slot-id="twister-plus-inline-twister-container" data-csa-c-type="slot" class="a-cardui-deck inline-twister-container-margins">
			<div id="inline-twister-row-colour_name" data-csa-c-content-id="inline-twister-row-colour_name" class="a-section a-spacing-none inline-twister-row">
				<div class="a-section a-spacing-none dimension-heading">
					<div class="a-section a-spacing-none dimension-text"><span class="a-size-base a-color-secondary"> Colour: </span><span id="inline-twister-expanded-dimension-text-colour_name" class="a-size-base a-color-base inline-twister-dim-title-value a-text-bold"> White and Grey </span></div>
				</div>
				<div id="inline-twister-expander-content-colour_name" class="a-section a-spacing-none dimension-expander-content">
					<ul class="a-unordered-list a-nostyle a-button-list a-horizontal dimension-values-list" role="radiogroup">
						<li data-asin="B0GL2XD8V3" data-defaultasin="B0GL2XD8V3" data-csa-c-item-id="B0GL2XD8V3" data-initiallySelected="true" class="dimension-value-list-item-square-image inline-twister-swatch">
							<span class="a-list-item">
								<span class="a-button a-button-selected a-button-toggle"><span class="a-button-inner"><span class="a-button-text" aria-hidden="true"><div class="a-section swatch-image-container"><img alt="White and Grey" src="https://m.media-amazon.com/images/I/516g+PLPnkL._SS64_.jpg" class="swatch-image" id="inline-twister-image-1"/></div></span></span></span>
							</span>
						</li>
						<li data-asin="B0GL317WG3" data-defaultasin="B0GL317WG3" data-csa-c-item-id="B0GL317WG3" class="dimension-value-list-item-square-image inline-twister-swatch">
							<span class="a-list-item">
								<span class="a-button a-button-toggle"><span class="a-button-inner"><span class="a-button-text" aria-hidden="true"><div class="a-section swatch-image-container"><img alt="Gravita Green" src="https://m.media-amazon.com/images/I/51j8AVvqdUL._SS64_.jpg" class="swatch-image" id="inline-twister-image-0"/></div></span></span></span>
							</span>
						</li>
					</ul>
				</div>
			</div>
		</div>
	</div>
	<div id="imageBlock_feature_div" class="celwidget" data-feature-name="imageBlock">
		<div id="imgTagWrapperId" class="imgTagWrapper">
			<img alt="Zenvora Ergonomic Office Desk Chair, White and Grey" src="https://m.media-amazon.com/images/I/91Vq0RqpA8L._SY300_SX300_QL70_ML2_.jpg" data-old-hires="https://m.media-amazon.com/images/I/91Vq0RqpA8L._SL1500_.jpg" class="a-dynamic-image a-stretch-vertical" id="landingImage"/>
		</div>
	</div>
	<script type="text/javascript">
		P.when("A", "jQuery").execute(function (A) {
			A.declarative("ImageBlockATF", function (A) {
				var data = { "colorImages": { "initial": A.$.parseJSON('[{"hiRes":"https://m.media-amazon.com/images/I/91Vq0RqpA8L._SL1500_.jpg","thumb":"https://m.media-amazon.com/images/I/51al5HzBKEL._SS100_.jpg","large":"https://m.media-amazon.com/images/I/51al5HzBKEL.jpg"},{"hiRes":"https://m.media-amazon.com/images/I/6184erHzSbL._SL1254_.jpg","thumb":"https://m.media-amazon.com/images/I/41fHCu5PQwL._SS100_.jpg","large":"https://m.media-amazon.com/images/I/41fHCu5PQwL.jpg"}]') } };
				A.trigger("ImageBlockATF", data);
			});
		});
	</script>
	<div id="feature-bullets" class="a-section a-spacing-medium a-spacing-top-small">
		<h1 class="a-size-base-plus a-text-bold"> About this item </h1>
		<ul class="a-unordered-list a-vertical a-spacing-mini">
			<li class="a-spacing-mini"><span class="a-list-item"> Ergonomic mesh back with adjustable lumbar support and a five-year warranty. </span></li>
			<li class="a-spacing-mini"><span class="a-list-item"> Pairs with the <a href="/dp/B0GL317WG3/ref=dp_bc_1?pd_rd_i=B0GL317WG3&amp;pd_rd_r=1b2c3d4e5f&amp;th=1">Gravita Green variant</a> sold separately. </span></li>
		</ul>
	</div>
	<div id="prodDetails" class="a-section a-spacing-medium">
		<h1 class="a-size-large a-spacing-small a-text-bold"> Product information </h1>
		<div class="a-row">
			<div class="a-column a-span12 a-span-last">
				<div id="productDetails_expanderSectionTables" class="a-section">
					<div class="a-row">
						<div class="a-column a-span6">
							<div id="productDetails_expanderTables_depthLeftSections" class="a-section">
								<div class="a-row a-expander-container a-expander-section-container a-section-expander-container">
									<span class="a-declarative" data-action="voyager-expander-heading-toggle"><a aria-expanded="true" role="button" href="javascript:void(0)" class="a-expander-header a-declarative a-expander-section-header prodDet-expander-header-styling a-size-medium"><span class="a-expander-prompt" role="heading" aria-level="5"> Item details </span></a></span>
									<div data-expanded="true" class="a-expander-content a-expander-extend-content">
										<div class="a-section">
											<table class="a-keyvalue prodDetTable">
												<tr><th class="a-color-secondary a-size-base prodDetSectionEntry"> Brand </th><td class="a-size-base prodDetAttrValue"> Zenvora </td></tr>
												<tr><th class="a-color-secondary a-size-base prodDetSectionEntry"> Manufacturer </th><td class="a-size-base prodDetAttrValue"> Zenvora Furniture Pvt Ltd, Bengaluru </td></tr>
											</table>
										</div>
									</div>
								</div>
								<div class="a-row a-expander-container a-expander-section-container a-section-expander-container">
									<span class="a-declarative" data-action="voyager-expander-heading-toggle"><a aria-expanded="false" role="button" href="javascript:void(0)" class="a-expander-header a-declarative a-expander-section-header prodDet-expander-header-styling a-size-medium"><i class="a-icon a-icon-section-expand"></i><span class="a-expander-prompt" role="heading" aria-level="5"> Additional Information </span></a></span>
									<div data-expanded="false" class="a-expander-content a-expander-extend-content" style="display:none">
										<div class="a-section">
											<table class="a-keyvalue prodDetTable">
												<tr><th class="a-color-secondary a-size-base prodDetSectionEntry"> Item Weight </th><td class="a-size-base prodDetAttrValue"> 15.4 Kilograms </td></tr>
												<tr><th class="a-color-secondary a-size-base prodDetSectionEntry"> Seat Height </th><td class="a-size-base prodDetAttrValue"> 45 Centimeters </td></tr>
											</table>
										</div>
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
	<div id="sp_detail" class="a-section a-spacing-top-large">
		<h2 class="a-size-base-plus a-text-bold">Sponsored products related to this item</h2>
		<div class="a-carousel" data-a-carousel-options="{&quot;name&quot;:&quot;sp_detail&quot;}">
			<ul class="a-carousel-collection">
				<li class="a-carousel-card"><a href="/dp/B09XYZ1234/ref=s9_simh_gw_p1_i1?pf_rd_i=desktop"><span class="a-size-base a-color-base">SPONSORED_MARKER_Folding Chair</span></a></li>
			</ul>
		</div>
	</div>
	<div id="reviewsMedley" class="a-section">
		<h2 class="a-size-base-plus a-text-bold">Customer reviews</h2>
		<div id="localTopReviews" data-hook="topReviewsSection">
			<h3 class="a-spacing-medium a-spacing-top-large">Top reviews from India</h3>
			<ul id="cm-cr-dp-review-list" data-csa-c-slot-id="cm-cr-dp-review-list" data-csa-c-type="widget" class="a-unordered-list a-nostyle a-vertical">
				<li><span class="a-list-item">
					<div data-hook="reviewContainer" data-reviewid="RRRR1111222" data-asin="B0GL2XD8V3">
						<div id="RRRR1111222" data-csa-c-slot-id="customer_review-RRRR1111222_1" data-hook="review" class="a-section aok-relative">
							<div data-hook="genome-widget" class="a-row a-spacing-mini"><a href="/gp/profile/amzn1.account.AAAAA?ref=cm_cr_dp_d_bdcrb_top" class="a-profile"><div class="a-profile-content"><span class="a-profile-name">Priya Sharma</span></div></a></div>
							<div class="a-row"><i data-hook="review-star-rating" class="a-icon a-icon-star a-star-4"><span class="a-icon-alt">4.0 out of 5 stars</span></i></div>
							<a class="a-size-base a-color-base a-link-normal a-text-bold" href="/portal/customer-reviews/srp/-/RRRR1111222/ref=cm_cr_dp_d_rvw_ttl?_encoding=UTF8&amp;ie=UTF8"><h5 data-hook="reviewTitle" class="a-size-base">Solid chair for long work days</h5></a>
							<div data-hook="review-by-line" class="a-row a-spacing-none"><span data-hook="review-date" class="a-size-base a-color-tertiary">Reviewed in India on 14 October 2026</span></div>
							<div data-hook="product-variation-attributes" class="a-row a-spacing-mini">
								<a data-hook="format-strip" class="a-link-normal" href="/portal/customer-reviews/B0GL2XD8V3/ref=cm_cr_dp_d_rvw_fmt?formatType=current_format"><span class="a-size-base a-color-secondary">Colour: White and Grey</span></a>
								<span data-hook="avp-badge" class="a-size-mini a-color-state a-text-bold">Verified Purchase</span>
							</div>
							<div data-hook="reviewTextContainer" class="a-section">
								<div data-hook="reviewText" class="a-section"><span class="a-size-base review-text-content">The mesh back stays cool all day and assembly took twenty minutes with the included tools.</span></div>
							</div>
							<div class="a-section a-spacing-top-small"><span data-hook="helpful-vote-statement" class="a-size-base a-color-tertiary">3 people found this helpful</span></div>
						</div>
					</div>
				</span></li>
			</ul>
		</div>
	</div>
</div>
</body>
</html>`;

const SEARCH_PAGE = `<!doctype html>
<html>
<head><title>Amazon.in : office chair</title></head>
<body>
<header id="nav-main"><div id="nav-belt"><a class="nav-a" href="/gp/goldbox?ref_=nav_cs_gb">NAV_MARKER_TODAYS_DEALS</a></div></header>
<div class="s-main-slot s-result-list">
	<div data-component-type="s-search-result" data-asin="B0GL2XD8V3"><h2>Sponsored Ad - Zenvora Ergonomic Office Desk Chair</h2></div>
</div>
<form method="get" action="/s"><input type="hidden" name="k" value="office chair"/></form>
</body>
</html>`;

const CAPTCHA_PAGE = `<!doctype html>
<html>
<head><title>Amazon.com</title></head>
<body>
<div class="a-container a-padding-double-large">
	<div class="a-box a-alert a-alert-info a-spacing-base"><div class="a-box-inner"><h4>Click the button below to continue shopping</h4></div></div>
	<div class="a-box a-color-offset-background"><div class="a-box-inner a-padding-extra-large">
		<form method="get" action="/errors_page/validateCaptcha" name="">
			<input type="hidden" name="amzn" value="XcNCbr1bJAkR/KoLgArrwA=="/><input type="hidden" name="field-keywords" value="LBYKGX"/>
			<span class="a-button a-button-primary a-span12"><span class="a-button-inner"><button type="submit" class="a-button-text" alt="Continue shopping">Continue shopping</button></span></span>
		</form>
	</div></div>
</div>
</body>
</html>`;

async function renderProductPage(): Promise<string> {
	const markdown = await renderAmazonProduct(PRODUCT_PAGE, PAGE_URL);
	if (markdown === null) throw new Error("renderAmazonProduct returned null for a product page");
	return markdown;
}

describe("renderAmazonProduct", () => {
	test("keeps title and rows from a collapsed product-details panel", async () => {
		const markdown = await renderProductPage();
		expect(markdown).toContain("Zenvora Ergonomic Office Desk Chair");
		expect(markdown).toContain("Item Weight");
		expect(markdown).toContain("15.4 Kilograms");
	});

	test("keeps the review body and the verified-purchase badge", async () => {
		const markdown = await renderProductPage();
		expect(markdown).toContain("assembly took twenty minutes");
		expect(markdown).toContain("Verified Purchase");
	});

	test("drops navigation, sponsored carousel and script content", async () => {
		const markdown = await renderProductPage();
		expect(markdown).not.toContain("NAV_MARKER_TODAYS_DEALS");
		expect(markdown).not.toContain("SPONSORED_MARKER_Folding Chair");
		expect(markdown).not.toContain("SCRIPT_MARKER_TEXT");
	});

	test("rewrites tracked product links to /dp/<ASIN> without query", async () => {
		const markdown = await renderProductPage();
		expect(markdown).toContain("https://www.amazon.in/dp/B0GL317WG3");
		expect(markdown).not.toContain("ref=");
		expect(markdown).not.toContain("pd_rd_i");
	});

	test("returns null for pages without a product title element", async () => {
		expect(await renderAmazonProduct(SEARCH_PAGE, "https://www.amazon.in/s?k=office+chair")).toBeNull();
		expect(await renderAmazonProduct(CAPTCHA_PAGE, PAGE_URL)).toBeNull();
	});
});
