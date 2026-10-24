//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { AgentEntry } from "@/queries/agents";
import { listTotal } from "@/lib/list-total";

const whole = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

/** Below this many organizations or job functions, "the most" says nothing. */
export const MIN_SPREAD = 2;

/** How many tied names a card spells out before counting the rest. */
const NAMED = 2;

export type SpotlightId = "sessions" | "functions" | "orgs";

export interface Spotlight {
    id: SpotlightId;
    label: string;
    /** The winning agent, or the tied agents, as one phrase. */
    names: string;
    /** What the card shows large: the winner, two tied names, or how many tie. */
    headline: string;
    value: number;
    sentence: string;
}

export interface AgentFunctions {
    name: string;
    functions: number;
    leaderCount?: number;
}

export interface SpotlightLeaders {
    top: number;
    names: string;
    count: number;
}

export interface RegistrySpotlights {
    sessions?: SpotlightLeaders;
    orgs?: SpotlightLeaders;
}

/** Never derive an overall winner from the capped registry list. */
export function readRegistrySpotlights(table: DataTable | undefined): RegistrySpotlights {
    const read = (metric: string, prefix: string): SpotlightLeaders | undefined => {
        const top = listTotal(table, `Top ${metric}`);
        const count = listTotal(table, `${prefix} Leader Count`);
        const at = table?.columns.findIndex((column) => column.name === `${prefix} Leaders`) ?? -1;
        const names = table?.rows[0]?.[at];
        if (top === undefined || count === undefined) return undefined;
        if (top === 0) return count === 0 ? { top, names: "", count } : undefined;
        if (typeof names !== "string") return undefined;
        if (table?.rows.some((row) => row[at] !== names)) return undefined;
        if (top > 0 && (count === 0 || !names.trim())) return undefined;
        return { top, names, count };
    };
    return { sessions: read("Sessions", "Session"), orgs: read("Orgs", "Org") };
}

/** Reads at most two winning agents, with the full tie count. */
export function readAgentFunctions(table: DataTable): AgentFunctions[] {
    const at = (name: string) => table.columns.findIndex((column) => column.name === name);
    const [nameAt, functionsAt] = [at("Agent"), at("Functions")];
    const leaderCount = listTotal(table, "Leader Count");
    if (nameAt < 0 || functionsAt < 0 || leaderCount === undefined || table.rows.length !== Math.min(2, leaderCount)) return [];
    const top = listTotal(table, "Functions");
    if (top === undefined || top <= 0) return [];
    return table.rows.map((row) => {
        const name = typeof row[nameAt] === "string" && (row[nameAt] as string).trim() ? (row[nameAt] as string).trim() : "Unnamed agent";
        return { name, functions: top, leaderCount };
    });
}

/** "A", "A and B", or "A, B and 3 others". */
export function namesText(names: readonly string[], count = names.length): string {
    if (count <= NAMED) return names.join(" and ");
    const rest = count - NAMED;
    return `${names.slice(0, NAMED).join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

/** The items sharing the highest value; identically named agents still count separately. */
function leaders<T>(items: readonly T[], name: (item: T) => string, value: (item: T) => number) {
    const top = items.reduce((best, item) => Math.max(best, value(item)), 0);
    const names = items.filter((item) => value(item) === top).map(name);
    return { top, names: namesText(names), count: names.length };
}

function card(
    id: SpotlightId,
    label: string,
    found: SpotlightLeaders,
    sentence: (names: string, value: string, tied: boolean) => string,
): Spotlight {
    const names = found.names;
    const headline = found.count > NAMED ? `${whole.format(found.count)} agents tie` : names;
    return { id, label, names, headline, value: found.top, sentence: sentence(names, whole.format(found.top), found.count > 1) };
}

/**
 * Up to three agents worth a look: the most used, the one used by the most
 * job functions, and the one reached by the most organizations. Each card is
 * left out when its winning figure is too small to single anything out, and
 * ties name every winner, or the first two and a count of the rest.
 */
export function agentSpotlights(entries: readonly AgentEntry[], functions: readonly AgentFunctions[] = [], summary?: RegistrySpotlights): Spotlight[] {
    const cards: Spotlight[] = [];

    const sessions = summary ? summary.sessions : leaders(entries, (entry) => entry.name, (entry) => entry.sessions);
    if (sessions && sessions.top > 0) {
        cards.push(
            card("sessions", "Most used", sessions, (names, value, tied) => {
                const counted = `${value} ${sessions.top === 1 ? "session" : "sessions"}`;
                return tied ? `${names} each had ${counted}, the most of any agent.` : `${names} had ${counted}, more than any other agent.`;
            }),
        );
    }

    const reach = leaders(functions, (row) => row.name, (row) => row.functions);
    if (functions[0]?.leaderCount !== undefined) {
        reach.count = functions[0].leaderCount;
        reach.names = namesText(functions.map((row) => row.name), reach.count);
    }
    if (reach.top >= MIN_SPREAD) {
        cards.push(
            card("functions", "Used by the most job functions", reach, (names, value, tied) =>
                tied
                    ? `${names} were each used by people in ${value} job functions, the most of any agent.`
                    : `${names} was used by people in ${value} job functions, more than any other agent.`,
            ),
        );
    }

    const orgs = summary ? summary.orgs : leaders(entries, (entry) => entry.name, (entry) => entry.orgsReached);
    if (orgs && orgs.top >= MIN_SPREAD) {
        cards.push(
            card("orgs", "Shared across the most organizations", orgs, (names, value, tied) =>
                tied
                    ? `${names} each reached people in ${value} organizations, the most of any agent.`
                    : `${names} reached people in ${value} organizations, more than any other agent.`,
            ),
        );
    }

    return cards;
}
