//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { dateBetween, daxString, treatAs } from "./dax-filters";
import {
    FILTER_COLUMNS,
    FILTER_KEYS,
    filterExpression,
    isFilterActive,
    isFilterInEffect,
    isTenantDefaultRange,
    type DateRange,
    type FilterKey,
    type FilterState,
} from "./filters";
import { describeOrgAttribute } from "./org-attribute";

/**
 * How one query takes the filter bar. For each filter it either gives the
 * DAX filter argument that narrows the query, or says why that filter can't
 * apply to it, so the card can say so rather than silently ignore it.
 *
 * Every filter argument is a `CALCULATETABLE` argument on a column the
 * shipped model templates already hold: no new measures, tables or
 * relationships, so the Fabric and Azure hosts, built from the same
 * templates, both support them.
 */
export type FilterProfile = Readonly<Record<FilterKey, FilterRule>>;

/** A filter a query can't take, and why, written to follow "Not filtered by Organization: ". */
export interface NotApplied {
    reason: string;
}

/** The DAX for an active filter, or why this query can't take it. */
export type FilterRule = NotApplied | ((state: FilterState, env: FilterEnvironment) => string | NotApplied);

/** What the rules need beyond the filter state: what the other models hold. */
export interface FilterEnvironment {
    /**
     * The `'Org Attribute Source'[Attribute]` names Consumption Central
     * holds, `undefined` while they load. A query reads as though every
     * attribute is there until they have loaded.
     */
    consumptionOrgAttributes?: readonly string[];
    /**
     * Whether the filter options say the tenant is large, `undefined` while
     * they load. The tenant's default date window narrows only on a large
     * tenant, so a query that can't take it says so only then.
     */
    largeTenant?: boolean;
}

/** An active filter a query left out, for a "Not filtered by" hint. */
export interface NotFiltered {
    key: FilterKey;
    reason: string;
}

export function notApplied(reason: string): NotApplied {
    return { reason };
}

function isNotApplied(value: unknown): value is NotApplied {
    return typeof value === "object" && value !== null && "reason" in value;
}

/**
 * The active filters among `keys`, split into the DAX arguments `profile`
 * applies and the filters it can't take, in `keys` order.
 */
export function resolveFilters(
    profile: FilterProfile,
    state: FilterState,
    keys: readonly FilterKey[],
    env: FilterEnvironment = {},
): { expressions: string[]; notFilteredBy: NotFiltered[] } {
    const expressions: string[] = [];
    const notFilteredBy: NotFiltered[] = [];
    for (const key of keys) {
        if (!isFilterActive(state, key)) continue;
        const rule = profile[key];
        const outcome = typeof rule === "function" ? rule(state, env) : rule;
        if (isNotApplied(outcome)) {
            if (isFilterInEffect(state, key, env)) notFilteredBy.push({ key, reason: outcome.reason });
        }
        else expressions.push(outcome);
    }
    return { expressions, notFilteredBy };
}

/** A profile that takes none of the filters, for the same reason. */
export function unfiltered(reason: string): FilterProfile {
    return Object.fromEntries(FILTER_KEYS.map((key) => [key, notApplied(reason)])) as FilterProfile;
}

const valueLens = (key: FilterKey) => (state: FilterState) => filterExpression(state, key);

/** The ValueLens activity model: every filter, on the columns the report's slicers use. */
export const VALUE_LENS: FilterProfile = {
    dateRange: valueLens("dateRange"),
    organizations: valueLens("organizations"),
    licence: valueLens("licence"),
    audience: valueLens("audience"),
    agentTypes: valueLens("agentTypes"),
    agentNames: valueLens("agentNames"),
};

/**
 * Overrides some of a profile's rules, as a query reading a cohort or a
 * snapshot does for the filters that would change what it measures.
 */
export function withRules(profile: FilterProfile, rules: Partial<Record<FilterKey, FilterRule>>): FilterProfile {
    return { ...profile, ...rules };
}

// ── Product feedback ─────────────────────────────────────────────────────

const FEEDBACK_AGENT = "'ProductFeedback'[AgentName]";

/**
 * Product feedback, related only to the Calendar. An agent filter matches
 * the agent the feedback was about; an agent type filter matches the agents
 * of that type in the registry, by name.
 */
export const FEEDBACK: FilterProfile = {
    dateRange: valueLens("dateRange"),
    organizations: notApplied("feedback is collected without the sender's organization."),
    licence: notApplied("feedback doesn't record the sender's license."),
    audience: notApplied("feedback isn't recorded by activity."),
    agentTypes: (state) =>
        `TREATAS(CALCULATETABLE(VALUES('Agents 365'[Agent name]), ${treatAs(FILTER_COLUMNS.agentType, state.agentTypes)}), ${FEEDBACK_AGENT})`,
    agentNames: (state) => treatAs(FEEDBACK_AGENT, state.agentNames),
};

// ── Agent 365 registry ───────────────────────────────────────────────────

