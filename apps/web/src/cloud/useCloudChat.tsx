import { useAtomValue } from "@effect/atom-react";
import {
  claimProvisionedBox,
  draftBoxLease,
  leaseReachesBox,
  newChatProject,
  newChatRunTargets,
  nextDraftEnvironment,
  type ProvisionedSandboxLease,
} from "@t3tools/client-runtime/cloud";
import { connectionBox } from "@t3tools/client-runtime/connection";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  cloneRepository,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  type PreviewAnnotationPayload,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type ProvisionChat,
  type RuntimeMode,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ServerConfig,
  type ServerProvider,
  type ThreadContextRecord,
  type ThreadId,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { applyClaudePromptEffortPrefix, resolvePromptInjectedEffort } from "@t3tools/shared/model";
import { truncate } from "@t3tools/shared/String";
import { AsyncResult } from "effect/unstable/reactivity";
import { SendIcon } from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import {
  type CloudEnvironmentSetupSnapshot,
  EnvironmentSetupFooter,
} from "../components/chat/EnvironmentSetupCard";
import type { CloudBaseBranch, CloudRunOn } from "../components/CloudRunOn";
import {
  cloneComposerImageForRetry,
  revokeUserMessagePreviewUrls,
} from "../components/ChatView.logic";
import { Button } from "../components/ui/button";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { collapseExpandedComposerCursor, type ComposerSubmissionIntent } from "../composer-logic";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { buildMessageContext, terminalContextReference } from "../lib/composerContextRecords";
import {
  removeInlineContextReference,
  stripInlineContextReferences,
} from "../lib/composerContextReferences";
import type { TerminalContextDraft } from "../lib/terminalContext";
import { newMessageId } from "../lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "../logicalProject";
import { getProviderModelCapabilities } from "../providerModels";
import { type ProviderInstanceEntry } from "../providerInstances";
import type { ReviewCommentContext } from "../reviewCommentContext";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { type EnvironmentPresentation, useEnvironment } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import type { ChatMessage } from "../types";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "../components/chat/composerPromptHistory";
import { useBoxDemand } from "./CloudBoxes";
import { cloudProviderEntries } from "./cloudProviderEntries";
import {
  buildCloudHandoff,
  cloudCloneSource,
  isDraftOnAnotherChatsBox,
  isInProgressCloudProvisioningPhase,
  knownRunOnEnvironments,
  pendingCloudSendPreview,
} from "./cloudChat.logic";
import { refreshProvisionedEnvironments } from "./cloudHosts";
import { cloudSends } from "./cloudSends";
import {
  patchDraftPendingEnvironmentSend,
  setDraftPendingEnvironmentSend,
} from "./pendingCloudSend";
import type { PendingCloudEnvironmentSend } from "./pendingCloudSendSchema";
import {
  cancelProvisionRequest,
  forgetProvisionRequest,
  provisionRequests,
} from "./provisionRequests";
import { provisionedSandboxFor, transferProvisionedSandboxLease } from "./provisionedSandboxLeases";
import { type ReconnectResult, useReconnectSend } from "./useReconnectSend";

export { needsLoadBalancedPick } from "./cloudChat.logic";
export { cloudUnavailableBanner } from "./cloudUnavailableBanner";

type CloudProvider = PendingCloudEnvironmentSend["provider"];

/** Whether a saved connection is a cloud box, which belongs to its chat. */
export function isCloudBoxTarget(target: Parameters<typeof connectionBox>[0]): boolean {
  return connectionBox(target) !== null;
}

/** What a cloud chat's first send carried, held until its environment is ready. */
interface HeldCloudSend {
  readonly message: ChatMessage;
  readonly prompt: string;
  readonly images: ComposerImageAttachment[];
  readonly files: ComposerFileAttachment[];
  readonly terminalContexts: TerminalContextDraft[];
  readonly previewAnnotations: PreviewAnnotationPayload[];
  readonly reviewComments: ReviewCommentContext[];
  readonly threadContexts: ThreadContextRecord[];
}

/** The composer's send context, as `ChatComposerHandle.getSendContext` returns it. */
type SendContext = ReturnType<ChatComposerHandle["getSendContext"]>;

type DirectAnnotation = {
  annotation: PreviewAnnotationPayload;
  image: ComposerImageAttachment | null;
};

/** A send waiting for its environment to reconnect. */
interface ReconnectedSend {
  readonly dispatchMode: ComposerDispatchMode;
  readonly submissionIntent: ComposerSubmissionIntent;
  readonly directAnnotation: DirectAnnotation | undefined;
}

