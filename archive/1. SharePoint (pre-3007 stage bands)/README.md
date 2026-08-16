# 1. SharePoint (pre-3007 stage bands)

The SharePoint template as it stood before the 30 Jul 2026 maturity re-band.

## Why it was replaced

The user maturity ladder used compound gates that combined active days with a
distinct-behaviour count:

| Stage | Old band |
|---|---|
| 1 - Beginner | 1-2 active days |
| 2 - Developing | 3-7 active days AND >=3 distinct behaviours |
| 3 - Habitual | 8-14 active days AND >=5 distinct behaviours |
| 4 - Power | >=15 active days, OR (>=10 days AND >=30% Producing/Delegating AND agent use) |

Those gates made the ladder non-monotonic: a user active 12 days a month with only
2 distinct behaviours failed both the Habitual and Developing breadth tests and fell
all the way through to Beginner. In a live tenant this left a meaningful share of
users unclassified by every stage measure at once.

The replacement uses distinct active days as the single input, aligned to the
AI-in-One Habit Formation bands so the two dashboards agree:

| Stage | New band |
|---|---|
| 0 - Inactive | 0 active days |
| 1 - Beginner | 1-5 |
| 2 - Developing | 6-10 |
| 3 - Habitual | 11-15 |
| 4 - Power | 16+ |

Breadth, value-focus and agent use are still reported - as the IsBroad /
IsValueFocused / IsFrontier badge columns on UserMonthMetrics - but they are no
longer gates on the ladder.

Not maintained. Use [`2. SharePoint/`](../../2.%20SharePoint/) instead.
