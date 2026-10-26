//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { resolveRayfinConfig, type RayfinRuntimeConfig } from "@microsoft/rayfin-client";
import { fabricConfig } from "@/fabric.generated";
import { buildTimeVariant, parseAppVariant, scopeModels, type AppVariant } from "@/lib/app-variant";
import type { ModelReference, ModelReferences } from "@/lib/connections";
import { toCurrencyCode, type InstallCurrency } from "@/lib/currency";
import { detectTeamsHost, resetTeamsHost } from "@/lib/teams-host";

/** Where an Azure install puts the host contract, next to the SPA. */
export const APP_CONFIG_PATH = "/app.config.json";
/** Where a Fabric install puts the semantic models it set up, next to the `rayfin.config.json` that `rayfin up` writes. */
export const FABRIC_CONFIG_PATH = "/fabric.config.json";

export type RuntimeHost = "fabric" | "azure";

export interface AzureRuntimeConfig {
    tenantId: string;
    clientId: string;
    apiScope: string;
    version?: string;
    /** A TeamsJS host (Teams, Outlook or the Microsoft 365 app) answered, so sign-in goes through it. */
    inTeams: boolean;
}

export interface RuntimeConfig {
    /** The host that supplies auth, query transport and app settings. */
    host: RuntimeHost;
    /** Which products this install shows. `semanticModels` holds only the models it may read. */
    variant: AppVariant;
    /** The Rayfin backend and the Fabric item that hosts the app. Fabric-only. */
    rayfin: RayfinRuntimeConfig;
    /** Azure auth and host settings. Azure-only. */
    azure?: AzureRuntimeConfig;
    /** The semantic models each page queries, by connection alias. */
    semanticModels: ModelReferences;
    /** Optional installer modules chosen for this install. Undefined for older installs and Azure hosts that do not say. */
    modules?: RuntimeModules;
    /** The reporting currency chosen at install, before anything is saved in the app. Undefined for older installs. */
    reporting?: InstallCurrency;
    /** The viewer group and who to ask for access. Undefined for installs without one. */
    access?: AccessInfo;
    /** Where questions about the data go. Undefined when the install set up neither a data agent nor a model. */
    ask?: AskConfig;
}

/** A Fabric data agent the viewer opens in Fabric, or the Azure host's own `/api/ask` chat. */
export type AskConfig = { mode: "fabric"; workspaceId: string; itemId: string } | { mode: "chat" };

export interface AccessInfo {
    groupId: string;
    groupName?: string;
    /** Email address that access requests go to. */
    contact?: string;
    /** A form or page for requesting access, used instead of email when set. */
    requestUrl?: string;
    /** The org attribute that org-scoped access (row-level security) filters on. Only there when it's on. */
    rlsOrgAttribute?: string;
    /** On Fabric, whether the installer recorded the app item as shared with the group. */
    appShared?: boolean;
}

export interface RuntimeModules {
    m365Activity: boolean;
    agent365: boolean;
    productFeedback: boolean;
    consumption: boolean;
    /** Absent from installs made before the Defender module existed. */
    defender?: boolean;
    /** Azure Resource Graph. Absent from configs written before it was a choice. */
    resourceGraph?: boolean;
}

export class RuntimeConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RuntimeConfigError";
    }
}

let loaded: RuntimeConfig | undefined;

/** The values baked in at build time. */
export function buildTimeConfig(): RuntimeConfig {
    const variant = buildTimeVariant();
    return {
        host: "fabric",
        variant,
        rayfin: {
            apiUrl: import.meta.env.VITE_RAYFIN_API_URL || undefined,
            publishableKey: import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY || undefined,
            workspaceId: import.meta.env.VITE_FABRIC_WORKSPACE_ID || undefined,
            itemId: import.meta.env.VITE_FABRIC_ITEM_ID || undefined,
            portalUrl: import.meta.env.VITE_FABRIC_PORTAL_URL || undefined,
            tenantId: import.meta.env.VITE_FABRIC_TENANT_ID || undefined,
        },
        semanticModels: scopeModels(fabricConfig.semanticModels as ModelReferences, variant),
    };
}

/** The config loadRuntimeConfig settled on, or the build-time values before it has run. */
export function runtimeConfig(): RuntimeConfig {
    return loaded ?? buildTimeConfig();
}

