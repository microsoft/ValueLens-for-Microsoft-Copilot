//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { SemanticModelMessageClient } from "@microsoft/fabric-app-data-embed-client";
import { FabricClient, type FabricClientConfig } from "@microsoft/fabric-app-data";
import { EmbedFabricApiProxy } from "@microsoft/fabric-app-data-proxy";
import { HttpFabricProxy } from "@/lib/http-fabric-proxy";
import { runtimeConfig } from "@/lib/runtime-config";
import { getAccessToken } from "@/services/rayfin-auth.service";

let _client: FabricClient | undefined;
let _messageClient: SemanticModelMessageClient | undefined;

/**
 * Results the SDK keeps for the visit. The app runs well over a hundred
 * distinct queries. With the SDK's default of 64, a page visited earlier would
 * already have been pushed out, and going back to it would run every query again.
 */
export const QUERY_CACHE_ENTRIES = 1000;

/**
 * Longest a cached result is reused. Older ones are fetched again, so in a tab
 * left open all day, going back to a page picks up the model's refresh within
 * the hour.
 */
export const QUERY_CACHE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Returns the pre-configured FabricClient singleton.
 *
 * Fabric uses the iframe postMessage proxy. Azure uses the same SDK over the
 * legacy executeQueries JSON protocol, proxied by the same-origin API.
 * Either way it keeps up to `QUERY_CACHE_ENTRIES` results for the visit.
 *
 * @internal Used by `useSemanticModelQuery` — prefer the hook over direct client access.
 */
export function getFabricClient(): FabricClient {
    if (!_client) {
        const config = runtimeConfig();
        const proxy = config.host === "azure"
            ? new HttpFabricProxy(getAccessToken)
            : fabricProxy();
        _client = new FabricClient({
            proxy,
            semanticModels: config.semanticModels,
            daxProtocol: config.host === "azure" ? "json" : undefined,
            cache: { maxEntries: QUERY_CACHE_ENTRIES },
        } as FabricClientConfig);
    }
    return _client;
}

/** Back-compatible alias for the query client seam. */
export const getQueryClient = getFabricClient;

function fabricProxy(): EmbedFabricApiProxy {
    if (!_messageClient)
        _messageClient = new SemanticModelMessageClient();
    return new EmbedFabricApiProxy(_messageClient);
}