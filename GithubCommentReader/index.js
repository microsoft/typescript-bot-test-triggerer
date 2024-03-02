const { app } = require("@azure/functions");
const { verify: verifyWebhook } = require("@octokit/webhooks-methods");
const { Octokit } = require("octokit");
const vsts = require("azure-devops-node-api");
const assert = require("assert");

// We cache the clients below this way if a single comment executes two commands, we only bother creating the client once
/** @type {{GH?: Octokit["rest"], vstsTypescript?: vsts.WebApi}} */
let clients = {};

function getGHClient() {
    if (clients.GH) {
        return clients.GH;
    }
    else {
        const token = process.env.GITHUB_TOKEN;
        assert(token, "GITHUB_TOKEN must be set");
        clients.GH = new Octokit({ auth: token }).rest;
        return clients.GH;
    }
}

const typeScriptProjectId = "cf7ac146-d525-443c-b23c-0d58337efebc";

function getVSTSTypeScriptClient() {
    if (clients.vstsTypescript) {
        return clients.vstsTypescript;
    }
    else {
        const token = process.env.VSTS_TOKEN;
        assert(token, "VSTS_TOKEN must be set");
        clients.vstsTypescript = new vsts.WebApi("https://typescript.visualstudio.com/defaultcollection", vsts.getPersonalAccessTokenHandler(token));
        return clients.vstsTypescript;
    }
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
 *     isPr: boolean;
 *     requestingUser: string;
 *     statusCommentId: number; // TODO(jakebailey): rename this
 * }} RequestInfo
 * @typedef {(request: RequestInfo) => Promise<Run>} CommandFn
 * @typedef {{ fn: CommandFn; authorAssociations: AuthorAssociation[]; prOnly: boolean }} Command
 */
void 0;

/**
 * @param {CommandFn} fn
 * @param {AuthorAssociation[]} authorAssociations
 * @param {boolean} prOnly
 * @returns {Command}
 */
