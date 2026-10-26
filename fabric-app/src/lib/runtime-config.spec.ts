//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@microsoft/teams-js", () => ({ app: { initialize: vi.fn().mockRejectedValue(new Error("not teams")) } }));

vi.mock("@/fabric.generated", () => ({
    fabricConfig: {
        semanticModels: {
            vl: { workspaceId: "build-ws", itemId: "build-vl" },
        },
    },
}));

import * as teams from "@microsoft/teams-js";
import {
    APP_CONFIG_PATH,
    FABRIC_CONFIG_PATH,
    RuntimeConfigError,
    buildTimeConfig,
    loadRuntimeConfig,
    loadSemanticModels,
    parseAccess,
    parseAsk,
    parseModules,
    parseReporting,
    parseSemanticModels,
    resetRuntimeConfig,
    runtimeConfig,
} from "@/lib/runtime-config";
import { initialiseTeams } from "@/lib/teams-host";

type Reply = { status?: number; body: string; contentType?: string } | Error;

function stubFiles(files: Record<string, Reply | Promise<Reply>>) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const reply = await (files[String(input)] ?? { status: 404, body: "" });
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

/** A reply held back until the test sends it. */
function heldReply() {
    let send!: (reply: Reply) => void;
    const reply = new Promise<Reply>((resolve) => {
        send = resolve;
    });
    return { reply, send };
}

/** The files asked for so far. */
function requested(fetchMock: ReturnType<typeof stubFiles>): string[] {
    return fetchMock.mock.calls.map(([input]) => String(input));
}

/** Lets replies already sent, and the work waiting on them, run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Runs `body`, then returns the promise rejections nothing handled. */
async function unhandledRejections(body: () => Promise<unknown>): Promise<unknown[]> {
    const reasons: unknown[] = [];
    const record = (reason: unknown) => {
        reasons.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
        await body();
        // Node reports a rejection as unhandled once the microtasks after it have run.
        await tick();
    } finally {
        process.off("unhandledRejection", record);
    }
    return reasons;
}

const ALL_FILES = [APP_CONFIG_PATH, "/rayfin.config.json", FABRIC_CONFIG_PATH];

const SPA_FALLBACK: Reply = { body: "<!DOCTYPE html><html></html>", contentType: "text/html" };

/** An Azure install's app.config.json, as a tab loads it. */
const azureTab = {
    host: "azure",
    tenantId: "tenant",
    clientId: "client",
    apiScope: "scope",
    semanticModels: { vl: { workspaceId: "w", itemId: "i" } },
};

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
    modules: {
        m365Activity: true,
        agent365: false,
        productFeedback: false,
        consumption: true,
    },
};

