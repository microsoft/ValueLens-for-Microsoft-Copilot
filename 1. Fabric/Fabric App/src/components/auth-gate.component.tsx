//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { type ReactNode } from "react";
import { isRunningInFabric } from "@microsoft/fabric-app-data-embed-client";

import { useAuth } from "@/hooks/auth.context";
import { fabricItemUrl } from "@/lib/fabric-item-url";
import { runtimeConfig } from "@/lib/runtime-config";

interface AuthGateProps {
    children: ReactNode;
    /** Whether Fabric hosts the app in its iframe. Defaults to checking the window. */
    embedded?: boolean;
    /** The app's Fabric item link. Defaults to the one the build's env describes. */
    fabricLink?: string | null;
}

/** Host-aware auth gate. Fabric keeps the brokered iframe path; Azure signs in directly. */
export function AuthGate({
    children,
    embedded = isRunningInFabric(),
    fabricLink = fabricItemUrl(),
}: AuthGateProps) {
    const host = runtimeConfig().host;
    const {
        isLoading,
        isAuthenticated,
        signIn,
        isSigningIn,
        signInError,
        accessDenied,
    } = useAuth();

    if (host === "fabric" && !embedded && fabricLink) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background p-400">
                <div className="w-full max-w-md rounded-xl border border-border bg-card p-800 text-center shadow-8">
                    <h1 className="mb-200 text-500 font-semibold leading-500 text-card-foreground">
                        Open Analytics Hub in Fabric
                    </h1>
                    <p className="mb-600 text-300 leading-300 text-muted-foreground">
                        This address only hosts the app. Its data loads through Fabric, so open it from its Fabric item.
                    </p>
                    <a
                        href={fabricLink}
                        className="inline-block rounded-lg bg-primary px-400 py-200 text-300 font-semibold text-primary-foreground hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                        Open in Fabric
                    </a>
                    <p className="mt-400 text-[length:var(--text-200)] leading-200 text-muted-foreground">
                        Bookmark or share that page to come straight back.
                    </p>
                </div>
            </div>
        );
    }

    if (isLoading) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background">
                <div className="text-sm text-muted-foreground">
                    Connecting to {host === "azure" ? "Analytics Hub" : "Fabric"}…
                </div>
            </div>
        );
    }

    if (accessDenied) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background p-400">
                <div role="alert" className="w-full max-w-md rounded-xl border border-border bg-card p-800 text-center shadow-8">
                    <h1 className="mb-200 text-500 font-semibold leading-500 text-card-foreground">
                        You don't have access
                    </h1>
                    <p className="text-300 leading-300 text-muted-foreground">
                        Ask your admin to add you to Analytics Hub users.
                    </p>
                </div>
            </div>
        );
    }

    if (!isAuthenticated) {
        const signInLabel = host === "azure" ? "Sign in with Microsoft" : "Sign in with Fabric";
        return (
            <div className="flex min-h-screen items-center justify-center bg-background p-400">
                <div className="w-full max-w-md rounded-xl border border-border bg-card p-800 text-center shadow-8">
                    <h1 className="mb-200 text-500 font-semibold leading-500 text-card-foreground">
                        Sign in to open this app
                    </h1>
                    <p className="mb-600 text-300 leading-300 text-muted-foreground">
                        {host === "azure"
                            ? "Use your Microsoft account to access Analytics Hub."
                            : "Use your Fabric account to access this app and its connected semantic models."}
                    </p>
                    <button
                        type="button"
                        onClick={signIn}
                        disabled={isSigningIn}
                        aria-busy={isSigningIn}
                        className="rounded-lg bg-primary px-400 py-200 text-300 font-semibold text-primary-foreground hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {isSigningIn ? "Signing in…" : signInLabel}
                    </button>
                    {signInError && (
                        <p role="alert" className="mt-400 text-300 leading-300 text-destructive">
                            We couldn't sign you in: {signInError.message} Please try again and allow pop-ups for this site.
                        </p>
                    )}
                </div>
            </div>
        );
    }

    return <>{children}</>;
}