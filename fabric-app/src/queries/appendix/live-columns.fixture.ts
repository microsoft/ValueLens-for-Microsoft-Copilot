//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** Column names returned by the live semantic model on 2026-09-29. */
export const liveColumns = {
    glossary: ["[Page]", "[Metric]", "[Description]", "[Page Order]", "[Metric Order]", "[Page Description]"],
    signalImpact: [
        "[Signal]",
        "[AI Tasks]",
        "[Use Case]",
        "[Value Outcome]",
        "[Human Equivalent (Minutes)]",
        "[Research Source]",
        "[Source URL]",
        "[Confidence]",
        "[Category]",
    ],
} as const;
