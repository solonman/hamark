export type V04StableUserStatus = "ACTIVE" | "DISABLED";

export type V04StableUserIdentity = {
  id: string;
  email: string | null;
  status: V04StableUserStatus;
};

export type V04LegacyUploaderReference = {
  videoId: string;
  createdByEmail: string | null;
};

export type V04UploaderMappingClassification =
  | "UNIQUE"
  | "AMBIGUOUS"
  | "MISSING"
  | "DISABLED";

export type V04UploaderMappingPreview = {
  videoId: string;
  classification: V04UploaderMappingClassification;
  candidateUserIds: string[];
};

function normalizeLegacyIdentity(value: string | null) {
  return value?.normalize("NFKC").trim().toLocaleLowerCase("en-US") ?? "";
}

/**
 * Produces read-only evidence for the later 1C uploader backfill decision.
 * It deliberately returns no legacy email and never creates role membership rows.
 */
export function previewV04UploaderMappings(
  users: readonly V04StableUserIdentity[],
  references: readonly V04LegacyUploaderReference[],
): V04UploaderMappingPreview[] {
  const usersByIdentity = new Map<string, V04StableUserIdentity[]>();

  for (const user of users) {
    const identity = normalizeLegacyIdentity(user.email);
    if (!identity) continue;
    const matches = usersByIdentity.get(identity) ?? [];
    matches.push(user);
    usersByIdentity.set(identity, matches);
  }

  return references.map((reference) => {
    const identity = normalizeLegacyIdentity(reference.createdByEmail);
    const matches = identity ? usersByIdentity.get(identity) ?? [] : [];
    const candidateUserIds = matches.map((user) => user.id).sort();
    let classification: V04UploaderMappingClassification;

    if (matches.length === 0) {
      classification = "MISSING";
    } else if (matches.length > 1) {
      classification = "AMBIGUOUS";
    } else if (matches[0].status === "DISABLED") {
      classification = "DISABLED";
    } else {
      classification = "UNIQUE";
    }

    return {
      videoId: reference.videoId,
      classification,
      candidateUserIds,
    };
  });
}

export function hasV04MemberCapability(user: Pick<V04StableUserIdentity, "status">) {
  return user.status === "ACTIVE";
}

export function hasV04UploaderCapability(
  userId: string,
  video: { createdByUserId: string | null },
) {
  return Boolean(video.createdByUserId) && video.createdByUserId === userId;
}
