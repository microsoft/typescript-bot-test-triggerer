## `@typescript-bot x y` 

This repo is the code for the bot which powers the comment commands inside microsoft/TypeScript. You can see [all of the commands here](https://github.com/microsoft/TypeScript/wiki/Triggering-TypeScript-Bot) and the bot is deployed to Azure as a [Function App here](https://ms.portal.azure.com/#@microsoft.onmicrosoft.com/resource/subscriptions/57bfeeed-c34a-4ffd-a06b-ccff27ac91b8/resourceGroups/typescriptbot-github/providers/Microsoft.Web/sites/typescriptbot-github/appServices).

Commands that pin a PR snapshot require a two-minute quiet period unless the PR author is an active TypeScript team member.
For PRs authored by the cloud agent, the bot also exempts PRs whose original `copilot_work_started` event names an active team member.
This attribution prototype reads every page of the issue-events API using its pagination links and verifies the event's app identity.
It only fetches events when the quiet period would otherwise block a command.
Missing or unverifiable attribution retains the quiet period; API failures propagate rather than treating a partial history as complete.
The event is not currently documented in GitHub's REST schema, so this relies on observed API behavior.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see
the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com)
with any additional questions or comments.