/** The registry's own agent name column, which the agent filter matches by name. */
export const REGISTRY_AGENT_NAME = "'Agents 365'[Agent name]";

/** The Agent 365 registry: a catalogue of agents as they stand, not activity. */
export const REGISTRY: FilterProfile = {
    dateRange: notApplied("the agent registry lists agents as they stand today."),
    organizations: notApplied("the agent registry doesn't record an organization for agents or owners."),
    licence: notApplied("the agent registry lists agents, not people."),
    audience: notApplied("the agent registry lists agents, not activity."),
    agentTypes: valueLens("agentTypes"),
    agentNames: (state) => treatAs(REGISTRY_AGENT_NAME, state.agentNames),
};

/** Azure Resource Graph: agent configuration and Foundry resources at their latest load, for the whole tenant. */
export const RESOURCE_GRAPH: FilterProfile = unfiltered(
    "Azure Resource Graph lists configuration and resources at their latest load, for the whole tenant.",
);

/** Defender's shadow AI findings: a recent snapshot by device and tool. */
export const SHADOW_AI: FilterProfile = unfiltered(
    "Defender's shadow AI findings are a recent snapshot by device and tool, not linked to these filters.",
);

/**
 * Why a model other than ValueLens keeps every date under the tenant's
 * default window: the window follows the last day of Copilot activity and
 * the tenant's size in ValueLens, which another model can't read.
 */
function keepsOwnDates(model: string): NotApplied {
    return notApplied(`the default last 12 weeks follows Copilot activity, so ${model} keeps every date until you choose a range.`);
}

/**
 * A date rule for a model other than ValueLens: fixed dates as `rule` applies
 * them, and every date under the tenant's default window.
 */
function ownDates(model: string, rule: (range: DateRange) => string): FilterRule {
    return (state) => {
        const range = state.dateRange!;
        return isTenantDefaultRange(range) ? keepsOwnDates(model) : rule(range);
    };
}

// ── Consumption Central ──────────────────────────────────────────────────

/**
 * Consumption Central's names for org attributes, with the spellings each
 * stands for, as its `OrgNormalised` query folds them. An attribute with
 * none of these names keeps its own.
 */
const CONSUMPTION_ORG_ALIASES: readonly (readonly [string, readonly string[]])[] = [
    ["DisplayName", ["displayname", "name", "fullname", "preferredname"]],
    ["Department", ["department", "dept"]],
    ["Organisation", ["organisation", "organization"]],
    ["JobTitle", ["jobtitle", "title", "role"]],
    ["JobFamily", ["jobfamily", "function", "functiontype", "jobfunction"]],
    ["City", ["city", "officelocation", "location"]],
    ["Country", ["country", "countryorregion", "region"]],
    ["CostCenter", ["costcenter", "costcentre"]],
    ["Manager", ["manager", "managername", "supervisor", "managerid", "managerupn", "manageruserprincipalname"]],
    ["BusinessUnit", ["businessunit", "division", "segment", "companyname", "company"]],
];

/**
 * The `'Org Attribute Source'[Attribute]` a ValueLens org column turns into
 * in Consumption Central: its canonical name when it is one of the known
 * attributes, split into words as the model's `Pretty` step does.
 */
