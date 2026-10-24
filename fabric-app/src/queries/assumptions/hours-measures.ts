//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ModelMeasure } from "../consumption/rate-measures";

/**
 * The ValueLens measures between the task times and the hours and value the
 * app shows, copied verbatim from the released template
 * (`ValueLens - Fabric.pbit`; the CSV, SharePoint and Power Automate
 * templates carry the same text).
 *
 * A query that changes a task time must redefine every measure between the
 * minutes and the figure it shows: the model's own measures keep reading the
 * model's minutes whatever the query defines. The first is the one that
 * reads the minutes. Refresh these if the template's value measures change.
 */
export const HOURS_MEASURES: readonly ModelMeasure[] = [
    {
        table: "Chat + Agent Interactions (Audit Logs)",
        name: "Human Equivalent Hours (Behaviour Basis)",
        expression: String.raw`
    VAR _scn = [Effort Scenario Selected]
    RETURN
    SUMX(
        VALUES('Behavior Value Map'[Behavior]),
        VAR _cat   = CALCULATE(MAX('Human Time Estimates'[Category]))
        VAR _grain = CALCULATE(MAX('Human Time Estimates'[Effort Grain]))
        VAR _min =
            SWITCH(
                _scn,
                "Conservative", CALCULATE(MAX('Human Time Estimates'[Min Low])),
                "Optimistic", CALCULATE(MAX('Human Time Estimates'[Min High])),
                CALCULATE(MAX('Human Time Estimates'[Min Typical]))
            )
        VAR _mult =
            SWITCH(
                _cat,
                "Email", [Adj Comms],
                "Collaboration & Workflows", [Adj Comms],
                "Meetings", [Adj Meetings],
                "Document Creation", [Adj Content],
                "Document Summarisation", [Adj Content],
                "Presentations", [Adj Content],
                "Creative & Design", [Adj Content],
                "Coding & Technical", [Adj Content],
                "Search & Research", [Adj Search],
                "Data & Analysis", [Adj Search],
                "Specialist Support", [Adj Agents],
                "General Chat & Q&A", [Adj Agents],
                1
            )
        VAR _b = 'Behavior Value Map'[Behavior]
        VAR _msgs =
            CALCULATE(
                DISTINCTCOUNT('Chat + Agent Interactions (Audit Logs)'[Message_Id]),
                'Chat + Agent Interactions (Audit Logs)'[Message_isPrompt] = "TRUE"
            )
        VAR _rows =
            CALCULATE(
                COUNTROWS('Chat + Agent Interactions (Audit Logs)'),
                'Chat + Agent Interactions (Audit Logs)'[Message_isPrompt] = "TRUE"
            )
        // this behaviour's mean resources per prompt, measured across the whole
        // window so a filtered view is weighted against the org norm, not itself
        VAR _meanRes =
            CALCULATE(
                DIVIDE(
                    COUNTROWS('Chat + Agent Interactions (Audit Logs)'),
                    DISTINCTCOUNT('Chat + Agent Interactions (Audit Logs)'[Message_Id])
                ),
                REMOVEFILTERS(),
                'Behavior Value Map'[Behavior] = _b,
                'Chat + Agent Interactions (Audit Logs)'[Message_isPrompt] = "TRUE"
            )
        VAR _units =
            IF(
                _grain = "Per Resource" && _meanRes > 0,
                DIVIDE(_rows, _meanRes),
                _msgs
            )
        RETURN
            DIVIDE(_min * _mult * _units, 60, 0)
    )
`,
    },
    {
        table: "Chat + Agent Interactions (Audit Logs)",
        name: "Expert Equivalent Hours",
        expression: String.raw`
CALCULATE(
    [Human Equivalent Hours (Behaviour Basis)],
    KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[Agent Filter (Normalized)] <> "Cowork")
) + [Cowork Hours (Task Category Basis)]
`,
    },
    {
        table: "Chat + Agent Interactions (Audit Logs)",
        name: "AI Assisted Value",
        expression: String.raw`
    IF(
        ISBLANK(SELECTEDVALUE('Hourly Value'[Hourly Value])),
        BLANK(),
        [Expert Equivalent Hours]
        * [Hourly Value Value]
        * [Penalty Factor Value]
    )
`,
    },
    {
        table: "Chat + Agent Interactions (Audit Logs)",
        name: "AI Assisted Value Per Week",
        expression: String.raw`
IF(
    ISBLANK([AI Assisted Value]),
    BLANK(),
    DIVIDE(
        [AI Assisted Value],
        DISTINCTCOUNT('Chat + Agent Interactions (Audit Logs)'[WeekStart]),
        0
    )
)
`,
    },
    {
        table: "Chat + Agent Interactions (Audit Logs)",
        name: "Expert Equivalent Hours Per Week",
        expression: String.raw`
DIVIDE([Expert Equivalent Hours], CALCULATE(DISTINCTCOUNT('Chat + Agent Interactions (Audit Logs)'[WeekStart]), ALLEXCEPT('Chat + Agent Interactions (Audit Logs)', 'Chat + Agent Interactions (Audit Logs)'[WeekStart]), VALUES('Calendar'[Date])), 0)
`,
    },
    {
        table: "Chat + Agent Interactions (Audit Logs)",
        name: "Cowork Expert Equivalent Hours Per Week",
        expression: String.raw`
CALCULATE([Expert Equivalent Hours Per Week], KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[Is_Cowork] = TRUE()))
`,
    },
    {
        table: "Chat + Agent Interactions (Audit Logs)",
        name: "Top Value Outcome",
        expression: String.raw`
VAR _hasNonCowork =
    NOT ISEMPTY(
        CALCULATETABLE(
            'Chat + Agent Interactions (Audit Logs)',
            KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[Agent Filter (Normalized)] <> "Cowork")
        )
    )
RETURN
    IF(
        _hasNonCowork,
        MAXX(
            TOPN(1,
                ADDCOLUMNS(
                    VALUES('Chat + Agent Interactions (Audit Logs)'[Value_Outcome]),
                    "@Hrs", [Expert Equivalent Hours]
                ),
                [@Hrs], DESC
            ),
            'Chat + Agent Interactions (Audit Logs)'[Value_Outcome]
        ),
        MAXX(
            TOPN(1,
                ADDCOLUMNS(
                    FILTER(
                        VALUES('Chat + Agent Interactions (Audit Logs)'[Cowork Task Category]),
                        NOT ISBLANK('Chat + Agent Interactions (Audit Logs)'[Cowork Task Category])
                    ),
                    "@Hrs", [Expert Equivalent Hours]
                ),
                [@Hrs], DESC
            ),
            'Chat + Agent Interactions (Audit Logs)'[Cowork Task Category]
        )
    )
`,
    },
    {
        table: "Chat + Agent Interactions (Audit Logs)",
        name: "Cowork Top Value Outcome",
        expression: String.raw`
CALCULATE([Top Value Outcome], KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[Is_Cowork] = TRUE()))
`,
    },
    {
        table: "Chat + Agent Interactions (Audit Logs)",
        name: "Efficiency - Hours Per User Per Week",
        expression: String.raw`
AVERAGEX(
    CALCULATETABLE(VALUES('Chat + Agent Interactions (Audit Logs)'[WeekStart]), ALLEXCEPT('Chat + Agent Interactions (Audit Logs)', 'Chat + Agent Interactions (Audit Logs)'[WeekStart]), VALUES('Calendar'[Date])),
    DIVIDE([Expert Equivalent Hours], DISTINCTCOUNT('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]), 0)
)
`,
    },
    {
        table: "Headlines",
        name: "Executive Headline",
        expression: String.raw`
VAR Tsk        = [AI Tasks]
VAR HpW        = [Expert Equivalent Hours Per Week]
VAR WrkPerWeek = [Work Created - Per Week]
VAR Roles      = [New Expertise - Roles]
VAR LF         = UNICHAR(10)
VAR Insight    =
    SWITCH(
        TRUE(),
        HpW = 0,         "No measurable AI productivity in this view",
        HpW >= 5000,     "AI is delivering material weekly productivity across the org",
        HpW >= 1000,     "AI is delivering steady weekly productivity",
        "AI productivity is at an early, exploratory stage"
    )
VAR RawMetrics =
    FORMAT(Tsk, "#,##0") & " AI tasks  ·  " &
    FORMAT(HpW, "#,##0") & " expert equivalent hours per week  ·  " &
    FORMAT(WrkPerWeek, "#,##0") & " work items created  ·  " &
    FORMAT(Roles, "#,##0") & " specialist roles unlocked"
VAR Metrics =
    SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(
        RawMetrics,
        "0", UNICHAR(120812)),
        "1", UNICHAR(120813)),
        "2", UNICHAR(120814)),
        "3", UNICHAR(120815)),
        "4", UNICHAR(120816)),
        "5", UNICHAR(120817)),
        "6", UNICHAR(120818)),
        "7", UNICHAR(120819)),
        "8", UNICHAR(120820)),
        "9", UNICHAR(120821))
RETURN Insight & LF & Metrics
`,
    },
    {
        table: "Chat + Agent Interactions (Audit Logs)",
        name: "Expert Equivalent Hours Per Active User",
        expression: String.raw`
    DIVIDE(
        [Expert Equivalent Hours],
        DISTINCTCOUNT('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]),
        0
    )
`,
    },
    {
        table: "Chat + Agent Interactions (Audit Logs)",
        name: "Expert Equivalent Hours Per User",
        expression: String.raw`
    DIVIDE(
        [Expert Equivalent Hours],
        DISTINCTCOUNT('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]),
        0
    )
`,
    },
    {
        table: "Chat + Agent Interactions (Audit Logs)",
        name: "Heatmap Headline",
        expression: String.raw`
VAR _Order = SELECTEDVALUE('Heatmap Toggle'[Heatmap Toggle Order], 0)
VAR _Metric = SWITCH(_Order, 0, "Active Users", 1, "Active Days / User",
    3, "Modeled Hours / User", 4, "Sessions / User")
VAR _Ranked = ADDCOLUMNS(VALUES('Chat + Agent Org Data'[Organization]),
    "@Value", SWITCH(_Order, 0, [All Active Users], 1, [Average Active Days Per User (Chat + Agents)],
        3, [Expert Equivalent Hours Per Active User], 4, [Observed Sessions per User]))
VAR _Active = FILTER(_Ranked, [@Value] > 0)
VAR _Lead = TOPN(1, _Active, [@Value], DESC, 'Chat + Agent Org Data'[Organization], ASC)
VAR _Fmt = IF(_Order = 0, "#,##0", "#,##0.0")
RETURN IF(COUNTROWS(_Active) = 0, "No activity in the current selection.",
    _Metric & ": " & MAXX(_Lead, 'Chat + Agent Org Data'[Organization])
        & " leads at " & FORMAT(MAXX(_Lead, [@Value]), _Fmt)
        & " across " & FORMAT(COUNTROWS(_Active),"#,##0") & " active teams.")
`,
    },
    {
        table: "Chat + Agent Interactions (Audit Logs)",
        name: "Net ROI",
        expression: String.raw`
[AI Assisted Value] - [Copilot License Investment]
`,
    },
    {
        table: "Chat + Agent Interactions (Audit Logs)",
        name: "Projected Annualised Value",
        expression: String.raw`
VAR WeeksInView = DISTINCTCOUNT('Chat + Agent Interactions (Audit Logs)'[WeekStart])
VAR AnnualFactor = DIVIDE(52, MAX(WeeksInView, 1), 0)
RETURN [AI Assisted Value] * AnnualFactor
`,
    },
];
