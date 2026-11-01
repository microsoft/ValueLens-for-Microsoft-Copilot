//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { StageId } from "./destinations";

/** The id of a stage's tab, which names the panel while that stage is open. */
export function stageTabId(panelId: string, stage: StageId): string {
    return `${panelId}-${stage}`;
}
