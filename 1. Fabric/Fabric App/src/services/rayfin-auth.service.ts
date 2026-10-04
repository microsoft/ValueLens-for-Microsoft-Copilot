//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import RayfinClient from "@microsoft/rayfin-client";
import type { OpaqueSession } from "@microsoft/rayfin-auth";
import {
    ensureSignedInWithFabric,
    initEmbeddedAuth as sdkInitEmbeddedAuth,
    type FabricAuthOptions,
} from "@microsoft/rayfin-auth-provider-fabric";
import { getRayfinClient } from "@/lib/rayfin-client";
import { runtimeConfig } from "@/lib/runtime-config";

export interface IAuthService {
    /**
     * Try to acquire a session via the embedded (iframe) Fabric flow
     * without any UI. Returns `null` when not running inside a Fabric
     * iframe — the {@link AuthGate} renders the "not embedded" notice in
     * that case.
     */
    initEmbeddedAuth(): Promise<OpaqueSession | null>;
    /**
     * Start the Fabric brokered sign-in waterfall.
     *
     * Call this directly from a synchronous user gesture because the SDK may
     * open a broker tab.
     */
    signIn(): Promise<OpaqueSession>;
}

/**
 * Construct the auth service used by the app from the Rayfin and Fabric
 * settings: the deployed `rayfin.config.json`, or the build's `VITE_*` vars
 * when there isn't one (see {@link runtimeConfig}).
 *
 * Called from `root.tsx` before React mounts. If any required value is
 * missing this throws synchronously and the SPA never boots. That is
 * intentional: a Fabric-embedded app with no usable Rayfin or Fabric config
 * has nothing to render.
 *
 * Required values (build-time var in brackets):
 * - `apiUrl` (`VITE_RAYFIN_API_URL`) — Rayfin API base URL (e.g. `http://localhost:5168`)
 * - `publishableKey` (`VITE_RAYFIN_PUBLISHABLE_KEY`) — Rayfin publishable key (`pk-...`)
 * - `workspaceId` (`VITE_FABRIC_WORKSPACE_ID`) — Fabric workspace ID
 * - `itemId` (`VITE_FABRIC_ITEM_ID`) — Fabric item ID
 * - `portalUrl` (`VITE_FABRIC_PORTAL_URL`) — Fabric portal base URL
 */
export function bootstrapAuth(): IAuthService {
    const client = getRayfinClient();

    const { workspaceId, itemId: projectId, portalUrl: fabricPortalUrl } = runtimeConfig().rayfin;

    if (
        !workspaceId ||
        !projectId ||
        !fabricPortalUrl
    ) {
        throw new Error(`Missing required env vars for Fabric auth - run 'npx rayfin up'`);
    }

    const fabricOptions: FabricAuthOptions = {
        workspaceId,
        projectId,
        fabricPortalUrl,
        returnOrigin: window.location.origin,
    };

    return new RayfinAuthService(client, fabricOptions);
}

/**
 * Auth service that wraps the Fabric brokered authentication SDK
 * (`@microsoft/rayfin-auth-provider-fabric`).
 */
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
}