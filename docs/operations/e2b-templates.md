# E2B templates

E2B provisions from a saved template, which includes its own installed T3 package. Updating the host checkout does not update that package. Install the updated full T3 build in a disposable template sandbox and save a new template before switching the host to a build that requires workload memory isolation. Set `provisioning.templateId` in the host's environment-control configuration to that template, then verify a new environment can start and pair.

The template needs Linux cgroup v2 with the memory controller, root commands, `setpriv`, and the `user` account. Provisioning starts T3 in a separate control group and validates that the user can enter the workload group before launching T3. Providers and terminal shells enter the workload group before executing their commands, so their descendants share one memory limit. The remaining memory, at least 1 GiB or 20% of guest RAM, is reserved for T3, the E2B connection service, and the operating system. Provisioning refuses machines with less than 512 MiB left for workloads.

Check `/.well-known/t3/environment` on the new environment. Its `capabilities.workloadMemoryLimitBytes` must contain the enforced limit. A template with an older T3 build fails provisioning instead of silently running without containment. Startup diagnostics are in `/tmp/serve.out`.

Pause/resume retains the existing process and memory configuration. Reconnecting checks the expected T3 environment identity after E2B reports the sandbox running. It does not restart T3 or retrofit memory isolation into existing sessions. Changing `provisioning.templateId` affects new environments only.
