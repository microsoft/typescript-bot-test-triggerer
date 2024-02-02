const Client = require("@octokit/rest");
const vsts = require("azure-devops-node-api");
const crypto = require("crypto");
const assert = require("assert");

// We cache the clients below this way if a single comment executes two commands, we only bother creating the client once
/** @type {{GH?: Client.Octokit, vstsTypescript?: vsts.WebApi, vstsDevdiv?: vsts.WebApi}} */
let clients = {};

function getGHClient() {
    if (clients.GH) {
        return clients.GH;
    }
    else {
        clients.GH = new Client.Octokit({
            auth: process.env.GITHUB_TOKEN
        });
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
 * Authenticate with github and vsts, make a comment saying what's being done, then schedule the build
 * and update the comment with the build log URL.
 * @param {*} request The request object
 * @param {string} suiteName The frindly name to call the suite in the associated comment
 * @param {number} definitionId The VSTS id of the build definition to trigger
 * @param {(s: string) => void} log
 * @param {(pr: Client.RestEndpointMethodTypes["pulls"]["get"]["response"]["data"], commentId: number) => Promise<string>} buildTrigger
 */
async function commentAndTriggerBuild(request, suiteName, definitionId, log, buildTrigger) {
    log(`New build for ${suiteName} (${definitionId}) on ${request.issue.number}`)
    const cli = getGHClient();
    log("Got github client")
    const pr = (await cli.pulls.get({ pull_number: request.issue.number, owner: "microsoft", repo: "TypeScript" })).data;
    log(`Got pr for ${request.issue.number}`)
    const refSha = pr.head.sha;
    const requestingUser = request.comment.user.login;
    const result = await cli.issues.createComment({
        body: `Heya @${requestingUser}, I'm starting to run the ${suiteName} on this PR at ${refSha}. Hold tight - I'll update this comment with the log link once the build has been queued.`,
        issue_number: pr.number,
        owner: "microsoft",
        repo: "TypeScript"
    });
    const commentId = result.data.id;
    log(`Created new "started running" comment ${commentId}`)
    const buildUrl = await buildTrigger(pr, commentId);
    log(`Build done queueing`)
    await cli.issues.updateComment({
        owner: "microsoft",
        repo: "TypeScript",
        comment_id: commentId,
        body: `Heya @${requestingUser}, I've started to run the ${suiteName} on this PR at ${refSha}. You can monitor the build [here](${buildUrl}).`
    });
    log(`Updated to "build is queued" comment ${commentId}`)
}

/**
 * @typedef {{
 *   definition: {
 *       id: number;
 *   };
 *   queue: {
 *       id: number;
 *   };
 *   project: {
 *       id: string;
 *   };
 *   sourceBranch: string;
 *   sourceVersion: string;
 *   parameters: string;
 * }} BuildVars
 */

/**
 * Authenticate with github and vsts, make a comment saying what's being done, then schedule the build
 * and update the comment with the build log URL.
 * @param {*} request The request object
 * @param {string} suiteName The frindly name to call the suite in the associated comment
 * @param {number} definitionId The VSTS id of the build definition to trigger
 * @param {(s: string) => void} log
 * @param {(x: BuildVars) => (Promise<BuildVars> | BuildVars)} buildTriggerAugmentor maps the intial build request into an enhanced one
 */
async function makeNewBuildWithComments(request, suiteName, definitionId, log, buildTriggerAugmentor = p => p) {
    await commentAndTriggerBuild(request, suiteName, definitionId, log, async (pr, commentId) => {
        log(`Trigger build ${definitionId} on ${request.issue.number}`)
        const build = await getVSTSTypeScriptClient().getBuildApi();
        log("Got VSTS Client's Build API")
        const requestingUser = request.comment.user.login;
        let buildParams = /** @type BuildVars & { templateParameters: Record<string, string> } */ (await buildTriggerAugmentor({
            definition: { id: definitionId },
            queue: { id: 26 },
            project: { id: typeScriptProjectId },
            sourceBranch: `refs/pull/${pr.number}/merge`, // Undocumented, but used by the official frontend
            sourceVersion: ``, // Also undocumented
            parameters: JSON.stringify({ source_issue: pr.number, requesting_user: requestingUser, status_comment: commentId }), // This API is real bad
        }));
        buildParams.templateParameters = JSON.parse(buildParams.parameters);
        log(`Final template parameters after augmentation: ${JSON.stringify(buildParams.templateParameters)}`)
        const response = await build.queueBuild(buildParams, "TypeScript");
        return response._links.web.href;
    })
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
 * Authenticate with github and vsts, make a comment saying what's being done, then schedule the build
 * and update the comment with the build log URL.
 * @param {*} request The request object
 * @param {string} suiteName The frindly name to call the suite in the associated comment
 * @param {number} definitionId The VSTS id of the build definition to trigger
 * @param {(s: string) => void} log
 * @param {(x: PipelineRunArgs) => (Promise<PipelineRunArgs> | PipelineRunArgs)} buildTriggerAugmentor maps the intial build request into an enhanced one
 */
async function makeNewPipelineRunWithComments(request, suiteName, definitionId, log, buildTriggerAugmentor = p => p) {
    await commentAndTriggerBuild(request, suiteName, definitionId, log, async (pr, commentId) => {
        log(`Trigger pipeline ${definitionId} on ${request.issue.number}`)
        const build = await getVSTSTypeScriptClient().getBuildApi();
        log("Got VSTS Client's Build API")

        // The new pipelines API is not yet supported by the node client, so we have to do this manually.
        // The request was reverse engineered from the HTTP requests made by the azure devops UI, the node client, and the Go client (which has implemented this).
        // https://github.com/microsoft/azure-devops-go-api/blob/8dbf8bfd3346f337d914961fab01df812985dcb8/azuredevops/v7/pipelines/client.go#L446
        const verData = await build.vsoClient.getVersioningData("7.1-preview.1", "pipelines", "7859261e-d2e9-4a68-b820-a5d84cc5bb3d", { project: typeScriptProjectId, pipelineId: definitionId });
        const url = verData.requestUrl;
        const options = build.createRequestOptions('application/json', verData.apiVersion);
        assert(url);

        const requestingUser = request.comment.user.login;
        /** @type {PipelineRunArgs} */
        let args = {
            resources: {
                repositories: {
                    self: {
                        refName: `refs/pull/${pr.number}/merge`,
                    }
                }
            },
            templateParameters: {
                source_issue: pr.number,
                requesting_user: requestingUser,
                status_comment: commentId,
            }
        }
        args = await buildTriggerAugmentor(args);

        log(`Final template parameters after augmentation: ${JSON.stringify(args)}`)
        const response = await build.rest.create(url, args, options);
        return response.result._links.web.href;
    })
}

/**
 * @param {any} request
 * @param {string} event
 * @param {Record<string, unknown>} payload
 */
async function triggerGHAction(request, event, payload) {
    const cli = getGHClient();
    const requestingUser = request.comment.user.login;
    try {
        await cli.repos.createDispatchEvent({
            owner: "microsoft",
            repo: "TypeScript",
            event_type: event,
            client_payload: payload
        });
    }
    catch (err) {
        await cli.issues.createComment({
            body: `Heya @${requestingUser}, I couldn't dispatch the ${event} event`,
            issue_number: request.issue.number,
            owner: "microsoft",
            repo: "TypeScript"
        });
        return;
    }
}

/**
 * @param {number} duration - in seconds
 */
async function sleep(duration) {
    return new Promise(r => {
        setTimeout(r, duration * 1000);
    });
}

/**
 * @param {any} request
 * @param {string} event
 * @param {Record<string, unknown>} payload
 * @param {string} message
 */
async function triggerGHActionWithComment(request, event, payload, message) {
    const cli = getGHClient();
    await triggerGHAction(request, event, payload);
    await sleep(2);
    // we sleep because it takes a bit for the triggered event to cause a new run to appear
    // this improves our odds of findings the new run, rather than the old one
    // TODO: If GH ever makes the `repository_dispatch` event actually return the scheduled jobs,
    // use that info here
    const workflow = await cli.actions.listWorkflowRunsForRepo({
        owner: "microsoft",
        repo: "TypeScript",
        branch: "main",
        event: "repository_dispatch"
    });
    const requestingUser = request.comment.user.login;
    await cli.issues.createComment({
        body: `Heya @${requestingUser}, I've started to ${message} for you. [Here's the link to my best guess at the log](${workflow.data.workflow_runs[0].html_url}).`,
        issue_number: request.issue.number,
        owner: "microsoft",
        repo: "TypeScript"
    });
}

/**
 * @typedef {Object} CommentAction
 * @property {(req: any, log: (s: string) => void, match: RegExpExecArray) => Promise<void>} task
 * @property {("MEMBER" | "OWNER" | "COLLABORATOR")[]} relationships
 * @property {boolean} prOnly
 */

/**
 * @param {(req: any, log: (s: string) => void, match: RegExpExecArray) => Promise<void>} task
 * @param {("MEMBER" | "OWNER" | "COLLABORATOR")[]=} relationships
 * @param {boolean=} prOnly
 * @returns {CommentAction}
 */
function action(task, relationships = ["MEMBER", "OWNER", "COLLABORATOR"], prOnly = true) {
    return {
        task,
        relationships,
        prOnly
    };
}

const commands = (/** @type {Map<RegExp, CommentAction>} */(new Map()))
    .set(/run dt slower/, action(async (request, log) => await makeNewBuildWithComments(request, "Definitely Typed test suite", 18, log)))
    .set(/pack this/, action(async (request, log) => await makeNewBuildWithComments(request, "tarball bundle task", 19, log)))
    .set(/(?:new )?perf test(?: this)?(?: (\S+)?)?/, action(async (request, log, match) => {
        let preset = match[1] || "regular";

        await makeNewPipelineRunWithComments(request, `${preset} perf test suite`, 69, log, p => {
            // makeNewPipelineRunWithComments assumes that the pipeline is defined on TypeScript,
            // but this pipeline is defined on typescript-benchmarking, so we move the self reference
            // over to TypeScript (the name known to the benchmark pipeline).
            const self = p.resources?.repositories?.self;
            assert(self);
            return {
                ...p,
                resources: {
                    repositories: {
                        TypeScript: self,
                    }
                },
                templateParameters: {
                    ...p.templateParameters,
                    tsperf_preset: preset,
                }
            }
        });
    }))
    .set(/run dt(?! slower)/, action(async (request, log) => await makeNewBuildWithComments(request, "parallelized Definitely Typed test suite", 23, log, async p => ({
        ...p,
        parameters: JSON.stringify({
            ...JSON.parse(p.parameters),
            DT_SHA: (await getGHClient().repos.getBranch({owner: "DefinitelyTyped", repo: "DefinitelyTyped", branch: "master"})).data.commit.sha
        })
    }))))
    .set(/user test this slower/, action(async (request, log) => await makeNewBuildWithComments(request, "community code test suite", 24, log, async p => {
        const cli = getGHClient();
        const pr = (await cli.pulls.get({ pull_number: request.issue.number, owner: "microsoft", repo: "TypeScript" })).data;

        return {...p, parameters: JSON.stringify({
            ...JSON.parse(p.parameters),
            target_fork: pr.head.repo?.owner.login,
            target_branch: pr.head.ref
        })};
    })))
    .set(/user test this(?: inline)?(?! slower)/, action(async (request, log) => await makeNewBuildWithComments(request, "diff-based user code test suite", 47, log, async p => {
        const cli = getGHClient();
        const pr = (await cli.pulls.get({ pull_number: request.issue.number, owner: "microsoft", repo: "TypeScript" })).data;

        return {
            ...p,
            sourceBranch: "",
            parameters: JSON.stringify({
                ...JSON.parse(p.parameters),
                post_result: true,
                old_ts_repo_url: pr.base.repo.clone_url,
                old_head_ref: pr.base.ref
            })
        };
    })))
    .set(/user test tsserver/, action(async (request, log) => await makeNewBuildWithComments(request, "diff-based user code test suite (tsserver)", 47, log, async p => {
        const cli = getGHClient();
        const pr = (await cli.pulls.get({ pull_number: request.issue.number, owner: "microsoft", repo: "TypeScript" })).data;

        return {
            ...p,
            sourceBranch: "",
            parameters: JSON.stringify({
                ...JSON.parse(p.parameters),
                post_result: true,
                old_ts_repo_url: pr.base.repo.clone_url,
                old_head_ref: pr.base.ref,
                entrypoint: "tsserver",
                prng_seed: pr.id,
            })
        };
    })))
    .set(/test top(\d{1,3})/, action(async (request, log, match) => await makeNewBuildWithComments(request, "diff-based top-repos suite", 47, log, async p => {
        const cli = getGHClient();
        const pr = (await cli.pulls.get({ pull_number: request.issue.number, owner: "microsoft", repo: "TypeScript" })).data;
        const numRepos = +match[1];

        return {
            ...p,
            sourceBranch: "",
            parameters: JSON.stringify({
                ...JSON.parse(p.parameters),
                post_result: true,
                old_ts_repo_url: pr.base.repo.clone_url,
                old_head_ref: pr.base.ref,
                top_repos: true,
                repo_count: numRepos,
            })
        };
    })))
    .set(/test tsserver top(\d{1,3})/, action(async (request, log, match) => await makeNewBuildWithComments(request, "diff-based top-repos suite (tsserver)", 47, log, async p => {
        const cli = getGHClient();
        const pr = (await cli.pulls.get({ pull_number: request.issue.number, owner: "microsoft", repo: "TypeScript" })).data;
        const numRepos = +match[1];

        return {
            ...p,
            sourceBranch: "",
            parameters: JSON.stringify({
                ...JSON.parse(p.parameters),
                post_result: true,
                old_ts_repo_url: pr.base.repo.clone_url,
                old_head_ref: pr.base.ref,
                top_repos: true,
                repo_count: numRepos,
                entrypoint: "tsserver",
                prng_seed: pr.id,
            })
        };
    })))
    .set(/cherry-?pick (?:this )?(?:in)?to (\S+)?/, action(async (request, log, match) => {
        const targetBranch = match[1];
        const requestingUser = request.comment.user.login;

        const cli = getGHClient();
        const pr = (await cli.pulls.get({ pull_number: request.issue.number, owner: "microsoft", repo: "TypeScript" })).data;
        try {
            await cli.git.getRef({
                owner: "Microsoft",
                repo: "TypeScript",
                ref: `heads/${targetBranch}`
            });
        }
        catch (_) {
            const requestingUser = request.comment.user.login;
            await cli.issues.createComment({
                body: `Heya @${requestingUser}, I couldn't find the branch '${targetBranch}' on Microsoft/TypeScript. You may need to make it and try again.`,
                issue_number: pr.number,
                owner: "Microsoft",
                repo: "TypeScript"
            });
            return;
        }

        await triggerGHActionWithComment(request, "create-cherry-pick-pr", {
            pr: request.issue.number,
            target_branch: targetBranch,
            requesting_user: requestingUser,
        }, `cherry-pick this into \`${targetBranch}\``);
    }))
    .set(/create release-([\d\.]+)/, action(async (request, log, match) => {
        const cli = getGHClient();
        const targetBranch = `release-${match[1]}`;
        let targetBranchExists = false;
        try {
            await cli.git.getRef({
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
            // If there's no error, call it off, the branch already exists
            const requestingUser = request.comment.user.login;
            await cli.issues.createComment({
                body: `Heya @${requestingUser}, the branch '${targetBranch}' already seems to exist on microsoft/TypeScript. You should prepare it for the release by hand.`,
                issue_number: request.issue.number,
                owner: "Microsoft",
                repo: "TypeScript"
            });
            return;
        }
        await triggerGHActionWithComment(request, "new-release-branch", {
            package_version: `${match[1]}.0-beta`,
            core_major_minor: match[1],
            core_tag: "beta",
            branch_name: targetBranch
        }, `create the \`${targetBranch}\` branch`);
    }, undefined, false))
    .set(/bump release-([\d\.]+)/, action(async (request, log, match) => {
        const cli = getGHClient();
        const targetBranch = `release-${match[1]}`;
        const requestingUser = request.comment.user.login;
        try {
            await cli.git.getRef({
                owner: "Microsoft",
                repo: "TypeScript",
                ref: `heads/${targetBranch}`
            });
        }
        catch (_) {
            // Branch does not exist
            await cli.issues.createComment({
                body: `Heya @${requestingUser}, the branch '${targetBranch}' does not seem to exist on microsoft/TypeScript.`,
                issue_number: request.issue.number,
                owner: "Microsoft",
                repo: "TypeScript"
            });
            return;
        }
        const contentResponse = await cli.repos.getContent({
            owner: "microsoft",
            repo: "TypeScript",
            ref: targetBranch,
            path: "package.json"
        });
        if (Array.isArray(contentResponse.data) || contentResponse.data.type !== "file" || !contentResponse.data.content) {
            await cli.issues.createComment({
                body: `Heya @${requestingUser}, the branch '${targetBranch}' does not seem to have a \`package.json\` I can look up its current version in.`,
                issue_number: request.issue.number,
                owner: "Microsoft",
                repo: "TypeScript"
            });
            return;
        }
        /** @type {string} */
        let currentVersion;
        try {
            const packageContent = JSON.parse(Buffer.from(contentResponse.data.content, "base64").toString("utf-8"));
            currentVersion = packageContent.version;
        }
        catch (_) {
            await cli.issues.createComment({
                body: `Heya @${requestingUser}, the branch '${targetBranch}' had a \`package.json\`, but it didn't seem to be valid JSON.`,
                issue_number: request.issue.number,
                owner: "Microsoft",
                repo: "TypeScript"
            });
            return;
        }
        const parts = currentVersion.split(".");
        const majorMinor = parts.slice(0, 2).join(".");
        // > X.X.0-beta -> X.X.1-rc -> X.X.2 -> X.X.3
        const new_version = `${majorMinor}.${currentVersion.indexOf("beta") >= 0 ? "1-rc" : currentVersion.indexOf("rc") >= 0 ? "2" : (Number(parts[2]) + 1)}`;
        await triggerGHActionWithComment(request, "set-version", {
            package_version: new_version,
            core_major_minor: majorMinor,
            branch_name: targetBranch
        }, `update the version number on \`${targetBranch}\` to \`${new_version}\``);
    }, undefined, false))
    .set(/sync release-([\d\.]+)/, action(async (request, log, match) => {
        const branch = `release-${match[1]}`;
        await triggerGHActionWithComment(request, "sync-branch", {
            branch_name: branch
        }, `sync \`${branch}\` with main`);
    }, undefined, false))
    .set(/run repros/, action(async (request, log, match) => {
        const issueNumber = request.issue && request.issue.number
        const prNumber = request.pull_request && request.pull_request.number
        await triggerGHActionWithComment(request, "run-twoslash-repros", { number: issueNumber || prNumber || undefined }, `run the code sample repros`);
    }, undefined, false));


const botCall = "@typescript-bot";
for (const [key, value] of [...commands.entries()]) {
    commands.delete(key);
    commands.set(new RegExp(`${botCall} ${key.source}`, "i"), value);
}

/**
 * @param {*} context 
 * @param {*} data 
 */
module.exports = async function (context, data) {
    const sig = data.headers["x-hub-signature"];
    const webhookToken = process.env.WEBHOOK_TOKEN;
    assert(webhookToken, "WEBHOOK_TOKEN is not set")
    const hmac = crypto.createHmac("sha1", webhookToken);
    hmac.write(data.rawBody);
    const digest = hmac.digest();
    if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(`sha1=${digest.toString("hex")}`))) {
        return context.done();
    }
    const request = data.body;
    context.log("Inspecting comment...");
    const isNewCommentWithBody = request.action === "created" && !!request.comment && !!request.comment.body;
    if (!isNewCommentWithBody) {
        return context.done();
    }
    const isPr = !!request.pull_request || !!(request.issue && request.issue.pull_request);
    const command = matchesCommand(context, request.comment.body, isPr, request.comment.author_association);
    if (!command) {
        return context.done();
    }

    context.log('GitHub Webhook triggered!', request.comment.body);
    await command(request);

    context.done();
};

/**
 * @param {*} context
 * @param {string} body
 * @param {boolean} isPr
 * @param {string} authorAssociation
 * @returns {undefined | ((req: any) => Promise<any>)}
 */
function matchesCommand(context, body, isPr, authorAssociation) {
    if (!body) {
        return undefined;
    }

    if (!body.includes(botCall)) {
        return undefined;
    }

    const applicableActions = Array.from(commands.entries()).filter(e => {
        if (!isPr && e[1].prOnly) {
            return false;
        }
        return e[1].relationships.some(r => r === authorAssociation);
    });
    if (!applicableActions.length) {
        return undefined;
    }

    /** @type {((req: any) => Promise<void>)[]} */
    let results = [];

    const lines = new Set(body.split("\n").map(s => s.trim()).filter(s => s));
    for (const line of lines) {
        for (const [key, action] of applicableActions) {
            if (key.test(line)) {
                const match = key.exec(line);
                assert(match);
                results.push(r => action.task(r, s => context.log(s), match));
                break;
            }
        }
    }

    if (!results.length) {
        return undefined;
    }
    if (results.length === 1) {
        return results[0];
    }
    return req => Promise.all(results.map(r => r(req)));
}
