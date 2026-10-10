//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OpaqueSession } from "@microsoft/rayfin-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthGate } from "@/components/auth-gate.component";
import { AuthProvider } from "@/hooks/use-auth";
import { AnalyticsHubAccessDeniedError, type IAuthService } from "@/services/rayfin-auth.service";

const runtime = vi.hoisted(() => ({
    host: "fabric" as "fabric" | "azure",
    access: undefined as { groupId: string; groupName?: string; contact?: string; requestUrl?: string } | undefined,
}));

vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({ host: runtime.host, rayfin: {}, semanticModels: {}, access: runtime.access }),
}));

const authenticatedSession: OpaqueSession = {
    user: {
        id: "user-id",
        email: "user@example.com",
    },
    isAuthenticated: true,
    isAnonymous: false,
};

function createAuthService(
    overrides: Partial<IAuthService> = {},
): IAuthService {
    return {
        initEmbeddedAuth: vi.fn().mockResolvedValue(null),
        signIn: vi.fn().mockResolvedValue(authenticatedSession),
        getAccessToken: vi.fn().mockResolvedValue("token"),
        ...overrides,
    };
}

function renderAuthGate(
    authService: IAuthService,
    host: { embedded?: boolean; fabricLink?: string | null } = { embedded: false, fabricLink: null },
) {
    render(
        <AuthProvider rayfinAuthService={authService}>
            <AuthGate {...host}>
                <div>Authenticated app</div>
            </AuthGate>
        </AuthProvider>,
    );
}

const fabricLink = "https://app.fabric.microsoft.com/groups/ws-1/appbackends/item-1?ctid=tenant-1";

describe("AuthGate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        runtime.host = "fabric";
        runtime.access = undefined;
    });

    it("sends a visitor on the hosting address to the app's Fabric item instead of signing in", async () => {
        const authService = createAuthService({
            initEmbeddedAuth: vi.fn().mockResolvedValue(authenticatedSession),
        });
        renderAuthGate(authService, { embedded: false, fabricLink });

        expect(screen.getByRole("heading", { name: "Open Analytics Hub in Fabric" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Open in Fabric" })).toHaveAttribute("href", fabricLink);
        await waitFor(() => expect(authService.initEmbeddedAuth).toHaveBeenCalledOnce());
        expect(screen.queryByText("Authenticated app")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Sign in with Fabric" })).not.toBeInTheDocument();
        expect(authService.signIn).not.toHaveBeenCalled();
    });

    it("signs in inside Fabric when the embedded handoff has no session", async () => {
        const authService = createAuthService();
        renderAuthGate(authService, { embedded: true, fabricLink });

        fireEvent.click(await screen.findByRole("button", { name: "Sign in with Fabric" }));

        expect(authService.signIn).toHaveBeenCalledOnce();
        expect(await screen.findByText("Authenticated app")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Open in Fabric" })).not.toBeInTheDocument();
    });

    it("signs in from the standalone action and renders the app", async () => {
        const authService = createAuthService();
        renderAuthGate(authService);

        const signInButton = await screen.findByRole("button", {
            name: "Sign in with Fabric",
        });
        fireEvent.click(signInButton);

        expect(authService.signIn).toHaveBeenCalledOnce();
        expect(await screen.findByText("Authenticated app")).toBeInTheDocument();
    });

    it("shows an actionable standalone sign-in error without tearing down the auth gate", async () => {
        const authService = createAuthService({
            signIn: vi.fn().mockRejectedValue(new Error("The broker tab was blocked.")),
        });
        renderAuthGate(authService);

        fireEvent.click(await screen.findByRole("button", {
            name: "Sign in with Fabric",
        }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("The broker tab was blocked.");
        expect(alert).toHaveTextContent("allow pop-ups for this site");
        expect(screen.getByRole("button", {
            name: "Sign in with Fabric",
        })).toBeEnabled();
    });

    it("disables the action and prevents duplicate requests while sign-in is pending", async () => {
        let resolveSignIn!: (session: OpaqueSession) => void;
        const signInRequest = new Promise<OpaqueSession>((resolve) => {
            resolveSignIn = resolve;
        });
        const signIn = vi.fn().mockReturnValue(signInRequest);
        const authService = createAuthService({ signIn });
        renderAuthGate(authService);

        const signInButton = await screen.findByRole("button", {
            name: "Sign in with Fabric",
        });
        fireEvent.click(signInButton);
        fireEvent.click(signInButton);

        expect(signIn).toHaveBeenCalledOnce();
        expect(screen.getByRole("button", {
            name: "Signing in…",
        })).toBeDisabled();

        resolveSignIn(authenticatedSession);
        expect(await screen.findByText("Authenticated app")).toBeInTheDocument();
    });

    it("preserves the embedded auth flow without invoking interactive sign-in", async () => {
        const initEmbeddedAuth = vi.fn().mockResolvedValue(authenticatedSession);
        const signIn = vi.fn();
        const authService = createAuthService({ initEmbeddedAuth, signIn });
        renderAuthGate(authService);

        expect(await screen.findByText("Authenticated app")).toBeInTheDocument();
        await waitFor(() => expect(initEmbeddedAuth).toHaveBeenCalledOnce());
        expect(signIn).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", {
            name: "Sign in with Fabric",
        })).not.toBeInTheDocument();
    });

    it("does not redirect Azure-hosted users to Fabric", async () => {
        runtime.host = "azure";
        const authService = createAuthService();
        renderAuthGate(authService, { embedded: false, fabricLink });

        expect(await screen.findByRole("button", { name: "Sign in with Microsoft" })).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Open in Fabric" })).not.toBeInTheDocument();
    });

    it("shows the Azure access denied message", async () => {
        runtime.host = "azure";
        const authService = createAuthService({
            initEmbeddedAuth: vi.fn().mockRejectedValue(new AnalyticsHubAccessDeniedError()),
        });
        renderAuthGate(authService);

        expect(await screen.findByRole("alert")).toHaveTextContent("Ask your admin to add you to Analytics Hub users");
    });

    it("offers request access and an email to the install's contact", async () => {
        runtime.host = "azure";
        runtime.access = {
            groupId: "group-1",
            groupName: "Analytics Hub Viewers",
            contact: "admin@example.com",
            requestUrl: "https://example.com/request",
        };
        const authService = createAuthService({
            initEmbeddedAuth: vi.fn().mockRejectedValue(new AnalyticsHubAccessDeniedError()),
        });
        renderAuthGate(authService);

        expect(await screen.findByRole("alert")).toHaveTextContent("Ask to join Analytics Hub Viewers");
        expect(screen.getByRole("link", { name: "Request access" })).toHaveAttribute("href", "https://example.com/request");
        const email = screen.getByRole("link", { name: "Email admin@example.com" });
        expect(email.getAttribute("href")).toMatch(/^mailto:admin%40example\.com\?subject=Access%20to%20Analytics%20Hub/);
    });

});
