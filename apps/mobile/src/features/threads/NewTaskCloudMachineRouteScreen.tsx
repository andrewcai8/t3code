import {
  CommonActions,
  useNavigation,
  usePreventRemove,
  type StaticScreenProps,
} from "@react-navigation/native";
import { EnvironmentId, type ScopedProjectRef } from "@t3tools/contracts";
import { useCallback } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  useRemoteConnectionStatus,
  useSavedRemoteConnection,
} from "../../state/use-remote-environment-registry";
import { NewCloudMachineForm } from "../connection/NewCloudMachineSheet";
import { useCreateCloudMachine } from "../connection/useCreateCloudMachine";

type NewTaskCloudMachineRouteParams = {
  /** The host that starts the machine; it holds the project the thread was asked for. */
  readonly environmentId: string;
  readonly repository: string;
  readonly title?: string;
  readonly branch?: string | null;
};

/**
 * A new thread on a host that runs no agents: start a cloud machine cloned from the project's
 * repository, then open the draft on the machine's checkout.
 */
export function NewTaskCloudMachineRouteScreen({
  route,
}: StaticScreenProps<Partial<NewTaskCloudMachineRouteParams> | undefined>) {
  const params = route.params;
  // Only the new-thread entry points build these params; a bare deep link has nothing to start.
  if (!params?.environmentId || !params.repository) return null;
  return (
    <NewTaskCloudMachine
      environmentId={params.environmentId}
      repository={params.repository}
      {...(params.title ? { title: params.title } : {})}
      {...(params.branch ? { branch: params.branch } : {})}
    />
  );
}

function NewTaskCloudMachine({
  environmentId,
  repository,
  title,
  branch,
}: NewTaskCloudMachineRouteParams) {
  const managerId = EnvironmentId.make(environmentId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const manager = useSavedRemoteConnection(managerId);
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const onCreated = useCallback(
    (projectRef: ScopedProjectRef) => {
      navigation.dispatch(
        CommonActions.reset({
          index: 0,
          routes: [
            {
              name: "NewTaskDraft",
              params: {
                environmentId: projectRef.environmentId,
                projectId: projectRef.projectId,
                ...(title ? { title } : {}),
                // The branch carries over by name; the draft checks it out on the new machine.
                ...(branch ? { branch } : {}),
              },
            },
          ],
        }),
      );
    },
    [branch, navigation, title],
  );
  const creation = useCreateCloudMachine({ managerId, connectedEnvironments, onCreated });
  // Leaving mid-start would strand a machine nobody opens.
  usePreventRemove(creation.state.kind === "working", () => undefined);

  return (
    <View className="flex-1 bg-sheet" style={{ paddingBottom: insets.bottom }}>
      <NewCloudMachineForm
        managerId={managerId}
        managerLabel={manager?.environmentLabel ?? "The host"}
        initialRepository={repository}
        creation={creation}
      />
    </View>
  );
}
