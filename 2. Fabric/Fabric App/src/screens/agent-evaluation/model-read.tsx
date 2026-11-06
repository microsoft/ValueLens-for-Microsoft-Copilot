//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useId } from "react";
import { GradeMark } from "@/components/grade-mark";
import type { Note } from "@/components/report-panels";
import { parseVerdict, plainText } from "@/lib/model-text";
import { BODY, SMALL } from "@/lib/type-scale";

const HEADING = "text-[length:var(--text-300)] leading-300 font-semibold text-foreground";

interface ModelReadProps {
    /** The model's traffic-light verdicts, such as "65.8% resolved · 🟡 Below target". */
    verdicts: readonly Note[];
    /** Where the model says to look first, in its own words. */
    focus: readonly Note[];
}

/**
 * The report's At a Glance verdicts and focus list in one card: each verdict
 * as its traffic light and judgement, with the figure behind it, then the
 * three places the model says to start.
 */
export function ModelRead({ verdicts, focus }: ModelReadProps) {
    const headingId = useId();
    const readings = verdicts.flatMap((note) => {
        const verdict = parseVerdict(note.text);
        return verdict ? [{ term: note.term, ...verdict }] : [];
    });
    const leads = focus.flatMap((note) => {
        const text = plainText(note.text);
        return text ? [{ term: note.term, text }] : [];
    });
    if (readings.length === 0 && leads.length === 0) return null;

    return (
        <article aria-labelledby={headingId} className="flex flex-col self-start rounded-xl border border-border bg-card">
            <h3 id={headingId} className={`border-b border-border px-500 py-300 ${HEADING}`}>
                The model's read
            </h3>
            {readings.length > 0 && (
                <dl className="flex flex-col divide-y divide-border px-500">
                    {readings.map((reading) => (
                        <div key={reading.term} className="flex flex-col gap-100 py-300">
                            <dt className={`${SMALL} text-muted-foreground`}>{reading.term}</dt>
                            <dd className="flex flex-wrap items-center gap-x-200 gap-y-100">
                                <GradeMark tone={reading.tone} />
                                <span className={`${BODY} font-semibold text-foreground`}>{reading.label}</span>
                                {reading.figure && (
                                    <span className={`${SMALL} tabular-nums text-muted-foreground`}>{reading.figure}</span>
                                )}
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
            {leads.length > 0 && (
                <>
                    <h4 className={`border-t border-border px-500 pt-300 ${SMALL} font-semibold text-foreground`}>
                        Look first at
                    </h4>
                    <dl className="flex flex-col gap-200 px-500 pt-200 pb-400">
                        {leads.map((lead) => (
                            <div key={lead.term} className="flex flex-col gap-100-nudge">
                                <dt className={`${SMALL} text-muted-foreground`}>{lead.term}</dt>
                                <dd className={`${SMALL} text-foreground`}>{lead.text}</dd>
                            </div>
                        ))}
                    </dl>
                </>
            )}
        </article>
    );
}
