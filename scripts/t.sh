#!/bin/sh
npx tsx --test --test-concurrency=1 "$@" 2>&1 | awk '/^not ok/{print; next} /^  error:/{print substr($0,1,420)} /^# (tests|pass|fail)/{print}'
