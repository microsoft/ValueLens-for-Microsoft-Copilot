//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionProps {
    /** Anchor the sidebar scrolls to; see `stageAnchor`. */
    id?: string;
    title: string;
    /** One sentence explaining what the reader is looking at. */
    description?: string;
    /** Controls rendered on the right of the heading rule. */
    actions?: ReactNode;
    children: ReactNode;
    className?: string;
}

/**
 * A titled band of content. The hairline rule under the heading is the
 * repeating structural motif that ties the screens together.
 */
export function Section({ id, title, description, actions, children, className }: SectionProps) {
    return (
        <section
            id={id}
            // Focusable only by script, so a sidebar jump moves keyboard focus with the scroll.
            tabIndex={id ? -1 : undefined}
            className={cn("flex scroll-mt-600 flex-col gap-400 outline-none", className)}
        >
            <div className="flex flex-wrap items-end justify-between gap-300 border-b border-border pb-300">
                <div className="flex flex-col gap-100">
                    <h2 className="text-[length:var(--text-400)] leading-400 font-semibold text-foreground">
                        {title}
                    </h2>
                    {description && (
                        <p className="max-w-[68ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">
                            {description}
                        </p>
                    )}
                </div>
                {actions && <div className="flex items-center gap-200">{actions}</div>}
            </div>
            {children}
        </section>
    );
}
