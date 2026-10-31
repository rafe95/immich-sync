/**
 * "Test connection" for an instance (SPEC.md, Instances):
 * 1. ping  2. key valid (whose key)  3. permissions per role  4. version support.
 */

import { getMyApiKey, getMyUser, getServerVersion, isHttpError, pingServer } from "@immich/sdk";
import { requestOpts, type Instance } from "./instance.ts";
import { checkAllRoles, type Role, type RoleCheck } from "./permissions.ts";
import { formatVersion, versionStatus, type Version, type VersionStatus } from "./version.ts";

export type CheckStage = "ping" | "version" | "key" | "permissions";

export type InstanceCheck = {
  alias: string;
  ok: boolean;
  checkedAt: string;
  latencyMs: number | null;
  version: string | null;
  versionStatus: VersionStatus | null;
  user: { id: string; email: string; name: string } | null;
  permissions: string[];
  roles: Record<Role, RoleCheck> | null;
  /** Set when a stage failed; later stages were not run. */
  error: { stage: CheckStage; message: string } | null;
  warnings: string[];
};

function describe(err: unknown): string {
  if (isHttpError(err)) {
    const msg = err.data?.message ?? "";
    return `HTTP ${err.status}${msg ? `: ${msg}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function checkInstance(instance: Instance): Promise<InstanceCheck> {
  const opts = requestOpts(instance);
  const result: InstanceCheck = {
    alias: instance.alias,
    ok: false,
    checkedAt: new Date().toISOString(),
    latencyMs: null,
    version: null,
    versionStatus: null,
    user: null,
    permissions: [],
    roles: null,
    error: null,
    warnings: [],
  };
  const fail = (stage: CheckStage, err: unknown) => {
    result.error = { stage, message: describe(err) };
    return result;
  };

  // 1. ping
  try {
    const started = performance.now();
    const pong = await pingServer(opts);
    result.latencyMs = Math.round(performance.now() - started);
    if (pong.res !== "pong") return fail("ping", new Error(`unexpected ping answer: ${JSON.stringify(pong)}`));
  } catch (err) {
    return fail("ping", err);
  }

  // 4. version (needs no key, so it is read right after the ping)
  let version: Version;
  try {
    const v = await getServerVersion(opts);
    version = { major: v.major, minor: v.minor, patch: v.patch };
    result.version = formatVersion(version);
    result.versionStatus = versionStatus(version);
  } catch (err) {
    return fail("version", err);
  }
  if (result.versionStatus === "unsupported") {
    return fail("version", new Error(`Immich ${result.version} is not supported; v3.3 or newer is required`));
  }
  if (result.versionStatus === "untested") {
    result.warnings.push(`Immich ${result.version} is newer than the versions this release was tested with.`);
  }

  // 2. key valid
  try {
    const me = await getMyUser(opts);
    result.user = { id: me.id, email: me.email, name: me.name };
  } catch (err) {
    return fail("key", err);
  }

  // 3. permissions
  try {
    const key = await getMyApiKey(opts);
    result.permissions = [...key.permissions];
    result.roles = checkAllRoles(result.permissions);
  } catch (err) {
    return fail("permissions", err);
  }

  result.ok = true;
  return result;
}