function formatCloudPrompt(params: {
  provider: ProviderDriverKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  return applyClaudePromptEffortPrefix(
    params.text,
    resolvePromptInjectedEffort(caps, params.effort),
  );
}

/** The box a draft's held cloud send made ready, if any. */
function readyDraftBoxEnvironmentId(draftId: DraftId): string | null {
  return (
    useComposerDraftStore.getState().getDraftSession(draftId)?.pendingEnvironmentSend
      ?.readyEnvironmentId ?? null
  );
}

/** The host a saved box connection names, read when a send or pick needs it. */
function catalogBoxManager(environmentId: EnvironmentId): EnvironmentId | null {
  const target = appAtomRegistry
    .get(environmentCatalog.catalogValueAtom)
    .entries.get(environmentId)?.target;
  return target === undefined ? null : (connectionBox(target)?.managerId ?? null);
}

function heldMessageFromRecord(pending: PendingCloudEnvironmentSend): ChatMessage {
  return {
    id: MessageId.make(pending.messageId),
    role: "user",
    text: pending.outgoingMessageText,
    runId: null,
    createdAt: pending.createdAt,
    updatedAt: pending.createdAt,
    streaming: false,
  };
}

/** A draft's optimistic messages with its held cloud send, until the send itself adds it. */
export function withHeldCloudMessage(
  messages: ChatMessage[],
  held: ChatMessage | null,
): ChatMessage[] {
  return held === null || messages.some((message) => message.id === held.id)
    ? messages
    : [...messages, held];
}

/** The composer's send context with a held cloud send's content in place of the composer's. */
export function withHeldCloudSend(
  context: SendContext | undefined,
  held: HeldCloudSend | null,
): SendContext | undefined {
  if (held === null || context === undefined) return context;
  return {
    ...context,
    prompt: held.prompt,
    images: held.images,
    files: held.files,
    terminalContexts: held.terminalContexts,
    previewAnnotations: held.previewAnnotations,
    reviewComments: held.reviewComments,
    threadContexts: held.threadContexts,
  };
}

/**
 * The environments a chat view names, by id: the user environments, plus the cloud box the chat
 * runs on unless the chat is a draft on another chat's box. Keeps the chat's own box connected
 * while the view is open.
 */
export function useChatEnvironmentById(input: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly environmentId: EnvironmentId;
  readonly draftId: DraftId | null;
}) {
  const { environments, environmentId, draftId } = input;
  const activeEnvironment = useEnvironment(environmentId);
  const boxIds = useAtomValue(environmentCatalog.boxIdsAtom);
  const promoted = useComposerDraftStore(
    (store) => draftId !== null && store.getDraftSession(draftId)?.promotedTo != null,
  );
  // The box a draft's own cloud send started stays its own after the send clears, until the
  // draft becomes the thread on it.
  const readyBoxEnvironmentId = useComposerDraftStore((store) =>
    draftId === null
      ? null
      : (store.getDraftSession(draftId)?.pendingEnvironmentSend?.readyEnvironmentId ?? null),
  );
  const [ownBox, setOwnBox] = useState<{ draftId: string; environmentId: string } | null>(null);
  if (
    draftId !== null &&
    readyBoxEnvironmentId !== null &&
    (ownBox?.draftId !== draftId || ownBox.environmentId !== readyBoxEnvironmentId)
  ) {
    setOwnBox({ draftId, environmentId: readyBoxEnvironmentId });
  }
  const onAnotherChatsBox = isDraftOnAnotherChatsBox({
    draftId: promoted ? null : draftId,
    environmentId,
    ownBoxEnvironmentId:
      readyBoxEnvironmentId ?? (ownBox?.draftId === draftId ? ownBox.environmentId : null),
    boxIds,
  });
  const environmentById = useMemo(() => {
    const byId = new Map(
      environments.map((environment) => [environment.environmentId, environment]),
    );
    if (activeEnvironment !== null && !onAnotherChatsBox) {
      byId.set(activeEnvironment.environmentId, activeEnvironment);
    }
    return byId;
  }, [activeEnvironment, environments, onAnotherChatsBox]);
  useBoxDemand(onAnotherChatsBox ? null : environmentId);
  return { environmentById, onAnotherChatsBox };
}

/**
 * The machines "Run on" offers. A draft offers only machines a new chat can run on, never another
 * chat's box; a started thread still names the machine it ran on.
 */
