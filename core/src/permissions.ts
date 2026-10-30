/**
 * What an instance's API key must be allowed to do for each role it plays in a step.
 * See SPEC.md, "Instances". To be re-confirmed against each supported Immich version.
 */

export const ROLES = [
  "source-copy",
  "source-move",
  "source-metadata",
  "target-copy",
  "target-metadata",
] as const;

export type Role = (typeof ROLES)[number];

const SOURCE_COPY = ["user.read", "asset.read", "asset.view", "asset.download"];
const TARGET_COPY = ["user.read", "asset.read", "asset.upload"];

export const ROLE_PERMISSIONS: Record<Role, readonly string[]> = {
  "source-copy": SOURCE_COPY,
  "source-move": [...SOURCE_COPY, "asset.delete"],
  "source-metadata": [...SOURCE_COPY, "album.read", "tag.read", "stack.read", "asset.edit.get"],
  "target-copy": TARGET_COPY,
  "target-metadata": [
    ...TARGET_COPY,
    "asset.update",
    "album.read",
    "album.create",
    "albumAsset.create",
    "tag.read",
    "tag.create",
    "tag.asset",
    "stack.read",
    "stack.create",
    "asset.edit.create",
  ],
};

export const ROLE_LABELS: Record<Role, string> = {
  "source-copy": "source (copy)",
  "source-move": "source (move)",
  "source-metadata": "source (metadata sync)",
  "target-copy": "target (copy)",
  "target-metadata": "target (metadata sync)",
};

export type RoleCheck = { ok: boolean; missing: string[] };

/** A key created with "all" permissions passes every role. */
export function checkRole(granted: readonly string[], role: Role): RoleCheck {
  if (granted.includes("all")) return { ok: true, missing: [] };
  const missing = ROLE_PERMISSIONS[role].filter((p) => !granted.includes(p));
  return { ok: missing.length === 0, missing };
}

export function checkAllRoles(granted: readonly string[]): Record<Role, RoleCheck> {
  return Object.fromEntries(ROLES.map((r) => [r, checkRole(granted, r)])) as Record<Role, RoleCheck>;
}
