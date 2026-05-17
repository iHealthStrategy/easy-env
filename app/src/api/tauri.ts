// Typed wrappers around the Tauri commands defined in src-tauri/src/lib.rs.
// Keep this file thin — every Rust command should have a matching function
// here so React components don't sprinkle invoke() calls.
import { invoke } from '@tauri-apps/api/core';

export type DaemonStatus = {
  running: boolean;
  pid: number | null;
  port: number;
  url: string;
  healthy: boolean;
  version: string | null;
  uptime_ms: number | null;
  last_error: string | null;
  /** True when the daemon is running but was spawned outside this Tauri
   * session (npm run daemon, MCP auto-spawn, previous app session). Stop
   * still works via the pidfile in that case. */
  external: boolean;
};

export type SkillEntry = {
  name: string;
  installed: boolean;
  source_size: number;
  target_size: number | null;
  target_path: string;
  up_to_date: boolean;
};

export type SkillStatus = {
  source_dir: string;
  target_dir: string;
  entries: SkillEntry[];
  all_installed: boolean;
};

export type McpStatus = {
  config_path: string;
  registered: boolean;
  server_entry: string;
  server_entry_exists: boolean;
  current_command: string | null;
  current_args: string[] | null;
};

export type PathsInfo = {
  repo_root: string;
  mcp_server_dir: string;
  daemon_entry: string;
  daemon_entry_exists: boolean;
  server_entry: string;
  server_entry_exists: boolean;
  skill_source_dir: string;
  claude_home: string;
  claude_skills_dir: string;
  claude_config_path: string;
  node_binary: string | null;
};

const IS_TAURI =
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

function ensureTauri<T>(): T {
  throw new Error(
    'This command requires the Tauri runtime. Launch the app via `npm run tauri:dev` instead of plain `npm run dev`.',
  );
}

export const tauri = {
  isTauri: IS_TAURI,
  paths: (): Promise<PathsInfo> =>
    IS_TAURI ? invoke('paths_info') : ensureTauri(),
  daemon: {
    status: (): Promise<DaemonStatus> =>
      IS_TAURI ? invoke('daemon_status') : ensureTauri(),
    start: (): Promise<DaemonStatus> =>
      IS_TAURI ? invoke('daemon_start') : ensureTauri(),
    stop: (): Promise<DaemonStatus> =>
      IS_TAURI ? invoke('daemon_stop') : ensureTauri(),
  },
  skill: {
    status: (): Promise<SkillStatus> =>
      IS_TAURI ? invoke('skill_status') : ensureTauri(),
    install: (): Promise<SkillStatus> =>
      IS_TAURI ? invoke('skill_install') : ensureTauri(),
    uninstall: (): Promise<SkillStatus> =>
      IS_TAURI ? invoke('skill_uninstall') : ensureTauri(),
  },
  mcp: {
    status: (): Promise<McpStatus> =>
      IS_TAURI ? invoke('mcp_status') : ensureTauri(),
    register: (): Promise<McpStatus> =>
      IS_TAURI ? invoke('mcp_register') : ensureTauri(),
    unregister: (): Promise<McpStatus> =>
      IS_TAURI ? invoke('mcp_unregister') : ensureTauri(),
  },
};
