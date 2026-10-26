//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * The rules behind Cowork fit and Model fit, in plain words, and the published
 * research that loosely informed them. The rules restate the semantic model's
 * `Fit Rule Step`, `Work Weight Grade`, `Model Cost Tier` and `Model:` verdict
 * logic at its default Balanced setting; they are not computed here.
 */

import { ArrowDown, ArrowUp, Check, Minus, type LucideIcon } from "lucide-react";

export type GradeTone = "positive" | "negative" | "caution" | "neutral" | "none";

export interface GradeRule {
    name: string;
    tone: GradeTone;
    rule: string;
    /** How the model's "Decided by" column words this grade. */
    decidedBy?: readonly string[];
    /** The glyph the report draws inside its verdict icon. */
    icon?: LucideIcon;
}

export const WORK_WEIGHT_GRADES: readonly GradeRule[] = [
    {
        name: "Strong fit",
        tone: "positive",
        rule: "Spans two or more apps, builds or packages a file, or draws on many sources: three or more items of at least two kinds, or more than five items.",
        decidedBy: ["Spans apps", "Built or packaged an artifact", "Multi-source synthesis"],
    },
    {
        name: "Fair fit",
        tone: "neutral",
        rule: "Some sources (three or more items, or two kinds), messages read with nothing attached, or work kept inside one app.",
        decidedBy: ["Mixed or repeated sources", "Read messages", "Worked in one app"],
    },
    {
        name: "Worth a look",
        tone: "caution",
        rule: "Chat with nothing read or attached. Everyday Copilot Chat could probably have done it.",
        decidedBy: ["Chat only, nothing attached"],
    },
    {
        name: "Too light to grade",
        tone: "none",
        rule: "Too little recorded to place. Left out of every share.",
    },
];

// Models built before the grades were renamed carry High, Medium and Low fit.
const GRADE_ALIASES: Record<string, string> = {
    "strong fit": "Strong fit",
    "high fit": "Strong fit",
    "fair fit": "Fair fit",
    "medium fit": "Fair fit",
    "worth a look": "Worth a look",
    "low fit": "Worth a look",
    unclassified: "Too light to grade",
    "too light to grade": "Too light to grade",
};

// Work Weight Grade Sort has run 0 (strongest) to 3 (unclassified) in every model version.
const GRADE_BY_SORT = ["Strong fit", "Fair fit", "Worth a look", "Too light to grade"] as const;

/**
 * The grade rule for a model `Work Weight Grade` value, under either naming,
 * falling back to its sort position for a name this app has not seen.
 */
export function workWeightGrade(value: unknown, sort?: unknown): GradeRule | undefined {
    const alias = typeof value === "string" ? GRADE_ALIASES[value.trim().toLowerCase()] : undefined;
    const bySort = typeof sort === "number" && Number.isInteger(sort) ? GRADE_BY_SORT[sort] : undefined;
    const name = alias ?? bySort;
    return name ? WORK_WEIGHT_GRADES.find((grade) => grade.name === name) : undefined;
}

export const GRADING_SETTING_NOTE =
    "Shown at the Balanced setting. Strict moves message-reading and one-app work down to Worth a look; Lenient lifts longer chats to Fair fit. The setting lives in the semantic model's Assumptions table.";

export interface ModelTier {
    name: string;
    models: string;
}

export const MODEL_TIERS: readonly ModelTier[] = [
    { name: "Frontier (premium cost)", models: "Claude Opus, GPT-6" },
    { name: "Workhorse (mid cost)", models: "Claude Sonnet and other Claude models, GPT-5, GPT-4" },
];

export const MODEL_TIER_NOTE =
    "A session takes the dearest tier logged in its thread. Tiers follow published per-million-token list prices; the audit feed carries no per-call cost.";

export const MODEL_VERDICTS: readonly GradeRule[] = [
    { name: "Good match", tone: "positive", icon: Check, rule: "The model's cost tier suits the weight of the work." },
    {
        name: "Lighter model may do",
        tone: "negative",
        icon: ArrowDown,
        rule: "A Frontier model on work graded Worth a look.",
    },
    {
        name: "Try stronger",
        tone: "caution",
        icon: ArrowUp,
        rule: "A Workhorse model on Strong-fit work, where Cowork or a Frontier model may do better.",
    },
    {
        name: "Not judged",
        tone: "neutral",
        icon: Minus,
        rule: "No model logged, or the work was too light to grade. A segment needs five judged sessions before it gets a verdict.",
    },
];

export interface ResearchSource {
    title: string;
    publisher: string;
    /** Left out for living documentation pages. */
    year?: number;
    url: string;
    /** What the source says, kept to claims checked against it. */
    finding: string;
    /** How it shaped the grading. */
    use: string;
}

