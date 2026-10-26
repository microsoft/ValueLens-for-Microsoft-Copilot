//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { scopeModels, type AppVariant } from "@/lib/app-variant";
import type { ModelReferences } from "@/lib/connections";
import { ALL_UNKNOWN } from "@/lib/optional-sources";
import {
    availableDestinations,
    availableProducts,
    destinations,
    isBandDestination,
    productDestinations,
    products,
    tabLabel,
    type Destination,
} from "@/components/destinations";

const byId = (id: string) => destinations.find((destination) => destination.id === id) as Destination;

describe("destinations", () => {
    it("each belong to one of the two products", () => {
        const ids = products.map((product) => product.id);
        expect(ids).toEqual(["valuelens", "consumption"]);
        for (const destination of destinations) expect(ids).toContain(destination.product);
    });

    it("put Ask and the assumptions in the band, outside any product's tabs", () => {
        expect(destinations.filter(isBandDestination).map((destination) => destination.id)).toEqual(["ask", "assumptions"]);
        expect(productDestinations(destinations, "valuelens").map((destination) => destination.id)).not.toContain("ask");
    });

    it("take a shorter tab name where one is set", () => {
        expect(tabLabel(byId("executive"))).toBe("Summary");
        expect(tabLabel(byId("appendix"))).toBe("Guide");
        expect(tabLabel(byId("adoption"))).toBe("Adoption");
    });

    it("give Consumption Central one destination, whose stages are its tabs", () => {
        expect(productDestinations(destinations, "consumption").map((destination) => destination.id)).toEqual(["consumption"]);
    });

    it("name the model every destination but Ask reads", () => {
        for (const destination of destinations) {
            if (destination.id === "ask") expect("connection" in destination).toBe(false);
            else if (destination.product === "consumption") expect(destination).toHaveProperty("connection", "cc");
            else expect(destination).toHaveProperty("connection", "vl");
        }
    });

    it("offer only the products with a destination available, in switcher order", () => {
        const valueLensOnly = destinations.filter((destination) => destination.product === "valuelens");
        expect(availableProducts(valueLensOnly).map((product) => product.id)).toEqual(["valuelens"]);
        expect(availableProducts(destinations).map((product) => product.id)).toEqual(["valuelens", "consumption"]);
        // Ask alone does not make a product worth switching to.
        expect(availableProducts([byId("ask"), byId("consumption")]).map((product) => product.id)).toEqual(["consumption"]);
    });
});

describe("destinations by app variant", () => {
    const WORKSPACE = "11111111-2222-3333-4444-555555555555";
    const ITEM = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const allModels: ModelReferences = {
        vl: { workspaceId: WORKSPACE, itemId: ITEM },
        cc: { workspaceId: WORKSPACE, itemId: ITEM },
    };
    const forVariant = (variant: AppVariant) => availableDestinations(scopeModels(allModels, variant), ALL_UNKNOWN);
    const destinationIds = (variant: AppVariant) => forVariant(variant).map((destination) => destination.id);
    const productIds = (variant: AppVariant) => availableProducts(forVariant(variant)).map((product) => product.id);

    it("shows only ValueLens in a ValueLens-only app", () => {
        expect(destinationIds("vl")).not.toContain("consumption");
        expect(destinationIds("vl")).toEqual(
            destinations.filter((destination) => destination.product === "valuelens").map((destination) => destination.id),
        );
        expect(productIds("vl")).toEqual(["valuelens"]);
    });

    it("shows only Consumption Central, plus Ask, in a Consumption Central-only app", () => {
        expect(destinationIds("cc")).toEqual(["consumption", "ask"]);
        expect(productIds("cc")).toEqual(["consumption"]);
    });

    it("shows both products when the app has both", () => {
        expect(destinationIds("both")).toEqual(destinations.map((destination) => destination.id));
        expect(productIds("both")).toEqual(["valuelens", "consumption"]);
    });
});
