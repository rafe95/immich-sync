/** Reactive auth state shared by the app shell. */
import { createApiClient } from "./api.ts";

export const session = $state({ status: "loading" as "loading" | "anonymous" | "authenticated", error: null as string | null });

export const api = createApiClient({
  onUnauthorized: () => {
    session.status = "anonymous";
  },
});

export async function checkSession() {
  try {
    session.status = (await api.me()) ? "authenticated" : "anonymous";
  } catch (err) {
    session.error = err instanceof Error ? err.message : String(err);
    session.status = "anonymous";
  }
}

export async function login(password: string) {
  await api.login(password);
  session.error = null;
  session.status = "authenticated";
}

export async function logout() {
  try {
    await api.logout();
  } finally {
    session.status = "anonymous";
  }
}
