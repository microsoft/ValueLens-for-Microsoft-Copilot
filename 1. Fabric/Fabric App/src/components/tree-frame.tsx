//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ReactNode } from "react";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import type { RollupTree } from "@/lib/rollup-tree";

interface TreeFrameProps {
    tree: RollupTree | undefined;
    error?: string;
    onRetry: () => void;
    isLoading: boolean;
    height: number | undefined;
    emptyTitle: string;
    emptyDescription: string;
    children: ReactNode;
}

/** Sizes a tree grid to its visible rows, standing in for it while it loads, fails or comes back empty. */
export function TreeFrame({ tree, error, onRetry, isLoading, height, emptyTitle, emptyDescription, children }: TreeFrameProps) {
    return (
        <div className="flex h-[420px] flex-col" style={height ? { height } : undefined}>
            {error !== undefined ? (
                <QueryError className="h-full" message={error} onRetry={onRetry} />
            ) : isLoading || !tree ? (
                <QueryLoading className="h-full" />
            ) : tree.rows.length === 0 ? (
                <QueryEmpty className="h-full" title={emptyTitle} description={emptyDescription} />
            ) : (
                children
            )}
        </div>
    );
}
