//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * The four cohorts every Work query carries side by side.
 *
 * Licensed and Unlicensed partition the population. Agent is an orthogonal
 * subset overlapping both, so the four task counts deliberately do not sum to
 * the total — a user with a licence who runs an agent is counted in two.
 */
export type WorkCohort = "all" | "licensed" | "unlicensed" | "agents";

const taskFields: Record<WorkCohort, string> = {
    all: "All Tasks",
    licensed: "Licensed Tasks",
    unlicensed: "Unlicensed Tasks",
    agents: "Agent Tasks",
};

/** The four Work cohorts, in reading order. */
export const workCohorts: { id: WorkCohort; label: string }[] = [
    { id: "all", label: "Everyone" },
    { id: "licensed", label: "Licensed" },
    { id: "unlicensed", label: "Unlicensed" },
    { id: "agents", label: "Agents" },
];

/** The task-count column a cohort binds to, shared by every Work query. */
export function cohortTaskField(cohort: WorkCohort): string {
    return taskFields[cohort];
}