export interface ResearchGroup {
    id: string;
    title: string;
    sources: readonly ResearchSource[];
}

export const RESEARCH_GROUPS: readonly ResearchGroup[] = [
    {
        id: "complexity",
        title: "Complexity, tool use and model choice",
        sources: [
            {
                title: "GPT-5 System Card",
                publisher: "OpenAI",
                year: 2025,
                url: "https://openai.com/index/gpt-5-system-card/",
                finding:
                    "A real-time router picks between a fast model and a deeper reasoning model from the conversation type, its complexity, the tools it needs and explicit intent.",
                use: "Complexity and tool needs are the signals Model fit weighs against the cost of the model used.",
            },
            {
                title: "How we built our multi-agent research system",
                publisher: "Anthropic",
                year: 2025,
                url: "https://www.anthropic.com/engineering/multi-agent-research-system",
                finding:
                    "Token usage, the number of tool calls and the model chosen explained 95% of performance variance on the BrowseComp evaluation.",
                use: "Tool use tracks how heavy a task is, which is why the grade reads the apps and sources a session reached for.",
            },
            {
                title: "Reasoning best practices",
                publisher: "OpenAI",
                url: "https://platform.openai.com/docs/guides/reasoning-best-practices",
                finding:
                    "Reasoning models suit ambiguous, multistep problems; GPT models suit straightforward, well-defined tasks where speed and cost matter most.",
                use: "Behind Lighter model may do: a premium model on light work spends more than the work needs.",
            },
            {
                title: "A practical guide to building agents",
                publisher: "OpenAI",
                year: 2025,
                url: "https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf",
                finding:
                    "Prototype with the most capable model, then swap in smaller models wherever results hold up. Agents earn their keep on complex decisions and unstructured data.",
                use: "Behind Try stronger: heavy, multi-source work is where a more capable model or Cowork is worth trying.",
            },
            {
                title: "Available today: GPT-5 in Microsoft 365 Copilot",
                publisher: "Microsoft",
                year: 2025,
                url: "https://www.microsoft.com/en-us/microsoft-365/blog/2025/08/07/available-today-gpt-5-in-microsoft-365-copilot/",
                finding:
                    "Copilot uses GPT-5's router to answer simple prompts quickly and send complex, open-ended ones to deeper reasoning.",
                use: "The same split, simple against complex, that the work weight grade draws for each session.",
            },
        ],
    },
    {
        id: "weight",
        title: "Weight and length of the work",
        sources: [
            {
                title: "GDPval: evaluating AI model performance on real-world economically valuable tasks",
                publisher: "OpenAI",
                year: 2025,
                url: "https://openai.com/index/gdpval/",
                finding:
                    "Tests models on real work across 44 occupations, built from the tasks of professionals averaging 14 years' experience. More reasoning effort, context and scaffolding improved results.",
                use: "Its tasks pair reference files with a finished deliverable: the shape of work graded Strong fit.",
            },
            {
                title: "Measuring AI ability to complete long tasks",
                publisher: "METR",
                year: 2025,
                url: "https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/",
                finding:
                    "The length of task frontier agents finish with 50% reliability has doubled roughly every seven months for six years.",
                use: "Why longer, multi-step work is the kind worth handing to an agent such as Cowork.",
            },
            {
                title: "Building effective agents",
                publisher: "Anthropic",
                year: 2024,
                url: "https://www.anthropic.com/engineering/building-effective-agents",
                finding:
                    "Find the simplest solution that works; agentic systems trade latency and cost for better task performance.",
                use: "Why chat-only work handed to Cowork is flagged Worth a look.",
            },
            {
                title: "Working with AI: measuring the applicability of generative AI to occupations",
                publisher: "Microsoft Research",
                year: 2025,
                url: "https://arxiv.org/abs/2507.07935",
                finding:
                    "Maps 200,000 anonymised Bing Copilot conversations to the work activities they serve; most occupations have an information-work component.",
                use: "Supports reading Copilot use by the work it serves, as Task Category and Task Breakdown do.",
            },
        ],
    },
    {
        id: "evidence",
        title: "What the audit log records",
        sources: [
            {
                title: "Copilot schema in the Office 365 Management Activity API",
                publisher: "Microsoft Learn",
                url: "https://learn.microsoft.com/en-us/office/office-365-management-api/copilot-schema",
                finding:
                    "Each Copilot interaction record lists the resources it accessed and the plugins it called. Messages carry an ID, a size and a prompt flag, not their text.",
                use: "The evidence the grade reads: what a session touched, never the prompt or the answer.",
            },
        ],
    },
];

export const TOOL_CALL_NOTE =
    "Tool calls are not counted in the grade yet. The audit record lists the plugins and connectors each session calls, and the research above ties tool use to how heavy a task is, so counting them is a candidate refinement to the fit rule.";
