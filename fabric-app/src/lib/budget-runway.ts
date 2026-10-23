//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** One day's spend, on an ISO `YYYY-MM-DD` date. */
export interface DailySpend {
    date: string;
    cost: number;
}

/** One week's spend, on the ISO date the week starts. */
export interface WeeklySpend {
    start: string;
    cost: number;
}

/**
 * - `no-data`: nothing has been spent in the source yet.
 * - `no-budget`: spend is known, but nobody has set a budget.
 * - `early`: too few days into the month to project from.
 * - `on-track`: the month is projected to end within budget.
 * - `at-risk`: the month is projected to end over budget.
 * - `over`: the month's spend has already passed the budget.
 */
export type RunwayStatus = "no-data" | "no-budget" | "early" | "on-track" | "at-risk" | "over";

export interface Runway {
    status: RunwayStatus;
    /** The last day the source has data for. The month runs to this day, not to today. */
    asOf?: string;
    monthStart?: string;
    monthEnd?: string;
    /** Calendar days from the start of the month to `asOf`, inclusive. */
    daysElapsed: number;
    daysInMonth: number;
    /** Spend from the start of the month to `asOf`. */
    spent: number;
    budget?: number;
    /** `spent` over `daysElapsed`; only once there are enough days to project from. */
    dailyAverage?: number;
    /** Where the month ends if the rest of it goes at `dailyAverage`. */
    projected?: number;
    /** The day spend passed the budget, or is projected to. */
    crossesOn?: string;
}

/** Fewer days than this and a month-end projection says more than the data does. */
export const MIN_DAYS_FOR_PROJECTION = 3;

const DAY_MS = 86_400_000;

