//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

const configs = vi.hoisted(() => [] as unknown[]);

vi.mock("@microsoft/fabric-app-data", () => ({
    FabricClient: class {
        constructor(config: unknown) {
            configs.push(config);
        }
    },
}));
vi.mock("@microsoft/fabric-app-data-proxy", () => ({ EmbedFabricApiProxy: class {} }));
vi.mock("@microsoft/fabric-app-data-embed-client", () => ({ SemanticModelMessageClient: class {} }));
vi.mock("@/lib/runtime-config", () => ({ runtimeConfig: () => ({ host: "fabric", semanticModels: {} }) }));

import { getFabricClient, QUERY_CACHE_ENTRIES } from "./fabric-client";

describe("getFabricClient", () => {
    it("keeps enough results for every query in the app, so a page visited earlier opens from the cache", () => {
        getFabricClient();
        expect(configs).toHaveLength(1);
        expect(configs[0]).toMatchObject({ cache: { maxEntries: QUERY_CACHE_ENTRIES } });
        expect(QUERY_CACHE_ENTRIES).toBeGreaterThanOrEqual(500);
    });

    it("makes one client for the session", () => {
        expect(getFabricClient()).toBe(getFabricClient());
        expect(configs).toHaveLength(1);
    });
});
