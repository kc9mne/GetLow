#!/bin/sh
# Keep a GetLow website up to date from GitHub.
#
# Checks GitHub for a new version of main; when there is one, builds the site
# (tools/build-site.py, which also makes the offline copy script sw.js that
# tells open and installed copies to offer "Update now") and copies the build
# into the website folder. When nothing has changed it does nothing.
#
# Needs git and python3:   sudo apt install git python3
#
# Put it in the website's home folder, next to its public_html (Virtualmin:
# /home/USER for a server, /home/USER/domains/DOMAIN for a sub-server), and
# run it from cron as the owner of that folder every few minutes, e.g.
#   */5 * * * * /home/USER/domains/DOMAIN/update-getlow.sh >> /home/USER/domains/DOMAIN/update-getlow.log 2>&1
# It keeps its copy of the repository in getlow-src beside it. WEB=... or
# SRC=... in front of the command point it somewhere else.
#
# Files in the website folder that GetLow doesn't have are left alone, and an
# .htaccess the site already has is never overwritten. Run it with --force to
# rebuild and copy even when nothing has changed.

set -e

REPO="https://github.com/kc9mne/GetLow.git"
BRANCH="main"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${SRC:-$HERE/getlow-src}"     # a copy of the repository, outside the website
WEB="${WEB:-$HERE/public_html}"    # where the site is served from
BUILD_OPTS="--with-pe"        # include the Parts Express catalogue (no prices); empty to leave it out

if [ ! -d "$SRC/.git" ]; then
  git clone -q --branch "$BRANCH" "$REPO" "$SRC"
  FORCE=1
fi
[ "$1" = "--force" ] && FORCE=1

cd "$SRC"
git fetch -q origin "$BRANCH"
NEW="$(git rev-parse "origin/$BRANCH")"
# the version last copied into the website (only written once a copy succeeds)
if [ -z "$FORCE" ] && [ "$(cat .deployed 2>/dev/null)" = "$NEW" ]; then
  exit 0                      # nothing new
fi
git reset -q --hard "$NEW"

python3 tools/build-site.py $BUILD_OPTS > /dev/null

mkdir -p "$WEB"
cp -R build/getlow/* "$WEB"/
# GetLow's .htaccess (no caching of the files that announce a new version),
# unless the site already has an .htaccess of its own
if [ ! -f "$WEB/.htaccess" ] || grep -q '^# GetLow' "$WEB/.htaccess"; then
  cp build/getlow/.htaccess "$WEB"/
fi
echo "$NEW" > .deployed
echo "$(date '+%Y-%m-%d %H:%M') GetLow updated to $(git log -1 --format='%h %s')"
