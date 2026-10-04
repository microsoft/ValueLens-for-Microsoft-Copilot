//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/fabric.generated", () => ({
    fabricConfig: {
        semanticModels: {
            vl: { workspaceId: "build-ws", itemId: "build-vl" },
        },
    },
}));

import {
    FABRIC_CONFIG_PATH,
    RuntimeConfigError,
    loadRuntimeConfig,
    loadSemanticModels,
    parseSemanticModels,
    resetRuntimeConfig,
    runtimeConfig,
} from "@/lib/runtime-config";

type Reply = { status?: number; body: string; contentType?: string } | Error;

function stubFiles(files: Record<string, Reply>) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const reply = files[String(input)] ?? { status: 404, body: "" };
        if (reply instanceof Error)
            throw reply;
        return new Response(reply.body, {
            status: reply.status ?? 200,
            headers: { "content-type": reply.contentType ?? "application/json" },
        });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

const SPA_FALLBACK: Reply = { body: "<!DOCTYPE html><html></html>", contentType: "text/html" };

const deployedRayfin = {
    apiUrl: "https://api.example.com",
    publishableKey: "pk-deployed",
    workspaceId: "ws-deployed",
    itemId: "item-deployed",
    portalUrl: "https://app.fabric.microsoft.com",
    tenantId: "tenant-deployed",
};

const deployedModels = {
    semanticModels: {
        vl: { workspaceId: "ws-deployed", itemId: "vl-deployed" },
        cc: { workspaceId: "ws-deployed", itemId: "cc-deployed" },
    },
};

beforeEach(() => resetRuntimeConfig());
afterEach(() => {
    vi.unstubAllGlobals();
    resetRuntimeConfig();
});

describe("runtimeConfig", () => {
    it("uses the build's models until the deployed config has loaded", () => {
        expect(runtimeConfig().semanticModels).toEqual({ vl: { workspaceId: "build-ws", itemId: "build-vl" } });
    });

    it("takes the Rayfin settings and models an install deployed next to the app", async () => {
        stubFiles({
            "/rayfin.config.json": { body: JSON.stringify(deployedRayfin) },
            [FABRIC_CONFIG_PATH]: { body: JSON.stringify(deployedModels) },
        });

        await loadRuntimeConfig();

        expect(runtimeConfig().rayfin).toEqual({ ...deployedRayfin, apiUrl: "https://api.example.com/" });
        expect(runtimeConfig().semanticModels).toEqual(deployedModels.semanticModels);
    });

    it("keeps the build's values when a developer deploy has no config files", async () => {
        stubFiles({ "/rayfin.config.json": SPA_FALLBACK, [FABRIC_CONFIG_PATH]: SPA_FALLBACK });

        await loadRuntimeConfig();

        expect(runtimeConfig().semanticModels).toEqual({ vl: { workspaceId: "build-ws", itemId: "build-vl" } });
    });

    it("fails rather than fall back when the models file is there but won't load", async () => {
        stubFiles({ [FABRIC_CONFIG_PATH]: { status: 500, body: "" } });

        await expect(loadRuntimeConfig()).rejects.toBeInstanceOf(RuntimeConfigError);
    });
});

describe("loadSemanticModels", () => {
    it("asks for a fresh copy so a reinstall's models show straight away", async () => {
        const fetchMock = stubFiles({ [FABRIC_CONFIG_PATH]: { body: JSON.stringify(deployedModels) } });

        await loadSemanticModels();

        expect(fetchMock).toHaveBeenCalledWith(FABRIC_CONFIG_PATH, { cache: "no-store" });
    });

    it("treats a 404 or the app's own page as no file", async () => {
        stubFiles({ [FABRIC_CONFIG_PATH]: { status: 404, body: "" } });
        await expect(loadSemanticModels()).resolves.toBeNull();

        stubFiles({ [FABRIC_CONFIG_PATH]: SPA_FALLBACK });
        await expect(loadSemanticModels()).resolves.toBeNull();

        stubFiles({ [FABRIC_CONFIG_PATH]: { body: "<html></html>", contentType: "text/plain" } });
        await expect(loadSemanticModels()).resolves.toBeNull();
    });

    it("reports a network failure, a server error or a broken file", async () => {
        stubFiles({ [FABRIC_CONFIG_PATH]: new TypeError("Failed to fetch") });
        await expect(loadSemanticModels()).rejects.toThrow(/Failed to fetch/);

        stubFiles({ [FABRIC_CONFIG_PATH]: { status: 403, body: "" } });
        await expect(loadSemanticModels()).rejects.toThrow(/403/);

        stubFiles({ [FABRIC_CONFIG_PATH]: { body: "{ not json" } });
        await expect(loadSemanticModels()).rejects.toThrow(/valid JSON/);
    });
});

describe("parseSemanticModels", () => {
    it("keeps each model's workspace and item, and nothing else", () => {
        expect(parseSemanticModels({
            semanticModels: { ae: { workspaceId: "w", itemId: "i", extra: true } },
            other: 1,
        })).toEqual({ ae: { workspaceId: "w", itemId: "i" } });
    });

    it("accepts an install that set up no models", () => {
        expect(parseSemanticModels({ semanticModels: {} })).toEqual({});
    });

    it("rejects a file without the semanticModels shape", () => {
        expect(() => parseSemanticModels(null)).toThrow(/semanticModels/);
        expect(() => parseSemanticModels({ semanticModels: [] })).toThrow(/semanticModels/);
        expect(() => parseSemanticModels({ semanticModels: { vl: { workspaceId: "w" } } })).toThrow(/"vl"/);
    });
});
