#!/bin/bash

nat_mode_is_valid() {
  case "$1" in
    gateway|instance-standby|instance-active|instance-only) return 0 ;;
    *) return 1 ;;
  esac
}

nat_mode_transition_allowed() {
  local current="$1"
  local requested="$2"

  [ "$current" = "$requested" ] && return 0
  case "$current:$requested" in
    gateway:instance-standby|instance-standby:gateway|instance-standby:instance-active|\
      instance-active:instance-standby|instance-active:instance-only|instance-only:instance-active)
      return 0
      ;;
    *) return 1 ;;
  esac
}
