//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * The Consumption Central measures that turn credits into dollars, copied
 * verbatim from the released template (`Consumption Central - Fabric.pbit`).
 *
 * A query that overrides a rate must redefine every measure between the rate
 * and the figure it shows: the model's own measures keep reading the model's
 * rates whatever the query defines. These are the ones the app's queries
 * reach. Refresh them if the template's cost measures change.
 */
export interface ModelMeasure {
    table: string;
    name: string;
    expression: string;
}

export const RATE_MEASURES: readonly ModelMeasure[] = [
    {
        table: "Credit Consumption (Agent)",
        name: "Billable Credit Cost (Agent)",
        expression: String.raw`
        [Total Billed Credits] * [Studio PAYG Rate Value]
    `,
    },
    {
        table: "Credit Consumption (User)",
        name: "Billable Credit Cost (User)",
        expression: String.raw`
        [Total Billable Credits Used] * [Studio PAYG Rate Value]
    `,
    },
    {
        table: "CoworkBilling",
        name: "Billing Basis",
        expression: String.raw`
        VAR Bal  = [Cowork Prepaid Balance]
        VAR Used = [Cowork Total Credits Used]
        RETURN
        SWITCH(
        TRUE(),
        Bal = 0,      "Pay-as-you-go",
        Bal >= Used,  "Capacity Packs",
        "Capacity Packs, then pay-as-you-go"
        )
    `,
    },
    {
        table: "CoworkBilling",
        name: "Blended Rate $",
        expression: String.raw`
        DIVIDE( [Cowork Total Cost], [Cowork Total Credits Used] )
    `,
    },
    {
        table: "CoworkBilling",
        name: "Cowork PAYG Cost",
        expression: String.raw`
        [Cowork PAYG Credits] * [Cowork PAYG Rate]
    `,
    },
    {
        table: "CoworkBilling",
        name: "Cowork PAYG Credits",
        expression: String.raw`
        // Same coercion as Cowork Prepaid Used: BLANK - 0 is 0, and MAX
        // then returns a real zero rather than passing the blank through.
        VAR Used = [Cowork Total Credits Used]
        RETURN
        	IF( NOT ISBLANK( Used ),
        		MAX( 0, Used - [Cowork Prepaid Balance] ) )
    `,
    },
    {
        table: "CoworkBilling",
        name: "Cowork PAYG Rate",
        expression: String.raw`
        [Cowork PAYG Rate Value]
    `,
    },
    {
        table: "CoworkBilling",
        name: "Cowork Prepaid Balance",
        expression: String.raw`
        [Cowork Capacity Pack Balance Value]
    `,
    },
    {
        table: "CoworkBilling",
        name: "Cowork Prepaid Cost",
        expression: String.raw`
        [Cowork Prepaid Used] * [Cowork Prepaid Rate Value]
    `,
    },
    {
        table: "CoworkBilling",
        name: "Cowork Prepaid Rate",
        expression: String.raw`
        [Cowork Prepaid Rate Value]
    `,
    },
    {
        table: "CoworkBilling",
        name: "Cowork Prepaid Used",
        expression: String.raw`
        // MIN coerces BLANK to a number, so a group with no Cowork users
        // reported 0 prepaid credits and kept its row on the Cost page at
        // $0 - while the Consumption page correctly dropped it.
        // Credits Used already separates "no users" (BLANK) from "users
        // who spent nothing" (0), so defer to it.
        VAR Used = [Cowork Total Credits Used]
        RETURN
        	IF( NOT ISBLANK( Used ), MIN( Used, [Cowork Prepaid Balance] ) )
    `,
    },
    {
        table: "CoworkBilling",
        name: "Cowork Total Cost",
        expression: String.raw`
        [Cowork Prepaid Cost] + [Cowork PAYG Cost]
    `,
    },
    {
        table: "CreditsWeekly",
        name: "Cowork Weekly PAYG Cost",
        expression: String.raw`
        VAR Wks      = [Cowork Period Weeks]
        VAR Bal      = [Cowork Prepaid Balance]
        VAR PaygRate = [Cowork PAYG Rate Value]
        RETURN
        SUMX(
            FILTER( VALUES( 'CreditsWeekly'[Weeks Ago] ), 'CreditsWeekly'[Weeks Ago] < Wks ),
            VAR ThisAgo  = 'CreditsWeekly'[Weeks Ago]
            VAR ThisWeek = CALCULATE( SUM( 'CreditsWeekly'[CreditsUsed] ) )
            VAR PriorUsed =
                CALCULATE(
                    SUM( 'CreditsWeekly'[CreditsUsed] ),
                    FILTER(
                        ALL( 'CreditsWeekly'[Weeks Ago] ),
                        'CreditsWeekly'[Weeks Ago] > ThisAgo
                            && 'CreditsWeekly'[Weeks Ago] < Wks
                    ),
                    REMOVEFILTERS( 'CreditsWeekly'[Week Label] ),
                    REMOVEFILTERS( 'CreditsWeekly'[Week Index] ),
                    REMOVEFILTERS( 'CreditsWeekly'[MetricDate] ),
                    REMOVEFILTERS( 'Date' )
                )
            VAR PrepaidLeft = MAX( 0, Bal - PriorUsed )
            VAR PrepaidThis = MIN( ThisWeek, PrepaidLeft )
            VAR PaygThis    = ThisWeek - PrepaidThis
            RETURN PaygThis * PaygRate
        )
    `,
    },
    {
        table: "CreditsWeekly",
        name: "Cowork Weekly Prepaid Cost",
        expression: String.raw`
        VAR Wks         = [Cowork Period Weeks]
        VAR Bal         = [Cowork Prepaid Balance]
        VAR PrepaidRate = [Cowork Prepaid Rate Value]
        RETURN
        SUMX(
            FILTER( VALUES( 'CreditsWeekly'[Weeks Ago] ), 'CreditsWeekly'[Weeks Ago] < Wks ),
            VAR ThisAgo  = 'CreditsWeekly'[Weeks Ago]
            VAR ThisWeek = CALCULATE( SUM( 'CreditsWeekly'[CreditsUsed] ) )
            // credits consumed in older weeks inside the period, which have already
            // eaten into the pack before this week starts. The REMOVEFILTERS matter:
            // on a chart the axis filters Week Label, not Weeks Ago.
            VAR PriorUsed =
                CALCULATE(
                    SUM( 'CreditsWeekly'[CreditsUsed] ),
                    FILTER(
                        ALL( 'CreditsWeekly'[Weeks Ago] ),
                        'CreditsWeekly'[Weeks Ago] > ThisAgo
                            && 'CreditsWeekly'[Weeks Ago] < Wks
                    ),
                    REMOVEFILTERS( 'CreditsWeekly'[Week Label] ),
                    REMOVEFILTERS( 'CreditsWeekly'[Week Index] ),
                    REMOVEFILTERS( 'CreditsWeekly'[MetricDate] ),
                    REMOVEFILTERS( 'Date' )
                )
            VAR PrepaidLeft = MAX( 0, Bal - PriorUsed )
            VAR PrepaidThis = MIN( ThisWeek, PrepaidLeft )
            RETURN PrepaidThis * PrepaidRate
        )
    `,
    },
    {
        table: "Settings",
        name: "Rates In Use",
        expression: String.raw`
        "Cowork " & FORMAT( [Cowork PAYG Rate Value], "$0.0000" )
            & "   Studio " & FORMAT( [Studio PAYG Rate Value], "$0.0000" )
            & "   Prepaid pack " & FORMAT( [Cowork Capacity Pack Balance Value], "#,0" ) & " credits"
    `,
    },
    {
        table: "Settings",
        name: "Reporting Cowork Cost",
        expression: String.raw`
        VAR Lo = [Reporting Start]
        VAR Hi = [Reporting End]
        RETURN CALCULATE(SUM('CreditsWeekly'[CreditsUsed]) * [Cowork PAYG Rate Value], REMOVEFILTERS('Date'),
            KEEPFILTERS(FILTER(ALL('CreditsWeekly'[MetricDate]),
                'CreditsWeekly'[MetricDate] >= Lo && 'CreditsWeekly'[MetricDate] <= Hi)))
    `,
    },
    {
        table: "Settings",
        name: "Reporting Product Cost",
        expression: String.raw`
        SWITCH(SELECTEDVALUE('Reporting Product'[Product]), "Cowork / Work IQ", [Reporting Cowork Cost],
        "Copilot Studio", [Reporting Studio Cost],
        "GitHub Copilot", [Reporting GitHub Cost],
        "Azure AI Foundry", [Reporting Foundry Cost])
    `,
    },
    {
        table: "Settings",
        name: "Reporting Studio Cost",
        expression: String.raw`
        VAR Lo = [Reporting Start]
        VAR Hi = [Reporting End]
        RETURN CALCULATE(SUM('Credit Consumption (Tenant)'[Prepaid_Consumed_Quantity]) * [Studio Prepaid Rate Value] + SUM('Credit Consumption (Tenant)'[Pay_as_you_go_Consumed_Quantity]) * [Studio PAYG Rate Value], REMOVEFILTERS('Date'),
            KEEPFILTERS(FILTER(ALL('Credit Consumption (Tenant)'[Usage_Date]),
                'Credit Consumption (Tenant)'[Usage_Date] >= Lo && 'Credit Consumption (Tenant)'[Usage_Date] <= Hi)))
    `,
    },
    {
        table: "Settings",
        name: "Studio Effective Rate",
        expression: String.raw`
        DIVIDE(
            [Studio Prepaid Consumed] * [Studio Prepaid Rate Value] + [Studio PAYG Consumed] * [Studio PAYG Rate Value],
            [Studio Prepaid Consumed] + [Studio PAYG Consumed]
        )
    `,
    },
    {
        table: "Credit Consumption (Tenant)",
        name: "Studio PAYG Cost",
        expression: String.raw`
        [Studio PAYG Consumed] * [Studio PAYG Rate Value]
    `,
    },
    {
        table: "Credit Consumption (Tenant)",
        name: "Studio Prepaid Cost",
        expression: String.raw`
        [Studio Prepaid Consumed] * [Studio Prepaid Rate Value]
    `,
    },
    {
        table: "Credit Consumption (Tenant)",
        name: "Total Billable Cost",
        expression: String.raw`
        ( [Studio Prepaid Consumed] * [Studio Prepaid Rate Value] ) + ( [Studio PAYG Consumed] * [Studio PAYG Rate Value] )
    `,
    },
];