/** Reads deployed host config over build-time defaults. */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
    const defaults = buildTimeConfig();
    // All three files load at once. On Fabric the Azure check finds nothing, and waiting for that
    // before asking for the Fabric files put a round trip to the app host in front of the first query.
    const azureLoad = loadAzureConfig(APP_CONFIG_PATH);
    const fabricLoad = Promise.all([
        resolveRayfinConfig(defaults.rayfin),
        loadFabricConfig(FABRIC_CONFIG_PATH),
    ]);
    // Nothing awaits the Fabric files until the Azure check is done, and on Azure nothing ever does, so
    // their failing mustn't surface as an unhandled rejection. Without an Azure config, the await below
    // still rejects on it.
    fabricLoad.catch(() => undefined);

    const azure = await azureLoad;
    if (azure) {
        loaded = {
            ...defaults,
            host: "azure",
            variant: azure.variant,
            azure: { ...azure.azure!, inTeams: await detectTeamsHost() },
            semanticModels: azure.semanticModels,
            modules: azure.modules,
            reporting: azure.reporting,
            access: azure.access,
            ask: azure.ask,
        };
        return loaded;
    }

    const [rayfin, fabric] = await fabricLoad;
    const variant = fabric?.variant ?? defaults.variant;
    loaded = {
        host: "fabric",
        variant,
        rayfin: rayfin.runtimeConfig,
        semanticModels: fabric ? scopeModels(fabric.semanticModels, variant) : scopeModels(defaults.semanticModels, variant),
        modules: fabric?.modules,
        reporting: fabric?.reporting,
        access: fabric?.access,
        ask: fabric?.ask,
    };
    return loaded;
}

/** Forgets the loaded config and the TeamsJS check. For tests. */
export function resetRuntimeConfig(): void {
    loaded = undefined;
    resetTeamsHost();
}

/** The Azure host config, or null when this is not an Azure-hosted install. */
export async function loadAzureConfig(path = APP_CONFIG_PATH): Promise<RuntimeConfig | null> {
    let response: Response;
    try {
        response = await fetch(path, { cache: "no-store" });
    } catch (error) {
        throw new RuntimeConfigError(`Couldn't load ${path}: ${error instanceof Error ? error.message : String(error)}.`);
    }

    if (response.status === 404)
        return null;
    if (!response.ok)
        throw new RuntimeConfigError(`Couldn't load ${path}: ${response.status} ${response.statusText}.`);

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const body = (await response.text()).trimStart();
    if (contentType.includes("html") || body.startsWith("<"))
        return null;

    let json: unknown;
    try {
        json = JSON.parse(body);
    } catch {
        throw new RuntimeConfigError(`${path} isn't valid JSON.`);
    }
    return parseAzureConfig(json, path);
}

export async function loadSemanticModels(path = FABRIC_CONFIG_PATH): Promise<ModelReferences | null> {
    const config = await loadFabricConfig(path);
    return config?.semanticModels ?? null;
}

export async function loadFabricConfig(
    path = FABRIC_CONFIG_PATH,
): Promise<(Pick<RuntimeConfig, "semanticModels" | "modules" | "reporting" | "access" | "ask"> & { variant?: AppVariant }) | null> {
    let response: Response;
    try {
        response = await fetch(path, { cache: "no-store" });
    } catch (error) {
        throw new RuntimeConfigError(`Couldn't load ${path}: ${error instanceof Error ? error.message : String(error)}.`);
    }

    if (response.status === 404)
        return null;
    if (!response.ok)
        throw new RuntimeConfigError(`Couldn't load ${path}: ${response.status} ${response.statusText}.`);

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const body = (await response.text()).trimStart();
    if (contentType.includes("html") || body.startsWith("<"))
        return null;

    let json: unknown;
    try {
        json = JSON.parse(body);
    } catch {
        throw new RuntimeConfigError(`${path} isn't valid JSON.`);
    }
    return {
        semanticModels: parseSemanticModels(json, path),
        modules: parseModules(json),
        reporting: parseReporting(json),
        access: parseAccess(json),
        ask: parseAsk(json, "fabric"),
        ...(parseAppVariant(json) ? { variant: parseAppVariant(json) } : {}),
    };
}

/** Checks an Azure app.config.json body has the host contract shape. */
export function parseAzureConfig(json: unknown, path = APP_CONFIG_PATH): RuntimeConfig {
    if (!isRecord(json) || json.host !== "azure")
        throw new RuntimeConfigError(`${path} needs host: "azure".`);
    const { tenantId, clientId, apiScope, version } = json;
    if (typeof tenantId !== "string" || typeof clientId !== "string" || typeof apiScope !== "string")
        throw new RuntimeConfigError(`${path} needs tenantId, clientId and apiScope.`);
    const variant = parseAppVariant(json) ?? buildTimeVariant();
    return {
        ...buildTimeConfig(),
        host: "azure",
        variant,
        azure: {
            tenantId,
            clientId,
            apiScope,
            version: typeof version === "string" ? version : undefined,
            // loadRuntimeConfig sets this once TeamsJS has answered.
            inTeams: false,
        },
        semanticModels: scopeModels(parseSemanticModels(json, path), variant),
        modules: parseModules(json),
        reporting: parseReporting(json),
        access: parseAccess(json),
        ask: parseAsk(json, "azure"),
    };
}

