import assert from "node:assert/strict";
import test from "node:test";
import { createPrSnapshot, isPrQuietPeriodActive } from "./pr-snapshot.js";

test("pins the actual base parent of a synthetic merge", () => {
    assert.deepEqual(
        createPrSnapshot("head", "merge", ["synthetic-base", "head"]),
        {
            headSha: "head",
            baseSha: "synthetic-base",
            mergeSha: "merge",
        },
    );
});

test("rejects a synthetic merge for a different head", () => {
    assert.equal(createPrSnapshot("head", "merge", ["base", "old-head"]), undefined);
});

test("rejects a commit that is not a two-parent merge", () => {
    assert.equal(createPrSnapshot("head", "merge", ["head"]), undefined);
});

test("exempts team-authored PRs from the quiet period", () => {
    assert.equal(
        isPrQuietPeriodActive(
            "2026-09-21T18:06:55Z",
            "2026-09-21T18:06:00Z",
            true,
            2 * 60 * 1000,
        ),
        false,
    );
});

test("retains the quiet period for other PRs", () => {
    assert.equal(
        isPrQuietPeriodActive(
            "2026-09-21T18:06:55Z",
            "2026-09-21T18:06:00Z",
            false,
            2 * 60 * 1000,
        ),
        true,
    );
});
