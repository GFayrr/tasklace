#!/bin/bash
# The removal script of the RPM package, electron-builder's own with two changes: during an upgrade RPM runs the copy of
# the old version with 1 as its argument, after the new version has set up its link, so only a full removal, with 0,
# takes the link away; and a link the alternatives system cannot remove is said and removed by hand.
if [ "$1" != 0 ]; then
    exit 0
fi

if type update-alternatives >/dev/null 2>&1; then
    if ! update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'; then
        echo "Tasklace: the alternatives system kept /usr/bin/${executable}, which is removed by hand." >&2
        rm -f '/usr/bin/${executable}'
    fi
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
