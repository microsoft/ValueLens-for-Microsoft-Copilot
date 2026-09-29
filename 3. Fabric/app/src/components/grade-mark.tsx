//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { LucideIcon } from "lucide-react";
import type { GradeTone } from "@/lib/grading-method";
import { cn } from "@/lib/utils";

const TONE_FILL: Record<Exclude<GradeTone, "none">, string> = {
    positive: "var(--vl-teal)",
    negative: "var(--vl-coral)",
    caution: "var(--vl-amber)",
    neutral: "var(--vl-slate)",
};

interface GradeMarkProps {
    tone: GradeTone;
    /** A glyph drawn inside the mark, as the report's verdict icons do. */
    icon?: LucideIcon;
    className?: string;
}

/**
 * The coloured dot beside a grade or verdict. Decorative: the label next to
 * it always says the same thing in words. "none" draws an empty ring for
 * work that was not graded.
 */
export function GradeMark({ tone, icon: Icon, className }: GradeMarkProps) {
    if (tone === "none") {
        return (
            <span
                aria-hidden="true"
                className={cn("inline-block size-[14px] shrink-0 rounded-full border-2 border-muted-foreground/60", className)}
            />
        );
    }
    return (
        <span
            aria-hidden="true"
            className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-full text-white",
                Icon ? "size-[18px]" : "size-[14px]",
                className,
            )}
            style={{ backgroundColor: TONE_FILL[tone] }}
        >
            {Icon && <Icon className="size-[12px]" strokeWidth={3} />}
        </span>
    );
}