export function useNewChatRunTargets(input: {
  readonly projectEnvironments: ReadonlyArray<EnvironmentOption>;
  readonly environmentById: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly environmentId: EnvironmentId | null;
  readonly draftId: DraftId | null;
  readonly managerConfig: ServerConfig | null | undefined;
}) {
  const { environmentById, environmentId, draftId, managerConfig } = input;
  const projectEnvironments = useMemo(
    () => knownRunOnEnvironments(input.projectEnvironments, environmentById),
    [input.projectEnvironments, environmentById],
  );
  const runTargets = useMemo(
    () =>
      newChatRunTargets({
        environments: projectEnvironments,
        environmentState: (id) => environmentById.get(id),
        environmentId,
        managerConfig,
      }),
    [projectEnvironments, environmentById, environmentId, managerConfig],
  );
  return {
    runTargets,
    logicalProjectEnvironments: draftId ? runTargets.environments : projectEnvironments,
  };
}

/**
 * A chat view's cloud machines: the Run-on picker's cloud entries, a draft's first send that holds
 * until the machine it starts is ready, the setup card, and a send that waits for a sleeping
 * machine to reconnect.
 */
export function useCloudChat(input: {
  readonly draftId: DraftId | null;
  readonly threadId: ThreadId;
  readonly routeThreadKey: string;
  readonly activeProject: EnvironmentProject | null;
  readonly activeThreadEnvironmentId: EnvironmentId | null;
  readonly activeEnvironment: EnvironmentPresentation | null;
  readonly allProjects: ReadonlyArray<EnvironmentProject>;
  readonly projectGroupingSettings: ProjectGroupingSettings;
  readonly environmentById: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly onAnotherChatsBox: boolean;
  readonly runTargets: ReturnType<typeof useNewChatRunTargets>["runTargets"];
  readonly projectEnvironments: ReadonlyArray<EnvironmentOption>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly activeProviderStatus: ServerProvider | null;
  readonly automaticEnvironment: boolean;
  readonly envLocked: boolean;
  readonly sendInFlightRef: { current: boolean };
  readonly promptRef: RefObject<string>;
  readonly composerImagesRef: RefObject<ComposerImageAttachment[]>;
  readonly composerFilesRef: RefObject<ComposerFileAttachment[]>;
  readonly composerTerminalContextsRef: RefObject<TerminalContextDraft[]>;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  /** Whether a send could go out now, were its environment connected. */
  readonly sendReady: boolean;
  readonly send: (
    dispatchMode?: ComposerDispatchMode,
    submissionIntent?: ComposerSubmissionIntent,
    directAnnotation?: DirectAnnotation,
  ) => Promise<void>;
}) {
  const {
    draftId,
    threadId,
    activeProject,
    runTargets,
    primaryEnvironmentId,
    automaticEnvironment,
    sendInFlightRef,
  } = input;
  const inputRef = useRef(input);
  inputRef.current = input;

  // The cloud kind the user picked; `requested` adds the default.
  const [choice, setChoice] = useState<CloudProvider | null>(null);
  // The branch a cloud environment starts from; null is the repository's default.
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [setupPhase, setSetupPhase] = useState<PendingCloudEnvironmentSend["phase"] | null>(null);
  const [readyEnvironmentId, setReadyEnvironmentId] = useState<EnvironmentId | null>(null);
  // The held send resumes from the same render that clears the ready environment. Let that
  // internal call cross the send guard once; an ordinary send still waits for the handoff.
  const resumingRef = useRef(false);
  const heldRef = useRef<HeldCloudSend | null>(null);
  // The held message this page sent; a failed send gives it back to the composer, not the timeline.
  const [sentHeldMessageId, setSentHeldMessageId] = useState<string | null>(null);

  // Any page with the draft may be driving its cloud send (see `cloudSends`), so the setup card
  // follows the draft's record, including on the page that pressed Send.
  const pending = useComposerDraftStore((store) =>
    draftId === null ? null : (store.getDraftSession(draftId)?.pendingEnvironmentSend ?? null),
  );

  const restoreKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const restoreKey = `${draftId ?? ""}:${threadId}`;
    if (restoreKeyRef.current === restoreKey) return;
    restoreKeyRef.current = restoreKey;
    sendInFlightRef.current = false;
    resumingRef.current = false;
    const restored =
      draftId === null
        ? null
        : (useComposerDraftStore.getState().getDraftSession(draftId)?.pendingEnvironmentSend ??
          null);
    setBaseBranch(restored?.branch ?? null);
    heldRef.current = restored
      ? {
          message: heldMessageFromRecord(restored),
          prompt: restored.prompt,
          images: [],
          files: [],
          terminalContexts: [],
          previewAnnotations: [],
          reviewComments: [],
          threadContexts: [],
        }
      : null;
    if (!restored) setChoice(null);
  }, [draftId, sendInFlightRef, threadId]);

  useLayoutEffect(() => {
    setSetupPhase(pending?.phase ?? null);
    if (!pending) {
      setReadyEnvironmentId(null);
      return;
    }
    if (pending.phase === "ready" && pending.readyEnvironmentId) {
      setChoice(null);
      setReadyEnvironmentId(EnvironmentId.make(pending.readyEnvironmentId));
    } else {
      setChoice(pending.provider);
      setReadyEnvironmentId(null);
    }
  }, [pending]);

  // The manager picks the account; this instance is only the hint the picker shows for the driver.
  const cloudAccount = useMemo(
    () =>
      cloudProviderEntries(input.providerInstanceEntries).find(
        (entry) => entry.driverKind === input.activeProviderStatus?.driver,
      )?.snapshot ?? input.activeProviderStatus,
    [input.activeProviderStatus, input.providerInstanceEntries],
  );
  const offeredProviders = runTargets.cloudProviders;
  const canCreate =
    draftId !== null &&
    primaryEnvironmentId !== null &&
    offeredProviders.length > 0 &&
    cloudAccount !== null;
  const requested =
    choice ??
    (canCreate && !automaticEnvironment && runTargets.redirect?.kind === "cloud"
      ? runTargets.redirect.provider
      : null);
  const creating = isInProgressCloudProvisioningPhase(setupPhase);

  const onSelect = useCallback(
    (provider: CloudProvider) => {
      if (!canCreate) return;
      setChoice(provider);
      setReadyEnvironmentId(null);
      const label = provider === "namespace" ? "Namespace Mac" : "E2B";
      toastManager.add({
        type: "info",
        title: `${label} selected`,
        description: `Your ${label} environment will start when you send the first message.`,
      });
    },
    [canCreate],
  );
  // While a cloud environment is pending, the branch picker chooses the branch it clones. The
  // choice is fixed once a send has reserved the request.
  const base = useMemo<CloudBaseBranch | undefined>(
    () =>
      requested !== null && cloneRepository(activeProject?.repositoryIdentity)
        ? { branch: baseBranch, onChange: setupPhase === null ? setBaseBranch : null }
        : undefined,
    [activeProject, baseBranch, setupPhase, requested],
  );
  const runOn = useMemo<CloudRunOn | undefined>(
    () =>
      canCreate
        ? { providers: offeredProviders, onSelect, creating, pending: requested, base }
        : undefined,
    [base, canCreate, creating, offeredProviders, onSelect, requested],
  );

  // A draft on an expired box, or on another chat's box or a host that runs no agents with no
  // cloud kind to start instead, moves to a machine that can take it.
  const redirectEnvironment =
    draftId &&
    !input.envLocked &&
    !automaticEnvironment &&
    runTargets.redirect?.kind === "environment"
      ? runTargets.redirect.environment
      : null;
  const projectOffAnotherChatsBox = useMemo(
    () =>
      input.onAnotherChatsBox && activeProject
        ? newChatProject({
            requested: scopeProjectRef(activeProject.environmentId, activeProject.id),
            projects: input.allProjects,
            logicalProjectKey: (project) =>
              deriveLogicalProjectKeyFromSettings(project, input.projectGroupingSettings),
            environmentState: (environmentId) => input.environmentById.get(environmentId),
          })
        : null,
    [
      activeProject,
      input.allProjects,
      input.environmentById,
      input.onAnotherChatsBox,
      input.projectGroupingSettings,
    ],
  );
  useEffect(() => {
    if (!draftId || !projectOffAnotherChatsBox || sendInFlightRef.current) return;
    useComposerDraftStore.getState().setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(
        projectOffAnotherChatsBox.environmentId,
        projectOffAnotherChatsBox.id,
      ),
      loadBalancedEnvironmentId: null,
    });
  }, [draftId, projectOffAnotherChatsBox, sendInFlightRef]);
  useEffect(() => {
    // A machine whose "No project" folder does not exist yet has no project to move to.
    if (
      !draftId ||
      !redirectEnvironment ||
      redirectEnvironment.projectId === null ||
      sendInFlightRef.current
    )
      return;
    useComposerDraftStore.getState().setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(redirectEnvironment.environmentId, redirectEnvironment.projectId),
      environmentSelection: "manual",
      loadBalancedEnvironmentId: null,
    });
  }, [draftId, redirectEnvironment, sendInFlightRef]);

  /** Auto balance or another machine replaces the cloud choice. */
  const onEnvironmentPicked = useCallback(
    (nextEnvironmentId: EnvironmentId | null) => {
      setChoice(null);
      setReadyEnvironmentId(null);
      if (draftId === null || nextEnvironmentId === null) return;
      // Moving off the box this draft provisioned lets the box go, so no later send claims it.
      const lease = provisionedSandboxFor(draftId);
      if (
        lease &&
        !leaseReachesBox(
          draftBoxLease(lease, readyDraftBoxEnvironmentId(draftId)),
          nextEnvironmentId,
          catalogBoxManager,
        )
      ) {
        cancelProvisionRequest(draftId);
        setDraftPendingEnvironmentSend(draftId, null);
      }
    },
    [draftId],
  );

  const provision = useCallback(
    async (
      startedDraftId: DraftId,
      handoff: {
        readonly agentDriver: ProviderDriverKind;
        readonly modelSelection: ModelSelection;
      },
      chat: ProvisionChat | undefined,
    ) => {
      if (!requested || !canCreate || primaryEnvironmentId === null || !cloudAccount) return;
      // Saved with the draft, so a page that picks the send back up sends it on the same model.
      patchDraftPendingEnvironmentSend(startedDraftId, { modelSelection: handoff.modelSelection });
      await cloudSends.start({
        draftId: startedDraftId,
        managerEnvironmentId: primaryEnvironmentId,
        input: {
          provider: requested,
          providerInstanceId: cloudAccount.instanceId,
          agentDriver: handoff.agentDriver,
          ...cloudCloneSource(activeProject?.repositoryIdentity, baseBranch),
          ...(chat ? { chat } : {}),
        },
      });
    },
    [activeProject, baseBranch, canCreate, cloudAccount, primaryEnvironmentId, requested],
  );

  /**
   * A draft's first send while a cloud kind is chosen: shows the message, clears the composer, and
   * starts the machine, whose ready step sends the message. True when it took the send.
   */
  const holdFirstSend = async (send: {
    readonly sendCtx: SendContext;
    readonly prompt: string;
    readonly trimmed: string;
    readonly images: ComposerImageAttachment[];
    readonly previewAnnotations: PreviewAnnotationPayload[];
    readonly sendableTerminalContexts: TerminalContextDraft[];
    readonly hasSendableContent: boolean;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  }): Promise<boolean> => {
    if (requested === null || resumingRef.current || draftId === null || !activeProject) {
      return false;
    }
    const { sendCtx } = send;
    const handoff = buildCloudHandoff({
      agentDriver: sendCtx.selectedProvider,
      selection: sendCtx.selectedModelSelection,
    });
    if (heldRef.current) {
      const current = useComposerDraftStore
        .getState()
        .getDraftSession(draftId)?.pendingEnvironmentSend;
      if (current) {
        setDraftPendingEnvironmentSend(draftId, {
          provider: current.provider,
          preview: current.preview,
          messageId: current.messageId,
          createdAt: current.createdAt,
          prompt: current.prompt,
          outgoingMessageText: current.outgoingMessageText,
          phase: "creating",
          startedAt: current.startedAt,
          ...(current.repository ? { repository: current.repository } : {}),
          ...(current.branch ? { branch: current.branch } : {}),
          ...(current.readyEnvironmentId ? { readyEnvironmentId: current.readyEnvironmentId } : {}),
        });
      }
      // The request is reserved with its exact input, so a retry sends the chat it saved.
      await provision(draftId, handoff, provisionRequests.current(draftId)?.input.chat);
      return true;
    }
    if (!send.hasSendableContent) return false;
    const images = [...send.images];
    const files = [...sendCtx.files];
    const attachments = [...images, ...files];
    const terminalContexts = [...send.sendableTerminalContexts];
    const previewAnnotations = [...send.previewAnnotations];
    const reviewComments = [...sendCtx.reviewComments];
    const threadContexts = [...sendCtx.threadContexts];
    // Expired terminal excerpts are not sent; their chips leave the text with them.
    const messageText = sendCtx.terminalContexts
      .filter((context) => !terminalContexts.includes(context))
      .reduce(
        (text, context) =>
          removeInlineContextReference(text, terminalContextReference(context).contextId).prompt,
        send.prompt,
      )
      .trim();
    const context = buildMessageContext({
      terminalContexts,
      reviewComments,
      previewAnnotations,
      threadContexts,
      attachments: attachments.map((attachment) => ({ attachment, attachmentId: attachment.id })),
    });
    const outgoingMessageText = formatCloudPrompt({
      provider: sendCtx.selectedProvider,
      model: sendCtx.selectedModel,
      models: sendCtx.selectedProviderModels,
      effort: sendCtx.selectedPromptEffort,
      text: messageText || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    });
    const { composerRef, promptRef, composerDraftTarget } = inputRef.current;
    if (composerRef.current?.validateProviderInput(outgoingMessageText) === false) return true;
    const messageId = newMessageId();
    const createdAt = new Date().toISOString();
    const message: ChatMessage = {
      id: messageId,
      role: "user",
      text: outgoingMessageText,
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((attachment) =>
              attachment.type === "image"
                ? {
                    type: "image" as const,
                    id: attachment.id,
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.sizeBytes,
                    previewUrl: attachment.previewUrl,
                    ...(attachment.source ? { source: attachment.source } : {}),
                  }
                : {
                    type: "file" as const,
                    id: attachment.id,
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.sizeBytes,
                    downloadable: false,
                    ...(attachment.source ? { source: attachment.source } : {}),
                  },
            ),
          }
        : {}),
      ...(context !== undefined ? { context } : {}),
      runId: null,
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    };
    heldRef.current = {
      message,
      prompt: send.prompt,
      images,
      files,
      terminalContexts,
      previewAnnotations,
      reviewComments,
      threadContexts,
    };
    setDraftPendingEnvironmentSend(draftId, {
      provider: requested,
      preview: pendingCloudSendPreview(outgoingMessageText),
      messageId,
      createdAt,
      prompt: send.prompt,
      outgoingMessageText,
      phase: "creating",
      startedAt: createdAt,
      ...cloudCloneSource(activeProject.repositoryIdentity, baseBranch),
    });
    promptRef.current = "";
    useComposerDraftStore.getState().clearComposerContent(composerDraftTarget);
    composerRef.current?.resetCursorState();
    const titleSeed =
      assistantCitationsToPlainText(stripInlineContextReferences(send.trimmed)).trim() ||
      "New thread";
    // The host starts a plain-text first turn itself once the box is ready, so it runs whether
    // or not this page is still open. Attachments and context still go out from this page.
    const chat: ProvisionChat = {
      threadId,
      ...(attachments.length === 0 && context === undefined
        ? {
            firstTurn: {
              messageId,
              text: outgoingMessageText,
              title: truncate(titleSeed),
              titleSeed,
              modelSelection: handoff.modelSelection,
              runtimeMode: send.runtimeMode,
              interactionMode: send.interactionMode,
              createdAt,
            },
          }
        : {}),
    };
    // Not marked in flight: the setup phase holds the composer, and the held message's own
    // send starts the moment setup records ready, before this call returns.
    await provision(draftId, handoff, chat);
    return true;
  };

  const cancelSetup = useCallback(() => {
    const { composerRef, promptRef, composerDraftTarget } = inputRef.current;
    if (draftId !== null) {
      cancelProvisionRequest(draftId);
      setDraftPendingEnvironmentSend(draftId, null);
    }
    sendInFlightRef.current = false;
    const held = heldRef.current;
    heldRef.current = null;
    if (!held) return;
    revokeUserMessagePreviewUrls(held.message);
    const store = useComposerDraftStore.getState();
    const images = held.images.map(cloneComposerImageForRetry);
    promptRef.current = held.prompt;
    inputRef.current.composerImagesRef.current = images;
    inputRef.current.composerFilesRef.current = held.files;
    inputRef.current.composerTerminalContextsRef.current = held.terminalContexts;
    store.setPrompt(composerDraftTarget, held.prompt);
    store.addImages(composerDraftTarget, images);
    store.addFiles(composerDraftTarget, held.files);
    store.setTerminalContexts(composerDraftTarget, held.terminalContexts);
    store.setPreviewAnnotations(composerDraftTarget, held.previewAnnotations);
    store.setReviewComments(composerDraftTarget, held.reviewComments);
    store.setThreadContexts(composerDraftTarget, held.threadContexts);
    composerRef.current?.resetCursorState({
      cursor: collapseExpandedComposerCursor(held.prompt, held.prompt.length),
      prompt: held.prompt,
      detectTrigger: true,
    });
  }, [draftId, sendInFlightRef]);

  const environmentSetup = useMemo<CloudEnvironmentSetupSnapshot | null>(() => {
    if (setupPhase === null || pending === null) return null;
    const repository = cloneRepository(activeProject?.repositoryIdentity);
    return {
      provider: pending.provider,
      phase: setupPhase,
      startedAt: pending.startedAt,
      ...(pending.endedAt && setupPhase === "failed" ? { endedAt: pending.endedAt } : {}),
      ...(pending.error ? { error: pending.error } : {}),
      ...(repository ? { repository } : {}),
    };
  }, [activeProject, pending, setupPhase]);
  const environmentSetupCard = useMemo(
    () =>
      environmentSetup === null ? null : (
        <EnvironmentSetupFooter snapshot={environmentSetup} onCancel={cancelSetup} />
      ),
    [cancelSetup, environmentSetup],
  );
  const heldMessage = useMemo(
    () =>
      pending === null || pending.messageId === sentHeldMessageId
        ? null
        : heldRef.current?.message.id === pending.messageId
          ? heldRef.current.message
          : heldMessageFromRecord(pending),
    [pending, sentHeldMessageId],
  );

  // The send button spins while a queued send waits for its environment, through a box's wake.
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const awaitEnvironmentConnected = useAtomCommand(environmentCatalog.awaitConnected, {
    reportFailure: false,
  });
  const recoverForSend = useCallback(
    async (environmentId: EnvironmentId): Promise<ReconnectResult> => {
      await retryEnvironment(environmentId);
      const connected = await awaitEnvironmentConnected(environmentId);
      if (connected._tag !== "Failure") return { kind: "ready" };
      const error = squashAtomCommandFailure(connected);
      return {
        kind: "failed",
        message: error instanceof Error ? error.message : "The environment could not reconnect.",
      };
    },
    [awaitEnvironmentConnected, retryEnvironment],
  );
  const sendReconnected = useCallback((pendingSend: ReconnectedSend) => {
    void inputRef.current.send(
      pendingSend.dispatchMode,
      pendingSend.submissionIntent,
      pendingSend.directAnnotation,
    );
  }, []);
  const notifyReconnectSendAbandoned = useCallback(() => {
    toastManager.add({
      type: "info",
      title: "Message not sent",
      description: "You left the chat before it reconnected. The message is still in its composer.",
    });
  }, []);
  const notifyReconnectSendFailed = useCallback((message: string) => {
    toastManager.add(
      stackedThreadToast({ type: "error", title: "Message not sent", description: message }),
    );
  }, []);
  const reconnect = useReconnectSend<ReconnectedSend>({
    threadKey: input.routeThreadKey,
    ready: input.sendReady,
    recover: recoverForSend,
    send: sendReconnected,
    onAbandoned: notifyReconnectSendAbandoned,
    onFailure: notifyReconnectSendFailed,
  });
  const { cancel: cancelReconnectSend, reconnecting } = reconnect;
  // A send waiting on a reconnect, which a box's wake can stretch to minutes, can be called off;
  // its message stays in the composer.
  const bannerItems = useMemo<ComposerBannerStackItem[]>(
    () =>
      reconnecting
        ? [
            {
              id: `pending-send:${input.routeThreadKey}`,
              variant: "info",
              icon: <SendIcon />,
              title: "Your message sends once this chat reconnects",
              actions: (
                <Button size="xs" variant="ghost" onClick={cancelReconnectSend}>
                  Cancel send
                </Button>
              ),
            },
          ]
        : [],
    [cancelReconnectSend, input.routeThreadKey, reconnecting],
  );

  // Once the environment is ready and the draft points at it, the held message goes out.
  const activeProjectEnvironmentId = activeProject?.environmentId ?? null;
  const activeEnvironmentConfigured = input.activeEnvironment?.serverConfig != null;
  useEffect(() => {
    if (
      readyEnvironmentId === null ||
      draftId === null ||
      activeProjectEnvironmentId !== readyEnvironmentId ||
      input.activeThreadEnvironmentId !== readyEnvironmentId ||
      !activeEnvironmentConfigured ||
      sendInFlightRef.current
    ) {
      return;
    }
    setReadyEnvironmentId(null);
    setSetupPhase(null);
    if (
      useComposerDraftStore.getState().getDraftSession(draftId)?.pendingEnvironmentSend
        ?.hostStartedFirstTurn
    ) {
      // The host confirmed it started this turn on the box, which its chat now owns. The draft
      // becomes the thread as soon as the box reports it, so the page only stops tracking the
      // request. Without that confirmation, from an older host or a turn the host could not
      // start, the page sends the message itself below.
      transferProvisionedSandboxLease(draftId, scopeThreadRef(readyEnvironmentId, threadId));
      forgetProvisionRequest(draftId);
      return;
    }
    // Another tab may hold the same draft, and only one of them sends the held message. Until
    // this tab's turn comes the composer stays held, and leaving the draft drops the send here.
    const held = heldRef.current;
    sendInFlightRef.current = true;
    void cloudSends
      .sendHeld(draftId, async () => {
        if (heldRef.current !== held) return;
        sendInFlightRef.current = false;
        resumingRef.current = true;
        try {
          await inputRef.current.send();
        } finally {
          resumingRef.current = false;
        }
      })
      .finally(() => {
        if (heldRef.current !== held) return;
        heldRef.current = null;
        sendInFlightRef.current = false;
        if (held) setSentHeldMessageId(held.message.id);
      });
  }, [
    activeEnvironmentConfigured,
    activeProjectEnvironmentId,
    draftId,
    input.activeThreadEnvironmentId,
    readyEnvironmentId,
    sendInFlightRef,
    threadId,
  ]);

  /** The lease a draft's send claims: only its own box's, which the send must be going to. */
  const leaseForSend = (target: ScopedThreadRef | DraftId | null, environmentId: EnvironmentId) => {
    if (typeof target !== "string") return null;
    const stored = provisionedSandboxFor(target);
    if (!stored) return null;
    const lease = draftBoxLease(stored, readyDraftBoxEnvironmentId(target));
    // A draft keeps its lease when provisioning fails, and may then run on a real server. Only
    // a send on its own box claims the box; any other leaves the box for the draft to dispose.
    if (leaseReachesBox(lease, environmentId, catalogBoxManager)) return lease;
    cancelProvisionRequest(target);
    return null;
  };

  const claimCloudLease = useAtomCommand(serverEnvironment.claimProvisionedEnvironment, {
    reportFailure: false,
  });
  /** After a draft's first turn starts: the draft's cloud send is over, and its box is the chat's. */
  const claimFirstTurn = async (
    target: ScopedThreadRef | DraftId,
    lease: ProvisionedSandboxLease | null,
    owner: ScopedThreadRef,
  ) => {
    if (typeof target !== "string") return;
    setDraftPendingEnvironmentSend(target, null);
    if (!lease) return;
    const claimed = await claimProvisionedBox(
      {
        claim: async (request) => {
          const result = await claimCloudLease(request);
          return AsyncResult.isSuccess(result) && result.value.kind === "claimed";
        },
        refresh: refreshProvisionedEnvironments,
        boxManager: catalogBoxManager,
        warn: (attempt) =>
          console.warn("[cloud] could not claim the box for its first turn", {
            leaseId: lease.leaseId,
            attempt,
          }),
      },
      lease,
      owner,
    );
    transferProvisionedSandboxLease(target, owner);
    forgetProvisionRequest(target);
    if (!claimed) {
      toastManager.add({
        type: "warning",
        title: "Cloud chat started, but its lease could not be claimed.",
        description: "Stop the cloud machine from the thread menu after reconnecting.",
      });
    }
  };

  /**
   * Where a background send opens the next draft. Never on the box this chat just took: its
   * claim may not have landed, so nothing else would stop the draft from starting on it.
   */
  const nextDraftProjectRef = (
    project: EnvironmentProject,
    lease: ProvisionedSandboxLease | null,
  ): ScopedProjectRef => {
    const next = nextDraftEnvironment({
      environmentId: project.environmentId,
      ownBoxManagerId: lease?.managerEnvironmentId ?? null,
      environments: input.projectEnvironments,
      runTargets: runTargets.environments,
    });
    return next?.projectId
      ? scopeProjectRef(next.environmentId, next.projectId)
      : scopeProjectRef(project.environmentId, project.id);
  };

  return {
    runOn,
    /** The draft starts a cloud machine on its first send. */
    startsCloudEnvironment: requested !== null,
    onEnvironmentPicked,
    environmentSetup,
    environmentSetupCard,
    heldMessage,
    /** A send must wait: the draft's cloud machine is being set up, or its held send is going. */
    blocksSend: () =>
      reconnect.isPending() || ((readyEnvironmentId !== null || creating) && !resumingRef.current),
    /** The held send this call is sending, when the cloud machine's ready step sent it. */
    heldSendForResume: () => (resumingRef.current ? heldRef.current : null),
    holdFirstSend,
    reconnectAndSend: reconnect.reconnectAndSend,
    reconnectingSend: reconnecting,
    bannerItems,
    leaseForSend,
    claimFirstTurn,
    nextDraftProjectRef,
  };
}
