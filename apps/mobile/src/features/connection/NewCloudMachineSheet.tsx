import type { EnvironmentId } from "@t3tools/contracts";
import { type ReactNode, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import {
  CLOUD_MACHINE_PROVIDER_LABELS,
  cloudMachineAccountOptions,
  cloudMachineBlockReason,
  cloudMachineRepositoryOptions,
  type CloudMachineAccountOption,
  type CloudMachineProvider,
} from "./cloudMachineOptions";
import { createCloudMachineProgressText, useCreateCloudMachine } from "./useCreateCloudMachine";

const PROVIDERS: ReadonlyArray<CloudMachineProvider> = ["e2b", "namespace"];

/**
 * Starts a cloud machine from the phone: pick a repository to clone, where to run it, and which
 * account its agent signs in as. The manager does the work, so this closes once the machine is
 * joined and its checkout has landed — at which point a new task can be started on it normally.
 */
export function NewCloudMachineSheet(props: {
  readonly managerId: EnvironmentId;
  readonly managerLabel: string;
  readonly connectedEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const serverConfig = useEnvironmentServerConfig(props.managerId);
  const repositories = useMemo(
    () =>
      cloudMachineRepositoryOptions(
        projects.filter((project) => project.environmentId === props.managerId),
      ),
    [projects, props.managerId],
  );
  const accounts = useMemo(
    () => cloudMachineAccountOptions(serverConfig?.providers ?? []),
    [serverConfig?.providers],
  );
  const [repository, setRepository] = useState<string | null>(null);
  const [provider, setProvider] = useState<CloudMachineProvider>("e2b");
  const [account, setAccount] = useState<CloudMachineAccountOption | null>(null);
  const selectedAccount = account ?? accounts[0] ?? null;
  const selection = { repository, provider, account: selectedAccount };
  const blockReason = cloudMachineBlockReason(selection);
  const { state, create, dismissError } = useCreateCloudMachine({
    managerId: props.managerId,
    connectedEnvironments: props.connectedEnvironments,
    onCreated: props.onClose,
  });
  const working = state.kind === "working";

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-screen" style={{ paddingBottom: insets.bottom }}>
        <View className="flex-row items-center justify-between gap-3 px-5 py-3">
          <Text className="flex-1 text-xl font-t3-semibold">New cloud machine</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            disabled={working}
            onPress={props.onClose}
            className="min-h-11 justify-center px-3 disabled:opacity-50"
          >
            <Text className="text-base text-primary">Cancel</Text>
          </Pressable>
        </View>
        <Text className="px-5 pb-3 text-sm text-foreground-muted">
          {props.managerLabel} starts the machine and this device joins it. It keeps running when
          this app is closed.
        </Text>

        <ScrollView className="flex-1" contentContainerClassName="gap-5 px-5 pb-8">
          <Section title="Repository">
            {repositories.length === 0 ? (
              <Empty text="No project on this manager has a git remote to clone." />
            ) : (
              repositories.map((option, index) => (
                <Choice
                  key={option.repository}
                  title={option.repository}
                  subtitle={option.projectTitles.join(", ")}
                  selected={repository === option.repository}
                  borderTop={index !== 0}
                  disabled={working}
                  onPress={() => setRepository(option.repository)}
                />
              ))
            )}
          </Section>

          <Section title="Run on">
            {PROVIDERS.map((candidate, index) => (
              <Choice
                key={candidate}
                title={CLOUD_MACHINE_PROVIDER_LABELS[candidate]}
                subtitle={candidate === "namespace" ? "macOS, for Apple builds" : "Linux"}
                selected={provider === candidate}
                borderTop={index !== 0}
                disabled={working}
                onPress={() => setProvider(candidate)}
              />
            ))}
          </Section>

          <Section title="Account">
            {accounts.length === 0 ? (
              <Empty text="No provider account on this manager is ready to run an agent." />
            ) : (
              accounts.map((option, index) => (
                <Choice
                  key={option.instanceId}
                  title={option.label}
                  selected={selectedAccount?.instanceId === option.instanceId}
                  borderTop={index !== 0}
                  disabled={working}
                  onPress={() => setAccount(option)}
                />
              ))
            )}
          </Section>

          {state.kind === "failed" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss error"
              onPress={dismissError}
              className="rounded-[20px] bg-card p-4"
            >
              <Text className="text-sm text-danger">{state.message}</Text>
            </Pressable>
          ) : null}
        </ScrollView>

        <View className="gap-3 border-t border-border px-5 pt-4">
          {working ? (
            <View className="flex-row items-center gap-3">
              <ActivityIndicator colorClassName="accent-icon" size="small" />
              <Text className="flex-1 text-sm text-foreground-muted">
                {createCloudMachineProgressText(state.phase, provider)}
              </Text>
            </View>
          ) : blockReason !== null ? (
            <Text className="text-sm text-foreground-muted">{blockReason}</Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create cloud machine"
            disabled={working || blockReason !== null}
            onPress={() => {
              if (selection.repository === null || selection.account === null) return;
              void create({
                repository: selection.repository,
                provider: selection.provider,
                account: selection.account,
              });
            }}
            className="min-h-12 items-center justify-center rounded-full bg-primary active:opacity-80 disabled:opacity-50"
          >
            <Text className="text-base font-t3-bold text-primary-foreground">
              {working ? "Starting…" : "Create machine"}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View collapsable={false} className="gap-2">
      <Text className="px-1 text-sm font-t3-bold uppercase text-foreground-muted">
        {props.title}
      </Text>
      <View collapsable={false} className="overflow-hidden rounded-[20px] bg-card">
        {props.children}
      </View>
    </View>
  );
}

function Empty(props: { readonly text: string }) {
  return <Text className="p-4 text-sm text-foreground-muted">{props.text}</Text>;
}

function Choice(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly selected: boolean;
  readonly borderTop: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected, disabled: props.disabled }}
      accessibilityLabel={props.title}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center gap-3 px-4 py-3.5 active:opacity-70 disabled:opacity-50",
        props.borderTop && "border-t border-border",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base leading-snug text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.selected ? (
        <SymbolView name="checkmark" size={14} tintColorClassName="accent-icon" type="monochrome" />
      ) : null}
    </Pressable>
  );
}
