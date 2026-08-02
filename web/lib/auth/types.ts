export type AuthFlow = "QR" | "IN_APP";

export type CurrentUser = {
  id: string;
  identityKey: string;
  displayName: string;
  avatarUrl: string | null;
  email: string | null;
  departments: Array<{ id: string; name: string; isPrimary: boolean }>;
};

export type WeComMember = {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  email: string | null;
  departments: Array<{ id: string; name: string; isPrimary: boolean }>;
};

export class AuthError extends Error {
  constructor(
    public readonly code:
      | "auth_cancelled"
      | "auth_expired"
      | "member_not_allowed"
      | "profile_unavailable"
      | "service_unavailable"
      | "auth_misconfigured",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
