//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo, type AuthenticationResult } from "@azure/msal-browser";
import * as teams from "@microsoft/teams-js";
import RayfinClient from "@microsoft/rayfin-client";
import type { OpaqueSession } from "@microsoft/rayfin-auth";
import {
    ensureSignedInWithFabric,
    initEmbeddedAuth as sdkInitEmbeddedAuth,
    type FabricAuthOptions,
} from "@microsoft/rayfin-auth-provider-fabric";
import { getRayfinClient } from "@/lib/rayfin-client";
import { runtimeConfig } from "@/lib/runtime-config";

export interface AnalyticsHubUser {
    id?: string;
    name?: string;
    email?: string;
    username?: string;
    roles?: string[];
}

export class AnalyticsHubAccessDeniedError extends Error {
    constructor(message = "You don't have access — ask your admin to add you to Analytics Hub users.") {
        super(message);
        this.name = "AnalyticsHubAccessDeniedError";
    }
}

export interface TokenOptions {
    /** Skip cached tokens, e.g. after a role was granted since sign-in. */
    forceRefresh?: boolean;
}

export interface IAuthService {
    initEmbeddedAuth(): Promise<OpaqueSession | null>;
    signIn(): Promise<OpaqueSession>;
    getAccessToken?(options?: TokenOptions): Promise<string>;
    getUser?(): AnalyticsHubUser | null;
}

let currentAuthService: IAuthService | undefined;

export function getAccessToken(options?: TokenOptions): Promise<string> {
    if (!currentAuthService)
        throw new Error("Authentication has not been initialised.");
    return currentAuthService.getAccessToken?.(options) ?? Promise.reject(new Error("Authentication cannot supply API tokens."));
}

/** Construct the auth service used by the app for the current host. */
export function bootstrapAuth(): IAuthService {
    const config = runtimeConfig();
    currentAuthService = config.host === "azure" ? new AzureAuthService() : bootstrapFabricAuth();
    return currentAuthService;
}

function bootstrapFabricAuth(): IAuthService {
    const client = getRayfinClient();
    const { workspaceId, itemId: projectId, portalUrl: fabricPortalUrl } = runtimeConfig().rayfin;

    if (!workspaceId || !projectId || !fabricPortalUrl)
        throw new Error(`Missing required env vars for Fabric auth - run 'npx rayfin up'`);

    const fabricOptions: FabricAuthOptions = {
        workspaceId,
        projectId,
        fabricPortalUrl,
        returnOrigin: window.location.origin,
    };

    return new RayfinAuthService(client, fabricOptions);
}

class RayfinAuthService implements IAuthService {
    constructor(
        private readonly client: Pick<RayfinClient, "auth">,
        private readonly fabricOptions: FabricAuthOptions,
    ) {}

    async initEmbeddedAuth(): Promise<OpaqueSession | null> {
        return sdkInitEmbeddedAuth(this.client.auth, this.fabricOptions);
    }

    signIn(): Promise<OpaqueSession> {
        return ensureSignedInWithFabric(this.client.auth, this.fabricOptions);
    }

    async getAccessToken(): Promise<string> {
        const session = await this.initEmbeddedAuth();
        if (!session?.isAuthenticated)
            throw new Error("Sign in before calling the API.");
        return "";
    }
}

class AzureAuthService implements IAuthService {
    private readonly config = runtimeConfig().azure!;
    private readonly msal = new PublicClientApplication({
        auth: {
            clientId: this.config.clientId,
            authority: `https://login.microsoftonline.com/${this.config.tenantId}`,
            redirectUri: window.location.origin + window.location.pathname + window.location.search,
        },
        cache: { cacheLocation: "localStorage" },
    });
    private init?: Promise<void>;
    private token?: string;
    private user: AnalyticsHubUser | null = null;

    async initEmbeddedAuth(): Promise<OpaqueSession | null> {
        await this.ensureInitialised();
        if (this.config.inTeams && new URLSearchParams(window.location.search).get("auth") === "popup")
            await this.completeTeamsPopup();
        const account = this.account();
        if (!account) return null;
        await this.getAccessToken();
        return this.session(account);
    }

