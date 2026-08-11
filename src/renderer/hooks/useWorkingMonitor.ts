import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'

/**
 * How long a tab may look busy with nothing to reconcile it against.
 *
 * Event silence only means the run is gone when there is no run to ask about.
 * A tab that still holds an activeRequestId is covered by
 * useHealthReconciliation, which asks the backend whether the process is
 * actually alive instead of inferring it — and a healthy turn is silent for its
 * whole duration, because the agent transport reports the reply in one piece
 * rather than streaming progress. Timing such a tab out mid-answer retracts
 * "Working…" and the Interrupt button while the agent is still thinking.
 */
const WORKING_STALE_MS = 5000
/**
 * Backstop for a tab the health poll cannot speak for (its run vanished from
 * the backend registry). Sits above the CLI's own 600s agent timeout, so it
 * only ever fires after the transport itself would have given up.
 */
const WORKING_STALE_WITH_RUN_MS = 15 * 60 * 1000
const TIMER_INTERVAL_MS = 1000

export function useWorkingMonitor() {
  useEffect(() => {
    const timer = setInterval(() => {
      const { tabs } = useSessionStore.getState()
      const now = Date.now()
      let mutated = false
      const freshTabs = tabs.map((tab) => {
        if (tab.status === 'running' || tab.status === 'connecting') {
          const lastEventAge = now - (tab.lastEventAt || 0)
          const hasRunningTool = tab.messages.some((m) => m.role === 'tool' && m.toolStatus === 'running')
          const limit = tab.activeRequestId ? WORKING_STALE_WITH_RUN_MS : WORKING_STALE_MS
          const isStale = lastEventAge > limit && !hasRunningTool

          if (isStale) {
            mutated = true
            return {
              ...tab,
              status: 'completed' as const,
              activeRequestId: null,
              currentActivity: '',
              permissionQueue: [],
            }
          }
        }
        return tab
      })

      if (mutated) {
        useSessionStore.setState({ tabs: freshTabs })
      }
    }, TIMER_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [])
}
