//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { FabricApiProxyError, FabricNetworkProxyError } from "@microsoft/fabric-app-data";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpFabricProxy } from "@/lib/http-fabric-proxy";
import { ACCESS_DENIED_EVENT } from "@/lib/access";

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

    it("throws FabricApiProxyError for API failures after one forced token refresh", async () => {
        const fetchMock = vi.fn().mockImplementation(async () => new Response("no role", { status: 403 }));
        vi.stubGlobal("fetch", fetchMock);
        const getToken = vi.fn().mockResolvedValue("token");
        const proxy = new HttpFabricProxy(getToken);

        await expect(proxy.semanticModel.executeDaxJson("ws", "model", "EVALUATE ROW()"))
            .rejects.toBeInstanceOf(FabricApiProxyError);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(getToken).toHaveBeenLastCalledWith({ forceRefresh: true });
    });

    it("reports why access was denied so the app can show the request access card", async () => {
        const body = JSON.stringify({ error: { code: "NotAViewer", message: "no" } });
        vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(body, { status: 403 })));
        const listener = vi.fn();
        window.addEventListener(ACCESS_DENIED_EVENT, listener);
        try {
            await expect(new HttpFabricProxy(async () => "token").semanticModel.executeDaxJson("ws", "model", "EVALUATE ROW()"))
                .rejects.toBeInstanceOf(FabricApiProxyError);
        } finally {
            window.removeEventListener(ACCESS_DENIED_EVENT, listener);
        }
        expect(listener).toHaveBeenCalledOnce();
        expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ reason: "NotAViewer" });
    });

    it("retries a 403 with a refreshed token, picking up a newly granted role", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response("no role", { status: 403 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        const getToken = vi.fn(async (options?: { forceRefresh?: boolean }) => options?.forceRefresh ? "fresh" : "stale");
        const proxy = new HttpFabricProxy(getToken);

        const result = await proxy.semanticModel.executeDaxJson("ws", "model", "EVALUATE ROW()");

        expect(result.data).toEqual({ results: [] });
        expect(fetchMock.mock.calls[1][1].headers.authorization).toBe("Bearer fresh");
    });

    it("throws FabricNetworkProxyError for fetch failures", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
        const proxy = new HttpFabricProxy(async () => "token");

        await expect(proxy.semanticModel.executeDaxJson("ws", "model", "EVALUATE ROW()"))
            .rejects.toBeInstanceOf(FabricNetworkProxyError);
    });
});