/**
 * The `ask` block: a Fabric install names its data agent
 * (`{ workspaceId, itemId }`), and an Azure host says `{ mode: "chat" }` when
 * its `/api/ask` has a model. Anything else leaves Ask unconfigured.
 */
export function parseAsk(json: unknown, host: RuntimeHost): AskConfig | undefined {
    const ask = isRecord(json) ? json.ask : undefined;
    if (!isRecord(ask)) return undefined;
    if (host === "azure") return ask.mode === "chat" ? { mode: "chat" } : undefined;
    const { workspaceId, itemId } = ask;
    if (typeof workspaceId !== "string" || !GUID.test(workspaceId)) return undefined;
    if (typeof itemId !== "string" || !GUID.test(itemId)) return undefined;
    return { mode: "fabric", workspaceId, itemId };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `access` block the installer writes: a viewer group, plus who to ask. Ignored without a group id. */
export function parseAccess(json: unknown): AccessInfo | undefined {
    const access = isRecord(json) ? json.access : undefined;
    if (!isRecord(access) || typeof access.groupId !== "string" || !access.groupId) return undefined;
    const text = (key: string) => (typeof access[key] === "string" && access[key] ? (access[key] as string) : undefined);
    const requestUrl = text("requestUrl");
    return {
        groupId: access.groupId,
        ...(text("groupName") ? { groupName: text("groupName") } : {}),
        ...(text("contact") ? { contact: text("contact") } : {}),
        ...(requestUrl && /^https:\/\//i.test(requestUrl) ? { requestUrl } : {}),
        ...(text("rlsOrgAttribute") ? { rlsOrgAttribute: text("rlsOrgAttribute") } : {}),
        ...(access.appShared === true ? { appShared: true } : {}),
    };
}

/**
 * Reads `{ reporting: { currency, exchangeRate? } }`: the installer's choice
 * of reporting currency. An unknown currency or a rate that isn't a positive
 * number is left out rather than failing the app.
 */
export function parseReporting(json: unknown): InstallCurrency | undefined {
    const reporting = isRecord(json) ? json.reporting : undefined;
    if (!isRecord(reporting)) return undefined;
    const currency = toCurrencyCode(reporting.currency);
    if (!currency) return undefined;
    const rate = typeof reporting.exchangeRate === "string" ? Number(reporting.exchangeRate) : reporting.exchangeRate;
    const exchangeRate = currency !== "USD" && typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : undefined;
    return exchangeRate === undefined ? { currency } : { currency, exchangeRate };
}

/** Checks a config body has the `{ semanticModels: { alias: { workspaceId, itemId } } }` shape. */
export function parseSemanticModels(json: unknown, path = FABRIC_CONFIG_PATH): ModelReferences {
    const models = isRecord(json) ? json.semanticModels : undefined;
    if (!isRecord(models))
        throw new RuntimeConfigError(`${path} needs a "semanticModels" object.`);

    const parsed: Record<string, ModelReference> = {};
    for (const [alias, model] of Object.entries(models)) {
        if (!isRecord(model) || typeof model.workspaceId !== "string" || typeof model.itemId !== "string")
            throw new RuntimeConfigError(`${path} has no workspaceId and itemId for "${alias}".`);
        parsed[alias] = { workspaceId: model.workspaceId, itemId: model.itemId };
    }
    return parsed;
}

export function parseModules(json: unknown): RuntimeModules | undefined {
    const modules = isRecord(json) ? json.modules : undefined;
    if (!isRecord(modules)) return undefined;

    const keys = ["m365Activity", "agent365", "productFeedback", "consumption"] as const;
    if (!keys.every((key) => typeof modules[key] === "boolean")) return undefined;
    const parsed = Object.fromEntries(keys.map((key) => [key, modules[key]])) as unknown as RuntimeModules;
    return {
        ...parsed,
        ...(typeof modules.defender === "boolean" ? { defender: modules.defender } : {}),
        ...(typeof modules.resourceGraph === "boolean" ? { resourceGraph: modules.resourceGraph } : {}),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