export function consumptionOrgAttribute(column: string): string {
    const key = column.replace(/[ _-]/g, "").toLowerCase();
    const canonical =
        CONSUMPTION_ORG_ALIASES.find(([name, aliases]) => name.toLowerCase() === key || aliases.includes(key))?.[0] ??
        column;
    return canonical === "DisplayName" ? "User" : canonical.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/**
 * The org filter on Consumption Central: the people with one of the chosen
 * values, found in its own org attributes and applied to `Org`, which every
 * per-person table relates to. It never touches `'Group By'`, which the
 * page's own Group by slicer filters.
 */
const consumptionOrg = (state: FilterState, env: FilterEnvironment): string | NotApplied => {
    const attribute = consumptionOrgAttribute(state.orgAttribute);
    const held = env.consumptionOrgAttributes;
    if (held && !held.includes(attribute)) {
        return notApplied(`Consumption Central has no ${describeOrgAttribute(state.orgAttribute).noun} for people.`);
    }
    const people = `CALCULATETABLE(VALUES('Org Attribute Source'[UserPrincipalName]), 'Org Attribute Source'[Attribute] = ${daxString(attribute)}, ${treatAs("'Org Attribute Source'[Value]", state.organizations)})`;
    return `TREATAS(${people}, 'Org'[UserPrincipalName])`;
};

const reportingDate = ownDates("Consumption Central", (range) => dateBetween("'Reporting Date'[Date]", range.from, range.to));

const agentBridge = (state: FilterState) => treatAs("'Agent Bridge'[Agent Name]", state.agentNames);

const CREDITS_NO_LICENCE = notApplied("credits aren't recorded by Copilot license.");
const CREDITS_NO_ACTIVITY = notApplied("credits are counted by product, not by activity.");
const CREDITS_NO_AGENT_TYPE = notApplied("Consumption Central doesn't record agent types.");

/**
 * Every product's credits over the reporting dates. Studio and Azure are
 * billed for the tenant, so an org filter would narrow only Cowork's share.
 */
export const CONSUMPTION_REPORTING: FilterProfile = {
    dateRange: reportingDate,
    organizations: notApplied("Copilot Studio and Azure are billed for the tenant, not per person."),
    licence: CREDITS_NO_LICENCE,
    audience: CREDITS_NO_ACTIVITY,
    agentTypes: CREDITS_NO_AGENT_TYPE,
    agentNames: notApplied("product totals aren't split by agent."),
};

const COWORK_PERIOD = notApplied(
    "Cowork counts its own billing period, drawing down the prepaid balance week by week.",
);
const COWORK_NO_AGENT = notApplied("Cowork credits aren't recorded per agent.");

/** Cowork's per-person credits, over the stage's own billing period. */
export const CONSUMPTION_COWORK: FilterProfile = {
    dateRange: COWORK_PERIOD,
    organizations: consumptionOrg,
    licence: CREDITS_NO_LICENCE,
    audience: CREDITS_NO_ACTIVITY,
    agentTypes: COWORK_NO_AGENT,
    agentNames: COWORK_NO_AGENT,
};

/** Cowork's per-person credits over the reporting dates. */
export const CONSUMPTION_COWORK_REPORTING: FilterProfile = withRules(CONSUMPTION_COWORK, { dateRange: reportingDate });

const STUDIO_PERIOD = notApplied("Copilot Studio counts its own billing period, so it keeps this stage's Period.");
const STUDIO_TENANT = notApplied("Copilot Studio capacity is billed for the tenant, not per person.");

/** Copilot Studio's tenant billing: by day and environment, not by person or agent. */
export const CONSUMPTION_STUDIO_TENANT: FilterProfile = {
    dateRange: STUDIO_PERIOD,
    organizations: STUDIO_TENANT,
    licence: CREDITS_NO_LICENCE,
    audience: CREDITS_NO_ACTIVITY,
    agentTypes: CREDITS_NO_AGENT_TYPE,
    agentNames: notApplied("the tenant's billing isn't split by agent."),
};

/** Copilot Studio's per-agent billing: by agent, not by person. */
export const CONSUMPTION_STUDIO_AGENT: FilterProfile = {
    dateRange: STUDIO_PERIOD,
    organizations: notApplied("Copilot Studio bills each agent, not the people using it."),
    licence: CREDITS_NO_LICENCE,
    audience: CREDITS_NO_ACTIVITY,
    agentTypes: CREDITS_NO_AGENT_TYPE,
    agentNames: agentBridge,
};

/** Copilot Studio credits per person and agent, which the export doesn't date. */
export const CONSUMPTION_STUDIO_PEOPLE: FilterProfile = {
    dateRange: notApplied("Copilot Studio's per-person credits aren't dated in the export."),
    organizations: consumptionOrg,
    licence: CREDITS_NO_LICENCE,
    audience: CREDITS_NO_ACTIVITY,
    agentTypes: CREDITS_NO_AGENT_TYPE,
    agentNames: agentBridge,
};

const AZURE_NO_AGENT = notApplied("Azure spend isn't recorded per agent.");

/** Azure spend: billed by resource over the stage's own period. */
export const CONSUMPTION_AZURE: FilterProfile = {
    dateRange: notApplied("Azure spend counts its own period, so it keeps this stage's Period."),
    organizations: notApplied("Azure is billed by resource, not by person."),
    licence: CREDITS_NO_LICENCE,
    audience: CREDITS_NO_ACTIVITY,
    agentTypes: AZURE_NO_AGENT,
    agentNames: AZURE_NO_AGENT,
};

/** What Consumption Central holds — dates, sources, slicer choices — rather than activity. */
export const CONSUMPTION_METADATA: FilterProfile = unfiltered("it describes what Consumption Central holds.");

const OTHER_MODEL: FilterProfile = unfiltered("this model has no matching column.");

/** The profile a query without its own takes: every filter on ValueLens, none elsewhere. */
export function defaultProfile(connection: string, valueLensConnection: string): FilterProfile {
    return connection === valueLensConnection ? VALUE_LENS : OTHER_MODEL;
}

export interface NotFilteredGroup {
    keys: FilterKey[];
    reason: string;
}

/**
 * Merges what several queries left out into one line per reason, in the
 * order the filters first appear, so a card built from many queries says
 * each thing once.
 */
export function groupNotFiltered(lists: readonly (readonly NotFiltered[] | undefined)[]): NotFilteredGroup[] {
    const groups = new Map<string, Set<FilterKey>>();
    for (const list of lists) {
        for (const { key, reason } of list ?? []) {
            const keys = groups.get(reason) ?? new Set<FilterKey>();
            keys.add(key);
            groups.set(reason, keys);
        }
    }
    return [...groups].map(([reason, keys]) => ({ keys: [...keys], reason }));
}
