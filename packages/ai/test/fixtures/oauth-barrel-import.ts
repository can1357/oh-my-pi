import {
	getOAuthProviders as rootGetOAuthProviders,
	refreshOAuthToken as rootRefreshOAuthToken,
} from "@oh-my-pi/pi-ai";
import {
	getOAuthProviders as oauthGetOAuthProviders,
	refreshOAuthToken as oauthRefreshOAuthToken,
} from "@oh-my-pi/pi-ai/registry/oauth";
import "@oh-my-pi/pi-ai/providers/anthropic";
import "@oh-my-pi/pi-ai/auth-storage";

const publicExports = [rootGetOAuthProviders, rootRefreshOAuthToken, oauthGetOAuthProviders, oauthRefreshOAuthToken];

if (publicExports.some(value => !value)) {
	throw new Error("OAuth registry exports are unavailable");
}
