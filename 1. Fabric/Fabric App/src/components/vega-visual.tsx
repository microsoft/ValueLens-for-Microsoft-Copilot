//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { VegaVisual as EvalVegaVisual } from "@microsoft/fabric-visuals";
import { EmbeddableVegaVisual } from "@microsoft/fabric-visuals/embeddable";

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
export const VegaVisual = isEvalBlocked() ? EmbeddableVegaVisual : EvalVegaVisual;
