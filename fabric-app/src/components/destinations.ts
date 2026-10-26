//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { LucideIcon } from "lucide-react";
import {
    Banknote,
    BookOpen,
    Briefcase,
    Coins,
    Gauge,
    KeyRound,
    LayoutDashboard,
    MessageSquareQuote,
    ShieldCheck,
    Sparkles,
    Timer,
    TrendingUp,
    Trophy,
} from "lucide-react";
import { isConnectionConfigured, type ModelReferences } from "@/lib/connections";
import type { FilterKey } from "@/lib/filters";
import { isAbsent, type SourceAvailability } from "@/lib/optional-sources";
import { connection, consumptionConnection } from "@/queries/shared";

/**
 * The top-level destinations the report pages were folded into, each
 * holding its pages as stages read top to bottom, plus the app's assumptions
 * and the report's appendix as reference destinations below them. Every
 * destination but Ask names the model it reads as its `connection`: the
 * ValueLens model (`vl`) or Consumption Central's (`cc`). A destination whose
 * model this install doesn't have is left out, so an app with only one of the
 * two models shows only that product. Ask reads whichever models there are.
 * A destination with a `source` reads an optional module of the ValueLens
 * model, and is left out once the app has checked that source has no data.
 * Governance reads the Agent 365 registry, plus the optional Defender source
 * for its Shadow AI stage, and stays listed without either, saying how to
 * connect them.
 *
 * A stage that is not built yet stays listed so the shape of the destination
 * is visible; a destination is reachable once any of its stages is built.
 * `filters` are the slicers the destination responds to, taken from the ones
 * the report placed on its pages; the destination id doubles as its palette.
 * A `reference` destination holds definitions rather than activity, so it has
 * no filters and sits apart in the sidebar. Ask takes no filters either: the
 * question says what period and organisations it is about. It is
 * `conversational`, so it can't go in a report pack. A destination on
 * another model lists the filters its queries' profiles can take (see
 * `filter-profiles.ts`); a card that still can't take one says so.
 *
 * Each destination belongs to a `product`, one of the two apps in the
 * band's switcher, and may carry a shorter `tab` name. Ask and the
 * assumptions have `placement: "band"`: they sit beside the switcher.
 *
 * The executive summary comes first and is where the app opens: one page
 * drawing on the others, each of its panels linking to the destination
 * that tells that part of the story in full. The rest follow in the order
 * the sidebar lists them and the background loader warms them: who is
 * using it (Adoption), whether it is paying off (Value, Consumption,
 * Efficiency), who does the most and how people work, who is next, the
 * agents, then what people say.
 */
