import { app } from "@azure/functions";
import { verify as verifyWebhook } from "@octokit/webhooks-methods";
import { Octokit } from "octokit";
import vsts from "azure-devops-node-api";
import assert from "assert";
import { ManagedIdentityCredential } from "@azure/identity";
import { CryptographyClient } from "@azure/keyvault-keys";
import { createGitHubAppAuth } from "./github-app-auth.js";

const refreshWindowMs = 1000 * 60 * 5;

// We cache the clients below this way if a single comment executes two commands, we only bother creating the client once.
/** @type {{GH?: { token: string; api: Octokit["rest"] }, GHAppAuth?: ReturnType<typeof createGitHubAppAuth>, definitelyTypedGH?: { token: string; api: Octokit["rest"] }, vstsTypescript?: { expiresAt: number; api: vsts.WebApi }}} */
let clients = {};

const githubAppRepositories = ["TypeScript", "typescript-go"];

function getGitHubAppAuth() {
    const appClientId = process.env.GITHUB_APP_CLIENT_ID || process.env.GITHUB_APP_ID;
    assert(appClientId, "GITHUB_APP_CLIENT_ID or GITHUB_APP_ID must be set");
    const keyId = process.env.GITHUB_APP_KEY_VAULT_KEY_ID;
    assert(keyId, "GITHUB_APP_KEY_VAULT_KEY_ID must be set when using Key Vault GitHub App auth");
    if (!clients.GHAppAuth) {
        const cryptographyClient = new CryptographyClient(keyId, new ManagedIdentityCredential());
        /**
         * @param {string} signingInput
         */
        const signer = async (signingInput) => {
            const signature = await cryptographyClient.signData("RS256", Buffer.from(signingInput));
            return Buffer.from(signature.result).toString("base64url");
        };
        clients.GHAppAuth = createGitHubAppAuth({
            appClientId,
            signer,
            defaultOwner: "microsoft",
        });
    }
    return clients.GHAppAuth;
}

/** @returns {Record<string, "read" | "write" | "admin">} */
function getTokenPermissions() {
    return {
        actions: "write",
        contents: "read",
        issues: "write",
        pull_requests: "write",
    };
}

async function getGHClient() {
    const permissions = getTokenPermissions();

    const token = await getGitHubAppAuth().getToken({
        repositories: githubAppRepositories,
        permissions,
    });

    const cachedGH = clients.GH;
    if (cachedGH && cachedGH.token === token) {
        return cachedGH.api;
    }

    const api = new Octokit({ auth: token }).rest;
    clients.GH = { token, api };
    return api;
}

async function getDefinitelyTypedGHClient() {
    const token = await getGitHubAppAuth().getToken({
        owner: "DefinitelyTyped",
        repositories: ["DefinitelyTyped"],
        permissions: { contents: "read" },
    });

    if (clients.definitelyTypedGH?.token === token) {
        return clients.definitelyTypedGH.api;
    }

    const api = new Octokit({ auth: token }).rest;
    clients.definitelyTypedGH = { token, api };
    return api;
}

async function getDefinitelyTypedMasterSha() {
    const api = await getDefinitelyTypedGHClient();
    return (await api.repos.getBranch({ owner: "DefinitelyTyped", repo: "DefinitelyTyped", branch: "master" })).data.commit.sha;
}

const typeScriptProjectId = "cf7ac146-d525-443c-b23c-0d58337efebc";

async function getVSTSTypeScriptClient() {
    if (clients.vstsTypescript) {
        if (Date.now() < (clients.vstsTypescript.expiresAt - refreshWindowMs)) {
            return clients.vstsTypescript.api;
        }
    }

    const identity = new ManagedIdentityCredential();
    // Scope from https://learn.microsoft.com/en-us/rest/api/azure/devops/tokens/
    const token = await identity.getToken("499b84ac-1321-427f-aa17-267ca6975798/.default")

    const api = new vsts.WebApi("https://typescript.visualstudio.com/defaultcollection", vsts.getBearerHandler(token.token))
    clients.vstsTypescript = { expiresAt: token.expiresOnTimestamp, api };
    return api;
}

