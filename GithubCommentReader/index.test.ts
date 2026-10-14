import assert from "node:assert/strict";
import test from "node:test";
import { getApplicableCommands } from "./index.js";

const commandCases = [
    { text: "pack this", prOnly: true },
    { text: "perf test this", prOnly: true },
    { text: "run dt", prOnly: true },
    { text: "user test this", prOnly: true },
    { text: "user test tsserver", prOnly: true },
    { text: "test top400", prOnly: true },
    { text: "test tsserver top400", prOnly: true },
    { text: "cherry-pick this into release-7.1", prOnly: true },
    { text: "create release-7.1", prOnly: false },
    { text: "bump release-7.1", prOnly: false },
    { text: "sync release-7.1", prOnly: false },
    { text: "run repros", prOnly: false },
    { text: "fix this", prOnly: true },
];

test("covers every registered command exactly once", () => {
    const commands = getApplicableCommands(true);
    assert.equal(commands.length, commandCases.length);
    for (const [pattern] of commands) {
        assert.equal(commandCases.filter(({ text }) => pattern.test(text)).length, 1, `${pattern}`);
    }
    for (const { text } of commandCases) {
        assert.equal(commands.filter(([pattern]) => pattern.test(text)).length, 1, text);
    }
});

for (const isPr of [false, true]) {
    test(`selects commands for TypeScript ${isPr ? "PRs" : "issues"}`, () => {
        const commands = getApplicableCommands(isPr);
        const actual = commandCases
            .filter(({ text }) => commands.some(([pattern]) => pattern.test(text)))
            .map(({ text }) => text);
        const expected = commandCases
            .filter(({ prOnly }) => isPr || !prOnly)
            .map(({ text }) => text);
        assert.deepEqual(actual, expected);
    });
}
