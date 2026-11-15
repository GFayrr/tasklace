#!/usr/bin/env bash
# Installs the RPM package built in dist/ on Fedora in a container, runs the tests of the installed application as an
# ordinary person, upgrades it to a later version of the same application, then uninstalls it and checks that none of
# its files, links or folders stays. A container refuses the user namespaces the sandbox of Chromium needs, so the
# application runs there without it, and the tests that need it skip themselves on TASKLACE_IN_CONTAINER; they are to
# be checked by hand on a Fedora computer. For the same reason the package gives chrome-sandbox its SUID fallback here,
# where a Fedora computer keeps it as it is. desktop-file-utils is installed on its own, as on a desktop, so that removing
# Tasklace does not take it away before it updates the cache of file types. Traces of failed tests land in rpm-test-results/, and no crash leaves a core
# dump behind.
set -euo pipefail

FEDORA_IMAGE=registry.fedoraproject.org/fedora:45
UPGRADE_FOLDER=rpm-upgrade
UPGRADE_VERSION=99.0.0
SHA256_DIGEST_ALGORITHM=8

NODE_BINARY="$(command -v node || true)"
if [ ! -x "$NODE_BINARY" ]; then
  echo "Node is needed to run the tests of the RPM package." >&2
  exit 1
fi
NODE_FOLDER="$(dirname "$(dirname "$NODE_BINARY")")"
VERSION="$(node --print "require('./package.json').version")"

rm -rf -- "${UPGRADE_FOLDER:?}"
npx electron-builder --linux rpm --publish never --prepackaged dist/linux-unpacked \
  "--config.extraMetadata.version=$UPGRADE_VERSION" "--config.directories.output=$UPGRADE_FOLDER"
mkdir --parents --mode=777 rpm-test-results
docker run --rm --ulimit core=0 \
  --env "VERSION=$VERSION" \
  --env "UPGRADE_VERSION=$UPGRADE_VERSION" \
  --env "SHA256_DIGEST_ALGORITHM=$SHA256_DIGEST_ALGORITHM" \
  --volume "$PWD:/work:ro" \
  --volume "$PWD/rpm-test-results:/results" \
  --volume "$NODE_FOLDER:/node:ro" \
  --volume "$PWD/$UPGRADE_FOLDER:/upgrade:ro" \
  "$FEDORA_IMAGE" bash -c '
    set -euo pipefail
    fail() { echo "$1" >&2; exit 1; }
    check_libraries() {
      if ldd /opt/Tasklace/tasklace | grep "not found"; then fail "A library of Tasklace is missing."; fi
    }
    package="/work/dist/Tasklace-$VERSION-x86_64.rpm"
    test "$(rpm --query --package --queryformat "%{FILEDIGESTALGO}" "$package")" = "$SHA256_DIGEST_ALGORITHM" \
      || fail "The files of the package are not fingerprinted with SHA-256."
    dnf5 install --assumeyes "$package" desktop-file-utils xorg-x11-server-Xvfb xorg-x11-xauth
    command -v gio > /dev/null || fail "gio is missing, so the file types cannot be checked."
    test -L /usr/bin/tasklace || fail "The package did not set up /usr/bin/tasklace."
    check_libraries
    if unshare --user true 2>/dev/null; then sandbox_mode=755; else sandbox_mode=4755; fi
    test "$(stat --format %a /opt/Tasklace/chrome-sandbox)" = "$sandbox_mode" \
      || fail "chrome-sandbox does not have the mode $sandbox_mode this system needs."
    useradd --create-home person
    runuser -u person -- env PATH=/node/bin:/usr/bin:/bin HOME=/home/person CI=true \
      TASKLACE_PACKAGED_APP=/opt/Tasklace/tasklace TASKLACE_INSTALLED_PACKAGE=rpm TASKLACE_IN_CONTAINER=1 \
      bash -c "cd /work && xvfb-run --auto-servernum npx playwright test --config playwright.packaged.config.ts --output /results/traces"
    dnf5 install --assumeyes "/upgrade/Tasklace-$UPGRADE_VERSION-x86_64.rpm"
    test "$(rpm --query --queryformat "%{VERSION}" tasklace)" = "$UPGRADE_VERSION" \
      || fail "The upgrade did not install version $UPGRADE_VERSION."
    test "$(readlink --canonicalize /usr/bin/tasklace)" = /opt/Tasklace/tasklace \
      || fail "The upgrade lost /usr/bin/tasklace."
    check_libraries
    rpm --query --list tasklace > /tmp/installed-files
    grep --quiet "^/usr/share/applications/tasklace.desktop$" /tmp/installed-files \
      || fail "The package lists no desktop file, so its file list cannot be trusted."
    dnf5 remove --assumeyes tasklace
    while read -r path; do
      if [ -d "$path" ] && rpm --query --file "$path" > /dev/null 2>&1; then
        continue
      fi
      if [ -e "$path" ] || [ -L "$path" ]; then fail "$path stayed"; fi
    done < /tmp/installed-files
    test ! -e /opt/Tasklace || fail "/opt/Tasklace stayed."
    test ! -e /usr/bin/tasklace || fail "/usr/bin/tasklace stayed."
    test ! -L /usr/bin/tasklace || fail "A broken link /usr/bin/tasklace stayed."
    test ! -e /etc/alternatives/tasklace || fail "The alternative of Tasklace stayed."
    test ! -L /etc/alternatives/tasklace || fail "A broken alternative of Tasklace stayed."
    gio mime x-scheme-handler/tasklace > /tmp/handlers
    if grep --quiet tasklace.desktop /tmp/handlers; then fail "Tasklace still opens Tasklace links."; fi
    if grep --quiet --no-messages tasklace.desktop /usr/share/applications/mimeinfo.cache; then
      fail "The desktop still lists Tasklace for a file type."
    fi
  '
