// @ts-check
const Client = require("@octokit/rest");
const vsts = require("vso-node-api");
const crypto = require("crypto");

module.exports = async function (context, data) {
    const sig = data.headers["x-hub-signature"];
    const hmac = crypto.createHmac("sha1", "jaH7T1WULO9l7hfAI16BG0MUSK5ruWnB4kiGIxaOktTjCa9YFWkCow==");
    hmac.write(data.rawBody);
    const digest = hmac.digest();
    if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(`sha1=${digest.toString("hex")}`))) {
        return context.done();
    }
    const shouldHandleComment = data.action === "created" && data.comment && data.comment.body && data.pull_request && matchesCommand(data.comment.body);
    if (!shouldHandleComment) {
        return context.done();
    }
    const requestingUserStatus = data.comment.user.author_association;
    if (requestingUserStatus !== "MEMBER" && requestingUserStatus !== "OWNER" && requestingUserStatus !== "COLLABORATOR") {
        return context.done(); // Only trigger for MS members/repo owners/invited collaborators
    }
    context.log('GitHub Webhook triggered!', data.comment.body);
    const cli = new Client();
    cli.authenticate({
        type: "token",
        token: context.bindings.github_token
    });
    const refSha = data.pull_request.head.sha;
    const branch = data.pull_request.head.ref;
    const originUrl = data.pull_request.head.repo.git_url;
    const isLocalBranch = originUrl === "git@github.com:Microsoft/TypeScript.git";
    const requestingUser = data.comment.user.login;
    const result = await cli.pullRequests.createCommentReply({
        body: `Heya @${requestingUser}, I'm starting to run the extended test suite on this PR at ${refSha}. Hold tight - I'll update this comment with the results when it's done.`,
        in_reply_to: data.comment.id,
        number: data.pull_request.number,
        owner: "Microsoft",
        repo: "TypeScript"
    });
    const commentId = result.data.comment.id;
    const vcli = new vsts.WebApi("https://typescript.visualstudio.com/defaultcollection", vsts.getPersonalAccessTokenHandler(context.bindings.vsts_token)); 
    const build = await vcli.getBuildApi();
    const buildQueue = await build.queueBuild(/** @type {*} */({
        definition: { id: 11 },
        queue: { id: 8 },
        project: { id: "cf7ac146-d525-443c-b23c-0d58337efebc" },
        sourceBranch: isLocalBranch ? branch : "master", // Undocumented, but used by the official frontend
        sourceVersion: isLocalBranch ? refSha : "", // Also undocumented
        parameters: JSON.stringify(isLocalBranch ? { status_comment: commentId } : { pr_id: data.pull_request.number, remote_url: originUrl, remote_branch: branch, remote_sha: refSha, status_comment: commentId }) // This API is garbage
    }), "TypeScript");
    await cli.pullRequests.editComment({
        owner: "Microsoft",
        repo: "TypeScript",
        comment_id: commentId,
        body: `Heya @${requestingUser}, I've started to run the extended test suite on this PR at ${refSha}. You can monitor the build [here](${buildQueue._links.web.href}). Hold tight - I'll update this comment with the results when it's done.`
    });
    context.done();
};

/**
 * @param {string} body 
 */
function matchesCommand(body) {
    return body === "@typescript-bot test this";
}
