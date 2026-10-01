//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useState } from "react";

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Tracks which rows the reader has opened or closed against the default, to
 * size a tree grid. The grid owns its expansion and only reads `_expanded` on
 * mount, so a change of `gridKey` (a new result) starts afresh.
 */
export function useRowToggles(gridKey: string) {
    const [toggled, setToggled] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: "", ids: NO_IDS });
    const ids = toggled.key === gridKey ? toggled.ids : NO_IDS;
    const onRowToggle = useCallback(
        (rowId: string) =>
            setToggled((previous) => {
                const next = new Set(previous.key === gridKey ? previous.ids : NO_IDS);
                if (next.has(rowId)) next.delete(rowId);
                else next.add(rowId);
                return { key: gridKey, ids: next };
            }),
        [gridKey],
    );
    return { ids, onRowToggle };
}
