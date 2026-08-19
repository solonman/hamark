export type V04StableUserStatus = "ACTIVE" | "DISABLED";

export type V04StableUserIdentity = {
  id: string;
  email: string | null;
  displayName?: string | null;
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

export type V04LegacyAdminReference = {
  stableReferenceId: string;
  displayName: string;
};

export type V04AdminMappingPreview = {
  stableReferenceId: string;
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

/**
 * Produces read-only evidence for old display-name administrator rows. Names are
 * normalized solely to classify existing references; they are never returned
 * and never grant a membership.
 */
export function previewV04AdminMappings(
  users: readonly V04StableUserIdentity[],
  references: readonly V04LegacyAdminReference[],
): V04AdminMappingPreview[] {
  const usersByName = new Map<string, V04StableUserIdentity[]>();
  for (const user of users) {
    const normalized = normalizeLegacyIdentity(user.displayName ?? null);
    if (!normalized) continue;
    usersByName.set(normalized, [...(usersByName.get(normalized) ?? []), user]);
  }
  return references.map((reference) => {
    const normalized = normalizeLegacyIdentity(reference.displayName);
    const matches = normalized ? usersByName.get(normalized) ?? [] : [];
    const activeMatches = matches.filter((user) => user.status === "ACTIVE");
    let classification: V04UploaderMappingClassification;
    if (matches.length === 0) classification = "MISSING";
    else if (activeMatches.length === 0) classification = "DISABLED";
    else if (matches.length > 1 || activeMatches.length > 1) classification = "AMBIGUOUS";
    else classification = "UNIQUE";
    return {
      stableReferenceId: reference.stableReferenceId,
      classification,
      candidateUserIds: matches.map((user) => user.id).sort(),
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