    async signIn(): Promise<OpaqueSession> {
        await this.ensureInitialised();
        if (this.config.inTeams) {
            try {
                this.token = await teams.authentication.getAuthToken();
                this.user = decodeUser(this.token);
                return this.session();
            } catch {
                await teams.authentication.authenticate({ url: `${window.location.origin}${window.location.pathname}?host=teams&auth=popup` });
                this.token = await teams.authentication.getAuthToken();
                this.user = decodeUser(this.token);
                return this.session();
            }
        }
        await this.msal.loginRedirect({ scopes: [this.config.apiScope] });
        return new Promise<OpaqueSession>(() => undefined);
    }

    async getAccessToken(options?: TokenOptions): Promise<string> {
        await this.ensureInitialised();
        if (this.config.inTeams) {
            try {
                this.token = await teams.authentication.getAuthToken();
                this.user = decodeUser(this.token);
                return this.token;
            } catch (error) {
                throw new AnalyticsHubAccessDeniedError(error instanceof Error ? error.message : undefined);
            }
        }

        const account = this.account();
        if (!account) throw new Error("Sign in before calling the Analytics Hub API.");
        let result: AuthenticationResult;
        try {
            // MSAL serves cached tokens until they near expiry; forceRefresh picks up newly granted roles.
            result = await this.msal.acquireTokenSilent({ account, scopes: [this.config.apiScope], forceRefresh: options?.forceRefresh === true });
        } catch (error) {
            if (error instanceof InteractionRequiredAuthError) {
                await this.msal.acquireTokenRedirect({ account, scopes: [this.config.apiScope] });
                return new Promise<string>(() => undefined);
            }
            throw error;
        }
        this.token = result.accessToken;
        this.user = userFromAccount(result.account, result.accessToken);
        return result.accessToken;
    }

    getUser(): AnalyticsHubUser | null {
        return this.user ?? (this.account() ? userFromAccount(this.account()!) : null);
    }

    private async ensureInitialised(): Promise<void> {
        this.init ??= (async () => {
            await this.msal.initialize();
            const result = await this.msal.handleRedirectPromise();
            if (result?.account)
                this.msal.setActiveAccount(result.account);
            if (result?.accessToken) {
                this.token = result.accessToken;
                this.user = userFromAccount(result.account, result.accessToken);
            }
        })();
        return this.init;
    }

    private account(): AccountInfo | null {
        return this.msal.getActiveAccount() ?? this.msal.getAllAccounts()[0] ?? null;
    }

    private session(account = this.account()): OpaqueSession {
        this.user ??= account ? userFromAccount(account, this.token) : decodeUser(this.token);
        return {
            user: { id: this.user?.id ?? this.user?.username ?? "azure-user", email: this.user?.email ?? this.user?.username ?? "" },
            isAuthenticated: true,
            isAnonymous: false,
        } as OpaqueSession;
    }

    private async completeTeamsPopup(): Promise<void> {
        try {
            const account = this.account();
            if (!account) await this.msal.loginRedirect({ scopes: [this.config.apiScope] });
            await teams.app.initialize();
            teams.authentication.notifySuccess();
        } catch (error) {
            teams.authentication.notifyFailure(error instanceof Error ? error.message : String(error));
        }
    }
}

function userFromAccount(account: AccountInfo, token?: string): AnalyticsHubUser {
    const fromToken = decodeUser(token);
    return {
        id: account.homeAccountId,
        name: account.name ?? fromToken?.name,
        email: account.username,
        username: account.username,
        roles: fromToken?.roles ?? [],
    };
}

function decodeUser(token: string | undefined): AnalyticsHubUser | null {
    const claims = decodeJwt(token);
    if (!claims) return null;
    const roles = Array.isArray(claims.roles) ? claims.roles.filter((role): role is string => typeof role === "string") : [];
    return {
        id: typeof claims.oid === "string" ? claims.oid : undefined,
        name: typeof claims.name === "string" ? claims.name : undefined,
        email: typeof claims.preferred_username === "string" ? claims.preferred_username : undefined,
        username: typeof claims.preferred_username === "string" ? claims.preferred_username : undefined,
        roles,
    };
}

function decodeJwt(token: string | undefined): Record<string, unknown> | null {
    const payload = token?.split(".")[1];
    if (!payload) return null;
    try {
        const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
        return JSON.parse(json) as Record<string, unknown>;
    } catch {
        return null;
    }
}
