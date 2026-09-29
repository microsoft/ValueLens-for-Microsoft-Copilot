//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { LucideIcon } from "lucide-react";
import { BookOpen, Gauge, KeyRound, MessageSquareQuote, PoundSterling, TrendingUp, Trophy } from "lucide-react";

/**
 * The six top-level destinations the report pages were folded into, each
 * holding its pages as stages read top to bottom.
 *
 * A stage that is not built yet stays listed so the shape of the destination
 * is visible; a destination is reachable once any of its stages is built.
 */
export const destinations = [
    {
        id: "adoption",
        label: "Adoption",
        blurb: "Who started, who stayed, who stuck",
        icon: TrendingUp as LucideIcon,
        stages: [
            { id: "activation", label: "Activation", ready: true },
            { id: "adoption", label: "Adoption", ready: true },
            { id: "habit-formation", label: "Habit formation", ready: true },
            { id: "trend-heatmap", label: "Trend heatmap", ready: false },
        ],
    },
    {
        id: "leaderboards",
        label: "Leaderboards",
        blurb: "The people and the agents doing the most",
        icon: Trophy as LucideIcon,
        stages: [
            { id: "leaderboard", label: "Leaderboard", ready: true },
            { id: "agent-registry", label: "Agent registry", ready: true },
        ],
    },
    {
        id: "readiness",
        label: "Readiness",
        blurb: "Who to license next, and who is ready for Cowork",
        icon: KeyRound as LucideIcon,
        stages: [
            { id: "license-readiness", label: "License readiness", ready: false },
            { id: "cowork-readiness", label: "Cowork readiness", ready: true },
        ],
    },
    {
        id: "value",
        label: "Value",
        blurb: "What the work was, and what it was worth",
        icon: PoundSterling as LucideIcon,
        stages: [
            { id: "task-breakdown", label: "Task breakdown", ready: true },
            { id: "estimated-value", label: "Estimated value", ready: false },
        ],
    },
    {
        id: "efficiency",
        label: "Efficiency",
        blurb: "Whether the right tool is doing the job",
        icon: Gauge as LucideIcon,
        stages: [
            { id: "cowork-fit", label: "Cowork fit", ready: true },
            { id: "model-fit", label: "Model fit", ready: false },
        ],
    },
    {
        id: "feedback",
        label: "Feedback",
        blurb: "What people say about it",
        icon: MessageSquareQuote as LucideIcon,
        stages: [{ id: "feedback", label: "Feedback", ready: false }],
    },
] as const;

export type Destination = (typeof destinations)[number];
export type DestinationId = Destination["id"];
export type StageId = Destination["stages"][number]["id"];

/** A destination is reachable once any of its stages is built. */
export function isDestinationReady(destination: Destination): boolean {
    return destination.stages.some((stage) => stage.ready);
}

/** The DOM id a stage's section carries, so the sidebar can scroll to it. */
export function stageAnchor(id: StageId): string {
    return `stage-${id}`;
}

/** The reference material that lives in the slide-over drawer, not in the nav. */
export const referenceIcon = BookOpen as LucideIcon;
