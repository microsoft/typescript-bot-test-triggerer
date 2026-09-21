export interface PrSnapshot {
    headSha: string;
    baseSha: string;
    mergeSha: string;
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
