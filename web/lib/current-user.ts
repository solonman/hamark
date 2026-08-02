export type CurrentUser = {
  email: string;
  name: string;
};

const EMAIL_HEADER = "oai-authenticated-user-email";
const NAME_HEADER = "oai-authenticated-user-full-name";
const NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";

export function currentUserFromRequest(request: Request): CurrentUser {
  const email = request.headers.get(EMAIL_HEADER)?.trim();
  const encodedName = request.headers.get(NAME_HEADER);
  const encoding = request.headers.get(NAME_ENCODING_HEADER);

  let name: string | null = null;
  if (encodedName && encoding === "percent-encoded-utf-8") {
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      name = null;
    }
  }

  return {
    email: email || "demo@reverse.local",
    name: name || (email ? email.split("@")[0] : "演示用户"),
  };
}

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}
