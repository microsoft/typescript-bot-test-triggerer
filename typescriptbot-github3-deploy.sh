#!/bin/bash

set -exo pipefail

# typescriptbotgithub8c94

rm -rf function.zip
zip -r -x *.sh function.zip .

az storage blob upload -f function.zip --account-name typescriptbotgithub8c94 -c deployment -n function.zip --overwrite true --auth-mode login


# https://typescriptbotgithub8c94.blob.core.windows.net/deployment/function.zip

# https://typescriptbot-github.azurewebsites.net/api/GithubCommentReader?clientId=default
# https://typescriptbot-github3.azurewebsites.net/api/GithubCommentReader?clientId=default


# az functionapp config appsettings set \
#     -g typescriptbot-github3 \
#     -n typescriptbot-github3 \
#     --settings WEBSITE_RUN_FROM_PACKAGE="https://typescriptbotgithub8c94.blob.core.windows.net/deployment/function.zip"

az functionapp restart \
    -g typescriptbot-github3 \
    -n typescriptbot-github3