/**
 * @param {number} ms
 */
async function sleep(ms) {
    return new Promise(r => {
        setTimeout(r, ms);
    });
}

/**
 * @typedef {import("@octokit/webhooks-types").AuthorAssociation} AuthorAssociation
 * @typedef {Awaited<ReturnType<import("octokit").Octokit["rest"]["pulls"]["get"]>>["data"] | undefined} PR
 * @typedef {{ kind: "unresolvedGitHub"; distinctId: string }} UnresolvedGitHubRun
 * @typedef {{ kind: "resolved"; distinctId: string; url: string }} ResolvedRun
 * @typedef {{ kind: "error"; distinctId: string; error: string }} ErrorRun
 * @typedef {UnresolvedGitHubRun | ResolvedRun | ErrorRun} Run
 *
 * @typedef {{
 *     log: (s: string) => void;
 *     match: RegExpMatchArray;
 *     distinctId: string;
 *     issueNumber: number; // TODO(jakebailey): rename this
 *     pr: PR | undefined;
 *     requestingUser: string;
 *     statusCommentId: number; // TODO(jakebailey): rename this
 *     owner: string;
 *     repo: string;
 *     tsgo: boolean;
 * }} RequestInfo
 * @typedef {(request: RequestInfo) => Promise<Run>} CommandFn
 * @typedef {{ fn: CommandFn; authorAssociations: AuthorAssociation[]; prOnly: boolean, tsgoAllowed: boolean }} Command
 */
void 0;

/**
 * @param {CommandFn} fn
 * @param {AuthorAssociation[]} authorAssociations
 * @param {boolean} prOnly
 * @param {boolean} tsgoAllowed
 * @returns {Command}
 */
function createCommand(fn, authorAssociations = ["MEMBER", "OWNER", "COLLABORATOR"], prOnly = true, tsgoAllowed = false) {
    return { fn, authorAssociations, prOnly, tsgoAllowed };
}

/**
 * @typedef {{
 *     definition: {
 *         id: number;
 *     };
 *     project: {
 *         id: string;
 *     };
 *     sourceBranch: string;
 *     sourceVersion: string;
 *     parameters: string;
 *     templateParameters: Record<string, string>
 * }} BuildVars
 */
void 0;

/**
 * @param {RequestInfo} info
 * @param {Record<string, string>} inputs
 */
function createParameters(info, inputs) {
    /** @type {Record<string, string>} */
    const parameters = {
        distinct_id: info.distinctId,
        source_issue: `${info.issueNumber}`,
        requesting_user: info.requestingUser,
        status_comment: `${info.statusCommentId}`,
    };

    const requiredParameters = Object.keys(parameters);
    const confliciting = Object.keys(inputs).filter((key) => requiredParameters.includes(key));
    assert(confliciting.length === 0, `Inputs conflict with required parameters: ${confliciting.join(", ")}`);

    Object.assign(parameters, inputs);

    return parameters;
}

/**
 * This queues a build using the legacy AzDO build API.
 *
 * @typedef {{
 *    definitionId: number;
 *    sourceBranch: string;
 *    info: RequestInfo;
 *    inputs: Record<string, string>;
 * }} QueueBuildRequest
 *
 * @param {QueueBuildRequest} arg
 * @returns {Promise<ResolvedRun>}
 */
async function queueBuild({ definitionId, sourceBranch, info, inputs }) {
    const parameters = createParameters(info, inputs);

    /** @type {BuildVars} */
    const buildParams = {
        definition: { id: definitionId },
        project: { id: typeScriptProjectId },
        sourceBranch, // Undocumented, but used by the official frontend
        sourceVersion: ``, // Also undocumented
        parameters: JSON.stringify(parameters), // This API is real bad
        templateParameters: parameters,
    };

    info.log(`Trigger build ${definitionId} on ${info.issueNumber}`)
    const build = await (await getVSTSTypeScriptClient()).getBuildApi();
    const response = await build.queueBuild(buildParams, "TypeScript");
    return {
        kind: "resolved",
        distinctId: info.distinctId,
        url: response._links.web.href
    };
}

