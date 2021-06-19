// @ts-check
const Client = require("@octokit/rest");
const vsts = require("azure-devops-node-api");
const crypto = require("crypto");

// We cache the clients below this way if a single comment executes two commands, we only bother creating the client once
/** @type {{GH?: Client.Octokit, vstsTypescript?: vsts.WebApi, vstsDevdiv?: vsts.WebApi}} */
let clients = {};

function getGHClient() {
    if (clients.GH) {
        return clients.GH;
    }
    else {
        clients.GH = new Client.Octokit();
        clients.GH.authenticate({
            type: "token",
            token: process.env.GITHUB_TOKEN
        });
        return clients.GH;
    }
}

function getVSTSTypeScriptClient() {
    if (clients.vstsTypescript) {
        return clients.vstsTypescript;
    }
    else {
        clients.vstsTypescript = new vsts.WebApi("https://typescript.visualstudio.com/defaultcollection", vsts.getPersonalAccessTokenHandler(process.env.VSTS_TOKEN));
        return clients.vstsTypescript;
    }
}

function getVSTSDevDivClient() {
    if (clients.vstsDevdiv) {
        return clients.vstsDevdiv;
    }
    else {
        clients.vstsDevdiv = new vsts.WebApi("https://devdiv.visualstudio.com/defaultcollection", vsts.getPersonalAccessTokenHandler(process.env.DEVDIV_TOKEN));
        return clients.vstsDevdiv;
    }
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
 * @typedef {{
 * definitionId: number;
 * project?: string;
 * projectId?: string;
 * agentPoolId?: number;
 * sourceBranch?: string;
 * }} BuildParams
 */

/**
 * Authenticate with github and vsts, make a comment saying what's being done, then schedule the build
 * and update the comment with the build log URL.
 * @param {*} request The request object
 * @param {string} suiteName The frindly name to call the suite in the associated comment
 * @param {BuildParams} buildParams The VSTS build parameters
 * @param {(x: BuildVars) => (Promise<BuildVars> | BuildVars)} buildTriggerAugmentor maps the intial build request into an enhanced one
 * @param {vsts.WebApi} [client] The VSTS client to use.
 */
async function makeNewBuildWithComments(request, suiteName, buildParams, buildTriggerAugmentor = p => p, client) {
    const cli = getGHClient();
    const pr = (await cli.pulls.get({ pull_number: request.issue.number, owner: "microsoft", repo: "TypeScript" })).data;
    const refSha = pr.head.sha;
    const requestingUser = request.comment.user.login;
    const result = await cli.issues.createComment({
        body: `Heya @${requestingUser}, I'm starting to run the ${suiteName} on this PR at ${refSha}. Hold tight - I'll update this comment with the log link once the build has been queued.`,
        number: pr.number,
        owner: "microsoft",
        repo: "TypeScript"
    });
    const commentId = result.data.id;
    const buildQueue = await triggerBuild(request, pr, buildParams, p => buildTriggerAugmentor({ ...p, parameters: JSON.stringify({ ...JSON.parse(p.parameters), status_comment: commentId }) }), client);
    await cli.issues.updateComment({
        owner: "microsoft",
        repo: "TypeScript",
        comment_id: commentId,
        body: `Heya @${requestingUser}, I've started to run the ${suiteName} on this PR at ${refSha}. You can monitor the build [here](${buildQueue._links.web.href}).`
    });
}

/**
 * Authenticate with vsts and schedule the build
 * @param {*} request The request object
 * @param {*} pr The gihtub PR data object
 * @param {BuildParams} buildParams The VSTS build parameters
 * @param {(x: BuildVars) => (Promise<BuildVars> | BuildVars)} buildTriggerAugmentor maps the intial build request into an enhanced one
 * @param {vsts.WebApi} [client] The VSTS client to use.
 */
async function triggerBuild(request, pr, buildParams, buildTriggerAugmentor = p => p, client) {
    const vcli = client || getVSTSTypeScriptClient();
    const build = await vcli.getBuildApi();
    const requestingUser = request.comment.user.login;

    return await build.queueBuild(await buildTriggerAugmentor({
        definition: { id: buildParams.definitionId },
        queue: { id: buildParams.agentPoolId ?? 11 },
        project: { id: buildParams.projectId ?? "cf7ac146-d525-443c-b23c-0d58337efebc" },
        sourceBranch: buildParams.sourceBranch ?? `refs/pull/${pr.number}/merge`, // Undocumented, but used by the official frontend
        sourceVersion: ``, // Also undocumented
        parameters: JSON.stringify({ source_issue: pr.number, requesting_user: requestingUser }) // This API is real bad
    }), buildParams.project ?? "TypeScript");
}

/**
 * @param {any} request
 * @param {string} event 
 * @param {object} payload 
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
 * @param {object} payload
 */
async function triggerGHActionWithComment(request, event, payload, message) {
    const cli = getGHClient();
    await triggerGHAction(request, event, payload);
    await sleep(2);
    // we sleep because it takes a bit for the triggered event to cause a new run to appear
    // this improves our odds of findings the new run, rather than the old one
    // TODO: If GH ever makes the `repository_dispatch` event actually return the scheduled jobs,
    // use that info here
    const workflow = await cli.actions.listRepoWorkflowRuns({
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
 * @param {*} request
 * @param {string} targetBranch
 * @param {boolean} produceLKG
 */
async function makeCherryPickPR(request, targetBranch, produceLKG) {
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
    await makeNewBuildWithComments(request, `task to cherry-pick this into \`${targetBranch}\``, { definitionId: 30 }, p => ({
        ...p,
        sourceBranch: `refs/pull/${pr.number}/head`,
        parameters: JSON.stringify({
            ...JSON.parse(p.parameters),
            target_branch: targetBranch,
            ...(produceLKG ? {PRODUCE_LKG: "true"} : {})
        })
    }), getVSTSTypeScriptClient());
}

/**
 * @typedef {Object} CommentAction
 * @property {(req: any, match?: RegExpExecArray) => Promise<void>} task 
 * @property {("MEMBER" | "OWNER" | "COLLABORATOR")[]} relationships 
 * @property {boolean} prOnly
 */

/**
 * @param {(req: any, match?: RegExpExecArray) => Promise<void>} task 
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
    .set(/test this/, action(async request => await makeNewBuildWithComments(request, "extended test suite", { definitionId: 11 })))
    .set(/run dt slower/, action(async request => await makeNewBuildWithComments(request, "Definitely Typed test suite", { definitionId: 18 })))
    .set(/pack this/, action(async request => await makeNewBuildWithComments(request, "tarball bundle task", { definitionId: 19 })))
    .set(/perf test(?: this)?(?! faster)/, action(async request => await makeNewBuildWithComments(request, "perf test suite", { definitionId: 22 }, p => ({...p, queue: { id: 22 }}))))
    .set(/perf test(?: this)? faster/, action(async request => await makeNewBuildWithComments(request, "abridged perf test suite", { definitionId: 45 }, p => ({...p, queue: { id: 22 }}))))
    .set(/run dt(?! slower)/, action(async request => await makeNewBuildWithComments(request, "parallelized Definitely Typed test suite", { definitionId: 23 }, async p => ({
        ...p,
        parameters: JSON.stringify({
            ...JSON.parse(p.parameters),
            DT_SHA: (await getGHClient().repos.getBranch({owner: "DefinitelyTyped", repo: "DefinitelyTyped", branch: "master"})).data.commit.sha
        })
    }))))
    .set(/user test this slower/, action(async request => await makeNewBuildWithComments(request, "community code test suite", { definitionId: 24 }, async p => {
        const cli = getGHClient();
        const pr = (await cli.pulls.get({ pull_number: request.issue.number, owner: "microsoft", repo: "TypeScript" })).data;

        return {...p, parameters: JSON.stringify({
            ...JSON.parse(p.parameters),
            target_fork: pr.head.repo.owner.login,
            target_branch: pr.head.ref
        })};
    })))
    .set(/user test this(?! slower| inline)/, action(async request => await makeNewBuildWithComments(request, "parallelized community code test suite", { definitionId: 33 }, async p => {
        const cli = getGHClient();
        const pr = (await cli.pulls.get({ pull_number: request.issue.number, owner: "microsoft", repo: "TypeScript" })).data;

        return {...p, parameters: JSON.stringify({
            ...JSON.parse(p.parameters),
            target_fork: pr.head.repo.owner.login,
            target_branch: pr.head.ref
        })};
    })))
    .set(/user test this inline/, action(async request => await makeNewBuildWithComments(
        request,
        "inline community code test suite",
        {
            definitionId: 14672,
            agentPoolId: 1897,
            project: "NodeRepos",
            projectId: "d8791be5-9f6d-4ec4-ad68-6bb7464ade24",
            sourceBranch: "",
        },
        async p => {
            const cli = getGHClient();
            const pr = (await cli.pulls.get({ pull_number: request.issue.number, owner: "microsoft", repo: "TypeScript" })).data;

            return {
                ...p,
                templateParameters: {
                    ...JSON.parse(p.parameters),
                    post_result: true,
                    old_ts_repo_url: pr.base.repo.clone_url,
                    old_head_ref: pr.base.ref
                }
            };
        }, getVSTSDevDivClient())))
    .set(/cherry-?pick (?:this )?(?:in)?to (\S+)( and LKG)?/, action(async (request, match) => await makeCherryPickPR(request, match[1], !!match[2])))
    .set(/create release-([\d\.]+)/, action(async (request, match) => {
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
    .set(/bump release-([\d\.]+)/, action(async (request, match) => {
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
        const contentResponse = await cli.repos.getContents({
            owner: "microsoft",
            repo: "TypeScript",
            ref: targetBranch,
            path: "package.json"
        });
        if (Array.isArray(contentResponse.data) || !contentResponse.data.content) {
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
    .set(/sync release-([\d\.]+)/, action(async (request, match) => {
        const branch = `release-${match[1]}`;
        await triggerGHActionWithComment(request, "sync-branch", {
            branch_name: branch
        }, `sync \`${branch}\` with main`);
    }, undefined, false))
    .set(/run repros/, action(async (request, match) => {
        const issueNumber = request.issue && request.issue.number 
        const prNumber = request.pull_request && request.pull_request.number 
        await triggerGHActionWithComment(request, "run-twoslash-repros", { number: issueNumber || prNumber || undefined }, `run the code sample repros`);
    }, undefined, false));

module.exports = async function (context, data) {
    const sig = data.headers["x-hub-signature"];
    const hmac = crypto.createHmac("sha1", process.env.WEBHOOK_TOKEN);
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
    const applicableActions = Array.from(commands.entries()).filter(e => {
        if (!isPr && e[1].prOnly) {
            return false;
        }
        return e[1].relationships.some(r => r === authorAssociation);
    });
    if (!applicableActions.length) {
        return undefined;
    }
    const botCall = "@typescript-bot";
    if (body.indexOf(botCall) !== -1) {
        context.log(`Bot reference detected ${body}`);
    }
    /** @type {((req: any) => Promise<void>)[]} */
    let results = [];
    for (const [key, action] of applicableActions) {
        const fullRe = new RegExp(`${botCall} ${key.source}`, "i");
        if (fullRe.test(body)) {
            results.push(r => action.task(r, fullRe.exec(body)));
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
