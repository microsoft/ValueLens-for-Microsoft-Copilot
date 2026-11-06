//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OpaqueSession } from "@microsoft/rayfin-auth";

import { AnalyticsHubAccessDeniedError, type AnalyticsHubUser, type IAuthService } from "@/services/rayfin-auth.service";
import { ACCESS_DENIED_EVENT, type AccessDeniedReason } from "@/lib/access";
import { AuthContext, type AuthContextValue } from "./auth.context";

interface AuthProviderProps {
    children: ReactNode;
    rayfinAuthService: IAuthService;
}

/** AuthProvider — runs the current host's passive auth handoff once on mount. */
export function AuthProvider({ children, rayfinAuthService }: AuthProviderProps) {
    const [session, setSession] = useState<OpaqueSession | null>(null);
    const [user, setUser] = useState<AnalyticsHubUser | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [accessDenied, setAccessDenied] = useState(false);
    const [accessDeniedReason, setAccessDeniedReason] = useState<AccessDeniedReason>();
    const [isSigningIn, setIsSigningIn] = useState(false);
    const [signInError, setSignInError] = useState<Error | null>(null);
    const signInRequestRef = useRef<Promise<OpaqueSession> | null>(null);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                const result = await rayfinAuthService.initEmbeddedAuth();
                if (cancelled) return;
                setSession(result);
                setUser(rayfinAuthService.getUser?.() ?? null);
            } catch (err) {
                if (cancelled) return;
                if (err instanceof AnalyticsHubAccessDeniedError) {
                    setAccessDenied(true);
                    setSession(null);
                } else {
                    setError(err instanceof Error ? err : new Error(String(err)));
                }
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [rayfinAuthService]);

    useEffect(() => {
        const onAccessDenied = (event: Event) => {
            const reason = (event as CustomEvent<{ reason?: string } | undefined>).detail?.reason;
            setAccessDeniedReason(reason === "NotAViewer" || reason === "PowerBIAccessDenied" ? reason : undefined);
            setAccessDenied(true);
            setSession(null);
        };
        window.addEventListener(ACCESS_DENIED_EVENT, onAccessDenied);
        return () => window.removeEventListener(ACCESS_DENIED_EVENT, onAccessDenied);
    }, []);

    const signIn = useCallback(() => {
        if (signInRequestRef.current)
            return;

        let request: Promise<OpaqueSession>;
        try {
            request = rayfinAuthService.signIn();
        } catch (err) {
            setSignInError(err instanceof Error ? err : new Error(String(err)));
            return;
        }

        signInRequestRef.current = request;
        setIsSigningIn(true);
        setSignInError(null);
        setAccessDenied(false);

        void request
            .then((value) => {
                setSession(value);
                setUser(rayfinAuthService.getUser?.() ?? null);
            })
            .catch((err: unknown) => {
                if (err instanceof AnalyticsHubAccessDeniedError)
                    setAccessDenied(true);
                setSignInError(err instanceof Error ? err : new Error(String(err)));
            })
            .finally(() => {
                if (signInRequestRef.current === request) {
                    signInRequestRef.current = null;
                    setIsSigningIn(false);
                }
            });
    }, [rayfinAuthService]);

    const value = useMemo<AuthContextValue>(
        () => ({
            session,
            user,
            isAuthenticated: session?.isAuthenticated ?? false,
            isLoading,
            error,
            signIn,
            isSigningIn,
            signInError,
            accessDenied,
            accessDeniedReason,
        }),
        [session, user, isLoading, error, signIn, isSigningIn, signInError, accessDenied, accessDeniedReason],
    );

    if (error)
        throw error;

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}