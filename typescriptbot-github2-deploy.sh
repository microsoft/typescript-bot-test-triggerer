#!/bin/bash

set -exo pipefail

# typescriptbotgithubb162

rm -rf function.zip
zip -r -x \*.sh function.zip .

az storage blob upload -f function.zip --account-name typescriptbotgithubb162 -c deployment -n function.zip --overwrite true --auth-mode login


# https://typescriptbotgithubb162.blob.core.windows.net/deployment/function.zip

# https://typescriptbot-github.azurewebsites.net/api/GithubCommentReader?clientId=default
# https://typescriptbot-github2.azurewebsites.net/api/GithubCommentReader?clientId=default


# az functionapp config appsettings set \
#     -g typescriptbot-github2 \
#     -n typescriptbot-github2 \
#     --settings WEBSITE_RUN_FROM_PACKAGE="https://typescriptbotgithubb162.blob.core.windows.net/deployment/function.zip"

az functionapp restart \
    -g typescriptbot-github2 \
    -n typescriptbot-github2

