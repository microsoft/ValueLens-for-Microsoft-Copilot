//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useDeferredValue, useId, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { destinations, stageAnchor } from "@/components/destinations";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { formatKpi } from "@/lib/format-kpi";
import { GLOSSARY_PAGE_HOME, highlightParts, searchGlossary, toGlossaryPages, type GlossaryPage } from "@/lib/glossary";
import { toRecords } from "@/lib/summary-row";
import { cn } from "@/lib/utils";
import { glossary } from "@/queries/appendix";

function prefersReducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function pageAnchor(page: string): string {
    return `glossary-${page.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/** "Adoption › Activation" for a report page the app folded into a stage. */
function appLocation(page: string): string | undefined {
    const home = GLOSSARY_PAGE_HOME[page];
    if (!home) return undefined;
    const destination = destinations.find((candidate) => candidate.id === home.destination);
    if (!destination) return undefined;
    const stage = home.stage && destination.stages.find((candidate) => candidate.id === home.stage);
    return stage && stage.label !== destination.label ? `${destination.label} › ${stage.label}` : destination.label;
}

function Highlighted({ text, term }: { text: string; term: string }) {
    return (
        <>
            {highlightParts(text, term).map((part, index) =>
                part.match ? (
                    <mark
                        key={index}
                        className="rounded-[2px] bg-[color-mix(in_srgb,var(--color-brand)_22%,transparent)] text-inherit"
                    >
                        {part.text}
                    </mark>
                ) : (
                    part.text
                ),
            )}
        </>
    );
}

function PageCard({ page, term }: { page: GlossaryPage; term: string }) {
    const headingId = useId();
    const location = appLocation(page.page);

    return (
        <article
            id={pageAnchor(page.page)}
            aria-labelledby={headingId}
            tabIndex={-1}
            className="scroll-mt-600 rounded-xl border border-border bg-card outline-none"
        >
            <header className="flex flex-col gap-100 border-b border-border px-500 py-400">
                <div className="flex flex-wrap items-baseline justify-between gap-x-400 gap-y-100">
                    <h3 id={headingId} className="text-[length:var(--text-400)] leading-400 font-semibold text-foreground">
                        <Highlighted text={page.page} term={term} />
                    </h3>
                    {location && (
                        <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">
                            In the app: <span className="font-semibold text-primary">{location}</span>
                        </span>
                    )}
                </div>
                {page.description && (
                    <p className="max-w-[80ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">
                        {page.description}
                    </p>
                )}
            </header>
            <dl className="flex flex-col divide-y divide-border px-500">
                {page.entries.map((entry) => (
                    <div
                        key={entry.metric}
                        className="grid gap-100 py-300 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:gap-600"
                    >
                        <dt className="text-[length:var(--text-300)] leading-300 font-semibold text-foreground">
                            <Highlighted text={entry.metric} term={term} />
                        </dt>
                        <dd className="max-w-[80ch] text-[length:var(--text-300)] leading-300 text-foreground">
                            <Highlighted text={entry.description} term={term} />
                        </dd>
                    </div>
                ))}
            </dl>
        </article>
    );
}

/**
 * The report's Metric Glossary: every metric defined page by page, searchable,
 * with a note of where each report page now lives in the app. The report
 * showed one page at a time behind a slicer; here the pages read as one
 * document with an index beside it.
 */
export function GlossaryStage() {
    const config = glossary();
    const result = useFilteredQuery({ connection: config.connection, query: config.query });
    const [term, setTerm] = useState("");
    const deferredTerm = useDeferredValue(term);
    const searchId = useId();

    const pages = useMemo(
        () => (result.data?.status === "success" ? toGlossaryPages(toRecords(result.data.table)) : undefined),
        [result.data],
    );
    const visible = useMemo(() => (pages ? searchGlossary(pages, deferredTerm) : []), [pages, deferredTerm]);
    const metricCount = visible.reduce((total, page) => total + page.entries.length, 0);
    const searching = deferredTerm.trim().length > 0;

    const goToPage = (page: string) => {
        const element = document.getElementById(pageAnchor(page));
        if (!element) return;
        element.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
        element.focus({ preventScroll: true });
    };

    return (
        <Section
            id={stageAnchor("glossary")}
            title="Glossary"
            description="What every metric in ValueLens means, page by page, in the words the semantic model defines it."
        >
            {result.data?.status === "error" ? (
                <QueryError message={result.data.error.message} onRetry={result.refetch} />
            ) : result.isLoading || !pages ? (
                <QueryLoading className="min-h-[320px]" />
            ) : pages.length === 0 ? (
                <QueryEmpty
                    title="No glossary in this model"
                    description="The semantic model's Metric Glossary table is empty. It ships with the ValueLens template, so check that the model was deployed from it."
                />
            ) : (
                <div className="flex flex-col gap-400">
                    <div className="flex flex-wrap items-center gap-300">
                        <label htmlFor={searchId} className="sr-only">
                            Search the glossary
                        </label>
                        <div className="relative w-full max-w-[420px]">
                            <Search
                                className="icon-size-200 pointer-events-none absolute top-1/2 left-300 -translate-y-1/2 text-muted-foreground"
                                aria-hidden="true"
                            />
                            <input
                                id={searchId}
                                type="search"
                                value={term}
                                onChange={(event) => setTerm(event.target.value)}
                                placeholder="Search metrics and definitions"
                                autoComplete="off"
                                className="h-[36px] w-full rounded-md border border-input bg-card pr-[36px] pl-[36px] text-[length:var(--text-300)] text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring [&::-webkit-search-cancel-button]:hidden"
                            />
                            {term && (
                                <button
                                    type="button"
                                    onClick={() => setTerm("")}
                                    aria-label="Clear search"
                                    className="absolute top-1/2 right-200 flex size-[24px] -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                                >
                                    <X className="icon-size-100" aria-hidden="true" />
                                </button>
                            )}
                        </div>
                        <p aria-live="polite" className="text-[length:var(--text-200)] leading-200 text-muted-foreground">
                            {searching
                                ? `${formatKpi(metricCount, "whole")} ${metricCount === 1 ? "match" : "matches"} on ${formatKpi(visible.length, "whole")} ${visible.length === 1 ? "page" : "pages"}`
                                : `${formatKpi(metricCount, "whole")} metrics across ${formatKpi(visible.length, "whole")} report pages`}
                        </p>
                    </div>

                    {visible.length === 0 ? (
                        <QueryEmpty
                            title={`Nothing matches “${deferredTerm.trim()}”`}
                            description="Try a shorter word, or a metric's name as the report shows it, such as Active users."
                        />
                    ) : (
                        <div className="grid items-start gap-500 xl:grid-cols-[220px_minmax(0,1fr)]">
                            <nav aria-label="Glossary pages" className="xl:sticky xl:top-600">
                                <ul className="flex flex-wrap gap-100 xl:flex-col xl:flex-nowrap xl:border-l xl:border-border">
                                    {visible.map((page) => (
                                        <li key={page.page}>
                                            <button
                                                type="button"
                                                onClick={() => goToPage(page.page)}
                                                className={cn(
                                                    "flex w-full items-baseline justify-between gap-300 rounded-md border border-border px-300 py-100 text-left text-[length:var(--text-200)] leading-200 text-muted-foreground transition-colors hover:text-foreground",
                                                    "xl:rounded-none xl:border-0 xl:pl-400",
                                                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                                                )}
                                            >
                                                <span>{page.page}</span>
                                                <span className="tabular-nums opacity-80">{page.entries.length}</span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </nav>
                            <div className="flex min-w-0 flex-col gap-400">
                                {visible.map((page) => (
                                    <PageCard key={page.page} page={page} term={deferredTerm} />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </Section>
    );
}