/**
 * @typedef {{
 *     resources?: {
 *         repositories?: Record<string, { refName?: string; version?: string }>;
 *     };
 *     variables?: Record<string, { isSecret?: boolean; value?: string; }>;
 *     templateParameters?: Record<string, string>;
 *     queue?: undefined;
 *     sourceBranch?: undefined;
 *     sourceVersion?: undefined;
 *     parameters?: undefined;
 * }} PipelineRunArgs
 */

/**
 * This queues a build using the AzDO Pipelines API.
 *
 * @typedef {{
*    definitionId: number;
*    repositories: Record<string, { refName?: string; version?: string }>
*    info: RequestInfo;
*    inputs: Record<string, string>;
* }} CreatePipelineRunRequest
*
* @param {CreatePipelineRunRequest} arg
* @returns {Promise<ResolvedRun>}
*/
async function createPipelineRun({ definitionId, repositories, info, inputs }) {
    const parameters = createParameters(info, inputs);

    /** @type {PipelineRunArgs} */
    const args = {
        resources: {
            repositories,
        },
        templateParameters: parameters,
    }

    info.log(`Trigger pipeline ${definitionId} on ${info.issueNumber}`)
    const api = await (await getVSTSTypeScriptClient()).getPipelinesApi();
    const result = await api.runPipeline(args, typeScriptProjectId, definitionId);
    return {
        kind: "resolved",
        distinctId: info.distinctId,
        url: result._links.web.href,
    };
}

/**
 * @param {string} workflowId
 * @param {{ distinct_id: string; issue_number: string; status_comment_id: string }} info
 * @param {Record<string, string>} inputs
 */

/**
 * This queues a build using the AzDO Pipelines API.
 *
 * @typedef {{
*    workflowId: string;
*    info: RequestInfo;
*    inputs: Record<string, string>;
* }} CreateWorkflowDispatchRequest
*
* @param {CreateWorkflowDispatchRequest} arg
* @returns {Promise<UnresolvedGitHubRun>}
*/
async function createWorkflowDispatch({ workflowId, info, inputs }) {
    const parameters = createParameters(info, inputs);

    const cli = await getGHClient();
    await cli.actions.createWorkflowDispatch({
        owner: "microsoft",
        repo: info.repo,
        ref: "main",
        workflow_id: workflowId,
        inputs: parameters,
    });

    return {
        kind: "unresolvedGitHub",
        distinctId: info.distinctId
    }
}


