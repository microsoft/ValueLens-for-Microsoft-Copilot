//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ReactNode } from "react";

/** Room a one-line headline takes above a chart, so the plot keeps its height. */
export const HEADLINE_SPACE = 40;

/**
 * A chart with its one-sentence headline above it. Without a headline the
 * chart is returned as it is, so a thin result never shows an empty line.
 */
export function Headlined({ text, children }: { text: string | undefined; children: ReactNode }) {
    if (!text) return <>{children}</>;
    return (
        <div className="flex h-full flex-col gap-200">
            <p className="text-[length:var(--text-300)] leading-300 text-foreground">{text}</p>
            <div className="min-h-0 flex-1">{children}</div>
        </div>
    );
}
