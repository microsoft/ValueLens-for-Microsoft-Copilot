//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { AgentEntry } from "@/queries/agents";

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
    value: number;
    sentence: string;
}

export interface AgentFunctions {
    name: string;
    functions: number;
}

/** Reads the agent functions query into one count per agent. */
export function readAgentFunctions(table: DataTable): AgentFunctions[] {
    const at = (name: string) => table.columns.findIndex((column) => column.name === name);
    const [nameAt, functionsAt] = [at("Agent"), at("Functions")];
    if (nameAt < 0 || functionsAt < 0) return [];
    return table.rows.map((row) => {
        const name = typeof row[nameAt] === "string" && (row[nameAt] as string).trim() ? (row[nameAt] as string).trim() : "Unnamed agent";
        const value = row[functionsAt];
        return { name, functions: typeof value === "number" && Number.isFinite(value) ? value : 0 };
    });
}

/** "A", "A and B", or "A, B and 3 others". */
export function namesText(names: readonly string[]): string {
    if (names.length <= NAMED) return names.join(" and ");
    const rest = names.length - NAMED;
    return `${names.slice(0, NAMED).join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

/** The items sharing the highest value, with their distinct names in the order given. */
function leaders<T>(items: readonly T[], name: (item: T) => string, value: (item: T) => number) {
    const top = items.reduce((best, item) => Math.max(best, value(item)), 0);
    const names = [...new Set(items.filter((item) => value(item) === top).map(name))];
    return { top, names };
}

function card(
    id: SpotlightId,
    label: string,
    found: { top: number; names: string[] },
    sentence: (names: string, value: string, tied: boolean) => string,
): Spotlight {
    const names = namesText(found.names);
    return { id, label, names, value: found.top, sentence: sentence(names, whole.format(found.top), found.names.length > 1) };
}

/**
 * Up to three agents worth a look: the most used, the one used by the most
 * job functions, and the one reached by the most organizations. Each card is
 * left out when its winning figure is too small to single anything out, and
 * ties name every winner, or the first two and a count of the rest.
 */
export function agentSpotlights(entries: readonly AgentEntry[], functions: readonly AgentFunctions[] = []): Spotlight[] {
    const cards: Spotlight[] = [];

    const sessions = leaders(entries, (entry) => entry.name, (entry) => entry.sessions);
    if (sessions.top > 0) {
        cards.push(
            card("sessions", "Most used", sessions, (names, value, tied) => {
                const counted = `${value} ${sessions.top === 1 ? "session" : "sessions"}`;
                return tied ? `${names} each had ${counted}, the most of any agent.` : `${names} had ${counted}, more than any other agent.`;
            }),
        );
    }

    const reach = leaders(functions, (row) => row.name, (row) => row.functions);
    if (reach.top >= MIN_SPREAD) {
        cards.push(
            card("functions", "Used by the most job functions", reach, (names, value, tied) =>
                tied
                    ? `${names} were each used by people in ${value} job functions, the most of any agent.`
                    : `${names} was used by people in ${value} job functions, more than any other agent.`,
            ),
        );
    }

    const orgs = leaders(entries, (entry) => entry.name, (entry) => entry.orgsReached);
    if (orgs.top >= MIN_SPREAD) {
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
