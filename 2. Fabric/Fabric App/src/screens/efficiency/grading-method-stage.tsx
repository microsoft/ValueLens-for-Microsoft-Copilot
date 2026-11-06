//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useId, type ReactNode } from "react";
import { ExternalLink, Wrench } from "lucide-react";
import { stageAnchor } from "@/components/destinations";
import { GradeMark } from "@/components/grade-mark";
import { Section } from "@/components/section";
import {
    GRADING_SETTING_NOTE,
    MODEL_TIER_NOTE,
    MODEL_TIERS,
    MODEL_VERDICTS,
    RESEARCH_GROUPS,
    TOOL_CALL_NOTE,
    WORK_WEIGHT_GRADES,
    type GradeRule,
    type ResearchGroup,
} from "@/lib/grading-method";

const SMALL = "text-[length:var(--text-200)] leading-200";
const BODY = "text-[length:var(--text-300)] leading-300";

function RulePanel({
    title,
    lead,
    note,
    children,
}: {
    title: string;
    lead: string;
    note: string;
    children: ReactNode;
}) {
    const headingId = useId();
    return (
        <article aria-labelledby={headingId} className="flex flex-col rounded-xl border border-border bg-card">
            <header className="flex flex-col gap-100 border-b border-border px-500 py-400">
                <h3 id={headingId} className="text-[length:var(--text-400)] leading-400 font-semibold text-foreground">
                    {title}
                </h3>
                <p className={`max-w-[68ch] ${BODY} text-muted-foreground`}>{lead}</p>
            </header>
            {children}
            <p className={`mt-auto border-t border-border px-500 py-300 ${SMALL} text-muted-foreground`}>{note}</p>
        </article>
    );
}

function RuleList({ rules }: { rules: readonly GradeRule[] }) {
    return (
        <dl className="flex flex-col divide-y divide-border px-500">
            {rules.map((rule) => (
                <div
                    key={rule.name}
                    className="grid items-start gap-100 py-300 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-500"
                >
                    <dt className={`flex min-h-[20px] items-center gap-200 ${BODY} font-semibold text-foreground`}>
                        <GradeMark tone={rule.tone} icon={rule.icon} />
                        {rule.name}
                    </dt>
                    <dd className="flex flex-col gap-100">
                        <span className={`${BODY} text-foreground`}>{rule.rule}</span>
                        {rule.decidedBy && (
                            <span className={`${SMALL} text-muted-foreground`}>
                                Shown as: {rule.decidedBy.join(" · ")}
                            </span>
                        )}
                    </dd>
                </div>
            ))}
        </dl>
    );
}

function TierList() {
    return (
        <dl className="flex flex-col gap-200 border-b border-border bg-muted/50 px-500 py-300">
            {MODEL_TIERS.map((tier) => (
                <div key={tier.name} className="grid gap-100-nudge sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-500">
                    <dt className={`${SMALL} font-semibold text-foreground`}>{tier.name}</dt>
                    <dd className={`${SMALL} text-muted-foreground`}>{tier.models}</dd>
                </div>
            ))}
        </dl>
    );
}

function ResearchTable({ group }: { group: ResearchGroup }) {
    const headingId = useId();
    const rowGrid = "lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)_minmax(0,1fr)] lg:gap-500";
    return (
        <section aria-labelledby={headingId} className="rounded-xl border border-border bg-card">
            <h4
                id={headingId}
                className={`border-b border-border px-500 py-300 ${BODY} font-semibold text-foreground`}
            >
                {group.title}
            </h4>
            <div aria-hidden="true" className={`hidden border-b border-border px-500 py-200 lg:grid ${rowGrid}`}>
                <span className={`${SMALL} text-muted-foreground`}>Source</span>
                <span className={`${SMALL} text-muted-foreground`}>What it found</span>
                <span className={`${SMALL} text-muted-foreground`}>How it shaped the grading</span>
            </div>
            <ul className="flex flex-col divide-y divide-border px-500">
                {group.sources.map((source) => (
                    <li key={source.url} className={`grid gap-200 py-300 ${rowGrid}`}>
                        <div className="flex flex-col gap-100-nudge">
                            <a
                                href={source.url}
                                target="_blank"
                                rel="noreferrer"
                                className={`${BODY} font-semibold text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
                            >
                                {source.title}
                                <ExternalLink
                                    className="icon-size-100 ml-100 inline-block -translate-y-[1px] align-middle"
                                    aria-hidden="true"
                                />
                                <span className="sr-only">(opens in a new tab)</span>
                            </a>
                            <span className={`${SMALL} text-muted-foreground`}>
                                {source.publisher}
                                {source.year ? ` · ${source.year}` : ""}
                            </span>
                        </div>
                        <p className={`${BODY} text-foreground`}>
                            <span className="font-semibold lg:sr-only">What it found: </span>
                            {source.finding}
                        </p>
                        <p className={`${BODY} text-muted-foreground`}>
                            <span className="font-semibold text-foreground lg:sr-only">How it shaped the grading: </span>
                            {source.use}
                        </p>
                    </li>
                ))}
            </ul>
        </section>
    );
}

/**
 * The method behind both Efficiency stages: the work weight grade Cowork fit
 * reports, the cost tiers Model fit sets against it, and the published
 * research that loosely informed where the lines sit. Static copy; the
 * semantic model does the grading.
 */
export function GradingMethodStage() {
    const researchId = useId();
    return (
        <Section
            id={stageAnchor("grading-method")}
            title="How grading works"
            description="The rules behind Cowork fit and Model fit, and the research that loosely informed them. The grade reads what a session touched, never the prompt or the answer, so a flag is a prompt to coach, not a verdict on anyone's work."
        >
            <div className="grid items-stretch gap-400 xl:grid-cols-2">
                <RulePanel
                    title="Work weight"
                    lead="One grade per session, from the apps and sources it touched. Cowork fit reports it for Cowork sessions; Model fit sets it against the cost of the model used."
                    note={GRADING_SETTING_NOTE}
                >
                    <RuleList rules={WORK_WEIGHT_GRADES} />
                </RulePanel>
                <RulePanel
                    title="Model cost"
                    lead="Each logged model falls in a cost tier. A session's verdict compares that tier with its work weight."
                    note={MODEL_TIER_NOTE}
                >
                    <TierList />
                    <RuleList rules={MODEL_VERDICTS} />
                </RulePanel>
            </div>

            <div role="group" aria-labelledby={researchId} className="flex flex-col gap-300">
                <div className="flex flex-col gap-100">
                    <h3 id={researchId} className="text-[length:var(--text-400)] leading-400 font-semibold text-foreground">
                        Research behind it
                    </h3>
                    <p className={`max-w-[80ch] ${BODY} text-muted-foreground`}>
                        None of these sources grades Copilot sessions. They informed where the lines sit, and the
                        thresholds are ValueLens's own.
                    </p>
                </div>
                {RESEARCH_GROUPS.map((group) => (
                    <ResearchTable key={group.id} group={group} />
                ))}
                <p className={`flex max-w-[80ch] items-start gap-200 ${BODY} text-muted-foreground`}>
                    <Wrench className="icon-size-200 mt-[3px] shrink-0" aria-hidden="true" />
                    <span>{TOOL_CALL_NOTE}</span>
                </p>
            </div>
        </Section>
    );
}
