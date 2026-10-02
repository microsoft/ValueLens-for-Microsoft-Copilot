//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { QueryEmpty, QueryError } from "@/components/query-states";
import { Section } from "@/components/section";
import { BODY } from "@/lib/type-scale";

interface SourceProps {
    /** The first stage's anchor, so the sidebar still has somewhere to land. */
    anchor: string;
    /** The page's own name, e.g. "Agent Evaluation". */
    page: string;
    /** The semantic model the page reads, e.g. "Agent Evaluator". */
    model: string;
}

interface SourceErrorProps extends SourceProps {
    /** The page's alias in `fabric.yaml`, e.g. `ae`. */
    alias: string;
    message: string;
    onRetry: () => void;
}

/**
 * Stands in for a whole page when its own model doesn't answer. The page is
 * only listed once `fabric.yaml` sets the model up, so this is a wrong ID, a
 * missing permission or a model that hasn't refreshed rather than a model the
 * customer doesn't have.
 */
export function SourceError({ anchor, page, model, alias, message, onRetry }: SourceErrorProps) {
    return (
        <Section id={anchor} title={page} description={`This page reads the ${model} semantic model.`}>
            <p className={`${BODY} max-w-[68ch] text-muted-foreground`}>
                {model} didn't answer. Check that the <code className="font-mono">{alias}</code> connection in{" "}
                <code className="font-mono">fabric.yaml</code> points at your published model, that you have Build
                permission on it, and that it has refreshed.
            </p>
            <QueryError message={message} onRetry={onRetry} />
        </Section>
    );
}

interface SourceEmptyProps extends SourceProps {
    title: string;
    description: string;
}

/** Stands in for a whole page when its model answers but holds nothing yet, rather than a page of blanks. */
export function SourceEmpty({ anchor, page, model, title, description }: SourceEmptyProps) {
    return (
        <Section id={anchor} title={page} description={`This page reads the ${model} semantic model.`}>
            <QueryEmpty title={title} description={description} />
        </Section>
    );
}
