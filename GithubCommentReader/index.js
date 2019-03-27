// @ts-check
const Client = require("@octokit/rest");
const vsts = require("vso-node-api");
const crypto = require("crypto");

// We cache the clients below this way if a single comment executes two commands, we only bother creating the client once
/** @type {{GH?: Client, VSTS?: vsts.WebApi}} */
let clients = {};

function getGHClient() {
    if (clients.GH) {
        return clients.GH;
    }
    else {
        clients.GH = new Client();
        clients.GH.authenticate({
            type: "token",
            token: process.env.GITHUB_TOKEN
        });
        return clients.GH;
    }
}

function getVSTSClient() {
    if (clients.VSTS) {
        return clients.VSTS;
    }
    else {
        clients.VSTS = new vsts.WebApi("https://typescript.visualstudio.com/defaultcollection", vsts.getPersonalAccessTokenHandler(process.env.VSTS_TOKEN));
        return clients.VSTS;
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
 * Authenticate with github and vsts, make a comment saying what's being done, then schedule the build
 * and update the comment with the build log URL.
 * @param {*} request The request object
 * @param {string} suiteName The frindly name to call the suite in the associated comment
 * @param {number} definitionId The VSTS id of the build definition to trigger
 * @param {(x: BuildVars) => (Promise<BuildVars> | BuildVars)} buildTriggerAugmentor maps the intial build request into an enhanced one
 */
async function makeNewBuildWithComments(request, suiteName, definitionId, buildTriggerAugmentor = p => p) {
    const cli = getGHClient();
    const pr = request.pull_request || (await cli.pullRequests.get({ number: request.issue.number, owner: "Microsoft", repo: "TypeScript" })).data;
    const refSha = pr.head.sha;
    const branch = pr.head.ref;
    const originUrl = pr.head.repo.git_url;
    const requestingUser = request.comment.user.login;
    const result = await cli.issues.createComment({
        body: `Heya @${requestingUser}, I'm starting to run the ${suiteName} on this PR at ${refSha}. Hold tight - I'll update this comment with the log link once the build has been queued.`,
        number: pr.number,
        owner: "Microsoft",
        repo: "TypeScript"
    });
    const commentId = result.data.id;
    const vcli = getVSTSClient(); 
    const build = await vcli.getBuildApi();
    const isLocalBranch = originUrl === "git://github.com/Microsoft/TypeScript.git";
    const buildQueue = await build.queueBuild(/** @type {*} */(await buildTriggerAugmentor({
        definition: { id: definitionId },
        queue: { id: 11 },
        project: { id: "cf7ac146-d525-443c-b23c-0d58337efebc" },
        sourceBranch: isLocalBranch ? branch : `refs/pull/${pr.number}/head`, // Undocumented, but used by the official frontend
        sourceVersion: isLocalBranch ? refSha : ``, // Also undocumented
        parameters: JSON.stringify({ status_comment: commentId, source_issue: pr.number, requesting_user: requestingUser }) // This API is real bad
    })), "TypeScript");
    await cli.issues.editComment({
        owner: "Microsoft",
        repo: "TypeScript",
        comment_id: commentId,
        body: `Heya @${requestingUser}, I've started to run the ${suiteName} on this PR at ${refSha}. You can monitor the build [here](${buildQueue._links.web.href}). It should now contribute to this PR's status checks.`
    });
}

const commands = (/** @type {Map<RegExp, (req: any, match?: RegExpExecArray) => Promise<void>>} */(new Map()))
    .set(/test this/, async request => await makeNewBuildWithComments(request, "extended test suite", 11))
    .set(/run dt(?! faster)/, async request => await makeNewBuildWithComments(request, "Definitely Typed test suite", 18))
    .set(/pack this/, async request => await makeNewBuildWithComments(request, "tarball bundle task", 19))
    .set(/perf test/, async request => await makeNewBuildWithComments(request, "perf test suite", 22, p => ({...p, queue: { id: 22 }})))
    .set(/run dt faster/, async request => await makeNewBuildWithComments(request, "parallelized Definitely Typed test suite", 23, async p => ({
        ...p,
        parameters: JSON.stringify({
            ...JSON.parse(p.parameters),
            DT_SHA: (await getGHClient().repos.getBranch({owner: "DefinitelyTyped", repo: "DefinitelyTyped", branch: "master"})).data.commit.sha
        })
    })));

module.exports = async function (context, data) {
    const sig = data.headers["x-hub-signature"];
    const hmac = crypto.createHmac("sha1", process.env.WEBHOOK_TOKEN);
    hmac.write(data.rawBody);
    const digest = hmac.digest();
    if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(`sha1=${digest.toString("hex")}`))) {
        return context.done();
    }
    const request = data.body;
    let command;
    context.log("Inspecting comment...");
    const shouldHandleComment = request.action === "created" && request.comment && request.comment.body && (request.pull_request || request.issue && request.issue.pull_request) && (command = matchesCommand(context, request.comment.body));
    if (!shouldHandleComment) {
        return context.done();
    }
    const requestingUserStatus = request.comment.author_association;
    if (requestingUserStatus !== "MEMBER" && requestingUserStatus !== "OWNER" && requestingUserStatus !== "COLLABORATOR") {
        return context.done(); // Only trigger for MS members/repo owners/invited collaborators
    }

    context.log('GitHub Webhook triggered!', request.comment.body);
    await command(request);

    context.done();
};

/**
 * @param {*} context
 * @param {string} body
 * @returns {undefined | ((req: any) => Promise<any>)}
 */
function matchesCommand(context, body) {
    if (!body) {
        return undefined;
    }
    const botCall = "@typescript-bot";
    if (body.indexOf(botCall) !== -1) {
        context.log(`Bot reference detected ${body}`);
    }
    /** @type {((req: any) => Promise<void>)[]} */
    let results = [];
    for (const [key, action] of commands.entries()) {
        const fullRe = new RegExp(`${botCall} ${key.source}`, "i");
        if (fullRe.test(body)) {
            results.push(r => action(r, fullRe.exec(body)));
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