export const destinations = [
    {
        id: "executive",
        label: "Executive summary",
        tab: "Summary",
        product: "valuelens",
        connection,
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
        product: "valuelens",
        connection,
        label: "Adoption",
        blurb: "Who started, who stayed, who stuck",
        icon: TrendingUp as LucideIcon,
        filters: ["dateRange", "organizations", "licence", "audience", "agentTypes", "agentNames"] as FilterKey[],
        stages: [
            { id: "adoption", label: "Adoption", ready: true },
            { id: "activation", label: "Activation", ready: true },
            { id: "habit-formation", label: "Habit formation", ready: true },
            { id: "trend-heatmap", label: "Trend heatmap", ready: true },
        ],
    },
    {
        id: "value",
        product: "valuelens",
        connection,
        label: "Value",
        blurb: "What the work was, and what it was worth",
        icon: Banknote as LucideIcon,
        filters: ["dateRange", "organizations", "licence", "audience", "agentTypes", "agentNames"] as FilterKey[],
        stages: [
            { id: "task-breakdown", label: "Task breakdown", ready: true },
            { id: "estimated-value", label: "Estimated value", ready: true },
            { id: "value-by-habit", label: "Value by habit", ready: true },
            { id: "cost-vs-value", label: "Cost vs value", ready: true },
        ],
    },
    {
        id: "consumption",
        product: "consumption",
        label: "Consumption",
        blurb: "Credits used, and what they cost",
        icon: Coins as LucideIcon,
        filters: ["dateRange", "organizations", "agentNames"] as FilterKey[],
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
        id: "efficiency",
        product: "valuelens",
        connection,
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
        id: "leaderboards",
        product: "valuelens",
        connection,
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
        product: "valuelens",
        connection,
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
        id: "readiness",
        product: "valuelens",
        connection,
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
        id: "governance",
        product: "valuelens",
        connection,
        label: "Governance",
        blurb: "Who owns your agents, who can reach them, and what needs a review",
        icon: ShieldCheck as LucideIcon,
        filters: ["agentTypes", "agentNames"] as FilterKey[],
        stages: [
            { id: "estate-health", label: "Estate health", ready: true },
            { id: "exposure", label: "Exposure", ready: true },
            { id: "accountability", label: "Accountability", ready: true },
            { id: "review-queue", label: "Review queue", ready: true },
            { id: "shadow-ai", label: "Shadow AI", ready: true },
        ],
    },
    {
        id: "feedback",
        product: "valuelens",
        connection,
        label: "Feedback",
        blurb: "What people say about it",
        icon: MessageSquareQuote as LucideIcon,
        filters: ["dateRange", "agentTypes", "agentNames"] as FilterKey[],
        source: "productFeedback",
        stages: [{ id: "feedback", label: "Feedback", ready: true }],
    },
    {
        id: "ask",
        product: "valuelens",
        placement: "band",
        label: "Ask",
        blurb: "Questions about the data, in your own words",
        icon: Sparkles as LucideIcon,
        filters: [] as FilterKey[],
        conversational: true,
        stages: [{ id: "ask", label: "Ask", ready: true }],
    },
    {
        id: "assumptions",
        product: "valuelens",
        connection,
        placement: "band",
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
        tab: "Guide",
        product: "valuelens",
        connection,
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

/**
 * The two products this app can show, each in the band's switcher:
 * ValueLens (adoption and value) and Consumption Central (credits and cost).
 * Which of them an install shows depends on its variant and on which models
 * it found (see `app-variant.ts`). A product with one destination shows that
 * destination's stages as its tabs; one with several shows the destinations.
 */
export const products = [
    { id: "valuelens", label: "ValueLens", blurb: "Adoption, value and readiness" },
    { id: "consumption", label: "Consumption Central", blurb: "Credits used, and what they cost" },
] as const;

export type Product = (typeof products)[number];
export type ProductId = Product["id"];

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

/** Whether a destination's stages can go in a report pack: not a conversation like Ask. */
export function isPackable(destination: Destination): boolean {
    return !("conversational" in destination && destination.conversational);
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

/** The product a destination belongs to. */
export function productOf(destination: Destination): ProductId {
    return destination.product;
}

/** The name a destination takes as a tab: shorter than its page title where one is set. */
export function tabLabel(destination: Destination): string {
    return "tab" in destination ? destination.tab : destination.label;
}

/**
 * Ask and the assumptions sit in the band beside the switcher rather than
 * among any product's tabs: Ask answers across every model, and the
 * assumptions price every value figure.
 */
export function isBandDestination(destination: Destination): boolean {
    return "placement" in destination && destination.placement === "band";
}

/** The products with at least one available destination, in switcher order. */
export function availableProducts(available: readonly Destination[]): Product[] {
    return products.filter((product) =>
        available.some((destination) => destination.product === product.id && !isBandDestination(destination)),
    );
}

/** A product's destinations that appear as its tabs, in order. */
export function productDestinations(available: readonly Destination[], product: ProductId): Destination[] {
    return available.filter((destination) => destination.product === product && !isBandDestination(destination));
}

/** The DOM id a stage's section carries, so a link can bring it into view. */
export function stageAnchor(id: StageId): string {
    return `stage-${id}`;
}

/**
 * The stage a destination shows: `wanted` when it is one of its built
 * stages, otherwise its first. A destination shows one stage at a time, so
 * opening a page only queries what is on screen.
 */
export function openStage(
    destination: { readonly stages: readonly { readonly id: StageId; readonly ready: boolean }[] },
    wanted?: StageId,
): StageId | undefined {
    const built = destination.stages.filter((stage) => stage.ready);
    return (built.find((stage) => stage.id === wanted) ?? built[0])?.id;
}