function toUtc(date: string): number {
    return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

function fromUtc(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
    return fromUtc(toUtc(date) + days * DAY_MS);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A weekly series as a daily one: each week's spend spread evenly over its
 * seven days, so a week that straddles two months counts towards both.
 */
export function spreadWeeks(weeks: readonly WeeklySpend[]): DailySpend[] {
    const days: DailySpend[] = [];
    for (const week of weeks) {
        if (!ISO_DATE.test(week.start) || !Number.isFinite(week.cost)) continue;
        for (let offset = 0; offset < 7; offset++) days.push({ date: addDays(week.start, offset), cost: week.cost / 7 });
    }
    return days;
}

/**
 * How the month the data last reaches is going against a monthly budget.
 *
 * The month is the one `asOf` falls in, which defaults to the last day with
 * data, so a source that lags by a few days isn't read as a quiet month.
 * The projection assumes the rest of the month goes at the average so far:
 * a straight line, not a forecast.
 */
export function budgetRunway(days: readonly DailySpend[], budget: number | undefined, asOf?: string): Runway {
    const valid = days.filter((day) => ISO_DATE.test(day.date) && Number.isFinite(day.cost));
    const usableBudget = budget !== undefined && Number.isFinite(budget) && budget > 0 ? budget : undefined;
    const end = asOf ?? valid.reduce<string | undefined>((latest, day) => (!latest || day.date > latest ? day.date : latest), undefined);
    if (!end || valid.length === 0) {
        return { status: "no-data", daysElapsed: 0, daysInMonth: 0, spent: 0, budget: usableBudget };
    }

    const year = Number(end.slice(0, 4));
    const month = Number(end.slice(5, 7)) - 1;
    const monthStart = fromUtc(Date.UTC(year, month, 1));
    const monthEnd = fromUtc(Date.UTC(year, month + 1, 0));
    const daysInMonth = Number(monthEnd.slice(8, 10));
    const daysElapsed = Number(end.slice(8, 10));

    const inMonth = valid
        .filter((day) => day.date >= monthStart && day.date <= end)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const spent = inMonth.reduce((total, day) => total + day.cost, 0);

    const runway: Runway = {
        status: "no-budget",
        asOf: end,
        monthStart,
        monthEnd,
        daysElapsed,
        daysInMonth,
        spent,
        budget: usableBudget,
    };

    if (daysElapsed >= MIN_DAYS_FOR_PROJECTION) {
        runway.dailyAverage = spent / daysElapsed;
        runway.projected = spent + runway.dailyAverage * (daysInMonth - daysElapsed);
    }

    if (usableBudget === undefined) return runway;

    if (spent >= usableBudget) {
        let running = 0;
        for (const day of inMonth) {
            running += day.cost;
            if (running >= usableBudget) {
                runway.crossesOn = day.date;
                break;
            }
        }
        runway.status = "over";
        return runway;
    }

    if (runway.projected === undefined || runway.dailyAverage === undefined) {
        runway.status = "early";
        return runway;
    }

    if (runway.projected > usableBudget && runway.dailyAverage > 0) {
        runway.status = "at-risk";
        runway.crossesOn = addDays(end, Math.ceil((usableBudget - spent) / runway.dailyAverage));
        return runway;
    }

    runway.status = "on-track";
    return runway;
}

function money(value: number, prefix: string): string {
    return `${prefix}${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * Where a runway's marks sit on its bullet bar, each as a share of the bar.
 * The bar runs to whichever is largest of the budget, the spend and the
 * projection, so spend past the budget shows past its mark instead of
 * stopping at the end. `pace` marks what an even spread of the budget
 * would have used by now.
 */
export interface BulletScale {
    spent: number;
    projected?: number;
    budget: number;
    pace: number;
    /** The budget spread evenly over the month, to the day the data reaches. */
    expectedByNow: number;
}

/** The bullet bar's marks, or nothing without a budget to measure against. */
export function bulletScale(runway: Runway): BulletScale | undefined {
    const budget = runway.budget;
    if (budget === undefined || budget <= 0 || runway.daysInMonth <= 0) return undefined;
    const expectedByNow = budget * Math.min(1, runway.daysElapsed / runway.daysInMonth);
    const max = Math.max(budget, runway.spent, runway.projected ?? 0);
    return {
        spent: runway.spent / max,
        projected: runway.projected === undefined ? undefined : runway.projected / max,
        budget: budget / max,
        pace: expectedByNow / max,
        expectedByNow,
    };
}

/** What the bullet bar shows, as plain sentences for a screen reader. */
export function bulletLabel(runway: Runway, scale: BulletScale, prefix: string): string {
    const parts = [
        `Spent ${money(runway.spent, prefix)} of a ${money(runway.budget ?? 0, prefix)} budget.`,
        `An even pace would have used ${money(scale.expectedByNow, prefix)} by now.`,
    ];
    if (runway.projected !== undefined) parts.push(`At this pace the month ends near ${money(runway.projected, prefix)}.`);
    return parts.join(" ");
}

/** A short date such as "25 Apr", read from an ISO date without a time zone shift. */
export function shortDate(date: string): string {
    return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * One plain sentence on how the month is going. The projection is a straight
 * line, so it is "at this pace", never a forecast or a reason. `approximate`
 * is for a source reported by week, where the day spend passed the budget is
 * known only roughly.
 */
export function runwayHeadline(runway: Runway, prefix: string, approximate = false): string {
    const projected = runway.projected === undefined ? undefined : money(runway.projected, prefix);
    const monthEnd = runway.monthEnd ? shortDate(runway.monthEnd) : undefined;
    switch (runway.status) {
        case "no-data":
            return "No spend recorded yet.";
        case "no-budget":
            return projected ? `No budget set. At this pace the month ends near ${projected}.` : "No budget set.";
        case "early":
            return `Only ${runway.daysElapsed} ${runway.daysElapsed === 1 ? "day" : "days"} into the month, too early to project.`;
        case "over":
            return runway.crossesOn
                ? `Spend passed the budget ${approximate ? "around" : "on"} ${shortDate(runway.crossesOn)}.`
                : "Spend has passed the budget.";
        case "at-risk":
            return `At this pace, spend passes the budget around ${shortDate(runway.crossesOn ?? runway.monthEnd ?? "")} and ends the month near ${projected}.`;
        case "on-track": {
            const share = runway.budget && runway.projected !== undefined ? Math.round((runway.projected / runway.budget) * 100) : undefined;
            return `On track. At this pace the month ends near ${projected} by ${monthEnd}${share === undefined ? "" : `, ${share}% of budget`}.`;
        }
    }
}
