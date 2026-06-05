// daemon-side tool context. Does NOT carry any project-specific state:
// every tool that needs to know "which project" reads `projectName` /
// `projectRoot` from its own input. The daemon never opens any file
// inside the project's own directory.
import type { Store } from '../store/fsStore.js';
import { EnvRegistry } from '../store/envRegistry.js';
import { ProjectManifestStore } from '../store/projectManifestStore.js';
import { ProjectVarsStore } from '../store/projectVarsStore.js';
import { TrafficMonitor } from './traffic.js';

export interface ToolContext {
  store: Store;
  registry: EnvRegistry;
  manifests: ProjectManifestStore;
  vars: ProjectVarsStore;
  // Live MongoDB traffic capture (profiler-backed). Long-lived: holds open
  // poller loops + clients across tool calls, so it lives on the daemon-scoped
  // context, not per-request.
  traffic: TrafficMonitor;
}

export function buildContext(store: Store): ToolContext {
  return {
    store,
    registry: new EnvRegistry(),
    manifests: new ProjectManifestStore(),
    vars: new ProjectVarsStore(),
    traffic: new TrafficMonitor(),
  };
}
