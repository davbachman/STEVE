import { useEffect, useState, useSyncExternalStore } from 'react';
import { createProjectRecovery } from '../persistence/projectRecovery';

export function useProjectRecovery() {
  const [recovery] = useState(() => createProjectRecovery({
    disabled: new URLSearchParams(window.location.search).has('testScene'),
  }));
  const status = useSyncExternalStore(recovery.subscribe, recovery.getSnapshot);

  useEffect(() => {
    const stop = recovery.start();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      recovery.flush();
      if (!recovery.getSnapshot().dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const onPageHide = () => recovery.flush();
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      stop();
    };
  }, [recovery]);

  return {
    ...status,
    markSaved: recovery.markSaved,
    markClean: recovery.markClean,
    dismissNotice: recovery.dismissNotice,
    hasUnsavedChanges: () => recovery.getSnapshot().dirty,
  };
}
