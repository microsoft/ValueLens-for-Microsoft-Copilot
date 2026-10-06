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
 * Returns the pre-configured FabricClient singleton.
 *
 * Fabric uses the iframe postMessage proxy. Azure uses the same SDK over the
 * legacy executeQueries JSON protocol, proxied by the same-origin API.
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