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
import { QueryScheduler, scheduledProxy } from "@/lib/query-scheduler";
import { runtimeConfig } from "@/lib/runtime-config";
import { getAccessToken } from "@/services/rayfin-auth.service";

let _client: FabricClient | undefined;
let _scheduler: QueryScheduler | undefined;
let _messageClient: SemanticModelMessageClient | undefined;

/**
 * Results the SDK keeps for the session. The app has about 180 distinct
 * queries, and with the SDK's default of 64 a page visited earlier had already
 * been pushed out, so going back to it ran every query again.
 */
export const QUERY_CACHE_ENTRIES = 1000;

/**
 * A result the SDK has held longer than this is fetched again, so a page left
 * open doesn't keep showing figures from before the model's next refresh.
 */
export const QUERY_CACHE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Returns the pre-configured FabricClient singleton.
 *
 * Fabric uses the iframe postMessage proxy. Azure uses the same SDK over the
 * legacy executeQueries JSON protocol, proxied by the same-origin API.
 * Either way every request is paced, de-duplicated and retried when
 * throttled by the query scheduler.
 *
 * @internal Used by `useSemanticModelQuery` — prefer the hook over direct client access.
 */
export function getFabricClient(): FabricClient {
    if (!_client) {
        const config = runtimeConfig();
        const proxy = scheduledProxy(config.host === "azure"
            ? new HttpFabricProxy(getAccessToken)
            : fabricProxy(), getQueryScheduler());
        _client = new FabricClient({
            proxy,
            semanticModels: config.semanticModels,
            daxProtocol: config.host === "azure" ? "json" : undefined,
            cache: { maxEntries: QUERY_CACHE_ENTRIES },
        } as FabricClientConfig);
    }
    return _client;
}

/** The scheduler every semantic model request goes through, for watching how busy it is. */
export function getQueryScheduler(): QueryScheduler {
    _scheduler ??= new QueryScheduler();
    return _scheduler;
}

/** Back-compatible alias for the query client seam. */
export const getQueryClient = getFabricClient;

function fabricProxy(): EmbedFabricApiProxy {
    if (!_messageClient)
        _messageClient = new SemanticModelMessageClient();
    return new EmbedFabricApiProxy(_messageClient);
}