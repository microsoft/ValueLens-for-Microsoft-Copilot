//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { authenticated, date, entity, text, uuid } from "@microsoft/rayfin-core";

/**
 * A report pack saved on the Reports page, shared by everyone who opens the
 * app: a name and an ordered list of stages, read as one page and exported
 * as one PDF or PowerPoint deck. There is one row per pack.
 *
 * `stages` holds the stage ids as a JSON array, so a pack keeps its order and
 * a stage the app later drops is skipped rather than breaking the pack. The
 * packs the app ships with are not stored. Rayfin knows only signed-in and
 * anonymous callers, so anyone who can open the app can change these.
 */
@entity()
@authenticated(["create", "read", "update", "delete"])
export class ReportPack {
    @uuid() id!: string;
    @text({ max: 80 }) name!: string;
    @text({ max: 280, optional: true }) description?: string;
    /** The stage ids, in order, as a JSON array. */
    @text({ max: 4000 }) stages!: string;
    @text({ max: 320, optional: true }) updatedBy?: string;
    @date({ optional: true }) updatedAt?: Date;
}
