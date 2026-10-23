//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ inTeams: true }));

/** The TeamsJS calls the tab makes in its host: Teams, Outlook or the Microsoft 365 app. */
const host = vi.hoisted(() => ({
    initialize: vi.fn<() => Promise<void>>(),
    getAuthToken: vi.fn<(request?: { silent?: boolean }) => Promise<string>>(),
    authenticate: vi.fn<(params: { url: string }) => Promise<string>>(),
    notifySuccess: vi.fn(),
    notifyFailure: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({
        host: "azure",
        rayfin: {},
        semanticModels: {},
        azure: { tenantId: "tenant", clientId: "client", apiScope: "api://host/client/access_as_user", inTeams: runtime.inTeams },
    }),
}));

vi.mock("@microsoft/teams-js", () => ({
    app: { initialize: host.initialize },
    authentication: {
        getAuthToken: host.getAuthToken,
        authenticate: host.authenticate,
        notifySuccess: host.notifySuccess,
        notifyFailure: host.notifyFailure,
    },
}));

// MSAL's cache, for a browser outside a host. It starts with no account, so only the host can sign the tab in.
const msal = vi.hoisted(() => ({
    account: null as { homeAccountId: string; username: string; name?: string } | null,
    acquireTokenSilent: vi.fn<(request: { forceRefresh?: boolean }) => Promise<{ accessToken: string; account: unknown }>>(),
}));

vi.mock("@azure/msal-browser", () => ({
    InteractionRequiredAuthError: class InteractionRequiredAuthError extends Error {},
    PublicClientApplication: class {
        initialize = vi.fn().mockResolvedValue(undefined);
        handleRedirectPromise = vi.fn().mockResolvedValue(null);
        getActiveAccount = vi.fn(() => msal.account);
        getAllAccounts = vi.fn(() => (msal.account ? [msal.account] : []));
        setActiveAccount = vi.fn();
        loginRedirect = vi.fn().mockResolvedValue(undefined);
        acquireTokenSilent = msal.acquireTokenSilent;
    },
}));

import { AnalyticsHubAccessDeniedError, bootstrapAuth, getAccessToken } from "@/services/rayfin-auth.service";
import { detectTeamsHost, resetTeamsHost } from "@/lib/teams-host";

/** A token as the host hands it over. The app only reads its claims. */
function hostToken(claims: Record<string, unknown>): string {
    return `header.${btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_")}.signature`;
}

