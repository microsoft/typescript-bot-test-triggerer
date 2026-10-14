export interface PrSnapshot {
    headSha: string;
    baseSha: string;
    mergeSha: string;
}

const copilotUserId = 198982749;
const copilotAppId = 1143301;

interface PrAttributionEvent {
    id: number;
    event: string;
    created_at: string;
    actor: { login: string; type: string; } | null;
    performed_via_github_app?: { id: number; } | null;
}

interface PrEventPage {
    data: readonly PrAttributionEvent[];
    headers: { link?: string; };
}

export async function getCopilotPrInitiator(
    prAuthorId: number,
    listEvents: (page: number) => Promise<PrEventPage>,
): Promise<string | undefined> {
    if (prAuthorId !== copilotUserId) {
        return undefined;
    }

    let firstWorkStarted: PrAttributionEvent | undefined;
    for (let page = 1; ; page++) {
        const response = await listEvents(page);
        for (const event of response.data) {
            if (event.event === "copilot_work_started"
                && (!firstWorkStarted
                    || event.created_at < firstWorkStarted.created_at
                    || event.created_at === firstWorkStarted.created_at && event.id < firstWorkStarted.id)) {
                firstWorkStarted = event;
            }
        }
        if (!response.headers.link?.includes('rel="next"')) {
            break;
        }
    }

    // Later sessions must not change who originally initiated the PR.
    return firstWorkStarted?.performed_via_github_app?.id === copilotAppId
        && firstWorkStarted.actor?.type === "User"
        ? firstWorkStarted.actor.login
        : undefined;
}

export function createPrSnapshot(
    headSha: string,
    mergeSha: string,
    mergeParentShas: readonly string[],
): PrSnapshot | undefined {
    if (mergeParentShas.length !== 2 || mergeParentShas[1] !== headSha) {
        return undefined;
    }

    return {
        headSha,
        baseSha: mergeParentShas[0],
        mergeSha,
    };
}

export function isPrQuietPeriodActive(
    commentCreatedAt: string,
    mergeCreatedAt: string,
    prAuthorIsTeamMember: boolean,
    quietPeriodMs: number,
): boolean {
    if (prAuthorIsTeamMember) {
        return false;
    }

    const quietForMs = new Date(commentCreatedAt).getTime() - new Date(mergeCreatedAt).getTime();
    return quietForMs < quietPeriodMs;
}