function createCommand(fn, authorAssociations = ["MEMBER", "OWNER", "COLLABORATOR"], prOnly = true) {
    return { fn, authorAssociations, prOnly };
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
    const build = await getVSTSTypeScriptClient().getBuildApi();
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
 *         repositories?: Record<string, { refName?: string; version?: string } | undefined>;
 *     };
 *     variables?: Record<string, { isSecret?: boolean; value?: string; } | undefined>;
 *     templateParameters?: Record<string, string | number | boolean | undefined>;
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
*    repositories: Record<string, { refName?: string; version?: string } | undefined>
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
    const build = await getVSTSTypeScriptClient().getBuildApi();
    // The new pipelines API is not yet supported by the node client, so we have to do this manually.
    // The request was reverse engineered from the HTTP requests made by the azure devops UI, the node client, and the Go client (which has implemented this).
    // https://github.com/microsoft/azure-devops-go-api/blob/8dbf8bfd3346f337d914961fab01df812985dcb8/azuredevops/v7/pipelines/client.go#L446
    const verData = await build.vsoClient.getVersioningData("7.1-preview.1", "pipelines", "7859261e-d2e9-4a68-b820-a5d84cc5bb3d", { project: typeScriptProjectId, pipelineId: definitionId });
    const url = verData.requestUrl;
    const options = build.createRequestOptions('application/json', verData.apiVersion);
    assert(url);

    const response = await build.rest.create(url, args, options);
    return {
        kind: "resolved",
        distinctId: info.distinctId,
        url: response.result._links.web.href,
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

    const cli = getGHClient();
    await cli.actions.createWorkflowDispatch({
        owner: "microsoft",
        repo: "TypeScript",
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
    .set(/(?:new )?perf test(?: this)?(?: (\S+)?)?/, createCommand((request) => {
        return createPipelineRun({
            definitionId: 69,
            repositories: {
                TypeScript: {
                    refName: `refs/pull/${request.issueNumber}/merge`,
                }
            },
            info: request,
            inputs: {
                tsperf_preset: request.match[1] || "regular",
            }
        })
    }))
    .set(/run dt/, createCommand(async (request) => {
        return queueBuild({
            definitionId: 23,
            sourceBranch: `refs/pull/${request.issueNumber}/merge`,
            info: request,
            inputs: {
                DT_SHA: (await getGHClient().repos.getBranch({owner: "DefinitelyTyped", repo: "DefinitelyTyped", branch: "master"})).data.commit.sha
            }
        })
    }))
    .set(/user test this(?: inline)?(?! slower)/, createCommand(async (request) => {
        const pr = (await getGHClient().pulls.get({ pull_number: request.issueNumber, owner: "microsoft", repo: "TypeScript" })).data;
        return queueBuild({
            definitionId: 47,
            sourceBranch: "",
            info: request,
            inputs: {
                post_result: "true",
                old_ts_repo_url: pr.base.repo.clone_url,
                old_head_ref: pr.base.ref
            }
        })
    }))
    .set(/user test tsserver/, createCommand(async (request) => {
        const pr = (await getGHClient().pulls.get({ pull_number: request.issueNumber, owner: "microsoft", repo: "TypeScript" })).data;
        return queueBuild({
            definitionId: 47,
            sourceBranch: "",
            info: request,
            inputs: {
                post_result: "true",
                old_ts_repo_url: pr.base.repo.clone_url,
                old_head_ref: pr.base.ref,
                entrypoint: "tsserver",
                prng_seed: `${pr.id}`,
            }
        })
    }))
    .set(/test top(\d{1,3})/, createCommand(async (request) => {
        const pr = (await getGHClient().pulls.get({ pull_number: request.issueNumber, owner: "microsoft", repo: "TypeScript" })).data;
        return queueBuild({
            definitionId: 47,
            sourceBranch: "",
            info: request,
            inputs: {
                post_result: "true",
                old_ts_repo_url: pr.base.repo.clone_url,
                old_head_ref: pr.base.ref,
                top_repos: "true",
                repo_count: request.match[1]
            }
        })
    }))
    .set(/test tsserver top(\d{1,3})/, createCommand(async (request) => {
        const pr = (await getGHClient().pulls.get({ pull_number: request.issueNumber, owner: "microsoft", repo: "TypeScript" })).data;
        return queueBuild({
            definitionId: 47,
            sourceBranch: "",
            info: request,
            inputs: {
                post_result: "true",
                old_ts_repo_url: pr.base.repo.clone_url,
                old_head_ref: pr.base.ref,
                top_repos: "true",
                repo_count: request.match[1],
                entrypoint: "tsserver",
                prng_seed: `${pr.id}`,
            }
        })
    }))
    .set(/cherry-?pick (?:this )?(?:in)?to (\S+)?/, createCommand(async (request) => {
        const targetBranch = request.match[1];

        const cli = getGHClient();
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
            await getGHClient().git.getRef({
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
                core_tag: "beta",
                branch_name: targetBranch
            }
        })
    }, undefined, false))
    .set(/bump release-([\d\.]+)/, createCommand(async (request) => {
        const cli = getGHClient();
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

const botCall = "@typescript-bot";

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
 * @typedef {{
 *     log: (s: string) => void;
 *     issueNumber: number;
 *     commentId: number;
 *     commentBody: string;
 *     isPr: boolean;
 *     commentUser: string;
 *     authorAssociation: AuthorAssociation
 * }} WebhookParams 
 * @param {WebhookParams} params */
async function webhook(params) {
    const log = params.log;
    const cli = getGHClient();

    const lines = params.commentBody.split("\n").map((line) => line.trim());

    const applicableCommands = Array.from(commands.entries()).filter(([, command]) => {
        if (!params.isPr && command.prOnly) {
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

    for (let line of lines) {
        if (!line.startsWith(botCall)) {
            continue;
        }
        line = line.slice(botCall.length).trim();

        for (const [key, command] of applicableCommands) {
            const match = key.exec(line);
            if (!match) {
                continue;
            }
            commandsToRun.push({ name: line, match, fn: command.fn });
        }
    }

    log(`Found ${commandsToRun.length} commands to run`);
    if (commandsToRun.length === 0) {
        return;
    }


    const start = Date.now();
    const created = `>=${new Date(start).toISOString()}`;

    const commandInfos = commandsToRun.map((obj, index) => ({ ...obj, distinctId: `${params.commentId}-${index}` }));

    const statusCommentBody = `
Starting jobs; this comment will be updated as builds start and complete.

| Command | Status | Results |
| ------- | ------ | ------- |
${
        commandInfos.map(({ name, distinctId }) =>
            `| \`${name}\` | ${getStatusPlaceholder(distinctId)} | ${getResultPlaceholder(distinctId)} |`
        )
            .join("\n")
    }
`.trim();

    log("Creating status comment");
    const statusComment = await cli.issues.createComment({
        owner: "microsoft",
        repo: "TypeScript",
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
                isPr: params.isPr,
                log: log,
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
            repo: "TypeScript",
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
                case "error":
                    replacement = `❌ Error: ${run.error}`;
                    break;
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
            repo: "TypeScript",
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
            repo: "TypeScript",
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
    const body = await request.text();

    const sig = request.headers.get("x-hub-signature-256");
    const webhookToken = process.env.WEBHOOK_TOKEN;
    assert(webhookToken, "WEBHOOK_TOKEN is not set")
    if (!sig || !verifyWebhook(webhookToken, body, `sha256=${sig}`)) {
        return {};
    }

    /** @type {import("@octokit/webhooks-types").WebhookEvent} */
    const event = JSON.parse(body);
    context.log("Inspecting comment...");

    const isNewComment = "action" in event
        && (event.action === "created" || event.action === "submitted")
        && ("issue" in event || "pull_request" in event);
    if (!isNewComment) {
        context.log("Not a new comment")
        return {};
    }

    const comment = "comment" in event ? event.comment : event.review;
    if (!comment.body) {
        context.log("No comment body")
        return {};
    }

    const isPr = !!("pull_request" in event && event.pull_request)
        || !!("issue" in event && event.issue && event.issue.pull_request);

    const issueNumber = "issue" in event ? event.issue.number : event.pull_request.number;

    context.log(`Processing comment ${comment.id} on ${isPr ? "PR" : "issue"} ${issueNumber} by ${comment.user.login} (${comment.author_association})`)

    await webhook({
        log: context.log,
        issueNumber,
        commentId: comment.id,
        commentBody: comment.body,
        isPr,
        commentUser: comment.user.login,
        authorAssociation: comment.author_association,
    });

    return {};
}

app.http('GithubCommentReader', {
    handler,
});
