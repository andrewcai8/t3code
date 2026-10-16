/**
 * The Linux cloud box image, as steps both builders read: E2B renders them as a template, Modal
 * as Dockerfile commands. A step runs as the user the last `user` step named.
 */
export const COMMON_TOOLS_BASE =
  "ubuntu:24.04@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254";

export const COMMON_TOOLS_STEPS = [
  { user: "root" },
  { copy: "e2b-common-tools.sh", to: "/opt/t3-common-tools.sh", mode: 0o755 },
  { run: "bash /opt/t3-common-tools.sh system" },
  { run: "bash /opt/t3-common-tools.sh runtimes" },
  {
    env: {
      HOME: "/home/user",
      NPM_CONFIG_PREFIX: "/home/user/.local",
      BUN_INSTALL: "/home/user/.bun",
      SWIFTLY_HOME_DIR: "/home/user/.local/share/swiftly",
      SWIFTLY_BIN_DIR: "/home/user/.local/bin",
      BROWSER_EXECUTABLE: "/usr/local/bin/chromium-headless",
      PATH: "/home/user/.local/bin:/home/user/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    },
  },
  { user: "user" },
  { workdir: "/home/user" },
  { run: "bash /opt/t3-common-tools.sh tools" },
  { run: "bash /opt/t3-common-tools.sh swift" },
  {
    run: String.raw`cat > /home/user/.profile.d-common-tools.sh <<'PROFILE'
export NPM_CONFIG_PREFIX="$HOME/.local"
export NODE_OPTIONS=--max-old-space-size=4096
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
PROFILE
printf '%s\n' '. "$HOME/.profile.d-common-tools.sh"' >> /home/user/.profile
printf '%s\n' '. "$HOME/.profile.d-common-tools.sh"' >> /home/user/.bashrc`,
  },
  {
    run: String.raw`set -eu
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
curl -fsSL --retry 3 https://go.dev/dl/go1.26.4.linux-amd64.tar.gz -o "$temporary/go.tar.gz"
printf '%s  %s\n' 1153d3d50e0ac764b447adfe05c2bcf08e889d42a02e0fe0259bd47f6733ad7f "$temporary/go.tar.gz" | sha256sum --check --status
sudo tar -xzf "$temporary/go.tar.gz" -C /usr/local
sudo ln -sfn /usr/local/go/bin/go /usr/local/bin/go
sudo ln -sfn /usr/local/go/bin/gofmt /usr/local/bin/gofmt
sudo systemctl disable redis-server.service
test "$(go version)" = 'go version go1.26.4 linux/amd64'`,
  },
  { run: "bash /opt/t3-common-tools.sh verify && ruby --version" },
];
