//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { createContext, useContext } from "react";
import type { OpaqueSession } from "@microsoft/rayfin-auth";
import type { AnalyticsHubUser } from "@/services/rayfin-auth.service";

export interface AuthContextValue {
    /** The current auth session, or `null` if not authenticated. */
    session: OpaqueSession | null;
    /** The current signed-in user, when known. */
    user: AnalyticsHubUser | null;
    /** Convenience accessor for `session?.isAuthenticated ?? false`. */
    isAuthenticated: boolean;
    /** True while the auth handoff is in flight. */
    isLoading: boolean;
    /** Last error from the auth flow, if any. */
    error: Error | null;
    /** Start an interactive sign-in. */
    signIn: () => void;
    /** True while interactive sign-in is in flight. */
    isSigningIn: boolean;
    /** Last error from interactive sign-in, if any. */
    signInError: Error | null;
    /** True when the API rejected the user before the app could load. */
    accessDenied: boolean;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function useAuth(): AuthContextValue {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}