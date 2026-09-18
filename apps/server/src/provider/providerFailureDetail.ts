/**
 * The text a person reads when a provider call fails: it becomes the thread
 * session's `lastError` and the detail of the `*.failed` activity in the
 * transcript. Provider errors carry an operation name and a stack for
 * operators; neither belongs in a chat bubble, so only the error's own
 * sentence gets through here. Callers log the full cause separately.
 */
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  humanizeSlug,
  resolveProviderInstanceDisplayName,
} from "@t3tools/shared/providerInstanceDisplay";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderValidationError,
} from "./Errors.ts";

const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderValidationError = Schema.is(ProviderValidationError);

export function providerFailureDetail(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (isProviderAdapterRequestError(error)) {
    return error.detail;
  }
  if (isProviderAdapterValidationError(error) || isProviderValidationError(error)) {
    return error.issue;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return Cause.pretty(cause);
}

/** A configured, enabled instance a person can pick in this environment. */
export interface OfferedProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName?: string | undefined;
}

/**
 * Why a turn cannot run on the instance it asked for, and what to do instead.
 * A cloud box enables exactly one agent, so the person is often on a phone
 * holding a picker that still shows the account they used at home.
 */
export function describeUnavailableProviderInstance(input: {
  readonly requested: {
    readonly instanceId: ProviderInstanceId;
    readonly driver?: ProviderDriverKind | undefined;
    readonly displayName?: string | undefined;
  };
  readonly offered: ReadonlyArray<OfferedProviderInstance>;
}): string {
  const { requested } = input;
  const requestedName =
    requested.driver === undefined
      ? humanizeSlug(requested.instanceId)
      : resolveProviderInstanceDisplayName({ ...requested, driver: requested.driver });
  const offeredNames = input.offered
    .filter((instance) => instance.instanceId !== requested.instanceId)
    .map(resolveProviderInstanceDisplayName);
  if (offeredNames.length === 0) {
    return `${requestedName} is not available in this environment, and no other agent is enabled. Enable one in Settings to continue.`;
  }
  return `${requestedName} is not available in this environment. Use ${listNames(offeredNames)} instead.`;
}

function listNames(names: ReadonlyArray<string>): string {
  if (names.length <= 2) return names.join(" or ");
  return `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
}
