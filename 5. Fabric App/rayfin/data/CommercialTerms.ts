//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { authenticated, date, decimal, entity, text, uuid } from "@microsoft/rayfin-core";

/**
 * The credit rates and Capacity Pack balance typed in on the Consumption
 * page, and the licence price and exchange rate typed in on the Value page,
 * shared by everyone who opens the app. There is only ever one row.
 *
 * Each credit value overrides the Consumption Central model's own, which
 * comes from the Lakehouse `commercial_terms` table or the template's
 * parameters. An empty value leaves the model's in force. The licence price
 * and exchange rate have no model value: an empty licence price uses the US
 * list price, and an empty exchange rate leaves costs in dollars.
 *
 * Rayfin knows only signed-in and anonymous callers, so anyone who can open
 * the app can change these. There is no delete: "Use model values" clears
 * the row's values instead.
 */
@entity()
@authenticated(["create", "read", "update"])
export class CommercialTerms {
    @uuid() id!: string;
    /** Pay-as-you-go price of one Copilot credit, in US dollars. Cowork, Work IQ and Copilot Studio. */
    @decimal({ precision: 12, scale: 6, optional: true }) creditRate?: number;
    /** Price of one prepaid Capacity Pack credit, in US dollars. */
    @decimal({ precision: 12, scale: 6, optional: true }) prepaidCreditRate?: number;
    /** Capacity Pack credits Cowork draws down before paying as it goes. */
    @decimal({ precision: 18, scale: 0, optional: true }) prepaidCreditBalance?: number;
    /** Microsoft 365 Copilot licence price per user per month, in US dollars. */
    @decimal({ precision: 10, scale: 2, optional: true }) licensePrice?: number;
    /** How much of ValueLens's currency one US dollar buys, to set dollar costs against value. */
    @decimal({ precision: 14, scale: 6, optional: true }) exchangeRate?: number;
    @text({ max: 320, optional: true }) updatedBy?: string;
    @date({ optional: true }) updatedAt?: Date;
}
