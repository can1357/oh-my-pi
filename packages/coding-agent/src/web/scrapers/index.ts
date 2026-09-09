/**
 * Web Fetch Special Handlers Index
 *
 * Exports all special handlers for site-specific content extraction.
 */
import { handleArtifactHub } from "./artifacthub";
import { handleArxiv } from "./arxiv";
import { handleAur } from "./aur";
import { handleBiorxiv } from "./biorxiv";
import { handleBluesky } from "./bluesky";
import { handleBrew } from "./brew";
import { handleCheatSh } from "./cheatsh";
import { handleChocolatey } from "./chocolatey";
import { handleChooseALicense } from "./choosealicense";
import { handleCisaKev } from "./cisa-kev";
import { handleClojars } from "./clojars";
import { handleCoinGecko } from "./coingecko";
import { handleCratesIo } from "./crates-io";
import { handleCrossref } from "./crossref";
import { handleDevTo } from "./devto";
import { handleDiscogs } from "./discogs";
import { handleDiscourse } from "./discourse";
import { handleDockerHub } from "./dockerhub";
import { handleDocsRs } from "./docs-rs";
import { handleFdroid } from "./fdroid";
import { handleFirefoxAddons } from "./firefox-addons";
import { handleFlathub } from "./flathub";
import { fetchGitHubApi, handleGitHub } from "./github";
import { handleGitHubGist } from "./github-gist";
import { handleGitLab } from "./gitlab";
import { handleGoPkg } from "./go-pkg";
import { handleHackage } from "./hackage";
import { handleHackerNews } from "./hackernews";
import { handleHex } from "./hex";
import { handleHuggingFace } from "./huggingface";
import { handleIacr } from "./iacr";
import { handleJetBrainsMarketplace } from "./jetbrains-marketplace";
import { handleLemmy } from "./lemmy";
import { handleLobsters } from "./lobsters";
import { handleMastodon } from "./mastodon";
import { handleMaven } from "./maven";
import { handleMDN } from "./mdn";
import { handleMetaCPAN } from "./metacpan";
import { handleMusicBrainz } from "./musicbrainz";
import { handleNpm } from "./npm";
import { handleNuGet } from "./nuget";
import { handleNvd } from "./nvd";
import { handleOllama } from "./ollama";
import { handleOpenVsx } from "./open-vsx";
import { handleOpenCorporates } from "./opencorporates";
import { handleOpenLibrary } from "./openlibrary";
import { handleOrcid } from "./orcid";
import { handleOsv } from "./osv";
import { handlePackagist } from "./packagist";
import { handlePubDev } from "./pub-dev";
import { handlePubMed } from "./pubmed";
import { handlePyPI } from "./pypi";
import { handleRawg } from "./rawg";
import { handleReadTheDocs } from "./readthedocs";
import { handleReddit } from "./reddit";
import { handleRepology } from "./repology";
import { handleRfc } from "./rfc";
import { handleRubyGems } from "./rubygems";
import { handleSearchcode } from "./searchcode";
import { handleSecEdgar } from "./sec-edgar";
import { handleSemanticScholar } from "./semantic-scholar";
import { handleSnapcraft } from "./snapcraft";
import { handleSourcegraph } from "./sourcegraph";
import { handleSpdx } from "./spdx";
import { handleSpotify } from "./spotify";
import { handleStackOverflow } from "./stackoverflow";
import { handleTerraform } from "./terraform";
import { handleTldr } from "./tldr";
import { handleTwitter } from "./twitter";
import type { SpecialHandler } from "./types";
import { handleVimeo } from "./vimeo";
import { handleVscodeMarketplace } from "./vscode-marketplace";
import { handleW3c } from "./w3c";
import { handleWikidata } from "./wikidata";
import { handleWikipedia } from "./wikipedia";
import { handleYouTube } from "./youtube";

export type { RenderResult, SpecialHandler } from "./types";

