//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    host: "fabric" as "fabric" | "azure",
    configs: [] as Record<string, unknown>[],
}));

vi.mock("@microsoft/fabric-app-data", () => ({
    FabricClient: class {
        constructor(config: Record<string, unknown>) {
            state.configs.push(config);
        }
    },
}));
vi.mock("@microsoft/fabric-app-data-proxy", () => ({ EmbedFabricApiProxy: class {} }));
vi.mock("@microsoft/fabric-app-data-embed-client", () => ({ SemanticModelMessageClient: class {} }));
vi.mock("@/lib/http-fabric-proxy", () => ({ HttpFabricProxy: class {} }));
vi.mock("@/services/rayfin-auth.service", () => ({ getAccessToken: () => Promise.resolve("token") }));
vi.mock("@/lib/runtime-config", () => ({ runtimeConfig: () => ({ host: state.host, semanticModels: {} }) }));

/** A fresh copy of the module, so each test makes its own client for the host it names. */
async function load(host: "fabric" | "azure") {
    state.host = host;
    vi.resetModules();
    const client = await import("./fabric-client");
    const { EmbedFabricApiProxy } = await import("@microsoft/fabric-app-data-proxy");
    const { HttpFabricProxy } = await import("@/lib/http-fabric-proxy");
    return { ...client, EmbedFabricApiProxy, HttpFabricProxy };
}

describe("getFabricClient", () => {
    beforeEach(() => {
        state.configs.length = 0;
    });

    it.each(["fabric", "azure"] as const)("keeps QUERY_CACHE_ENTRIES results for the visit on %s", async (host) => {
        const { getFabricClient, QUERY_CACHE_ENTRIES } = await load(host);

        getFabricClient();

        expect(state.configs).toHaveLength(1);
        expect(state.configs[0]).toMatchObject({ cache: { maxEntries: QUERY_CACHE_ENTRIES } });
    });

    it("keeps far more results than the SDK's default of 64, each for an hour", async () => {
        const { QUERY_CACHE_ENTRIES, QUERY_CACHE_MAX_AGE_MS } = await load("fabric");

        expect(QUERY_CACHE_ENTRIES).toBeGreaterThanOrEqual(500);
        expect(QUERY_CACHE_MAX_AGE_MS).toBe(60 * 60 * 1000);
    });

    it("asks Fabric through the iframe message proxy in the SDK's default protocol", async () => {
        const { getFabricClient, EmbedFabricApiProxy } = await load("fabric");

        getFabricClient();

        expect(state.configs[0].proxy).toBeInstanceOf(EmbedFabricApiProxy);
        expect(state.configs[0].daxProtocol).toBeUndefined();
    });

    it("asks Azure through the same-origin API in the JSON protocol", async () => {
        const { getFabricClient, HttpFabricProxy } = await load("azure");

        getFabricClient();

        expect(state.configs[0].proxy).toBeInstanceOf(HttpFabricProxy);
        expect(state.configs[0].daxProtocol).toBe("json");
    });

    it("makes one client for the visit", async () => {
        const { getFabricClient } = await load("fabric");

        expect(getFabricClient()).toBe(getFabricClient());
        expect(state.configs).toHaveLength(1);
    });
});