const commands = (/** @type {Map<RegExp, Command>} */ (new Map()))
    .set(/pack this/, createCommand((request) => {
        return queueBuild({
            definitionId: 19,
            sourceBranch: `refs/pull/${request.issueNumber}/merge`,
            info: request,
            inputs: {}
        })
    }))
    .set(/(?:new )?perf test(?: this)?(?: (.+)?)?/, createCommand((request) => {
        return createPipelineRun({
            definitionId: 69,
            repositories: request.tsgo ? {
                "typescript-go": {
                    refName: `refs/pull/${request.issueNumber}/merge`,
                }
            } : {
                TypeScript: {
                    refName: `refs/pull/${request.issueNumber}/merge`,
                }
            },
            info: request,
            inputs: {
                tsperf_preset: request.match[1] || "regular",
                ts_go: request.tsgo ? "true" : "false",
            }
        })
    },
        /* authorAssociations */ undefined,
        /* prOnly */ undefined,
        /* tsgoAllowed */ true,
    ))
    .set(/run dt/, createCommand(async (request) => {
        return queueBuild({
            definitionId: 23,
            sourceBranch: `refs/pull/${request.issueNumber}/merge`,
            info: request,
            inputs: {
                DT_SHA: await getDefinitelyTypedMasterSha()
            }
        })
    }))
    .set(/user test this(?: inline)?(?! slower)/, createCommand(async (request) => {
        assert(request.pr);
        return queueBuild({
            definitionId: 47,
            sourceBranch: "",
            info: request,
            inputs: {
                post_result: "true",
                old_ts_repo_url: request.pr.base.repo.clone_url,
                old_head_ref: request.pr.base.ref
            }
        })
    }))
    .set(/user test tsserver/, createCommand(async (request) => {
        assert(request.pr);
        return queueBuild({
            definitionId: 47,
            sourceBranch: "",
            info: request,
            inputs: {
                post_result: "true",
                old_ts_repo_url: request.pr.base.repo.clone_url,
                old_head_ref: request.pr.base.ref,
                entrypoint: "tsserver",
                prng_seed: `${request.pr.id}`,
            }
        })
    }))
    .set(/test top(\d{1,3})/, createCommand(async (request) => {
        assert(request.pr);
        return queueBuild({
            definitionId: 47,
            sourceBranch: "",
            info: request,
            inputs: {
                post_result: "true",
                old_ts_repo_url: request.pr.base.repo.clone_url,
                old_head_ref: request.pr.base.ref,
                top_repos: "true",
                repo_count: `${Math.max(+request.match[1], 400)}`,
            }
        })
    },
        /* authorAssociations */ undefined,
        /* prOnly */ undefined,
        /* tsgoAllowed */ true,
    ))
    .set(/test tsserver top(\d{1,3})/, createCommand(async (request) => {
        assert(request.pr);
        return queueBuild({
            definitionId: 47,
            sourceBranch: "",
            info: request,
            inputs: {
                post_result: "true",
                old_ts_repo_url: request.pr.base.repo.clone_url,
                old_head_ref: request.pr.base.ref,
                top_repos: "true",
                repo_count: `${Math.max(+request.match[1], 200)}`,
                entrypoint: "tsserver",
                prng_seed: `${request.pr.id}`,
            }
        })
    },
        /* authorAssociations */ undefined,
        /* prOnly */ undefined,
        /* tsgoAllowed */ true,
    ))
    .set(/cherry-?pick (?:this )?(?:in)?to (\S+)?/, createCommand(async (request) => {
        const targetBranch = request.match[1];

        const cli = await getGHClient();
        try {
            await cli.git.getRef({
                owner: "Microsoft",
                repo: "TypeScript",
                ref: `heads/${targetBranch}`
            });
        }
        catch (_) {
            return {
                kind: "error",
                distinctId: request.distinctId,
                error: `Branch \`${targetBranch}\` does not exist.`
            }
        }

        return createWorkflowDispatch({
            workflowId: "create-cherry-pick-pr.yml",
            info: request,
            inputs: {
                pr: `${request.issueNumber}`,
                target_branch: targetBranch,
            }
        })
    }))
    .set(/create release-([\d\.]+)/, createCommand(async (request) => {
        const targetBranch = `release-${request.match[1]}`;
        let targetBranchExists = false;
        try {
            await (await getGHClient()).git.getRef({
                owner: "Microsoft",
                repo: "TypeScript",
                ref: `heads/${targetBranch}`
            });
            targetBranchExists = true;
        }
        catch (_) {
            // OK, we expect an error
        }
        if (targetBranchExists) {
            return {
                kind: "error",
                distinctId: request.distinctId,
                error: `Branch \`${targetBranch}\` already exists.`
            }
        }
        return createWorkflowDispatch({
            workflowId: "new-release-branch.yaml",
            info: request,
            inputs: {
                package_version: `${request.match[1]}.0-beta`,
                core_major_minor: request.match[1],
                branch_name: targetBranch
            }
        })
    }, undefined, false))
    .set(/bump release-([\d\.]+)/, createCommand(async (request) => {
        const cli = await getGHClient();
        const targetBranch = `release-${request.match[1]}`;
        try {
            await cli.git.getRef({
                owner: "Microsoft",
                repo: "TypeScript",
                ref: `heads/${targetBranch}`
            });
        }
        catch (_) {
            // Branch does not exist
            return {
                kind: "error",
                distinctId: request.distinctId,
                error: `Branch \`${targetBranch}\` does not exist.`
            }
        }
        const contentResponse = await cli.repos.getContent({
            owner: "microsoft",
            repo: "TypeScript",
            ref: targetBranch,
            path: "package.json"
        });
        if (Array.isArray(contentResponse.data) || contentResponse.data.type !== "file" || !contentResponse.data.content) {
            return {
                kind: "error",
                distinctId: request.distinctId,
                error: `Branch \`${targetBranch}\` does not have a package.json`
            }
        }
        /** @type {string} */
        let currentVersion;
        try {
            const packageContent = JSON.parse(Buffer.from(contentResponse.data.content, "base64").toString("utf-8"));
            currentVersion = packageContent.version;
        }
        catch (_) {
            return {
                kind: "error",
                distinctId: request.distinctId,
                error: `Branch \`${targetBranch}\` has an invalid package.json`
            }
        }
        const parts = currentVersion.split(".");
        const majorMinor = parts.slice(0, 2).join(".");
        // > X.X.0-beta -> X.X.1-rc -> X.X.2 -> X.X.3
        const new_version = `${majorMinor}.${currentVersion.indexOf("beta") >= 0 ? "1-rc" : currentVersion.indexOf("rc") >= 0 ? "2" : (Number(parts[2]) + 1)}`;

        return createWorkflowDispatch({
            workflowId: "set-version.yaml",
            info: request,
            inputs: {
                package_version: new_version,
                core_major_minor: majorMinor,
                branch_name: targetBranch
            }
        })
    }, undefined, false))
    .set(/sync release-([\d\.]+)/, createCommand(async (request) => {
        const branch = `release-${request.match[1]}`;
        return createWorkflowDispatch({
            workflowId: "sync-branch.yaml",
            info: request,
            inputs: {
                branch_name: branch
            }
        })
    }, undefined, false))
    .set(/run repros/, createCommand(async (request) => {
        return createWorkflowDispatch({
            workflowId: "run-twoslash-repros.yaml",
            info: request,
            inputs: {
                number: `${request.issueNumber}`
            }
        })
    }, undefined, false))
    .set(/(auto)?fix this/, createCommand(async (request) => {
        assert(request.pr);
        assert(request.pr.head);
        if (request.pr.head.repo?.fork || request.pr.head.repo?.full_name != "microsoft/TypeScript") {
            return {
                kind: "error",
                distinctId: request.distinctId,
                error: `Can't invoke autofix workflow automatically on forks.`
            }
        }
        const cli = await getGHClient();
        await cli.actions.createWorkflowDispatch({
            owner: "microsoft",
            repo: "TypeScript",
            ref: request.pr.head.ref,
            workflow_id: "accept-baselines-fix-lints.yaml",
        });

        return {
            kind: "unresolvedGitHub",
            distinctId: request.distinctId
        }
    }))

