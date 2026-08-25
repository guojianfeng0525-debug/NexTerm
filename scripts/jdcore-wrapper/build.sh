#!/usr/bin/env bash
# Rebuild src-tauri/resources/jdcore/jdcore-wrapper.jar — the jd-core 1.1.3
# CLI used by the decompiler (the exact engine JD-GUI 1.6.6 is built on).
#
# jd-core 1.1.3 is NOT on Maven Central (jcenter was shut down), so we extract
# the org/jd/core classes from the official JD-GUI 1.6.6 release jar
# (https://github.com/java-decompiler/jd-gui/releases/download/v1.6.6/jd-gui-1.6.6.jar).
#
# Requires: JDK 9+ (javac + `jar --date` for reproducible output), curl, unzip.
# The output itself targets Java 8 because NexTerm supports running the
# decompiler with a Java 8 runtime.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Fixed timestamp → bit-for-bit reproducible jar (zip entry timestamps).
JAR_DATE="2024-01-01T00:00:00Z"

JD_GUI_JAR="${JD_GUI_JAR:-}"
if [[ -z "$JD_GUI_JAR" ]]; then
  JD_GUI_JAR="$WORK/jd-gui-1.6.6.jar"
  echo ">> downloading jd-gui-1.6.6.jar ..."
  curl -fsSL -o "$JD_GUI_JAR" \
    https://github.com/java-decompiler/jd-gui/releases/download/v1.6.6/jd-gui-1.6.6.jar
fi

echo ">> extracting org/jd/core (jd-core 1.1.3) ..."
mkdir -p "$WORK/jdcore"
( cd "$WORK/jdcore" && unzip -q "$JD_GUI_JAR" 'org/jd/core/*' )

echo ">> compiling JdCoreDecompiler ..."
mkdir -p "$WORK/classes"
javac --release 8 -cp "$WORK/jdcore" -d "$WORK/classes" "$ROOT/scripts/jdcore-wrapper/JdCoreDecompiler.java"

echo ">> merging into jdcore-wrapper.jar ..."
mkdir -p "$WORK/merged"
cp -R "$WORK/jdcore/org" "$WORK/merged/"
cp "$WORK/classes/"*.class "$WORK/merged/"
jar --create --file "$ROOT/src-tauri/resources/jdcore/jdcore-wrapper.jar" \
    --main-class JdCoreDecompiler --date="$JAR_DATE" -C "$WORK/merged" .

echo ">> done: src-tauri/resources/jdcore/jdcore-wrapper.jar"
