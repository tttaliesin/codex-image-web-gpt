import type { PowerMonitor } from 'electron';
import type { Operations } from './operations';
export function bindPower(monitor: PowerMonitor, operations: Operations) {
  const suspend = () => {
    void operations.suspend('OS_SUSPENDED');
  };
  const resume = () => {
    void operations.resume('OS_SUSPENDED');
  };
  monitor.on('suspend', suspend);
  monitor.on('resume', resume);
  return () => {
    monitor.removeListener('suspend', suspend);
    monitor.removeListener('resume', resume);
  };
}