const botCalls = ["@typescript-bot", "@typescript-automation"];

/**
 * @param {string} line
 * @returns {string | undefined} The remainder of the line after the bot call, or undefined if not a bot call.
 */
function matchBotCall(line) {
    for (const call of botCalls) {
        if (line.startsWith(call)) {
            return line.slice(call.length).trim();
        }
    }
    return undefined;
}

/**
 * @param {string} distinctId
 */
function getStatusPlaceholder(distinctId) {
    return `<!--status-${distinctId}-start-->🔄<!--status-${distinctId}-end-->`;
}

/**
 * @param {string} distinctId
 */
function getResultPlaceholder(distinctId) {
    // This string is known to other workflows/pipelines. Do not change without updating everything.
    return `<!--result-${distinctId}-->`;
}

/**
 * @param {string} s
 */
function asMarkdownInlineCode(s) {
    let backticks = "`";
    let space = "";
    while (s.includes(backticks)) {
        backticks += "`";
        space = " "
    }
    return `${backticks}${space}${s}${space}${backticks}`;
}

const testItSuffixes = ["test it", "test this"];
const testItCommandSuffixes = [
    "test top400",
    "user test this",
    "run dt",
    "perf test this faster",
];

/**
 * @typedef {{
 *     log: (s: string) => void;
 *     issueNumber: number;
 *     commentId: number;
 *     commentBody: string;
 *     commentIsFromIssue: boolean;
 *     isPr: boolean;
 *     commentUser: string;
 *     authorAssociation: AuthorAssociation;
 *     repo: string;
 * }} WebhookParams
 * @param {WebhookParams} params */
