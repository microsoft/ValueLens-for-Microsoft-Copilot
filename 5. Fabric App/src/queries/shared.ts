//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** Connection alias declared in `fabric.yaml`. */
export const connection = "vl";

/**
 * The Consumption Central model, bound as a second connection so the
 * Consumption page can read Copilot credits and Azure spend beside the
 * ValueLens activity.
 */
export const consumptionConnection = "cc";

/** Count of people, sessions or items. */
export const FORMAT_WHOLE = "#,0";
/** Share of a population, returned by the model as a fraction. */
export const FORMAT_PERCENT = "0.0%";
/** Rates such as sessions per user per week. */
export const FORMAT_RATE = "0.00";
/** Hours, which are meaningful to one decimal place. */
export const FORMAT_HOURS = "#,0.0";
/** Billed amounts, to the cent. */
export const FORMAT_MONEY = "#,0.00";
/** Credits, which the products report to fractions nobody bills by. */
export const FORMAT_CREDITS = "#,0";
