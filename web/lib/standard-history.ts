export type ReleaseHistoryRound = {
  id: string;
  roundNumber: number;
  status?: string;
  reviewerName: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
};

export function groupReleaseHistory<
  Revision extends { reviewRoundId?: string },
  Comment extends { reviewRoundId?: string },
>(
  rounds: ReleaseHistoryRound[],
  revisions: Revision[],
  comments: Comment[],
) {
  return rounds.map((round, index) => ({
    round,
    revisions: revisions.filter(
      (item) => item.reviewRoundId === round.id ||
        (!item.reviewRoundId && index === rounds.length - 1),
    ),
    comments: comments.filter(
      (item) => item.reviewRoundId === round.id ||
        (!item.reviewRoundId && index === rounds.length - 1),
    ),
  }));
}
