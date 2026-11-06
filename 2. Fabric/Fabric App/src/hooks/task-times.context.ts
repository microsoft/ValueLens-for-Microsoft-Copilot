//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createContext, useContext } from "react";
import type { SavedTaskTime, TaskTimeChange } from "@/services/task-times.service";

export interface TaskTimesContextValue {
    /**
     * `loading` until the app's saved task times are known, so no hours are
     * shown at the model's minutes first. `unavailable` when the app's database
     * could not be reached: hours then use the model's minutes, and nothing
     * can be saved.
     */
    status: "loading" | "ready" | "unavailable";
    /** Why the saved times could not be read. */
    unavailableReason?: string;
    /** The task times saved in the app, applied to every hours and value figure. */
    saved: readonly SavedTaskTime[];
    /** Saves each task's new times for everyone, or puts the model's back where a change is null. */
    save: (changes: readonly TaskTimeChange[]) => Promise<void>;
}

const NONE: readonly SavedTaskTime[] = [];

/**
 * The minutes per task every hours and value figure in the app is worked out
 * at, where they differ from the model's.
 *
 * Without a provider, as in isolated component tests, the model's own
 * minutes apply and nothing waits.
 */
export const TaskTimesContext = createContext<TaskTimesContextValue>({
    status: "ready",
    saved: NONE,
    save: () => Promise.reject(new Error("Task times can't be saved here.")),
});

export function useTaskTimes(): TaskTimesContextValue {
    return useContext(TaskTimesContext);
}
