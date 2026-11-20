#!/usr/bin/env bash
# Installs the RPM package built in dist/ on openSUSE Leap and Tumbleweed in containers, checks that it finds its
# libraries, then uninstalls it and checks that none of its files or links stays. The repositories are read first, tried
# again a minute apart while a mirror publishes a new snapshot, and installing never reads them again, so that zypper
# cannot skip an unreadable repository and report a missing dependency instead. Tumbleweed whose current repositories
# stay unreadable is tested on its newest complete snapshot of the history openSUSE keeps, with a warning; Leap, or
# Tumbleweed without any readable snapshot, fails with the real cause. No crash leaves a core dump behind.
set -euo pipefail

IMAGES=(leap:16.0 tumbleweed:latest)
REFRESH_ATTEMPTS=5
REFRESH_WAIT_SECONDS="${OPENSUSE_REFRESH_WAIT_SECONDS:-60}"
SNAPSHOTS_TRIED=3
HISTORY=https://download.opensuse.org/history

# Inside a container: reads the repositories, installs, checks and uninstalls the package.
inside() {
  local image="$1"
  local snapshots="$2"
  read_repositories "$image" "$snapshots"
  zypper --non-interactive --no-refresh install --allow-unsigned-rpm /package/Tasklace-*-x86_64.rpm
  test -L /usr/bin/tasklace
  if ldd /opt/Tasklace/tasklace | grep "not found"; then exit 1; fi
  zypper --non-interactive remove tasklace
  test ! -e /opt/Tasklace
  test ! -e /usr/bin/tasklace
  test ! -L /usr/bin/tasklace
}

# Reads the repositories of an image, a minute apart while they fail, falling back on a snapshot for Tumbleweed.
read_repositories() {
  local image="$1"
  local snapshots="$2"
  local attempt
  for ((attempt = 1; attempt <= REFRESH_ATTEMPTS; attempt += 1)); do
    if zypper --non-interactive refresh > /tmp/refresh 2>&1; then
      return 0
    fi
    cat /tmp/refresh
    if ((attempt < REFRESH_ATTEMPTS)); then
      echo "The repositories of openSUSE $image could not be read; trying again in $REFRESH_WAIT_SECONDS seconds ($attempt of $REFRESH_ATTEMPTS)."
      sleep "$REFRESH_WAIT_SECONDS"
    fi
  done
  if [ "$image" != tumbleweed:latest ]; then
    echo "::error::The repositories of openSUSE $image could not be read after $REFRESH_ATTEMPTS tries, as while a mirror publishes a new snapshot; the package was not tested on it."
    exit 1
  fi
  use_snapshot "$snapshots"
}

# Replaces the repositories of Tumbleweed by the newest of the given snapshots it can read whole.
use_snapshot() {
  local snapshot
  for snapshot in $1; do
    if [[ ! "$snapshot" =~ ^[0-9]{8}$ ]]; then
      continue
    fi
    zypper --non-interactive removerepo --all > /dev/null
    zypper --non-interactive addrepo "$HISTORY/$snapshot/tumbleweed/repo/oss/" "snapshot-$snapshot" > /dev/null
    if zypper --non-interactive refresh > /tmp/refresh 2>&1; then
      echo "::warning::openSUSE Tumbleweed was tested on its snapshot of $snapshot, its current repositories being unreadable."
      return 0
    fi
    cat /tmp/refresh
  done
  echo "::error::Neither the current repositories of openSUSE Tumbleweed nor its snapshots (${1:-none could be listed}) could be read; the package was not tested on it."
  exit 1
}

if [ "${1:-}" = inside ]; then
  inside "$2" "$3"
  exit 0
fi

snapshots="$(curl --fail --silent --show-error --retry 3 "$HISTORY/list" | sort --reverse | head --lines="$SNAPSHOTS_TRIED" | tr '\n' ' ' || true)"
for image in "${IMAGES[@]}"; do
  docker run --rm --ulimit core=0 \
    --volume "$PWD/dist:/package:ro" \
    --volume "$PWD/scripts:/scripts:ro" \
    --env "OPENSUSE_REFRESH_WAIT_SECONDS=$REFRESH_WAIT_SECONDS" \
    "registry.opensuse.org/opensuse/$image" \
    bash /scripts/test-opensuse-package.sh inside "$image" "$snapshots"
done
