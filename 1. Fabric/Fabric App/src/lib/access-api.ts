//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { getAccessToken } from "@/services/rayfin-auth.service";

export interface AccessPrincipal {
    id: string;
    name: string;
    email?: string;
    kind: "user" | "group";
}

/** What `/api/access` tells the signed-in user about the viewer group. Members and owners are only sent to people who can manage it. */
export interface AccessState {
    group: { id: string; name: string } | null;
    canManage: boolean;
    members?: AccessPrincipal[];
    owners?: AccessPrincipal[];
}

export function loadAccess(): Promise<AccessState> {
    return call<AccessState>("/api/access");
}

/** Adds a person (email address) or a group (exact name) to the viewer group. */
export function addViewer(name: string): Promise<AccessPrincipal> {
    return call<AccessPrincipal>("/api/access/members", "POST", { name });
}

export function removeViewer(id: string): Promise<void> {
    return call<void>(`/api/access/members/${encodeURIComponent(id)}`, "DELETE");
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const send = async (forceRefresh: boolean) => {
        const token = await getAccessToken(forceRefresh ? { forceRefresh } : undefined);
        return fetch(path, {
            method,
            cache: "no-store",
            headers: {
                authorization: `Bearer ${token}`,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    };
    let response = await send(false);
    // A cached token can predate a role or group change, so retry once with a fresh one.
    if (response.status === 401 || response.status === 403)
        response = await send(true);
    if (!response.ok) {
        let message = `Access API returned ${response.status}.`;
        try {
            const error = (await response.json() as { error?: { message?: unknown } }).error;
            if (typeof error?.message === "string") message = error.message;
        } catch { /* not JSON */ }
        throw new Error(message);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
}
