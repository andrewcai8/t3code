import { CloudComputeControls } from "./CloudComputeControls";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { Fragment, useCallback, useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { LocalEnvironmentList } from "./LocalEnvironmentList";
import { ProvisionedEnvironmentRows } from "./ProvisionedEnvironmentRows";
import { GitHubRoutingSettings } from "./GitHubRoutingSettings";

export function ConnectionsRouteScreen() {
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onRemoveEnvironmentPress,
    onSetEnvironmentEnabled,
    onUpdateEnvironment,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [expandedId, setExpandedId] = useState<EnvironmentId | null>(null);
  const handleToggle = useCallback((environmentId: EnvironmentId) => {
    setExpandedId((prev) => (prev === environmentId ? null : environmentId));
  }, []);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title="Environments"
          onBack={() => navigation.goBack()}
          actions={[
            {
              accessibilityLabel: "Add environment",
              icon: "plus",
              onPress: () => navigation.navigate("ConnectionsNew"),
            },
          ]}
        />
      ) : (
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Button
            icon="plus"
            onPress={() => navigation.navigate("ConnectionsNew")}
            separateBackground
          />
        </NativeHeaderToolbar>
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        <LocalEnvironmentList
          environments={connectedEnvironments}
          expandedId={expandedId}
          onToggle={handleToggle}
          onReconnect={onReconnectEnvironment}
          onRemove={onRemoveEnvironmentPress}
          onSetEnabled={onSetEnvironmentEnabled}
          onUpdate={onUpdateEnvironment}
        />
        {connectedEnvironments
          .filter((environment) => environment.connectionState === "connected")
          .map((environment) => (
            <Fragment key={environment.environmentId}>
              <ProvisionedEnvironmentRows
                managerId={environment.environmentId}
                managerLabel={environment.environmentLabel}
                connectedEnvironments={connectedEnvironments}
                onLeave={onRemoveEnvironmentPress}
              />
              <CloudComputeControls
                managerId={environment.environmentId}
                managerLabel={environment.environmentLabel}
                onStarted={(id) => {
                  if (!connectedEnvironments.some((entry) => entry.environmentId === id))
                    return false;
                  onReconnectEnvironment(id);
                  return true;
                }}
              />
            </Fragment>
          ))}
        <GitHubRoutingSettings />
      </ScrollView>
    </View>
  );
}
