//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ReactNode } from "react";
import { formatKpi, type KpiFormat } from "@/lib/format-kpi";
import type { Delta } from "@/lib/month-over-month";
import { cn } from "@/lib/utils";

/** A month-on-month change, and whether a rise is good news. */
export interface KpiDelta extends Delta {
    /** `neutral` for figures, such as credits consumed, where growth is neither good nor bad. */
    polarity?: "up-good" | "neutral";
}

interface KpiCardProps {
    label: string;
    value: number | undefined;
    format?: KpiFormat;
    prefix?: string;
    /** Month-on-month change, shown under the figure. */
    delta?: KpiDelta;
    /** Smaller supporting figure shown beneath the rule. */
    detail?: ReactNode;
    /** Emphasises the card as the lead figure of its group. */
    emphasis?: boolean;
    className?: string;
}

/**
 * A single figure presented as the focus of its card — oversized tabular
 * numerals over a hairline rule, with the label subordinated above it.
 */
export function KpiCard({ label, value, format = "whole", prefix, delta, detail, emphasis, className }: KpiCardProps) {
    const isBlank = value === undefined;

    return (
        <div
            className={cn(
                "flex flex-col gap-200 rounded-xl border border-border bg-card p-500",
                emphasis && "border-primary/40 bg-accent/40",
                className,
            )}
        >
            <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">
                {label}
            </span>
            <span
                className={cn(
                    "font-numeric font-semibold tabular-nums leading-hero-800 text-card-foreground",
                    emphasis
                        ? "text-[length:var(--text-hero-900)] leading-hero-900"
                        : "text-[length:var(--text-hero-800)]",
                    isBlank && "text-muted-foreground",
                )}
            >
                {formatKpi(value, format, { prefix })}
            </span>
            {delta && !isBlank && <KpiDeltaLine delta={delta} />}
            {detail && (
                <div className="border-t border-border pt-200 text-[length:var(--text-200)] leading-300 text-muted-foreground">
                    {detail}
                </div>
            )}
        </div>
    );
}

const DELTA_GLYPH = { up: "▲", down: "▼", flat: "" } as const;
const DELTA_WORD = { up: "Up", down: "Down", flat: "" } as const;

/**
 * The arrow line: a rise is teal and a fall coral, unless the figure is
 * neutral (credits), where either way is simply muted.
 */
function KpiDeltaLine({ delta }: { delta: KpiDelta }) {
    const { direction, amount, comparison, polarity = "up-good" } = delta;
    const tone =
        direction === "flat" || polarity === "neutral"
            ? "text-muted-foreground"
            : direction === "up"
              ? "text-positive"
              : "text-negative";

    return (
        <span className="flex flex-wrap items-baseline gap-x-100 text-[length:var(--text-200)] leading-200">
            <span className={cn("font-semibold tabular-nums", tone)}>
                {direction !== "flat" && (
                    <>
                        <span aria-hidden="true">{DELTA_GLYPH[direction]} </span>
                        <span className="sr-only">{DELTA_WORD[direction]} </span>
                    </>
                )}
                {amount}
            </span>
            <span className="text-muted-foreground">{comparison}</span>
        </span>
    );
}

interface KpiStatProps {
    label: string;
    value: number | undefined;
    format?: KpiFormat;
    prefix?: string;
}

/** A compact label/figure pair for use inside a card's detail area. */
export function KpiStat({ label, value, format = "whole", prefix }: KpiStatProps) {
    return (
        <div className="flex items-baseline justify-between gap-200">
            <span>{label}</span>
            <span className="font-numeric font-semibold tabular-nums text-[length:var(--text-300)] text-foreground">
                {formatKpi(value, format, { prefix })}
            </span>
        </div>
    );
}
