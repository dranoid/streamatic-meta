import type { CameraFolder } from '../cameras/camera-folder.js';
import { copyAlert, type CopyDeps } from '../events/copy-alert.js';
import type { RuleStore } from '../rules/rule-store.js';
import type { RuleBackend } from './client.js';

// Copies the backend's alerts into the app's events, so questions and the clip player keep working over them.
export class AlertCopier {
  constructor(
    private readonly options: { backend: Pick<RuleBackend, 'alerts'>; rules: RuleStore; cameras: CameraFolder; copy: CopyDeps; notify?: (event: number) => Promise<void> },
  ) {}

  async pass(): Promise<number> {
    const { backend, rules, cameras, copy, notify } = this.options;
    let copied = 0;
    for (const rule of rules.list()) {
      const camera = await cameras.get(rule.camera);
      if (!camera?.backend) continue;
      const { recorded } = camera.backend;
      for (const alert of await backend.alerts(rule.backendRuleId)) {
        const at = Date.parse(alert.triggeredAt);
        // A camera with stored hours shows only those: this app never sees a camera's other hours.
        if (recorded && (at < Date.parse(recorded.from) || at > Date.parse(recorded.to))) continue;
        const event = await copyAlert(alert, rule, camera.name, copy);
        if (event === null) continue;
        copied++;
        // The event is kept whatever happens here, and is not sent twice.
        await notify?.(event).catch((error: unknown) => console.error(`Sending alert ${event}: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    return copied;
  }
}
