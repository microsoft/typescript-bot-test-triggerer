import assert from "node:assert/strict";
import test from "node:test";
import { getApplicableCommands } from "./index.js";

const commandCases = [
    { text: "pack this", prOnly: true, tsgoAllowed: false },
    { text: "perf test this", prOnly: true, tsgoAllowed: true },
    { text: "run dt", prOnly: true, tsgoAllowed: false },
    { text: "user test this", prOnly: true, tsgoAllowed: false },
    { text: "user test tsserver", prOnly: true, tsgoAllowed: false },
    { text: "test top400", prOnly: true, tsgoAllowed: true },
    { text: "test tsserver top400", prOnly: true, tsgoAllowed: true },
    { text: "cherry-pick this into release-7.1", prOnly: true, tsgoAllowed: false },
    { text: "create release-7.1", prOnly: false, tsgoAllowed: false },
    { text: "bump release-7.1", prOnly: false, tsgoAllowed: false },
    { text: "sync release-7.1", prOnly: false, tsgoAllowed: false },
    { text: "run repros", prOnly: false, tsgoAllowed: false },
    { text: "fix this", prOnly: true, tsgoAllowed: false },
];

test("covers every registered command exactly once", () => {
    const commands = getApplicableCommands(true, false);
    assert.equal(commands.length, commandCases.length);
    for (const [pattern] of commands) {
        assert.equal(commandCases.filter(({ text }) => pattern.test(text)).length, 1, `${pattern}`);
    }
    for (const { text } of commandCases) {
        assert.equal(commands.filter(([pattern]) => pattern.test(text)).length, 1, text);
    }
});

for (const isPr of [false, true]) {
    for (const tsgo of [false, true]) {
        test(`selects commands for ${tsgo ? "typescript-go" : "TypeScript"} ${isPr ? "PRs" : "issues"}`, () => {
            const commands = getApplicableCommands(isPr, tsgo);
            const actual = commandCases
                .filter(({ text }) => commands.some(([pattern]) => pattern.test(text)))
                .map(({ text }) => text);
            const expected = commandCases
                .filter(({ prOnly, tsgoAllowed }) => (isPr || !prOnly) && (!tsgo || tsgoAllowed))
                .map(({ text }) => text);
            assert.deepEqual(actual, expected);
        });
    }
}