async function webhook(params) {
    const log = params.log;
    const cli = await getGHClient();

    let lines = params.commentBody.split("\n").map((line) => line.trim());
    let hasTestIt = false;
    lines = lines.filter((line) => {
        const rest = matchBotCall(line);
        if (rest !== undefined && testItSuffixes.includes(rest)) {
            hasTestIt = true;
            return false;
        }
        return true;
    })
    if (hasTestIt) {
        lines = [...lines, ...testItCommandSuffixes];
    }
    lines = [...new Set(lines)];

    const tsgo = params.repo.includes("typescript-go")
    const applicableCommands = Array.from(commands.entries()).filter(([, command]) => {
        if (!params.isPr && command.prOnly) {
            return false;
        }
        if (tsgo && !command.tsgoAllowed) {
            return false;
        }
        return command.authorAssociations.includes(params.authorAssociation);
    });

    if (applicableCommands.length === 0) {
        log("No applicable commands");
        return;
    }

    /** @type {{ name: string; match: RegExpExecArray; fn: CommandFn; }[]} */
    let commandsToRun = [];

    for (const line of lines) {
        let rest = matchBotCall(line);
        if (rest === undefined) {
            continue;
        }

        if (rest.startsWith(":")) {
            rest = rest.slice(1).trim();
        }

        for (const [key, command] of applicableCommands) {
            const match = key.exec(rest);
            if (!match) {
                continue;
            }
            commandsToRun.push({ name: rest, match, fn: command.fn });
        }
    }

    log(`Found ${commandsToRun.length} commands to run`);
    if (commandsToRun.length === 0) {
        return;
    }

    log(`Reacting to ${params.commentIsFromIssue ? "issue" : "review"} comment ${params.commentId}`);
    try {
        const createReaction = params.commentIsFromIssue ? cli.reactions.createForIssueComment : cli.reactions.createForPullRequestReviewComment;
        await createReaction({
            owner: "microsoft",
            repo: params.repo,
            comment_id: params.commentId,
            content: "+1",
        });
    } catch (e) {
        log(`Failed to react to comment: ${e}`);
    }

    /** @type {PR | undefined} */
    let pr;

    if (params.isPr) {
        pr = (await cli.pulls.get({ pull_number: params.issueNumber, owner: "microsoft", repo: params.repo })).data;

        if (!pr.merged && !pr.mergeable) {
            await cli.issues.createComment({
                owner: "microsoft",
                repo: params.repo,
                issue_number: params.issueNumber,
                body: `Hey @${params.commentUser}, this PR is in an unmergable state, so is missing a merge commit to run against; please resolve conflicts and try again.`,
            });
            return;
        }
    }

    const start = Date.now();
    const created = `>=${new Date(start).toISOString()}`;

    const commandInfos = commandsToRun.map((obj, index) => ({ ...obj, distinctId: `${params.commentId}-${index}` }));

    const statusCommentBody = `
Starting jobs; this comment will be updated as builds start and complete.

| Command | Status | Results |
| ------- | ------ | ------- |
${commandInfos.map(({ name, distinctId }) =>
        `| \`${name}\` | ${getStatusPlaceholder(distinctId)} | ${getResultPlaceholder(distinctId)} |`
    )
            .join("\n")
        }
