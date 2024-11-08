import { discover } from "./discover";
import type { OpenId, ProviderResponse } from "./openid";

/**
 * Helper function since URL.parse is not working in Node.js context
 */
const parseURL = (val: string): URL | null => {
  try {
    return new URL(val);
  } catch {
    return null;
  }
};

const FIVE_MINUTES_IN_MS = 300000; // microseconds

export type Provider = {
  endpoint?: string;
  version?: string;
};

type Nonce = `${string}Z${string}`;
type Nonces = Record<Nonce, Date>;

export class SteamOpenIdClient implements OpenId {
  private nonces: Nonces = {};

  async authenticate(identifier: string, returnUrl: string) {
    const providers = await discover(identifier);
    if (!providers || providers.length === 0) {
      throw new Error(
        "No providers found for the given identifier. Identifier: " +
          identifier,
      );
    }

    return await this.chooseProvider(providers, returnUrl);
  }

  async validateResponse(responseUrl: string, returnUrl: string) {
    const assertionUrl = new URL(responseUrl.trim());
    const params = assertionUrl.searchParams;

    this.checkReturnUrlsAreValid(assertionUrl, returnUrl);

    await this.checkParams(params);
    await this.checkNonce(params);

    return await this.verifyDiscoveredInformation(params);
  }

  private chooseProvider = async (
    providers: Provider[],
    returnUrl: string,
  ): Promise<string> => {
    let providerIndex = -1;

    while (++providerIndex < providers.length) {
      const currentProvider = providers[providerIndex];
      const authUrl = await this.requestAuthentication(
        currentProvider,
        returnUrl,
      );

      if (authUrl) {
        return authUrl;
      }
    }

    throw new Error("No usable providers found for the given identifier");
  };

  private async requestAuthentication(
    provider: Provider,
    returnUrl: string,
  ): Promise<string> {
    const params = {
      "openid.mode": "checkid_setup",
      "openid.ns": "http://specs.openid.net/auth/2.0",
      "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
      "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
      "openid.return_to": returnUrl,
    };

    if (!provider.endpoint) {
      throw new Error("No provider endpoint specified.");
    }

    return this.buildUrl(provider.endpoint, params);
  }

  private checkReturnUrlsAreValid(
    openIdReturnUrl: URL,
    clientReturnUrl: string,
  ): void {
    if (clientReturnUrl === "") {
      throw new Error("OpenId Client return url is empty.");
    }

    const openIdReturnTo = openIdReturnUrl.searchParams.get("openid.return_to");
    if (!openIdReturnTo) {
      throw new Error(
        "openId.return_to query param is missing in the request URL.",
      );
    }

    const parsedOpenIdReturnTo = parseURL(openIdReturnTo);
    if (!parsedOpenIdReturnTo) {
      throw new Error(
        `openId.return_to URL (${openIdReturnTo}) could not been parsed.`,
      );
    }

    const parsedClientReturnUrl = parseURL(clientReturnUrl);
    if (!parsedClientReturnUrl) {
      throw new Error(
        `OpenID Client return url (${clientReturnUrl}) could not been parsed.`,
      );
    }

    if (
      parsedClientReturnUrl.protocol !== parsedOpenIdReturnTo.protocol || // Verify scheme against original return URL
      parsedClientReturnUrl.host !== parsedOpenIdReturnTo.host || // Verify authority against original return URL
      parsedClientReturnUrl.pathname !== parsedOpenIdReturnTo.pathname
    ) {
      // Verify path against current request URL
      throw new Error(
        `OpenID Client and OpenID return_to URLs do not match. Client URL: ${JSON.stringify(parsedClientReturnUrl)}, OpenID URL: ${JSON.stringify(parsedOpenIdReturnTo)}.`,
      );
    }

    // Any query parameters that are present in the "openid.return_to" URL MUST also be present
    // with the same values in the URL of the HTTP request the RP received
    if (
      openIdReturnUrl.search &&
      parsedClientReturnUrl.search &&
      !openIdReturnUrl.search.includes(parsedClientReturnUrl.search)
    ) {
      // verify if query params matches (may contain all without one)
      throw new Error(
        "Query parameters in OpenID return_to and OpenID Client return URL do not match.",
      );
    }
  }