beforeEach(() => {
    resetRuntimeConfig();
    vi.mocked(teams.app.initialize).mockReset().mockRejectedValue(new Error("not teams"));
});
afterEach(() => {
    vi.unstubAllGlobals();
    resetRuntimeConfig();
    history.replaceState(null, "", "/");
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
        expect(runtimeConfig().modules).toEqual(deployedModels.modules);
    });

    it("asks for all three config files at once, so Fabric doesn't wait on the Azure check", async () => {
        const azureCheck = heldReply();
        const rayfinFile = heldReply();
        const modelsFile = heldReply();
        const fetchMock = stubFiles({
            [APP_CONFIG_PATH]: azureCheck.reply,
            "/rayfin.config.json": rayfinFile.reply,
            [FABRIC_CONFIG_PATH]: modelsFile.reply,
        });

        const loading = loadRuntimeConfig();
        // Nothing has answered, so no file waited on another.
        await vi.waitFor(() => expect(requested(fetchMock)).toEqual(expect.arrayContaining(ALL_FILES)));
        rayfinFile.send({ body: JSON.stringify(deployedRayfin) });
        modelsFile.send({ body: JSON.stringify(deployedModels) });
        azureCheck.send(SPA_FALLBACK);
        await loading;

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(runtimeConfig().host).toBe("fabric");
        expect(runtimeConfig().rayfin).toEqual({ ...deployedRayfin, apiUrl: "https://api.example.com/" });
        expect(runtimeConfig().semanticModels).toEqual(deployedModels.semanticModels);
    });

    it("uses Azure app config over the Fabric files, even when they answer first", async () => {
        const azureConfig = {
            host: "azure",
            tenantId: "tenant",
            clientId: "client",
            apiScope: "api://client/access_as_user",
            version: "1.2.3",
            semanticModels: { vl: { workspaceId: "azure-ws", itemId: "azure-model" } },
            modules: { m365Activity: true, agent365: false, productFeedback: false, consumption: false },
        };
        const azureCheck = heldReply();
        const fetchMock = stubFiles({
            [APP_CONFIG_PATH]: azureCheck.reply,
            "/rayfin.config.json": { body: JSON.stringify(deployedRayfin) },
            [FABRIC_CONFIG_PATH]: { body: JSON.stringify({ ...deployedModels, access: { groupId: "fabric-group" } }) },
        });

        const loading = loadRuntimeConfig();
        await vi.waitFor(() => expect(requested(fetchMock)).toHaveLength(3));
        await tick();
        azureCheck.send({ body: JSON.stringify(azureConfig) });
        await loading;

        // Nothing from the Fabric files: the build's Rayfin settings, and Azure's models and modules.
        expect(runtimeConfig()).toEqual({
            ...buildTimeConfig(),
            host: "azure",
            azure: { tenantId: "tenant", clientId: "client", apiScope: "api://client/access_as_user", version: "1.2.3", inTeams: false },
            semanticModels: azureConfig.semanticModels,
            modules: azureConfig.modules,
        });
    });

    it("uses Azure app config without waiting on the Fabric files, and ignores them failing", async () => {
        const modelsFile = heldReply();
        stubFiles({
            [APP_CONFIG_PATH]: { body: JSON.stringify(azureTab) },
            "/rayfin.config.json": { status: 500, body: "" },
            [FABRIC_CONFIG_PATH]: modelsFile.reply,
        });

        const unhandled = await unhandledRejections(async () => {
            await loadRuntimeConfig();
            // The models file only fails after the Azure config has loaded.
            modelsFile.send(new TypeError("Failed to fetch"));
        });

        expect(unhandled).toEqual([]);
        expect(runtimeConfig().host).toBe("azure");
        expect(runtimeConfig().semanticModels).toEqual(azureTab.semanticModels);
    });

    it("initialises TeamsJS once in a tab, so it can sign in through Teams, Outlook or the Microsoft 365 app", async () => {
        history.replaceState(null, "", "/?host=teams");
        vi.mocked(teams.app.initialize).mockResolvedValue(undefined);
        stubFiles({ [APP_CONFIG_PATH]: { body: JSON.stringify(azureTab) } });

        await loadRuntimeConfig();
        // The sign-in pop-up's call shares the one made at load.
        await initialiseTeams();

        expect(teams.app.initialize).toHaveBeenCalledOnce();
        expect(runtimeConfig().azure?.inTeams).toBe(true);
    });

    it("leaves TeamsJS alone on the web link, so a window another app opened doesn't wait for a host", async () => {
        // TeamsJS would take the opener for a host and wait up to a minute for an answer that never comes.
        vi.stubGlobal("opener", {});
        vi.mocked(teams.app.initialize).mockReturnValue(new Promise<void>(() => undefined));
        stubFiles({ [APP_CONFIG_PATH]: { body: JSON.stringify(azureTab) } });

        const loading = loadRuntimeConfig().then(() => "loaded");
        const waiting = new Promise((resolve) => setTimeout(resolve, 1_000, "waiting for a host"));

        await expect(Promise.race([loading, waiting])).resolves.toBe("loaded");
        expect(teams.app.initialize).not.toHaveBeenCalled();
        expect(runtimeConfig().azure?.inTeams).toBe(false);
    });

    it("doesn't take ?host=teams on trust when no host answers", async () => {
        history.replaceState(null, "", "/?host=teams");
        stubFiles({ [APP_CONFIG_PATH]: { body: JSON.stringify(azureTab) } });

        await loadRuntimeConfig();

        expect(teams.app.initialize).toHaveBeenCalledOnce();
        expect(runtimeConfig().azure?.inTeams).toBe(false);
    });

    it("keeps the build's values when a developer deploy has no config files", async () => {
        stubFiles({ [APP_CONFIG_PATH]: SPA_FALLBACK, "/rayfin.config.json": SPA_FALLBACK, [FABRIC_CONFIG_PATH]: SPA_FALLBACK });

        await loadRuntimeConfig();

        expect(runtimeConfig().semanticModels).toEqual({ vl: { workspaceId: "build-ws", itemId: "build-vl" } });
    });

    it("fails rather than fall back when the models file is there but won't load", async () => {
        stubFiles({ [FABRIC_CONFIG_PATH]: { status: 500, body: "" } });

        await expect(loadRuntimeConfig()).rejects.toBeInstanceOf(RuntimeConfigError);
    });

    it.each<[string, Reply, RegExp]>([
        ["a server error", { status: 500, body: "" }, /app\.config\.json: 500/],
        ["a broken file", { body: "{ not json" }, /app\.config\.json isn't valid JSON/],
        ["a network failure", new TypeError("Failed to fetch"), /app\.config\.json: Failed to fetch/],
    ])("fails on %s from app.config.json, even though the Fabric files load", async (_, azureReply, message) => {
        const azureCheck = heldReply();
        const fetchMock = stubFiles({
            [APP_CONFIG_PATH]: azureCheck.reply,
            "/rayfin.config.json": { body: JSON.stringify(deployedRayfin) },
            [FABRIC_CONFIG_PATH]: { body: JSON.stringify(deployedModels) },
        });

        const loading = loadRuntimeConfig();
        await vi.waitFor(() => expect(requested(fetchMock)).toHaveLength(3));
        await tick();
        azureCheck.send(azureReply);

        await expect(loading).rejects.toThrow(message);
    });

    it("reports the app.config.json failure, not the Fabric files', when they all fail", async () => {
        const azureCheck = heldReply();
        const fetchMock = stubFiles({
            [APP_CONFIG_PATH]: azureCheck.reply,
            "/rayfin.config.json": { status: 500, body: "" },
            [FABRIC_CONFIG_PATH]: new TypeError("Failed to fetch"),
        });

        const unhandled = await unhandledRejections(async () => {
            const loading = loadRuntimeConfig();
            // The Fabric files fail first.
            await vi.waitFor(() => expect(requested(fetchMock)).toHaveLength(3));
            await tick();
            azureCheck.send({ status: 503, body: "" });

            await expect(loading).rejects.toThrow(/app\.config\.json: 503/);
        });

        expect(unhandled).toEqual([]);
    });

    it.each<[string, Reply, RegExp]>([
        ["/rayfin.config.json", { status: 401, body: "" }, /rayfin\.config\.json.*401/],
        [FABRIC_CONFIG_PATH, { status: 500, body: "" }, /fabric\.config\.json: 500/],
    ])("fails when %s won't load and there's no Azure config, even if it failed first", async (path, failure, message) => {
        const azureCheck = heldReply();
        const fetchMock = stubFiles({ [APP_CONFIG_PATH]: azureCheck.reply, [path]: failure });

        const unhandled = await unhandledRejections(async () => {
            const loading = loadRuntimeConfig();
            await vi.waitFor(() => expect(requested(fetchMock)).toHaveLength(3));
            await tick();
            azureCheck.send(SPA_FALLBACK);

            await expect(loading).rejects.toThrow(message);
        });

        expect(unhandled).toEqual([]);
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

describe("parseAccess", () => {
    it("keeps the viewer group, contact and an https request link", () => {
        expect(parseAccess({
            access: { groupId: "g-1", groupName: "Analytics Hub Viewers", contact: "admin@example.com", requestUrl: "https://example.com/r" },
        })).toEqual({ groupId: "g-1", groupName: "Analytics Hub Viewers", contact: "admin@example.com", requestUrl: "https://example.com/r" });
    });

    it("keeps the org attribute when org-scoped access is on", () => {
        expect(parseAccess({ access: { groupId: "g-1", rlsOrgAttribute: "department" } })).toEqual({ groupId: "g-1", rlsOrgAttribute: "department" });
        expect(parseAccess({ access: { groupId: "g-1", rlsOrgAttribute: 7 } })).toEqual({ groupId: "g-1" });
    });

    it("keeps whether the app item is shared with the group, only when it's true", () => {
        expect(parseAccess({ access: { groupId: "g-1", appShared: true } })).toEqual({ groupId: "g-1", appShared: true });
        expect(parseAccess({ access: { groupId: "g-1", appShared: "true" } })).toEqual({ groupId: "g-1" });
        expect(parseAccess({ access: { groupId: "g-1", appShared: false } })).toEqual({ groupId: "g-1" });
    });

    it("drops a request link that isn't https", () => {
        expect(parseAccess({ access: { groupId: "g-1", requestUrl: "javascript:alert(1)" } })).toEqual({ groupId: "g-1" });
    });

    it("ignores access without a group", () => {
        expect(parseAccess({})).toBeUndefined();
        expect(parseAccess({ access: { contact: "admin@example.com" } })).toBeUndefined();
    });
});

describe("parseAsk", () => {
    const agent = { workspaceId: "11111111-2222-3333-4444-555555555555", itemId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };

    it("reads a Fabric install's data agent", () => {
        expect(parseAsk({ ask: agent }, "fabric")).toEqual({ mode: "fabric", ...agent });
    });

    it("reads an Azure host's chat", () => {
        expect(parseAsk({ ask: { mode: "chat" } }, "azure")).toEqual({ mode: "chat" });
    });

    it("leaves Ask unconfigured for anything else", () => {
        expect(parseAsk({}, "fabric")).toBeUndefined();
        expect(parseAsk({ ask: { workspaceId: agent.workspaceId, itemId: "../x" } }, "fabric")).toBeUndefined();
        expect(parseAsk({ ask: { mode: "chat" } }, "fabric")).toBeUndefined();
        expect(parseAsk({ ask: agent }, "azure")).toBeUndefined();
    });

    it("carries through loadRuntimeConfig on both hosts", async () => {
        stubFiles({
            "/rayfin.config.json": { body: JSON.stringify(deployedRayfin) },
            [FABRIC_CONFIG_PATH]: { body: JSON.stringify({ ...deployedModels, ask: agent }) },
        });
        await loadRuntimeConfig();
        expect(runtimeConfig().ask).toEqual({ mode: "fabric", ...agent });

        resetRuntimeConfig();
        stubFiles({
            [APP_CONFIG_PATH]: { body: JSON.stringify({ host: "azure", tenantId: "t", clientId: "c", apiScope: "s", semanticModels: deployedModels.semanticModels, ask: { mode: "chat" } }) },
        });
        await loadRuntimeConfig();
        expect(runtimeConfig().ask).toEqual({ mode: "chat" });
    });
});

describe("parseSemanticModels", () => {
    it("keeps each model's workspace and item, and nothing else", () => {
        expect(parseSemanticModels({
            semanticModels: { cc: { workspaceId: "w", itemId: "i", extra: true } },
            other: 1,
        })).toEqual({ cc: { workspaceId: "w", itemId: "i" } });
    });

    describe("parseModules", () => {
        it("keeps the optional installer module choices", () => {
            expect(parseModules(deployedModels)).toEqual(deployedModels.modules);
        });

        it("treats missing or invalid module choices as an older config", () => {
            expect(parseModules({ semanticModels: {} })).toBeUndefined();
            expect(parseModules({ modules: [] })).toBeUndefined();
            expect(parseModules({ modules: { m365Activity: true } })).toBeUndefined();
            expect(parseModules({ modules: { ...deployedModels.modules, productFeedback: "no" } })).toBeUndefined();
        });

        it("reads the Defender choice when the install records it, and leaves it out of older configs", () => {
            expect(parseModules({ modules: { ...deployedModels.modules, defender: true } })).toEqual({ ...deployedModels.modules, defender: true });
            expect(parseModules({ modules: { ...deployedModels.modules, defender: "yes" } })).toEqual(deployedModels.modules);
            expect(parseModules(deployedModels)).not.toHaveProperty("defender");
        });

        it("reads the Resource Graph choice only when the config states it", () => {
            expect(parseModules({ modules: { ...deployedModels.modules, resourceGraph: false } })?.resourceGraph).toBe(false);
            expect(parseModules({ modules: { ...deployedModels.modules, resourceGraph: "yes" } })).toEqual(deployedModels.modules);
            expect(parseModules(deployedModels)).not.toHaveProperty("resourceGraph");
        });
    });

    describe("parseReporting", () => {
        it("reads the installer's reporting currency and its rate", () => {
            expect(parseReporting({ reporting: { currency: "eur", exchangeRate: 0.92 } })).toEqual({ currency: "EUR", exchangeRate: 0.92 });
            expect(parseReporting({ reporting: { currency: "GBP", exchangeRate: "0.79" } })).toEqual({ currency: "GBP", exchangeRate: 0.79 });
            expect(parseReporting({ reporting: { currency: "USD", exchangeRate: 2 } })).toEqual({ currency: "USD" });
        });

        it("leaves out a currency it doesn't offer, a bad rate, and older configs", () => {
            expect(parseReporting(deployedModels)).toBeUndefined();
            expect(parseReporting({ reporting: { currency: "XYZ" } })).toBeUndefined();
            expect(parseReporting({ reporting: { currency: "GBP", exchangeRate: -1 } })).toEqual({ currency: "GBP" });
            expect(parseReporting({ reporting: { currency: "GBP", exchangeRate: "abc" } })).toEqual({ currency: "GBP" });
        });
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
