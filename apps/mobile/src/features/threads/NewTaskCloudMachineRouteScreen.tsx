import { CommonActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, type ScopedProjectRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { readProject } from "../../state/cloud-entities";
import {
  useRemoteConnectionStatus,
  useSavedRemoteConnection,
} from "../../state/use-remote-environment-registry";
import { NewCloudMachineForm } from "../connection/NewCloudMachineForm";
import { useCreateCloudMachine } from "../connection/useCreateCloudMachine";

type NewTaskCloudMachineRouteParams = {
  /** The host that starts the machine: the project's own host, or the host of the box it is on. */
  readonly environmentId: string;
  /** Absent when started from Connections, which lets the form pick the repository. */
  readonly repository?: string;
  readonly branch?: string | null;
};

/**
 * A new cloud chat: start a cloud machine cloned from a repository, then open the draft on the
 * machine's checkout, so the machine is always the chat's. New threads on a host that runs no
 * agents, or on another chat's box, arrive with the project's repository.
 */
export function NewTaskCloudMachineRouteScreen({
  route,
}: StaticScreenProps<Partial<NewTaskCloudMachineRouteParams> | undefined>) {
  const params = route.params;
  // A bare deep link names no host to start the machine on.
  if (!params?.environmentId) return null;
  return (
    <NewTaskCloudMachine
      // A new request while this screen is open starts from its own params, not the last form.
      key={`${params.environmentId}\n${params.repository ?? ""}\n${params.branch ?? ""}`}
      environmentId={params.environmentId}
      {...(params.repository ? { repository: params.repository } : {})}
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
  // Connections, but nothing opens a draft for a screen the user left or moved past.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onCreated = useCallback(
    (projectRef: ScopedProjectRef) => {
      // A screen pushed over this one (such as another project's draft opened from the
      // sidebar) is where the user is now; resetting the sheet would throw it away.
      if (!mounted.current || !navigation.isFocused()) return;
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
        {...(repository ? { initialRepository: repository } : {})}
        creation={creation}
      />
    </View>
  );
}
