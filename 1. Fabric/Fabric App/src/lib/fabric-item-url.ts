//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { runtimeConfig } from "@/lib/runtime-config";

export interface FabricItemLinkConfig {
    portalUrl?: string;
    workspaceId?: string;
    itemId?: string;
    tenantId?: string;
    /** The hostname the app is served from. */
    hostname?: string;
    /** Link shape to build. */
    host?: "fabric" | "azure";
}

const MSIT_HOSTING = /\.msit\.fabricapps\.net$/i;
const MSIT_PORTAL = "https://msit.fabric.microsoft.com";

function fromRuntime(): FabricItemLinkConfig {
    const config = runtimeConfig();
    if (config.host === "azure") {
        const model = config.semanticModels.vl ?? Object.values(config.semanticModels)[0];
        return { host: "azure", workspaceId: model?.workspaceId, itemId: model?.itemId };
    }
    const { portalUrl, workspaceId, itemId, tenantId } = config.rayfin;
    return {
        host: "fabric",
        portalUrl,
        workspaceId,
        itemId,
        tenantId,
        hostname: typeof window === "undefined" ? undefined : window.location.hostname,
    };
}

/** The host-aware link for the app's primary item. */
export function fabricItemUrl(config: FabricItemLinkConfig = fromRuntime()): string | null {
    const { portalUrl, workspaceId, itemId, tenantId, hostname, host = "fabric" } = config;
    if (!workspaceId || !itemId)
        return null;

    if (host === "azure")
        return `https://app.powerbi.com/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(itemId)}/details`;

    if (!portalUrl)
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