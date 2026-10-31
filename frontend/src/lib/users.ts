/** Pure helpers for first-run setup and the Users screen; limits mirror the backend contract. */
import type { SessionUser, UserDataCounts, UserRole } from "./api.ts";

export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 64;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
export const ROLES: readonly UserRole[] = ["admin", "user"];

const USERNAME_RE = /^[A-Za-z0-9._-]+$/;

/** Error message for a username, or null when acceptable. */
export function usernameProblem(username: string): string | null {
  if (username.length < MIN_USERNAME_LENGTH || username.length > MAX_USERNAME_LENGTH) {
    return `The username must be ${MIN_USERNAME_LENGTH} to ${MAX_USERNAME_LENGTH} characters.`;
  }
  if (!USERNAME_RE.test(username)) return "The username may only contain letters, digits, dots, underscores and hyphens.";
  return null;
}

/** Error message for a new password, or null when acceptable. */
export function newPasswordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `The password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}

export type SetupForm = { username: string; password: string; confirm: string };

/** Problems with the first-run setup form, in reading order. */
export function setupProblems(f: SetupForm): string[] {
  const out: string[] = [];
  const u = usernameProblem(f.username);
  if (u) out.push(u);
  const p = newPasswordProblem(f.password);
  if (p) out.push(p);
  if (f.confirm !== f.password) out.push("The confirmation does not match the password.");
  return out;
}

export type NewUserForm = { username: string; password: string; role: UserRole };

export function newUserProblems(f: NewUserForm): string[] {
  const out: string[] = [];
  const u = usernameProblem(f.username);
  if (u) out.push(u);
  const p = newPasswordProblem(f.password);
  if (p) out.push(p);
  if (!ROLES.includes(f.role)) out.push("Choose a role.");
  return out;
}

export const isAdmin = (user: SessionUser | null | undefined): boolean => user?.role === "admin";

export const loginBody = (username: string, password: string) => ({ username: username.trim(), password });
export const createUserBody = (f: NewUserForm) => ({ username: f.username.trim(), password: f.password, role: f.role });

/** Which path the app is on; only /setup is special, everything else shows the app. */
export const isSetupPath = (pathname: string): boolean => pathname.replace(/\/+$/, "") === "/setup";

export function roleLabel(role: UserRole): string {
  return role === "admin" ? "Admin" : "User";
}

export function deletionWarning(username: string, counts: UserDataCounts): string {
  return `Delete ${username}? This cancels their running jobs and permanently deletes their ${counts.instances} instances, ${counts.jobs} jobs (including schedules), and ${counts.runs} runs (including history and logs). Nothing on any Immich server is touched.`;
}

/** "Never" for a user who has not signed in yet. */
export function lastLoginText(iso: string | null, now = Date.now()): string {
  if (!iso) return "Never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Unknown";
  const mins = Math.floor((now - t) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)} h ago`;
  return new Date(t).toLocaleString();
}
