#!/bin/sh

set -eu

DATA_PERMISSION_LOG_KEY="codex-flycloud-data-permission"
FLYCLOUDHELPER_RUNTIME_UID="${FLYCLOUDHELPER_PUID:-1000}"
FLYCLOUDHELPER_RUNTIME_GID="${FLYCLOUDHELPER_PGID:-1000}"

# 校验 NAS 管理页面传入的 UID/GID，避免无效所有者导致容器反复重启。
validate_runtime_identity() {
  case "${FLYCLOUDHELPER_RUNTIME_UID}" in
    ''|*[!0-9]*)
      echo "${DATA_PERMISSION_LOG_KEY} 阶段=校验运行用户 结果=失败 用户ID=${FLYCLOUDHELPER_RUNTIME_UID} 用户组ID=${FLYCLOUDHELPER_RUNTIME_GID}" >&2
      exit 64
      ;;
  esac
  case "${FLYCLOUDHELPER_RUNTIME_GID}" in
    ''|*[!0-9]*)
      echo "${DATA_PERMISSION_LOG_KEY} 阶段=校验运行用户 结果=失败 用户ID=${FLYCLOUDHELPER_RUNTIME_UID} 用户组ID=${FLYCLOUDHELPER_RUNTIME_GID}" >&2
      exit 64
      ;;
  esac
}

# 创建单个持久化目录，并把已有内容统一交给实际运行服务的 UID/GID。
prepare_data_directory() {
  directory_path="$1"
  if ! mkdir -p "${directory_path}"; then
    echo "${DATA_PERMISSION_LOG_KEY} 阶段=创建数据目录 结果=失败 目录=${directory_path}" >&2
    exit 73
  fi
  if ! chown -R "${FLYCLOUDHELPER_RUNTIME_UID}:${FLYCLOUDHELPER_RUNTIME_GID}" "${directory_path}"; then
    echo "${DATA_PERMISSION_LOG_KEY} 阶段=修复数据权限 结果=失败 目录=${directory_path} 用户ID=${FLYCLOUDHELPER_RUNTIME_UID} 用户组ID=${FLYCLOUDHELPER_RUNTIME_GID}" >&2
    exit 73
  fi
}

# 修复被 NAS 宿主目录覆盖后的 /data 权限，再由普通用户启动服务。
prepare_persistent_data() {
  if ! mkdir -p /data; then
    echo "${DATA_PERMISSION_LOG_KEY} 阶段=创建数据根目录 结果=失败 目录=/data" >&2
    exit 73
  fi
  if ! chown "${FLYCLOUDHELPER_RUNTIME_UID}:${FLYCLOUDHELPER_RUNTIME_GID}" /data; then
    echo "${DATA_PERMISSION_LOG_KEY} 阶段=修复数据根目录 结果=失败 目录=/data 用户ID=${FLYCLOUDHELPER_RUNTIME_UID} 用户组ID=${FLYCLOUDHELPER_RUNTIME_GID}" >&2
    exit 73
  fi

  prepare_data_directory /data/database
  prepare_data_directory /data/secrets
  prepare_data_directory /data/plugins
  prepare_data_directory /data/exports
  prepare_data_directory /data/migrations

  if ! chmod 700 /data/secrets; then
    echo "${DATA_PERMISSION_LOG_KEY} 阶段=修复密钥目录权限 结果=失败 目录=/data/secrets" >&2
    exit 73
  fi
  if [ -f /data/secrets/credential-master-key ] && [ ! -L /data/secrets/credential-master-key ]; then
    if ! chmod 600 /data/secrets/credential-master-key; then
      echo "${DATA_PERMISSION_LOG_KEY} 阶段=修复主密钥权限 结果=失败 文件=/data/secrets/credential-master-key" >&2
      exit 73
    fi
  fi
  echo "${DATA_PERMISSION_LOG_KEY} 阶段=修复数据权限 结果=成功 用户ID=${FLYCLOUDHELPER_RUNTIME_UID} 用户组ID=${FLYCLOUDHELPER_RUNTIME_GID}"
}

validate_runtime_identity

if [ "$(id -u)" = "0" ]; then
  prepare_persistent_data
  exec gosu "${FLYCLOUDHELPER_RUNTIME_UID}:${FLYCLOUDHELPER_RUNTIME_GID}" "$@"
fi

echo "${DATA_PERMISSION_LOG_KEY} 阶段=修复数据权限 结果=跳过 原因=容器未使用root启动 当前用户ID=$(id -u)"
exec "$@"