/** A host that takes its time to answer, until the test settles the promise. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

/** Lets every call made so far run up to the host. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

const ada = { oid: "user-1", name: "Ada Lovelace", preferred_username: "ada@example.com", roles: ["AnalyticsHub.User"] };

describe("Azure sign-in in a Teams, Outlook or Microsoft 365 tab", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        resetTeamsHost();
        runtime.inTeams = true;
        msal.account = null;
        host.initialize.mockResolvedValue(undefined);
        history.replaceState(null, "", "/?host=teams");
    });

    afterEach(() => {
        history.replaceState(null, "", "/");
    });

    it("signs in as the tab opens, without a click, when the host has a token", async () => {
        host.getAuthToken.mockResolvedValue(hostToken(ada));
        const auth = bootstrapAuth();

        await expect(auth.initEmbeddedAuth()).resolves.toMatchObject({
            isAuthenticated: true,
            user: { id: "user-1", email: "ada@example.com" },
        });
        expect(host.getAuthToken).toHaveBeenCalledOnce();
        expect(host.getAuthToken).toHaveBeenCalledWith({ silent: true });
        expect(host.authenticate).not.toHaveBeenCalled();
        expect(auth.getUser?.()).toMatchObject({ name: "Ada Lovelace", roles: ["AnalyticsHub.User"] });
    });

    it("falls back to the Sign in button when the host can't sign in silently", async () => {
        host.getAuthToken.mockRejectedValueOnce(new Error("resourceRequiresConsent"));
        const auth = bootstrapAuth();

        await expect(auth.initEmbeddedAuth()).resolves.toBeNull();
        expect(host.authenticate).not.toHaveBeenCalled();

        // The button asks the host again, then opens its pop-up for the prompt.
        host.getAuthToken
            .mockRejectedValueOnce(new Error("resourceRequiresConsent"))
            .mockResolvedValueOnce(hostToken(ada));
        host.authenticate.mockResolvedValueOnce("");
        await expect(auth.signIn()).resolves.toMatchObject({ isAuthenticated: true, user: { id: "user-1" } });
        expect(host.authenticate).toHaveBeenCalledOnce();
        expect(host.authenticate).toHaveBeenCalledWith({ url: `${window.location.origin}/?host=teams&auth=popup` });
    });

    it("doesn't ask for a token silently in the sign-in pop-up", async () => {
        history.replaceState(null, "", "/?host=teams&auth=popup");
        const auth = bootstrapAuth();

        await expect(auth.initEmbeddedAuth()).resolves.toBeNull();
        expect(host.getAuthToken).not.toHaveBeenCalled();
    });

    it("initialises TeamsJS once in the sign-in pop-up, reusing the call the page made at load", async () => {
        history.replaceState(null, "", "/?host=teams&auth=popup");
        await expect(detectTeamsHost()).resolves.toBe(true);
        const auth = bootstrapAuth();

        await auth.initEmbeddedAuth();

        expect(host.initialize).toHaveBeenCalledOnce();
        expect(host.notifySuccess).toHaveBeenCalledOnce();
        expect(host.notifyFailure).not.toHaveBeenCalled();
    });

    it("leaves a browser outside a host to the Microsoft sign-in button", async () => {
        runtime.inTeams = false;
        const auth = bootstrapAuth();

        await expect(auth.initEmbeddedAuth()).resolves.toBeNull();
        expect(host.getAuthToken).not.toHaveBeenCalled();
    });

    describe("API tokens", () => {
        const now = Date.UTC(2026, 9, 20, 9, 0, 0);
        /** The token's exp claim, in seconds: an hour from now. */
        const expires = now / 1000 + 60 * 60;
        /** Five minutes before the token expires, when the tab asks the host for a new one. */
        const renewal = expires * 1000 - 5 * 60 * 1000;
        const token = hostToken({ ...ada, exp: expires });

        beforeEach(() => {
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(now);
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it("reuses the token the tab signed in with, rather than ask the host for every query", async () => {
            host.getAuthToken.mockResolvedValue(token);
            const auth = bootstrapAuth();
            await auth.initEmbeddedAuth();

            // A dashboard's queries at once, then more one at a time.
            await expect(Promise.all(Array.from({ length: 20 }, () => getAccessToken()))).resolves.toEqual(Array(20).fill(token));
            for (let query = 0; query < 20; query++)
                await expect(getAccessToken()).resolves.toBe(token);

            expect(host.getAuthToken).toHaveBeenCalledOnce();
            expect(host.getAuthToken).toHaveBeenCalledWith({ silent: true });
        });

        it("reuses the token from the Sign in button", async () => {
            host.getAuthToken
                .mockRejectedValueOnce(new Error("resourceRequiresConsent"))
                .mockResolvedValueOnce(token);
            const auth = bootstrapAuth();
            await expect(auth.initEmbeddedAuth()).resolves.toBeNull();
            await auth.signIn();

            await expect(getAccessToken()).resolves.toBe(token);
            await expect(getAccessToken()).resolves.toBe(token);
            expect(host.getAuthToken).toHaveBeenCalledTimes(2);
        });

        it("asks the host once for calls that need a new token at the same time", async () => {
            const reply = deferred<string>();
            host.getAuthToken.mockReturnValueOnce(reply.promise);
            bootstrapAuth();

            const calls = [getAccessToken(), getAccessToken(), getAccessToken({ forceRefresh: true })];
            await settle();
            expect(host.getAuthToken).toHaveBeenCalledOnce();

            reply.resolve(token);
            await expect(Promise.all(calls)).resolves.toEqual([token, token, token]);
            await expect(getAccessToken()).resolves.toBe(token);
            expect(host.getAuthToken).toHaveBeenCalledOnce();
        });

        it("asks the host for a new token five minutes before the old one expires", async () => {
            const next = hostToken({ ...ada, exp: expires + 60 * 60 });
            host.getAuthToken.mockResolvedValueOnce(token).mockResolvedValueOnce(next);
            bootstrapAuth();
            await expect(getAccessToken()).resolves.toBe(token);

            vi.setSystemTime(renewal - 1);
            await expect(getAccessToken()).resolves.toBe(token);
            expect(host.getAuthToken).toHaveBeenCalledOnce();

            vi.setSystemTime(renewal);
            await expect(getAccessToken()).resolves.toBe(next);
            await expect(getAccessToken()).resolves.toBe(next);
            expect(host.getAuthToken).toHaveBeenCalledTimes(2);
        });

        it("asks the host again when an API call forces a refresh, then reuses the new token", async () => {
            host.getAuthToken
                .mockResolvedValueOnce(hostToken({ ...ada, roles: [], exp: expires }))
                .mockResolvedValueOnce(token);
            const auth = bootstrapAuth();
            await auth.initEmbeddedAuth();
            expect(auth.getUser?.()).toMatchObject({ roles: [] });

            // The API clients retry this way after a 401 or 403, which picks up a role granted since sign-in.
            await expect(getAccessToken({ forceRefresh: true })).resolves.toBe(token);
            expect(auth.getUser?.()).toMatchObject({ roles: ["AnalyticsHub.User"] });
            await expect(getAccessToken()).resolves.toBe(token);
            expect(host.getAuthToken).toHaveBeenCalledTimes(2);
        });

        it("doesn't keep a failure, so the next call asks the host again", async () => {
            const reply = deferred<string>();
            host.getAuthToken
                .mockReturnValueOnce(reply.promise)
                .mockImplementationOnce(() => {
                    throw new Error("The library has not yet been initialized");
                })
                .mockResolvedValueOnce(token);
            bootstrapAuth();

            // Every call waiting on the host hears that it failed.
            const calls = [getAccessToken(), getAccessToken()];
            await settle();
            reply.reject(new Error("Silent sign-in failed"));
            await Promise.all(calls.map((call) => expect(call).rejects.toThrow(AnalyticsHubAccessDeniedError)));
            expect(host.getAuthToken).toHaveBeenCalledOnce();

            // A host that fails straight away doesn't hold up the next call either.
            await expect(getAccessToken()).rejects.toThrow("The library has not yet been initialized");
            await expect(getAccessToken()).resolves.toBe(token);
            await expect(getAccessToken()).resolves.toBe(token);
            expect(host.getAuthToken).toHaveBeenCalledTimes(3);
        });

        it("asks the host every time if its token doesn't say when it expires", async () => {
            host.getAuthToken.mockResolvedValue(hostToken(ada));
            bootstrapAuth();

            await getAccessToken();
            await getAccessToken();
            expect(host.getAuthToken).toHaveBeenCalledTimes(2);
        });

        it("leaves tokens outside a host to MSAL, which keeps its own cache", async () => {
            runtime.inTeams = false;
            msal.account = { homeAccountId: "home-1", username: "ada@example.com", name: "Ada Lovelace" };
            msal.acquireTokenSilent.mockImplementation(async () => ({ accessToken: token, account: msal.account }));
            const auth = bootstrapAuth();

            await expect(auth.initEmbeddedAuth()).resolves.toMatchObject({ isAuthenticated: true });
            await expect(getAccessToken()).resolves.toBe(token);
            await expect(getAccessToken({ forceRefresh: true })).resolves.toBe(token);

            expect(msal.acquireTokenSilent).toHaveBeenCalledTimes(3);
            expect(msal.acquireTokenSilent).toHaveBeenNthCalledWith(2, expect.objectContaining({ forceRefresh: false }));
            expect(msal.acquireTokenSilent).toHaveBeenNthCalledWith(3, expect.objectContaining({ forceRefresh: true }));
            expect(host.getAuthToken).not.toHaveBeenCalled();
        });
    });
});
