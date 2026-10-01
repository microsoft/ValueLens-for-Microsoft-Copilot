//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { LucideIcon } from "lucide-react";
import { BookOpen, BotMessageSquare, Coins, Gauge, KeyRound, MessageSquareQuote, PoundSterling, TrendingUp, Trophy } from "lucide-react";
import type { FilterKey } from "@/lib/filters";

/**
 * The top-level destinations the report pages were folded into, each
 * holding its pages as stages read top to bottom, plus the report's appendix
 * as a reference destination below them. Consumption and Agent Evaluation
 * come from their own reports, Consumption Central and Agent Evaluator, and
 * bring their own slicers, so they take none of the filter bar's.
 *
 * A stage that is not built yet stays listed so the shape of the destination
 * is visible; a destination is reachable once any of its stages is built.
 * `filters` are the slicers the destination responds to, taken from the ones
 * the report placed on its pages; the destination id doubles as its palette.
 * A `reference` destination holds definitions rather than activity, so it has
 * no filters and sits apart in the sidebar.
 */
export const destinations = [
    {
        id: "adoption",
        label: "Adoption",
        blurb: "Who started, who stayed, who stuck",
        icon: TrendingUp as LucideIcon,
        filters: ["dateRange", "organizations", "licence", "audience", "agentTypes", "agentNames"] as FilterKey[],
        stages: [
            { id: "activation", label: "Activation", ready: true },
            { id: "adoption", label: "Adoption", ready: true },
            { id: "habit-formation", label: "Habit formation", ready: true },
            { id: "trend-heatmap", label: "Trend heatmap", ready: true },
        ],
    },
    {
        id: "leaderboards",
        label: "Leaderboards",
        blurb: "The people and the agents doing the most",
        icon: Trophy as LucideIcon,
        filters: ["dateRange", "organizations", "licence", "audience", "agentTypes", "agentNames"] as FilterKey[],
        stages: [
            { id: "leaderboard", label: "Leaderboard", ready: true },
            { id: "agent-registry", label: "Agent registry", ready: true },
        ],
    },
    {
        id: "agent-evaluation",
        label: "Agent Evaluation",
        blurb: "How well your agents answer, and where they fall short",
        icon: BotMessageSquare as LucideIcon,
        filters: [] as FilterKey[],
        stages: [
            { id: "agent-performance", label: "Performance", ready: true },
            { id: "agent-conversations", label: "Conversations & topics", ready: true },
        ],
    },
    {
        id: "readiness",
        label: "Readiness",
        blurb: "Who to license next, and who is ready for Cowork",
        icon: KeyRound as LucideIcon,
        filters: ["dateRange", "organizations"] as FilterKey[],
        stages: [
            { id: "license-readiness", label: "License readiness", ready: true },
            { id: "cowork-readiness", label: "Cowork readiness", ready: true },
        ],
    },
    {
        id: "consumption",
        label: "Consumption",
        blurb: "Credits used, and what they cost",
        icon: Coins as LucideIcon,
        filters: [] as FilterKey[],
        stages: [
            { id: "consumption-overview", label: "All products", ready: true },
            { id: "cowork-credits", label: "Cowork / Work IQ", ready: true },
            { id: "studio-credits", label: "Copilot Studio", ready: true },
            { id: "azure-spend", label: "Azure", ready: true },
        ],
    },
    {
        id: "value",
        label: "Value",
        blurb: "What the work was, and what it was worth",
        icon: PoundSterling as LucideIcon,
        filters: ["dateRange", "organizations", "licence", "audience", "agentTypes", "agentNames"] as FilterKey[],
        stages: [
            { id: "task-breakdown", label: "Task breakdown", ready: true },
            { id: "estimated-value", label: "Estimated value", ready: true },
        ],
    },
    {
        id: "efficiency",
        label: "Efficiency",
        blurb: "Whether the right tool is doing the job",
        icon: Gauge as LucideIcon,
        filters: ["dateRange", "organizations", "licence", "audience", "agentTypes", "agentNames"] as FilterKey[],
        stages: [
            { id: "cowork-fit", label: "Cowork fit", ready: true },
            { id: "model-fit", label: "Model fit", ready: true },
            { id: "grading-method", label: "How grading works", ready: true },
        ],
    },
    {
        id: "feedback",
        label: "Feedback",
        blurb: "What people say about it",
        icon: MessageSquareQuote as LucideIcon,
        filters: ["dateRange"] as FilterKey[],
        stages: [{ id: "feedback", label: "Feedback", ready: true }],
    },
    {
        id: "appendix",
        label: "Appendix",
        blurb: "What each metric means, and the value assumptions",
        icon: BookOpen as LucideIcon,
        filters: [] as FilterKey[],
        reference: true,
        stages: [
            { id: "glossary", label: "Glossary", ready: true },
            { id: "signal-impact", label: "Signal → Impact", ready: true },
        ],
    },
] as const;

export type Destination = (typeof destinations)[number];
export type DestinationId = Destination["id"];
export type StageId = Destination["stages"][number]["id"];

/** A destination is reachable once any of its stages is built. */
export function isDestinationReady(destination: Destination): boolean {
    return destination.stages.some((stage) => stage.ready);
}

/** Reference destinations hold definitions rather than activity. */
export function isReference(destination: Destination): boolean {
    return "reference" in destination && destination.reference;
}

/** The DOM id a stage's section carries, so the sidebar can scroll to it. */
export function stageAnchor(id: StageId): string {
    return `stage-${id}`;
}