export {
	fetchGitHubApi,
	handleArtifactHub,
	handleArxiv,
	handleAur,
	handleBiorxiv,
	handleBluesky,
	handleBrew,
	handleCheatSh,
	handleChocolatey,
	handleChooseALicense,
	handleCisaKev,
	handleClojars,
	handleCoinGecko,
	handleCratesIo,
	handleCrossref,
	handleDevTo,
	handleDiscogs,
	handleDiscourse,
	handleDockerHub,
	handleDocsRs,
	handleFdroid,
	handleFirefoxAddons,
	handleFlathub,
	handleGitHub,
	handleGitHubGist,
	handleGitLab,
	handleGoPkg,
	handleHackage,
	handleHackerNews,
	handleHex,
	handleHuggingFace,
	handleIacr,
	handleJetBrainsMarketplace,
	handleLemmy,
	handleLobsters,
	handleMastodon,
	handleMaven,
	handleMDN,
	handleMetaCPAN,
	handleMusicBrainz,
	handleNpm,
	handleNuGet,
	handleNvd,
	handleOllama,
	handleOpenCorporates,
	handleOpenLibrary,
	handleOpenVsx,
	handleOrcid,
	handleOsv,
	handlePackagist,
	handlePubDev,
	handlePubMed,
	handlePyPI,
	handleRawg,
	handleReadTheDocs,
	handleReddit,
	handleRepology,
	handleRfc,
	handleRubyGems,
	handleSearchcode,
	handleSecEdgar,
	handleSemanticScholar,
	handleSnapcraft,
	handleSourcegraph,
	handleSpdx,
	handleSpotify,
	handleStackOverflow,
	handleTerraform,
	handleTldr,
	handleTwitter,
	handleVimeo,
	handleVscodeMarketplace,
	handleW3c,
	handleWikidata,
	handleWikipedia,
	handleYouTube,
};

export const specialHandlers: SpecialHandler[] = [
	// Git hosting
	handleGitHubGist,
	handleGitHub,
	handleGitLab,
	// Video/Media
	handleYouTube,
	handleVimeo,
	handleSpotify,
	handleDiscogs,
	handleMusicBrainz,
	// Games
	handleRawg,
	// Social/News
	handleTwitter,
	handleBluesky,
	handleMastodon,
	handleLemmy,
	handleHackerNews,
	handleLobsters,
	handleReddit,
	handleDiscourse,
	// Developer content
	handleStackOverflow,
	handleDevTo,
	handleMDN,
	handleDocsRs,
	handleReadTheDocs,
	handleSearchcode,
	handleSourcegraph,
	handleTldr,
	handleCheatSh,
	// Package registries
	handleNpm,
	handleFirefoxAddons,
	handleVscodeMarketplace,
	handleNuGet,
	handleChocolatey,
	handleClojars,
	handleBrew,
	handlePyPI,
	handleCratesIo,
	handleDockerHub,
	handleFdroid,
	handleFlathub,
	handleGoPkg,
	handleHex,
	handlePackagist,
	handlePubDev,
	handleMaven,
	handleJetBrainsMarketplace,
	handleOpenVsx,
	handleArtifactHub,
	handleRubyGems,
	handleTerraform,
	handleAur,
	handleHackage,
	handleMetaCPAN,
	handleRepology,
	handleSnapcraft,
	// ML/AI
	handleHuggingFace,
	handleOllama,
	// Academic
	handleArxiv,
	handleBiorxiv,
	handleCrossref,
	handleIacr,
	handleOrcid,
	handleSemanticScholar,
	handlePubMed,
	handleRfc,
	// Security
	handleCisaKev,
	handleNvd,
	handleOsv,
	// Crypto
	handleCoinGecko,
	// Business
	handleOpenCorporates,
	handleSecEdgar,
	// Reference
	handleOpenLibrary,
	handleChooseALicense,
	handleW3c,
	handleSpdx,
	handleWikidata,
	handleWikipedia,
];
