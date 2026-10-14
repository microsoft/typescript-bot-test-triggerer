import assert from "node:assert/strict";
import test from "node:test";
import { createPrSnapshot, getCopilotPrInitiator, isPrQuietPeriodActive } from "./pr-snapshot.js";

const workStarted = {
    id: 1,
    event: "copilot_work_started",
    created_at: "2026-10-14T21:59:11Z",
    actor: { login: "DanielRosenwasser", type: "User" },
    performed_via_github_app: { id: 1143301 },
};

test("finds the human initiator of an agent-authored PR", async () => {
    assert.equal(
        await getCopilotPrInitiator(198982749, async (page) => {
            assert.equal(page, 1);
            return { data: [workStarted], headers: {} };
        }),
        "DanielRosenwasser",
    );
});

test("does not inspect events on a PR authored by someone else", async () => {
    assert.equal(
        await getCopilotPrInitiator(123, async () => {
            assert.fail("must not fetch events for other PR authors");
        }),
        undefined,
    );
});

test("follows pagination links even when a page has fewer than 100 events", async () => {
    const pages: number[] = [];
    assert.equal(
        await getCopilotPrInitiator(198982749, async (page) => {
            pages.push(page);
            return page === 1
                ? { data: [], headers: { link: '<https://api.github.com/events?page=2>; rel="next"' } }
                : { data: [workStarted], headers: { link: '<https://api.github.com/events?page=1>; rel="prev"' } };
        }),
        "DanielRosenwasser",
    );
    assert.deepEqual(pages, [1, 2]);
});

test("does not replace the original initiator with a later session's actor", async () => {
    const pages: number[] = [];
    assert.equal(
        await getCopilotPrInitiator(198982749, async (page) => {
            pages.push(page);
            return page === 1
                ? {
                    data: [workStarted],
                    headers: { link: '<https://api.github.com/events?page=2>; rel="next"' },
                }
                : {
                    data: [{
                        ...workStarted,
                        id: 2,
                        created_at: "2026-10-15T00:00:00Z",
                        actor: { login: "another-user", type: "User" },
                    }],
                    headers: {},
                };
        }),
        "DanielRosenwasser",
    );
    assert.deepEqual(pages, [1, 2]);
});

test("selects the earliest event even if pages are not chronological", async () => {
    assert.equal(
        await getCopilotPrInitiator(198982749, async (page) => page === 1
            ? {
                data: [{ ...workStarted, id: 2, created_at: "2026-10-15T00:00:00Z" }],
                headers: { link: '<https://api.github.com/events?page=2>; rel="next"' },
            }
            : {
                data: [{ ...workStarted, actor: { login: "original-user", type: "User" } }],
                headers: {},
            }),
        "original-user",
    );
});

test("uses event IDs to break ties between session timestamps", async () => {
    assert.equal(
        await getCopilotPrInitiator(198982749, async () => ({
            data: [
                { ...workStarted, id: 2, actor: { login: "later-user", type: "User" } },
                workStarted,
            ],
            headers: {},
        })),
        "DanielRosenwasser",
    );
});

test("does not infer an initiator from assignments or unrelated events", async () => {
    assert.equal(
        await getCopilotPrInitiator(198982749, async () => ({
            data: [{ ...workStarted, event: "assigned" }],
            headers: {},
        })),
        undefined,
    );
});

test("leaves attribution unknown when there are no events", async () => {
    assert.equal(
        await getCopilotPrInitiator(198982749, async () => ({ data: [], headers: {} })),
        undefined,
    );
});

test("requires a human actor and the expected app on the first work-started event", async () => {
    for (const event of [
        { ...workStarted, actor: null },
        { ...workStarted, actor: { login: "Copilot", type: "Bot" } },
        { ...workStarted, performed_via_github_app: null },
        { ...workStarted, performed_via_github_app: undefined },
        { ...workStarted, performed_via_github_app: { id: 123 } },
    ]) {
        assert.equal(
            await getCopilotPrInitiator(198982749, async () => ({
                data: [
                    event,
                    { ...workStarted, id: 2, created_at: "2026-10-15T00:00:00Z" },
                ],
                headers: {},
            })),
            undefined,
        );
    }
});

test("propagates failures instead of treating incomplete history as verified attribution", async () => {
    await assert.rejects(
        getCopilotPrInitiator(198982749, async (page) => {
            if (page === 1) {
                return {
                    data: [workStarted],
                    headers: { link: '<https://api.github.com/events?page=2>; rel="next"' },
                };
            }
            throw new Error("Unable to fetch next page");
        }),
        /Unable to fetch next page/,
    );
});

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
