// @ts-check
const Client = require("@octokit/rest");
const vsts = require("vso-node-api");
const crypto = require("crypto");

module.exports = async function (context, data) {
    const sig = data.headers["x-hub-signature"];
    const hmac = crypto.createHmac("sha1", process.env.WEBHOOK_TOKEN);
    hmac.write(data.rawBody);
    const digest = hmac.digest();
    if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(`sha1=${digest.toString("hex")}`))) {
        // context.log(`Discarding request with mismatched signature: ${sig}`)
        return context.done();
    }
    const request = data.body;
    const shouldHandleComment = request.action === "created" && request.comment && request.comment.body && (request.pull_request || request.issue && request.issue.pull_request) && matchesCommand(request.comment.body);
    if (!shouldHandleComment) {
        // context.log(`Discarding filtered request: action: ${request.action}, isComment: ${!!request.comment} body: ${request.comment && request.comment.body}, isPr: ${!!(request.pull_request || request.issue && request.issue.pull_request)}, matches: ${matchesCommand(request.comment && request.comment.body)}`);
        return context.done();
    }
    const requestingUserStatus = request.comment.author_association;
    if (requestingUserStatus !== "MEMBER" && requestingUserStatus !== "OWNER" && requestingUserStatus !== "COLLABORATOR") {
        // context.log(`Discarding via association: ${request.comment.user.login}: ${requestingUserStatus}`);
        return context.done(); // Only trigger for MS members/repo owners/invited collaborators
    }
    context.log('GitHub Webhook triggered!', request.comment.body);
    const cli = new Client();
    cli.authenticate({
        type: "token",
        token: process.env.GITHUB_TOKEN
    });
    const pr = request.pull_request || (await cli.pullRequests.get({ number: request.issue.number, owner: "Microsoft", repo: "TypeScript" })).data;
    const refSha = pr.head.sha;
    const branch = pr.head.ref;
    const originUrl = pr.head.repo.git_url;
    const requestingUser = request.comment.user.login;
    const result = await cli.issues.createComment({
        body: `Heya @${requestingUser}, I'm starting to run the extended test suite on this PR at ${refSha}. Hold tight - I'll update this comment with the log link once the build has been queued.`,
        number: pr.number,
        owner: "Microsoft",
        repo: "TypeScript"
    });
    const commentId = result.data.id;
    const vcli = new vsts.WebApi("https://typescript.visualstudio.com/defaultcollection", vsts.getPersonalAccessTokenHandler(process.env.VSTS_TOKEN)); 
    const build = await vcli.getBuildApi();
    const isLocalBranch = originUrl === "git://github.com/Microsoft/TypeScript.git";
    const buildQueue = await build.queueBuild(/** @type {*} */({
        definition: { id: 11 },
        queue: { id: 8 },
        project: { id: "cf7ac146-d525-443c-b23c-0d58337efebc" },
        sourceBranch: isLocalBranch ? branch : `refs/pull/${pr.number}/head`, // Undocumented, but used by the official frontend
        sourceVersion: isLocalBranch ? refSha : ``, // Also undocumented
        parameters: JSON.stringify({ status_comment: commentId, source_issue: pr.number }) // This API is real bad
    }), "TypeScript");
    await cli.issues.editComment({
        owner: "Microsoft",
        repo: "TypeScript",
        comment_id: commentId,
        body: `Heya @${requestingUser}, I've started to run the extended test suite on this PR at ${refSha}. You can monitor the build [here](${buildQueue._links.web.href}). It should now contribute to this PR's status checks.`
    });
    context.done();
};

/**
 * @param {string} body 
 */
function matchesCommand(body) {
    return body === "@typescript-bot test this";
}
