//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ReactNode } from "react";
import { Sparkline } from "@/components/sparkline";
import type { SparkPoint } from "@/lib/sparkline";
import { formatKpi, type KpiFormat } from "@/lib/format-kpi";
import { fitFontSize } from "@/lib/kpi-fit";
import type { Delta } from "@/lib/month-over-month";
import { cn } from "@/lib/utils";

/** A month-on-month change, and whether a rise is good news. */
export interface KpiDelta extends Delta {
    /** `neutral` for figures, such as credits consumed, where growth is neither good nor bad. */
    polarity?: "up-good" | "neutral";
}

/** The figure's recent run, drawn as a sparkline under the arrow. */
export interface KpiTrend {
    points: readonly SparkPoint[];
    /** Read out in place of the line: "Per day, Jan to Jun: from 120 to 180". */
    description: string;
}

interface KpiCardProps {
    label: string;
    value: number | undefined;
    format?: KpiFormat;
    prefix?: string;
    /** Month-on-month change, shown under the figure. */
    delta?: KpiDelta;
    /** Recent months as a sparkline, shown with three or more points. */
    trend?: KpiTrend;
    /** Smaller supporting figure shown beneath the rule. */
    detail?: ReactNode;
    /** Text to show when the model returns BLANK for a deliberate, named state. */
    emptyValue?: string;
    /** Emphasises the card as the lead figure of its group. */
    emphasis?: boolean;
    className?: string;
}

/**
 * A single figure presented as the focus of its card — oversized tabular
 * numerals over a hairline rule, with the label subordinated above it.
 * A figure of a million or more reads 5.9M, with the exact figure on hover
 * and for screen readers, and it never wraps: if it would still be wider
 * than the card it is drawn smaller to fit.
 */
export function KpiCard({ label, value, format = "whole", prefix, delta, trend, detail, emptyValue, emphasis, className }: KpiCardProps) {
    const isBlank = value === undefined;
    const shown = isBlank && emptyValue ? emptyValue : formatKpi(value, format, { prefix, compact: true });
    const exact = formatKpi(value, format, { prefix });

    return (
        <div
            className={cn(
                "flex min-w-0 flex-col gap-100 rounded-xl border border-border bg-card px-400 pt-[14px] pb-[15px] shadow-card",
                emphasis && "border-primary/40 bg-accent/60",
                className,
            )}
        >
            <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                {label}
            </span>
            <div className="[container-type:inline-size]">
                <span
                    data-kpi-value=""
                    title={!isBlank && exact !== shown ? exact : undefined}
                    style={{ fontSize: fitFontSize(shown, emphasis ? "--text-hero-800" : "--text-hero-700") }}
                    className={cn(
                        "block whitespace-nowrap font-numeric font-semibold tracking-[-0.01em] tabular-nums leading-hero-700 text-card-foreground",
                        emphasis && "leading-hero-800",
                        isBlank && "text-muted-foreground",
                    )}
                >
                    <Figure shown={shown} exact={isBlank ? shown : exact} />
                </span>
            </div>
            {delta && !isBlank && <KpiDeltaLine delta={delta} />}
            {trend && !isBlank && <Sparkline points={trend.points} description={trend.description} />}
            {detail && (
                <div className="mt-100 border-t border-border pt-200 text-[12.5px] leading-[18px] text-muted-foreground">
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
    const shown = formatKpi(value, format, { prefix, compact: true });
    const exact = formatKpi(value, format, { prefix });
    return (
        <div className="flex items-baseline justify-between gap-200">
            <span>{label}</span>
            <span
                title={exact !== shown ? exact : undefined}
                className="shrink-0 whitespace-nowrap font-numeric font-semibold tabular-nums text-[length:var(--text-300)] text-foreground"
            >
                <Figure shown={shown} exact={exact} />
            </span>
        </div>
    );
}

/** A shortened figure, read out in full. */
export function Figure({ shown, exact }: { shown: string; exact: string }) {
    if (shown === exact) return <>{shown}</>;
    return (
        <>
            <span aria-hidden="true">{shown}</span>
            <span className="sr-only">{exact}</span>
        </>
    );
}
