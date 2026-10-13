//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./agent-leaderboard.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Agent]": { name: "Agent", displayName: "Agent" },
    "[Registry Id]": { name: "Registry Id", displayName: "Registry ID" },
    "[In Registry]": { name: "In Registry", displayName: "In registry" },
    "[Type]": { name: "Type", displayName: "Type" },
    "[Creator]": { name: "Creator", displayName: "Creator" },
    "[Users]": { name: "Users", displayName: "Users", format: FORMAT_WHOLE },
    "[Sessions]": { name: "Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
    "[Sessions Per User]": { name: "Sessions Per User", displayName: "Sessions / user", format: FORMAT_RATE },
    "[Return Rate]": { name: "Return Rate", displayName: "Return rate", format: FORMAT_PERCENT },
    "[Orgs Reached]": { name: "Orgs Reached", displayName: "Orgs reached", format: FORMAT_WHOLE },
    "[Last Activity]": { name: "Last Activity", displayName: "Last activity" },
    "[Features]": { name: "Features", displayName: "Available in" },
    "[Lifecycle]": { name: "Lifecycle", displayName: "Lifecycle stage" },
    "[Adoption]": { name: "Adoption", displayName: "Adoption" },
    "[Description]": { name: "Description", displayName: "Description" },
};

/**
 * Every agent ranked by its users, as the report's Agent Registry table
 * ranks them: each registered agent with its registry details, whether or
 * not anyone used it, plus the agents the audit log names that no registry
 * entry matches. Usage respects every filter; the registry list itself only
 * follows the agent type filter, and the agent filter keeps just the agents
 * used under it. Read the rows with {@link toAgentEntries}.
 */
export function agentLeaderboard() {
    return { connection, query, columnMetadata };
}

/** One row of the agent leaderboard, ready for the table and the detail card. */
export interface AgentEntry {
    /** Unique per row: the registry id, or the audit log's name for an agent the registry lacks. */
    key: string;
    name: string;
    registryId?: string;
    inRegistry: boolean;
    type?: string;
    creator?: string;
    /** Zero when nobody used the agent in the selection. */
    users: number;
    sessions: number;
    orgsReached: number;
    sessionsPerUser?: number;
    returnRate?: number;
    /** The day of the latest session, as `yyyy-mm-dd`. */
    lastActivity?: string;
    /** The registry's own wording, emoji and all. */
    features?: string;
    /** Where the agent can be used, read from `features`; undefined when the registry doesn't say plainly. */
    surfaces?: string[];
    lifecycle?: string;
    adoption?: string;
    description?: string;
}

const EMOJI_RUN = /[\p{Extended_Pictographic}\uFE0F\u200D]+/gu;

/**
 * Reads the registry's features text, such as "🤖 in Copilot 💬 in Teams",
 * as the surfaces it names: ["Copilot", "Teams"]. Anything that isn't a
 * run of "in …" phrases, such as "Unknown / insufficient capability
 * evidence", returns undefined so the caller can show the text as it is.
 */
export function agentSurfaces(features: string | null | undefined): string[] | undefined {
    if (!features) return undefined;
    const parts = features
        .split(EMOJI_RUN)
        .map((part) => part.trim())
        .filter(Boolean);
    if (parts.length === 0 || !parts.every((part) => /^in\s+\S/i.test(part))) return undefined;
    return parts.map((part) => part.replace(/^in\s+/i, ""));
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function day(value: unknown): string | undefined {
    const match = typeof value === "string" ? /^\d{4}-\d{2}-\d{2}/.exec(value) : null;
    return match?.[0];
}

/** The leaderboard's rows in the order the query ranks them, each with a key no other row shares. */
export function toAgentEntries(table: DataTable): AgentEntry[] {
    const index = new Map(table.columns.map((column, position) => [column.name, position]));
    const seen = new Map<string, number>();

    return table.rows.map((row) => {
        const cell = (name: string) => {
            const position = index.get(name);
            return position === undefined ? undefined : row[position];
        };
        const name = text(cell("Agent")) ?? "Unnamed agent";
        const registryId = text(cell("Registry Id"));
        const features = text(cell("Features"));

        // Registered agents can share a name, and two blank audit names both read "Unnamed agent".
        const base = registryId ?? `audit:${name}`;
        const repeat = seen.get(base) ?? 0;
        seen.set(base, repeat + 1);

        return {
            key: repeat === 0 ? base : `${base}#${repeat + 1}`,
            name,
            registryId,
            inRegistry: cell("In Registry") === true,
            type: text(cell("Type")),
            creator: text(cell("Creator")),
            users: number(cell("Users")) ?? 0,
            sessions: number(cell("Sessions")) ?? 0,
            orgsReached: number(cell("Orgs Reached")) ?? 0,
            sessionsPerUser: number(cell("Sessions Per User")),
            returnRate: number(cell("Return Rate")),
            lastActivity: day(cell("Last Activity")),
            features,
            surfaces: agentSurfaces(features),
            lifecycle: text(cell("Lifecycle")),
            adoption: text(cell("Adoption")),
            description: text(cell("Description")),
        };
    });
}
