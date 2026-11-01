//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { useEffect, useMemo, useRef, type ComponentProps } from "react";
import { VegaVisual as EvalVegaVisual } from "@microsoft/fabric-visuals";
import { EmbeddableVegaVisual } from "@microsoft/fabric-visuals/embeddable";
import { useIsPrefetch } from "@/hooks/prefetch.context";
import { rowCountKey } from "@/lib/chart-height";

export type { VegaVisualHandle, VisualizationSpec } from "@microsoft/fabric-visuals";

/** True when the page's Content-Security-Policy blocks `new Function`, as the Azure host's does. */
export function isEvalBlocked(): boolean {
    try {
        void new Function("");
        return false;
    } catch {
        return true;
    }
}

/**
 * The chart component for this host. Fabric allows eval, so it keeps the stock
 * VegaVisual; under a strict CSP the embeddable build interprets Vega
 * expressions instead. Both take the same props.
 */
const HostVegaVisual = isEvalBlocked() ? EmbeddableVegaVisual : EvalVegaVisual;

export type VegaVisualProps = ComponentProps<typeof HostVegaVisual>;

/**
 * Row-per-category charts size their frame from the row count, and the stock
 * visual doesn't re-lay its plot when new data shrinks that frame: the rows
 * collapse onto one line and the bars vanish until the window is resized.
 * Remounting on a new row count draws the chart fresh at its new size.
 */
export function VegaVisual(props: VegaVisualProps) {
    // A page fetched ahead of a visit only wants its data; drawing it would cost the open page.
    const prefetching = useIsPrefetch();
    const frame = useRef<HTMLDivElement>(null);
    const title = props.header?.title;
    const spec = useMemo(() => named(props.spec, title), [props.spec, title]);

    // The stock header draws its title as an h4, a level below the section's h2.
    useEffect(() => {
        const root = frame.current;
        if (!root) return;
        const level = () => {
            for (const heading of root.querySelectorAll("h4")) heading.setAttribute("aria-level", "3");
        };
        level();
        const observer = new MutationObserver(level);
        observer.observe(root, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, []);

    if (prefetching) return null;
    return (
        <div ref={frame} className="contents">
            <HostVegaVisual key={rowCountKey(props.data)} {...props} spec={spec} />
        </div>
    );
}

/** Vega reads a spec's description as the chart's accessible name; fall back to its title. */
function named(spec: VegaVisualProps["spec"], title: string | undefined): VegaVisualProps["spec"] {
    if (!title || !spec || typeof spec !== "object" || "description" in spec) return spec;
    return { ...spec, description: title } as VegaVisualProps["spec"];
}