`.trim();

    log("Creating status comment");
    const statusComment = await cli.issues.createComment({
        owner: "microsoft",
        repo: params.repo,
        issue_number: params.issueNumber,
        body: statusCommentBody,
    });

    const statusCommentId = statusComment.data.id;

    log("Starting runs...")
    /** @type {Run[]} */
    const startedRuns = await Promise.all(commandInfos.map(async ({ match, fn, distinctId }) => {
        try {
            return await fn({
                match,
                distinctId,
                issueNumber: params.issueNumber,
                statusCommentId: statusCommentId,
                requestingUser: params.commentUser,
                pr,
                log: log,
                owner: "microsoft",
                repo: params.repo,
                tsgo,
            });
        } catch (e) {
            // TODO: short error message
            log(/** @type {any} */(e)?.stack)
            return { kind: "error", distinctId, error: `${e}` };
        }
    }));

    log("Runs started");

    async function updateComment() {
        const comment = await cli.issues.getComment({
            owner: "microsoft",
            repo: params.repo,
            comment_id: statusCommentId,
        });

        const originalBody = comment.data.body;
        let body = comment.data.body;
        assert(body);

        for (const run of startedRuns) {
            const toReplace = getStatusPlaceholder(run.distinctId);
            let replacement;

            switch (run.kind) {
                case "unresolvedGitHub":
                    // Do nothing
                    break;
                case "resolved":
                    replacement = `[✅ Started](${run.url})`;
                    break;
                case "error": {
                    const errorMessage = run.error.replace(/\r?\n/g, " ").slice(0, 300);
                    replacement = `❌ Error: ${asMarkdownInlineCode(errorMessage)}`;
                    break;
                }
            }

            if (replacement) {
                body = body.replace(toReplace, replacement);
            }
        }

        if (body === originalBody) {
            return;
        }

        await cli.issues.updateComment({
            owner: "microsoft",
            repo: params.repo,
            comment_id: statusCommentId,
            body,
        });
    }

    await updateComment();
    log("Updated comment with build links");

    // Emperically, this process only takes 2-3 seconds to complete,
    // but stick a limit on it just in case.
    for (let i = 0; i < 50; i++) {
        if (!startedRuns.some((run) => run.kind === "unresolvedGitHub")) {
            break;
        }

        await sleep(500);

        const response = await cli.actions.listWorkflowRunsForRepo({
            owner: "microsoft",
            repo: params.repo,
            created,
            exclude_pull_requests: true,
        });
        const runs = response.data.workflow_runs;

        for (const [i, run] of startedRuns.entries()) {
            if (run.kind === "unresolvedGitHub") {
                const match = runs.find((candidate) => candidate.name?.includes(run.distinctId));
                if (match) {
                    startedRuns[i] = { kind: "resolved", distinctId: run.distinctId, url: match.html_url };
                }
            }
        }
    }

    log("Found runs");

    await updateComment();
    log("Updated comment with build links");
}

/** @type {import("@azure/functions").HttpHandler} */
async function handler(request, context) {
    context.log("Received request");
    const body = await request.text();

    const sig = request.headers.get("x-hub-signature-256");
    const webhookToken = process.env.WEBHOOK_TOKEN;
    assert(webhookToken, "WEBHOOK_TOKEN is not set")
    if (!sig || !verifyWebhook(webhookToken, body, `sha256=${sig}`)) {
        context.log("Invalid signature");
        return {};
    }

    /** @type {import("@octokit/webhooks-types").WebhookEvent} */
    const event = JSON.parse(body);
    context.log("Inspecting comment...");

    const isNewComment = "action" in event
        && (
            (event.action === "created" && "issue" in event) // issue_comment.created
            || (event.action === "submitted" && "review" in event) // pull_request_review.submitted
        )
    if (!isNewComment) {
        context.log("Not a new comment")
        return {};
    }

    const repoName = event.repository.name;
    const commentIsFromIssue = "comment" in event;
    const comment = commentIsFromIssue ? event.comment : event.review;
    if (!comment.body) {
        context.log("No comment body")
        return {};
    }

    const isPr = !!("pull_request" in event && event.pull_request)
        || !!("issue" in event && event.issue && event.issue.pull_request);

    const issueNumber = "issue" in event ? event.issue.number : event.pull_request.number;
    context.log(`Processing comment ${comment.id} on microsoft/${repoName} ${isPr ? "PR" : "issue"} ${issueNumber} by ${comment.user.login} (${comment.author_association})`)

    try {
        await webhook({
            // The azure functions logger is a getter and crashes if passed directly
            log: (s) => context.log(s),
            issueNumber,
            commentId: comment.id,
            commentBody: comment.body,
            commentIsFromIssue,
            isPr,
            commentUser: comment.user.login,
            authorAssociation: comment.author_association,
            repo: repoName,
        });
    } catch (e) {
        context.log(`Error processing comment: ${e}`);
        if (e instanceof Error) {
            context.log(e.stack);
        }
        return {
            status: 500,
        };
    }

    return {};
}

app.http('GithubCommentReader', {
    handler,
});
