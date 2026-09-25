import { CommonActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, type ScopedProjectRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { readProject } from "../../state/entities";
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
      // A new request while this screen is open starts from its own params, not the last form.
      key={`${params.environmentId}\n${params.repository}\n${params.branch ?? ""}`}
      environmentId={params.environmentId}
      repository={params.repository}
      {...(params.branch ? { branch: params.branch } : {})}
    />
  );
}

function NewTaskCloudMachine({
  environmentId,
  repository,
  branch,
}: NewTaskCloudMachineRouteParams) {
  const managerId = EnvironmentId.make(environmentId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const manager = useSavedRemoteConnection(managerId);
  const { connectedEnvironments } = useRemoteConnectionStatus();
  // Leaving is allowed while the machine starts: it keeps starting and appears under
  // Connections, but nothing opens a draft for a screen the user already left.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onCreated = useCallback(
    (projectRef: ScopedProjectRef) => {
      if (!mounted.current) return;
      const title = readProject(projectRef)?.title;
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
                // The branch carries over by name. The draft checks it out on the machine and
                // stays on the default branch when it cannot, since the sheet has nothing
                // behind it to go back to.
                ...(branch ? { branch, branchOptional: "1" } : {}),
              },
            },
          ],
        }),
      );
    },
    [branch, navigation],
  );
  const creation = useCreateCloudMachine({ managerId, connectedEnvironments, onCreated });

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
