//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

export interface FabricItemLinkConfig {
    portalUrl?: string;
    workspaceId?: string;
    itemId?: string;
    tenantId?: string;
    /** The hostname the app is served from. */
    hostname?: string;
}

const MSIT_HOSTING = /\.msit\.fabricapps\.net$/i;
const MSIT_PORTAL = "https://msit.fabric.microsoft.com";

function fromEnv(): FabricItemLinkConfig {
    return {
        portalUrl: import.meta.env.VITE_FABRIC_PORTAL_URL,
        workspaceId: import.meta.env.VITE_FABRIC_WORKSPACE_ID,
        itemId: import.meta.env.VITE_FABRIC_ITEM_ID,
        tenantId: import.meta.env.VITE_FABRIC_TENANT_ID,
        hostname: typeof window === "undefined" ? undefined : window.location.hostname,
    };
}

/**
 * The Fabric portal link that opens this app's item, in the
 * `<portal>/groups/<workspace>/appbackends/<item>?ctid=<tenant>` form `rayfin up` prints.
 * Fabric hosts the app in an iframe there and brokers its semantic model queries, which the
 * `…fabricapps.net` hosting address can't do on its own. `null` when the build has no item IDs.
 *
 * Apps hosted under `*.msit.fabricapps.net` live on Microsoft's internal ring, so their item opens
 * on the internal portal whichever portal the build was given.
 */
export function fabricItemUrl(config: FabricItemLinkConfig = fromEnv()): string | null {
    const { portalUrl, workspaceId, itemId, tenantId, hostname } = config;
    if (!portalUrl || !workspaceId || !itemId)
        return null;

    let url: URL;
    try {
        url = new URL(hostname && MSIT_HOSTING.test(hostname) ? MSIT_PORTAL : portalUrl);
    } catch {
        return null;
    }

    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/groups/${encodeURIComponent(workspaceId)}/appbackends/${encodeURIComponent(itemId)}`;
    if (tenantId)
        url.searchParams.set("ctid", tenantId);

    return url.toString();
}
