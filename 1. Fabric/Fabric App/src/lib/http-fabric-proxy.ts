//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import {
    FabricApiProxyError,
    FabricGenericProxyError,
    FabricNetworkProxyError,
    type IFabricApiProxy,
} from "@microsoft/fabric-app-data";

export type TokenFactory = (options?: { forceRefresh?: boolean }) => Promise<string>;

/** Fabric SDK proxy that sends DAX JSON queries to the same-origin Azure API. */
export class HttpFabricProxy implements IFabricApiProxy {
    private readonly sessionId = crypto.randomUUID();

    constructor(private readonly getToken: TokenFactory) {}

    readonly semanticModel = {
        executeDax: async () => {
            throw new FabricGenericProxyError({ message: "Arrow DAX is not supported on Azure.", sessionId: this.sessionId });
        },
        executeDaxJson: async (workspaceId: string, itemId: string, query: string) => {
            const requestId = crypto.randomUUID();
            let response = await this.post(requestId, workspaceId, itemId, query, false);
            // A cached token can predate a role assignment, so retry once with a fresh one.
            if (response.status === 401 || response.status === 403)
                response = await this.post(requestId, workspaceId, itemId, query, true);

            const serviceRequestId = response.headers.get("request-id")
                ?? response.headers.get("x-ms-request-id")
                ?? response.headers.get("x-ms-activity-id")
                ?? requestId;
            if (!response.ok) {
                if (response.status === 401 || response.status === 403)
                    window.dispatchEvent(new CustomEvent("analytics-hub-access-denied"));
                throw new FabricApiProxyError({
                    status: response.status,
                    requestId: serviceRequestId,
                    sessionId: this.sessionId,
                    body: await response.text(),
                });
            }

            return { data: await response.json(), requestId: serviceRequestId };
        },
    };

    private async post(requestId: string, workspaceId: string, itemId: string, query: string, forceRefresh: boolean): Promise<Response> {
        let token: string;
        try {
            token = await this.getToken(forceRefresh ? { forceRefresh } : undefined);
        } catch (error) {
            throw new FabricGenericProxyError({ message: "Couldn't get an access token.", requestId, sessionId: this.sessionId, cause: error });
        }

        try {
            return await fetch("/api/query", {
                method: "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "content-type": "application/json",
                    "x-ms-client-request-id": requestId,
                },
                body: JSON.stringify({ workspaceId, itemId, query }),
            });
        } catch (error) {
            throw new FabricNetworkProxyError({
                requestId,
                sessionId: this.sessionId,
                message: error instanceof Error ? error.message : "The query couldn't reach the Analytics Hub API.",
                cause: error,
            });
        }
    }

    readonly lakehouse = {
        executeSql: async () => {
            throw new FabricGenericProxyError({ message: "Lakehouse queries are not supported on Azure.", sessionId: this.sessionId });
        },
    };

    readonly warehouse = {
        executeSql: async () => {
            throw new FabricGenericProxyError({ message: "Warehouse queries are not supported on Azure.", sessionId: this.sessionId });
        },
    };
}