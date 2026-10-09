//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { LucideIcon } from "lucide-react";
import {
    BookOpen,
    BotMessageSquare,
    Briefcase,
    Coins,
    Gauge,
    KeyRound,
    LayoutDashboard,
    MessageSquareQuote,
    PoundSterling,
    ShieldCheck,
    Timer,
    TrendingUp,
    Trophy,
} from "lucide-react";
import { isConnectionConfigured, type ModelReferences } from "@/lib/connections";
import type { FilterKey } from "@/lib/filters";
import { isAbsent, type SourceAvailability } from "@/lib/optional-sources";
import { consumptionConnection, evaluatorConnection } from "@/queries/shared";

/**
 * The top-level destinations the report pages were folded into, each
 * holding its pages as stages read top to bottom, plus the app's assumptions
 * and the report's appendix as reference destinations below them. Consumption and Agent Evaluation
 * come from their own reports, Consumption Central and Agent Evaluator, and
 * bring their own slicers, so they take none of the filter bar's. Their
 * `connection` is optional: without it in `fabric.yaml` they are left out.
 * A destination with a `source` reads an optional module of the ValueLens
 * model, and is left out once the app has checked that source has no data.
 * Governance reads only the Agent 365 registry, but stays listed without it
 * and says how to connect it.
 *
 * A stage that is not built yet stays listed so the shape of the destination
 * is visible; a destination is reachable once any of its stages is built.
 * `filters` are the slicers the destination responds to, taken from the ones
 * the report placed on its pages; the destination id doubles as its palette.
 * A `reference` destination holds definitions rather than activity, so it has
 * no filters and sits apart in the sidebar.
 *
 * The executive summary comes first and is where the app opens: one page
 * drawing on the others, each of its panels linking to the destination
 * that tells that part of the story in full.
 */
export const destinations = [
    {
        id: "executive",
        label: "Executive summary",
        blurb: "What Copilot is delivering, and where",
        icon: LayoutDashboard as LucideIcon,
        filters: ["dateRange", "organizations"] as FilterKey[],
        stages: [
            { id: "the-bottom-line", label: "The bottom line", ready: true },
            { id: "is-it-growing", label: "Is it growing?", ready: true },
            { id: "where-it-is-landing", label: "Where it is landing", ready: true },
            { id: "what-needs-attention", label: "What needs attention", ready: true },
        ],
    },
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
            { id: "agents", label: "Agents", ready: true },
        ],
    },
    {
        id: "work-patterns",
        label: "Work patterns",
        blurb: "How people work across Microsoft 365, and where Copilot fits",
        icon: Briefcase as LucideIcon,
        filters: ["dateRange", "organizations"] as FilterKey[],
        source: "m365Activity",
        stages: [
            { id: "m365-activity", label: "Microsoft 365 activity", ready: true },
            { id: "m365-suite", label: "Apps and devices", ready: true },
            { id: "m365-copilot", label: "Copilot in the flow of work", ready: true },
        ],
    },
    {
        id: "agent-evaluation",
        label: "Agent Evaluation",
        blurb: "How well your agents answer, and where they fall short",
        icon: BotMessageSquare as LucideIcon,
        filters: [] as FilterKey[],
        connection: evaluatorConnection,
        stages: [
            { id: "agent-performance", label: "Performance", ready: true },
            { id: "agent-conversations", label: "Conversations & topics", ready: true },
        ],
    },
    {
        id: "governance",
        label: "Governance",
        blurb: "Who owns your agents, who can reach them, and what needs a review",
        icon: ShieldCheck as LucideIcon,
        filters: ["agentTypes"] as FilterKey[],
        stages: [
            { id: "estate-health", label: "Estate health", ready: true },
            { id: "exposure", label: "Exposure", ready: true },
            { id: "accountability", label: "Accountability", ready: true },
            { id: "review-queue", label: "Review queue", ready: true },
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
            { id: "habit-licence", label: "Heavy users without a licence", ready: true },
            { id: "cowork-readiness", label: "Cowork readiness", ready: true },
        ],
    },
    {
        id: "consumption",
        label: "Consumption",
        blurb: "Credits used, and what they cost",
        icon: Coins as LucideIcon,
        filters: [] as FilterKey[],
        connection: consumptionConnection,
        stages: [
            { id: "consumption-overview", label: "All products", ready: true },
            { id: "budget-runway", label: "Budget runway", ready: true },
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
            { id: "value-by-habit", label: "Value by habit", ready: true },
            { id: "cost-vs-value", label: "Cost vs value", ready: true },
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
        source: "productFeedback",
        stages: [{ id: "feedback", label: "Feedback", ready: true }],
    },
    {
        id: "assumptions",
        label: "Assumptions",
        blurb: "The task times behind every value figure",
        icon: Timer as LucideIcon,
        filters: [] as FilterKey[],
        reference: true,
        stages: [{ id: "time-per-task", label: "Time per task", ready: true }],
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
export type Stage = Destination["stages"][number];
export type StageId = Stage["id"];

/** A destination is reachable once any of its stages is built. */
export function isDestinationReady(destination: Destination): boolean {
    return destination.stages.some((stage) => stage.ready);
}

/** Reference destinations hold definitions rather than activity. */
export function isReference(destination: Destination): boolean {
    return "reference" in destination && destination.reference;
}

/**
 * Every destination except those reading a model `fabric.yaml` doesn't set
 * up, and, once `sources` has been checked, those whose source has no data.
 */
export function availableDestinations(models: ModelReferences, sources?: SourceAvailability): Destination[] {
    return destinations.filter(
        (destination) =>
            (!("connection" in destination) || isConnectionConfigured(models, destination.connection)) &&
            (!sources || !("source" in destination) || !isAbsent(sources, destination.source)),
    );
}

/** The DOM id a stage's section carries, so the sidebar can scroll to it. */
export function stageAnchor(id: StageId): string {
    return `stage-${id}`;
}
