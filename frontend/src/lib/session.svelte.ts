/** Reactive auth state shared by the app shell. */
import { ApiError, createApiClient, type SessionUser } from "./api.ts";
import { isSetupPath } from "./users.ts";

export const session = $state({
  status: "loading" as "loading" | "anonymous" | "authenticated",
  error: null as string | null,
  user: null as SessionUser | null,
  /** True while no account exists yet: the Setup screen is shown whatever the path. */
  needsSetup: false,
});

export const api = createApiClient({
  onUnauthorized: () => {
    session.status = "anonymous";
    session.user = null;
  },
});

function leaveSetupPath() {
  if (typeof location !== "undefined" && isSetupPath(location.pathname)) history.replaceState(null, "", "/");
}

export async function checkSession() {
  try {
    session.needsSetup = await api.getSetupStatus();
    if (session.needsSetup) {
      session.status = "anonymous";
      return;
    }
    leaveSetupPath();
    const me = await api.me();
    session.user = me?.user ?? null;
    session.status = me ? "authenticated" : "anonymous";
  } catch (err) {
    session.error = err instanceof Error ? err.message : String(err);
    session.status = "anonymous";
  }
}

export async function login(username: string, password: string) {
  try {
    session.user = await api.login(username, password);
  } catch (err) {
    if (err instanceof ApiError && err.needsSetup) session.needsSetup = true;
    throw err;
  }
  session.error = null;
  session.status = "authenticated";
}

export async function setupAdmin(username: string, password: string) {
  session.user = await api.setup(username, password);
  session.needsSetup = false;
  session.error = null;
  session.status = "authenticated";
  leaveSetupPath();
}

export async function logout() {
  try {
    await api.logout();
  } finally {
    session.status = "anonymous";
    session.user = null;
  }
}
