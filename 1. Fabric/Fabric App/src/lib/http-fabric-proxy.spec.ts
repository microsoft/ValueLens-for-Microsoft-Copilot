//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { FabricApiProxyError, FabricNetworkProxyError } from "@microsoft/fabric-app-data";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpFabricProxy } from "@/lib/http-fabric-proxy";

afterEach(() => vi.unstubAllGlobals());

describe("HttpFabricProxy", () => {
    it("posts DAX to the same-origin API and returns the raw JSON body", async () => {
        const body = { results: [{ tables: [{ rows: [{ "[Measure]": 1 }] }] }] };
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
            status: 200,
            headers: { "request-id": "server-request" },
        }));
        vi.stubGlobal("fetch", fetchMock);

        const proxy = new HttpFabricProxy(async () => "token");
        const result = await proxy.semanticModel.executeDaxJson("ws", "model", "EVALUATE ROW()");

        expect(result).toEqual({ data: body, requestId: "server-request" });
        expect(fetchMock).toHaveBeenCalledWith("/api/query", expect.objectContaining({
            method: "POST",
            headers: expect.objectContaining({ authorization: "Bearer token" }),
            body: JSON.stringify({ workspaceId: "ws", itemId: "model", query: "EVALUATE ROW()" }),
        }));
    });

    it("throws FabricApiProxyError for API failures", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no role", { status: 403 })));
        const proxy = new HttpFabricProxy(async () => "token");

        await expect(proxy.semanticModel.executeDaxJson("ws", "model", "EVALUATE ROW()"))
            .rejects.toBeInstanceOf(FabricApiProxyError);
    });

    it("throws FabricNetworkProxyError for fetch failures", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
        const proxy = new HttpFabricProxy(async () => "token");

        await expect(proxy.semanticModel.executeDaxJson("ws", "model", "EVALUATE ROW()"))
            .rejects.toBeInstanceOf(FabricNetworkProxyError);
    });
});