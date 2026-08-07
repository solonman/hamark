import "server-only";

import { getAuthConfig } from "./config.ts";
import { PostgresAuthStore, type AuthStore } from "./store.ts";
import { WeComClient } from "./wecom.ts";

let services:
  | {
      config: ReturnType<typeof getAuthConfig>;
      store: AuthStore;
      wecom: WeComClient;
    }
  | null = null;

export function getAuthServices() {
  if (!services) {
    const config = getAuthConfig();
    const store = new PostgresAuthStore();
    services = {
      config,
      store,
      wecom: new WeComClient({ config, store }),
    };
  }
  return services;
}
