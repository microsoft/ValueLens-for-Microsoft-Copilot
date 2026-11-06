//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { getSettingsStore, taskTimeId, type SavedTaskTime, type TaskTimeChange } from "@/lib/settings-store";

export { taskTimeId, type SavedTaskTime, type TaskTimeChange };

/** Every task time saved in the app, newest first when a task somehow has two. */
export function loadTaskTimes(): Promise<SavedTaskTime[]> {
    return getSettingsStore().loadTaskTimes();
}

/** Saves each task's new times for everyone, or deletes its row so the model's apply again. */
export function saveTaskTimes(
    changes: readonly TaskTimeChange[],
    updatedBy: string | undefined,
): Promise<SavedTaskTime[]> {
    return getSettingsStore().saveTaskTimes(changes, updatedBy);
}