//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { authenticated, date, decimal, entity, text, uuid } from "@microsoft/rayfin-core";

/**
 * A task's minutes typed in on the Assumptions page, shared by everyone who
 * opens the app: how long one unit of the task would take someone without
 * Copilot, for each effort scenario. There is one row per task changed.
 *
 * A row replaces the ValueLens model's own `Human Time Estimates` minutes for
 * that task in every figure the app shows. A task with no row keeps the
 * researched minutes; deleting the row puts them back. The Power BI report
 * keeps reading the model's.
 *
 * The id is worked out from the task's name, so saving the same task twice
 * updates one row. Rayfin knows only signed-in and anonymous callers, so
 * anyone who can open the app can change these.
 */
@entity()
@authenticated(["create", "read", "update", "delete"])
export class TaskTime {
    @uuid() id!: string;
    /** The behaviour, exactly as the model's `Human Time Estimates` table names it. */
    @text({ max: 200 }) task!: string;
    /** Minutes for the Conservative scenario. */
    @decimal({ precision: 6, scale: 1 }) minLow!: number;
    /** Minutes for the Typical scenario. */
    @decimal({ precision: 6, scale: 1 }) minTypical!: number;
    /** Minutes for the Optimistic scenario. */
    @decimal({ precision: 6, scale: 1 }) minHigh!: number;
    @text({ max: 320, optional: true }) updatedBy?: string;
    @date({ optional: true }) updatedAt?: Date;
}