  private removeOldNonces(): void {
    for (const nonce in this.nonces) {
      if (
        Math.abs(Date.now() - this.nonces[nonce].getTime()) > FIVE_MINUTES_IN_MS
      ) {
        delete this.nonces[nonce];
      }
    }
  }

  private async checkNonce(params: URLSearchParams): Promise<void> {
    if (params.has("openid.ns") && !params.get("openid.ns")?.includes("2.0")) {
      return; // Open ID 1.1 but not an Open ID 2.0 compatibility mode (ns with 2.0 indicates compatibility mode)
    }

    const nonce = params.get("openid.response_nonce");
    if (!nonce) {
      throw new Error(
        `Missing response nonce. Request params: ${JSON.stringify(params)}`,
      );
    }

    const nonceDate = nonce
      .trim()
      .match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)(.*)$/)?.[1];
    if (!nonceDate || nonceDate.toString().includes(".")) {
      // "." indicates fractional settings that are prohibited
      throw new Error(
        `Response nonce has invalid date format or no date at all. Nonce: ${nonce}. Request params: ` +
          JSON.stringify(params),
      );
    }

    const date = new Date(nonceDate);

    const timestamp = date.getTime();
    if (isNaN(timestamp)) {
      throw new TypeError(
        `Response nonce could not been converted to timestamp. Nonce: ${nonce}. Date: ${nonceDate}. Timestamp: ${timestamp}. Request params: ` +
          JSON.stringify(params),
      );
    }

    // Remove old nonces from our store (nonces that are skewed more than 5 minutes)
    this.removeOldNonces();

    // Check if nonce is skewed by more than 5 minutes
    if (Math.abs(Date.now() - timestamp) > FIVE_MINUTES_IN_MS) {
      throw new Error(
        `Response nonce is skewed by more than 5 minutes. Nonce: ${nonce}. Date: ${date}. Timestamp: ${timestamp}. Request params: ` +
          JSON.stringify(params),
      );
    }

    // Check if nonce is replayed
    if (nonce in this.nonces) {
      throw new Error(
        `Response nonce has already been used (replayed). Nonce: ${nonce}. Date: ${date}. Timestamp: ${timestamp}. Request params: ` +
          JSON.stringify(params),
      );
    }

    // Store the nonce
    this.nonces[nonce] = date;
  }

  private async checkParams(params?: URLSearchParams): Promise<void> {
    if (params === undefined) {
      throw new Error("Assertion request is malformed. Empty params.");
    } else if (params.get("openid.mode") === "error") {
      throw new Error(params.get("openid.error") as string);
    } else if (params.get("openid.mode") === "cancel") {
      throw new Error("Authentication cancelled.");
    }
  }

  private getCanonicalClaimedIdentifier(claimedIdentifier: string) {
    const index = claimedIdentifier.indexOf("#");

    return index !== -1
      ? claimedIdentifier.slice(0, Math.max(0, index))
      : claimedIdentifier;
  }

  private async verifyDiscoveredInformation(
    params: URLSearchParams,
  ): Promise<ProviderResponse> {
    const claimedIdentifier = params.get("openid.claimed_id");
    if (!claimedIdentifier) {
      throw new Error(
        `Could not obtain claimed identifier. Params: ${JSON.stringify(params)}`,
      );
    }

    const canonicalClaimedIdentifier =
      this.getCanonicalClaimedIdentifier(claimedIdentifier);
    const providers = await discover(canonicalClaimedIdentifier);
    if (!providers || providers.length === 0) {
      throw new Error(
        `No OpenID provider was discovered for the asserted claimed identifier. Claimed identifier: ${canonicalClaimedIdentifier}. Params: ${JSON.stringify(params)}`,
      );
    }

    if (!params.get("openid.signed") || !params.get("openid.sig")) {
      throw new Error("No signature in response.");
    }

    return {
      authenticated: true,
      claimedIdentifier: params.get("openid.claimed_id") as string,
    };
  }

  private buildUrl(theUrl: string, params: Record<string, string>): string {
    const parsedUrl = new URL(theUrl);
    parsedUrl.search = ""; // clear any previous params

    if (params) {
      for (const key in params) {
        parsedUrl.searchParams.set(key, params[key]);
      }
    }

    return parsedUrl.toString();
  }
}
