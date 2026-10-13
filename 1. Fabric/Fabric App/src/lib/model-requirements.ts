//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { isMissingFromModelError, parseMissingModelObject } from "@/lib/model-errors";
import { connection } from "@/queries/shared";

export type ModelRequirementScope = "governance";

export interface ModelObjectRequirement {
    /** Connection alias from `fabric.yaml`, e.g. `vl`. */
    model: string;
    table: string;
    columns: readonly string[];
    measures?: readonly string[];
}

export type RequirementProbeState =
    | { status: "ok" }
    | { status: "checking" }
    | { status: "unknown" }
    | { status: "outdated"; missing: readonly string[] };

/**
 * Optional model objects newer app pages rely on. Keep requirements grouped
 * by page so a version-skewed semantic model can be stopped before its page
 * queries produce raw engine errors.
 */
export const MODEL_REQUIREMENTS: Readonly<Record<ModelRequirementScope, readonly ModelObjectRequirement[]>> = {
    governance: [
        {
            model: connection,
            table: "Agents 365",
            columns: ["Owner account", "Governance Flags", "Data Access", "Sharing Scope"],
        },
    ],
};

function daxString(value: string): string {
    return `"${value.replace(/"/g, `""`)}"`;
}

function tableRef(table: string): string {
    return `'${table.replace(/'/g, "''")}'`;
}

function columnRef(table: string, column: string): string {
    return `${tableRef(table)}[${column.replace(/\]/g, "]]")}]`;
}

function sameName(left: string | undefined, right: string): boolean {
    return left?.toLowerCase() === right.toLowerCase();
}

function requiredLabels(requirement: ModelObjectRequirement): string[] {
    return [
        ...requirement.columns.map((column) => `${requirement.table}[${column}]`),
        ...(requirement.measures ?? []).map((measure) => `[${measure}]`),
    ];
}

/** A zero-row query that binds every required object without scanning data. */
export function requirementProbeDax(requirement: ModelObjectRequirement): string {
    const columns = requirement.columns.map((column) => `${daxString(column)}, ${columnRef(requirement.table, column)}`);
    const measures = (requirement.measures ?? []).map((measure) => `${daxString(measure)}, [${measure.replace(/\]/g, "]]")}]`);
    return `EVALUATE TOPN(0, SELECTCOLUMNS(${tableRef(requirement.table)}, ${[...columns, ...measures].join(", ")}))`;
}

/** Classifies one requirement probe's result. Other errors never block the page. */
export function readRequirementProbeState(
    requirement: ModelObjectRequirement,
    result: { loaded: boolean; error?: string },
): RequirementProbeState {
    if (!result.loaded && result.error === undefined) return { status: "checking" };
    if (result.error === undefined) return { status: "ok" };

    const missing = parseMissingModelObject(result.error);
    if (missing?.kind === "column" && (missing.table === undefined || sameName(missing.table, requirement.table))) {
        return { status: "outdated", missing: [`${requirement.table}[${missing.name}]`] };
    }
    if (missing?.kind === "table" && sameName(missing.name, requirement.table)) {
        return { status: "outdated", missing: [`${requirement.table} table`] };
    }
    if (missing?.kind === "measure" && requirement.measures?.some((measure) => sameName(missing.name, measure))) {
        return { status: "outdated", missing: [`[${missing.name}]`] };
    }
    if (isMissingFromModelError(result.error)) {
        return { status: "outdated", missing: requiredLabels(requirement) };
    }
    return { status: "unknown" };
}

/** Combines all probes for a page. Only `outdated` blocks the page queries. */
export function combineRequirementStates(states: readonly RequirementProbeState[]): RequirementProbeState {
    const missing = [...new Set(states.flatMap((state) => (state.status === "outdated" ? state.missing : [])))];
    if (missing.length > 0) return { status: "outdated", missing };
    if (states.every((state) => state.status === "ok")) return { status: "ok" };
    if (states.some((state) => state.status === "checking")) return { status: "checking" };
    return { status: "unknown" };
}
