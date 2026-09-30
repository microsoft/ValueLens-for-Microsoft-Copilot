//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { CSSProperties, ReactNode } from "react";

export interface HeatCellProps {
    /** Share of the heat colour, from `heatMix`; undefined leaves the cell plain. */
    mix: number | undefined;
    /** Any CSS colour; defaults to the destination brand colour. */
    color?: string;
    children?: ReactNode;
}

/** A cell body whose tint fills the grid cell (see `.vl-heat` in global.css). */
export function HeatCell({ mix, color, children }: HeatCellProps) {
    if (mix === undefined) return <>{children}</>;
    const style = { "--heat-mix": `${mix}%`, ...(color ? { "--heat-color": color } : {}) } as CSSProperties;
    return (
        <span className="vl-heat" data-heat={mix} style={style}>
            {children}
        </span>
    );
}
