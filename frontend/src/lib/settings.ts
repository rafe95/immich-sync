/** Pure helpers for the Settings screen; limits mirror the backend (auth.ts and settings.ts). */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

export type PasswordForm = { current: string; next: string; confirm: string };

/** Problems with the change-password form, in reading order; empty when it can be submitted. */
export function passwordProblems(f: PasswordForm): string[] {
  const out: string[] = [];
  if (!f.current) out.push("Enter your current password.");
  if (f.next.length < MIN_PASSWORD_LENGTH) out.push(`The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  else if (f.next.length > MAX_PASSWORD_LENGTH) out.push(`The new password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  else if (f.next === f.current) out.push("The new password must differ from the current one.");
  if (f.confirm !== f.next) out.push("The confirmation does not match the new password.");
  return out;
}

/** Parses the retention field; returns the whole number of days or an error message. */
export function parseRetentionDays(text: string): { days: number } | { error: string } {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return { error: "Enter a whole number of days." };
  const days = Number(t);
  if (days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    return { error: `Retention must be from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS} days.` };
  }
  return { days };
}
