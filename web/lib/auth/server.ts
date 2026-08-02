import "server-only";

import { getWeComAuthConfig } from "./config.ts";
import { PostgresAuthStore, type AuthStore } from "./store.ts";
import { WeComClient } from "./wecom.ts";

let services:
  | {
      config: ReturnType<typeof getWeComAuthConfig>;
      store: AuthStore;
      wecom: WeComClient;
    }
  | null = null;

export function getAuthServices() {
  if (!services) {
    const config = getWeComAuthConfig();
    const store = new PostgresAuthStore();
    services = {
      config,
      store,
      wecom: new WeComClient({ config, store }),
    };
  }
  return services;
}
