//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Kinds of work that say nothing about what Copilot was used for, so they
 * never count as a skill. The executive `.dax` files list the same names; a
 * test keeps the two in step.
 */
export const EXCLUDED_KINDS = ["General Chat", "General Assistance", "General assistance / Other"] as const;

/** How many kinds of work make someone a broad user. */
export const BROAD_USER_SKILLS = 5;
