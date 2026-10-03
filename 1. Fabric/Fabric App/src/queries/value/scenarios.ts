//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** The model's Effort Scenario choices: how long each task would have taken without Copilot. */
export type Scenario = "Conservative" | "Typical" | "Optimistic";

export const SCENARIOS: readonly Scenario[] = ["Conservative", "Typical", "Optimistic"];
